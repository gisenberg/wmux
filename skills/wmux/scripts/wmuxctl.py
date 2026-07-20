#!/usr/bin/env python3
"""Small wmux API helper for Codex skills."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import posixpath
import re
import socket
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any


DEFAULT_URL = "http://127.0.0.1:3478"
WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


def _read_exact(stream: socket.socket, size: int) -> bytes:
    chunks: list[bytes] = []
    remaining = size
    while remaining:
        chunk = stream.recv(remaining)
        if not chunk:
            raise OSError("unexpected websocket EOF")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _read_http_headers(stream: socket.socket) -> str:
    data = bytearray()
    while b"\r\n\r\n" not in data:
        chunk = stream.recv(1)
        if not chunk:
            raise OSError("unexpected EOF during websocket upgrade")
        data.extend(chunk)
        if len(data) > 64 * 1024:
            raise OSError("websocket upgrade headers are too large")
    headers, _separator, _remainder = bytes(data).partition(b"\r\n\r\n")
    return headers.decode("iso-8859-1")


def _read_websocket_frame(stream: socket.socket) -> tuple[int, bytes]:
    first, second = _read_exact(stream, 2)
    opcode = first & 0x0F
    masked = bool(second & 0x80)
    length = second & 0x7F
    if length == 126:
        length = int.from_bytes(_read_exact(stream, 2), "big")
    elif length == 127:
        length = int.from_bytes(_read_exact(stream, 8), "big")
    if length > 4 * 1024 * 1024:
        raise OSError("websocket frame is too large")
    mask = _read_exact(stream, 4) if masked else b""
    payload = _read_exact(stream, length)
    if mask:
        payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
    return opcode, payload


def _write_websocket_frame(stream: socket.socket, opcode: int, payload: bytes) -> None:
    mask = os.urandom(4)
    length = len(payload)
    if length < 126:
        header = bytes((0x80 | opcode, 0x80 | length))
    elif length < 65536:
        header = bytes((0x80 | opcode, 0x80 | 126)) + length.to_bytes(2, "big")
    else:
        header = bytes((0x80 | opcode, 0x80 | 127)) + length.to_bytes(8, "big")
    masked = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
    stream.sendall(header + mask + masked)


def read_text(path: str | Path) -> str:
    try:
        return Path(path).expanduser().read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def default_url() -> str:
    return os.environ.get("WMUX_URL") or read_text("~/.wmux/url") or DEFAULT_URL


def default_token(token_path: str | None) -> str:
    if os.environ.get("WMUX_TOKEN"):
        return os.environ["WMUX_TOKEN"]
    path = token_path or os.environ.get("WMUX_TOKEN_PATH") or "~/.wmux/token"
    return read_text(path)


class WmuxClient:
    def __init__(self, url: str, token: str) -> None:
        self.url = url.rstrip("/")
        self.token = token

    def request(self, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        data = None if body is None else json.dumps(body).encode("utf-8")
        headers = {"content-type": "application/json"}
        if self.token:
            headers["authorization"] = f"Bearer {self.token}"
        request = urllib.request.Request(self.url + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                raw = response.read()
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            if error.code == 401:
                raise SystemExit("wmuxctl: unauthorized; set WMUX_TOKEN or ensure ~/.wmux/token is readable") from error
            raise SystemExit(f"wmuxctl: HTTP {error.code} for {path}: {detail}") from error
        except urllib.error.URLError as error:
            raise SystemExit(f"wmuxctl: cannot reach {self.url}: {error.reason}") from error
        if not raw:
            return None
        return json.loads(raw.decode("utf-8"))

    def bootstrap(self) -> dict[str, Any]:
        return self.request("GET", "/api/bootstrap")

    def create_workspace(self, machine_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
        result = self.request("POST", "/api/workspaces", {"machineId": machine_id, "createdBy": "agent"})
        return result["workspace"], result["state"]

    def create_tab(self, workspace_id: str, machine_id: str, source_pane_id: str = "") -> tuple[dict[str, Any], dict[str, Any]]:
        body = {"machineId": machine_id}
        if source_pane_id:
            body["sourcePaneId"] = source_pane_id
        result = self.request("POST", f"/api/workspaces/{urllib.parse.quote(workspace_id)}/tabs", body)
        return result["tab"], result["state"]

    def set_workspace_title(self, workspace_id: str, title: str) -> None:
        self.request("POST", f"/api/workspaces/{urllib.parse.quote(workspace_id)}/title", {"title": title})

    def set_tab_title(self, workspace_id: str, tab_id: str, title: str) -> None:
        self.request(
            "POST",
            f"/api/workspaces/{urllib.parse.quote(workspace_id)}/tabs/{urllib.parse.quote(tab_id)}/title",
            {"title": title},
        )

    def close_tab(self, workspace_id: str, tab_id: str) -> dict[str, Any]:
        return self.request(
            "DELETE",
            f"/api/workspaces/{urllib.parse.quote(workspace_id)}/tabs/{urllib.parse.quote(tab_id)}",
        )

    def close_workspace(self, workspace_id: str) -> dict[str, Any]:
        return self.request("DELETE", f"/api/workspaces/{urllib.parse.quote(workspace_id)}")

    def record_agent_event(
        self,
        workspace_id: str,
        tab_id: str,
        pane_id: str,
        agent: str,
        status: str,
        title: str,
        summary: str,
        message: str = "",
        run_id: str = "",
    ) -> None:
        body = {
            "workspaceId": workspace_id,
            "tabId": tab_id,
            "paneId": pane_id,
            "agent": agent,
            "status": status,
            "title": title,
            "summary": summary,
        }
        if message:
            body["message"] = message
        if run_id:
            body["runId"] = run_id
        self.request(
            "POST",
            "/api/agent-events",
            body,
        )

    def delegation_status(self, run_id: str) -> dict[str, Any] | None:
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", run_id):
            raise SystemExit("wmuxctl: invalid delegation run ID")
        try:
            result = self.request("GET", f"/api/delegations/{urllib.parse.quote(run_id, safe='')}")
        except SystemExit as error:
            if "HTTP 404" in str(error):
                return None
            raise
        delegation = result.get("delegation") if isinstance(result, dict) else None
        return delegation if isinstance(delegation, dict) else None

    def send_input(self, pane_id: str, data: str, cols: int, rows: int) -> dict[str, Any]:
        return self.request(
            "POST",
            f"/api/panes/{urllib.parse.quote(pane_id)}/input",
            {"data": data, "cols": cols, "rows": rows},
        )

    def read_pane_output(self, pane_id: str, cols: int, rows: int, timeout: float = 10) -> dict[str, Any]:
        parsed = urllib.parse.urlsplit(self.url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise SystemExit(f"wmuxctl: unsupported wmux URL for websocket output: {self.url}")
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        path_prefix = parsed.path.rstrip("/")
        query = urllib.parse.urlencode({"cols": cols, "rows": rows})
        path = f"{path_prefix}/ws/panes/{urllib.parse.quote(pane_id)}/output?{query}"
        host = parsed.hostname if parsed.port is None else f"{parsed.hostname}:{port}"
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        headers = [
            f"GET {path} HTTP/1.1",
            f"Host: {host}",
            "Upgrade: websocket",
            "Connection: Upgrade",
            f"Sec-WebSocket-Key: {key}",
            "Sec-WebSocket-Version: 13",
        ]
        if self.token:
            headers.append(f"Authorization: Bearer {self.token}")
        headers.extend(["", ""])

        raw_socket = socket.create_connection((parsed.hostname, port), timeout=timeout)
        stream: socket.socket
        if parsed.scheme == "https":
            stream = ssl.create_default_context().wrap_socket(raw_socket, server_hostname=parsed.hostname)
        else:
            stream = raw_socket
        stream.settimeout(timeout)
        try:
            stream.sendall("\r\n".join(headers).encode("ascii"))
            response = _read_http_headers(stream)
            status_line, _, header_block = response.partition("\r\n")
            if " 101 " not in f" {status_line} ":
                raise SystemExit(f"wmuxctl: pane output websocket upgrade failed: {status_line}")
            accept_match = re.search(r"(?im)^sec-websocket-accept:\s*(\S+)\s*$", header_block)
            expected_accept = base64.b64encode(
                hashlib.sha1((key + WEBSOCKET_GUID).encode("ascii")).digest()
            ).decode("ascii")
            if not accept_match or accept_match.group(1) != expected_accept:
                raise SystemExit("wmuxctl: pane output websocket returned an invalid handshake")
            while True:
                opcode, payload = _read_websocket_frame(stream)
                if opcode == 0x8:
                    raise SystemExit("wmuxctl: pane output websocket closed before sending ready state")
                if opcode == 0x9:
                    _write_websocket_frame(stream, 0xA, payload)
                    continue
                if opcode != 0x1:
                    continue
                message = json.loads(payload.decode("utf-8"))
                if message.get("type") == "ready":
                    return message
        except (OSError, ValueError, json.JSONDecodeError) as error:
            raise SystemExit(f"wmuxctl: cannot read pane output: {error}") from error
        finally:
            stream.close()


def active_tab(workspace: dict[str, Any]) -> dict[str, Any]:
    active_id = workspace.get("activeTabId")
    for tab in workspace.get("tabs", []):
        if tab.get("id") == active_id:
            return tab
    tabs = workspace.get("tabs", [])
    if tabs:
        return tabs[0]
    raise SystemExit("wmuxctl: created workspace has no tabs")


def active_pane(tab: dict[str, Any]) -> dict[str, Any]:
    active_id = tab.get("activePaneId")
    for pane in tab.get("panes", []):
        if pane.get("id") == active_id:
            return pane
    panes = tab.get("panes", [])
    if panes:
        return panes[0]
    raise SystemExit("wmuxctl: active tab has no panes")


def select_tab(workspace: dict[str, Any], tab_id: str = "") -> dict[str, Any]:
    if not tab_id:
        return active_tab(workspace)
    for tab in workspace.get("tabs", []):
        if tab.get("id") == tab_id:
            return tab
    raise SystemExit(f"wmuxctl: tab not found in workspace {workspace.get('id')}: {tab_id}")


def select_pane(
    workspace: dict[str, Any], tab: dict[str, Any], pane_id: str = "", explicit_tab_id: str = ""
) -> tuple[dict[str, Any], dict[str, Any]]:
    if not pane_id:
        return tab, active_pane(tab)
    for candidate_tab in workspace.get("tabs", []):
        for pane in candidate_tab.get("panes", []):
            if pane.get("id") != pane_id:
                continue
            if explicit_tab_id and explicit_tab_id != candidate_tab.get("id"):
                raise SystemExit(f"wmuxctl: pane {pane_id} does not belong to tab {explicit_tab_id}")
            return candidate_tab, pane
    raise SystemExit(f"wmuxctl: pane not found in workspace {workspace.get('id')}: {pane_id}")


def target_tab_and_pane(
    workspace: dict[str, Any],
    tab_id: str = "",
    pane_id: str = "",
    require_explicit_multi_tab: bool = False,
) -> tuple[dict[str, Any], dict[str, Any]]:
    tabs = workspace.get("tabs", [])
    if require_explicit_multi_tab and len(tabs) > 1 and not tab_id and not pane_id:
        choices = ", ".join(f"{tab.get('id')} ({tab.get('title') or 'untitled'})" for tab in tabs)
        raise SystemExit(
            "wmuxctl: reused workspace has multiple tabs; choose --tab or --pane explicitly. "
            f"Available tabs: {choices}"
        )
    tab = select_tab(workspace, tab_id)
    return select_pane(workspace, tab, pane_id, tab_id)


def workspace_url(base_url: str, workspace_id: str, tab_id: str) -> str:
    return f"{base_url.rstrip('/')}/workspaces/{urllib.parse.quote(workspace_id)}/tabs/{urllib.parse.quote(tab_id)}"


def print_json(value: Any) -> None:
    print(json.dumps(value, indent=2, sort_keys=True))


def cmd_machines(client: WmuxClient, args: argparse.Namespace) -> int:
    payload = client.bootstrap()
    if args.json:
        print_json(payload["machines"])
        return 0
    for machine in payload["machines"]:
        reachable = "up" if machine.get("reachable") else "down"
        detail = machine.get("backendDetail") or machine.get("reason") or ""
        endpoint = machine.get("endpoint") or ""
        print(f"{machine['id']}\t{machine['kind']}\t{reachable}\t{endpoint}\t{detail}")
    return 0


def cmd_bootstrap(client: WmuxClient, _args: argparse.Namespace) -> int:
    print_json(client.bootstrap())
    return 0


def describe_workspace(
    base_url: str,
    workspace: dict[str, Any],
    tab_id: str = "",
    pane_id: str = "",
    require_explicit_multi_tab: bool = False,
) -> dict[str, Any]:
    tab, pane = target_tab_and_pane(workspace, tab_id, pane_id, require_explicit_multi_tab)
    return {
        "workspaceId": workspace["id"],
        "tabId": tab["id"],
        "paneId": pane["id"],
        "machineId": workspace["machineId"],
        "url": workspace_url(base_url, workspace["id"], tab["id"]),
    }


ANSI_ESCAPE = re.compile(
    r"\x1b(?:"
    r"\][^\x07]*(?:\x07|\x1b\\)"
    r"|\[[0-?]*[ -/]*[@-~]"
    r"|[ -/]*[0-~]"
    r")"
)


def clean_terminal_text(value: str) -> str:
    value = ANSI_ESCAPE.sub("", value).replace("\r\n", "\n").replace("\r", "\n")
    output: list[str] = []
    for character in value:
        if character == "\b":
            if output and output[-1] != "\n":
                output.pop()
            continue
        if character == "\n" or character == "\t" or ord(character) >= 32:
            output.append(character)
    return "".join(output)


def wait_for_output(
    client: WmuxClient,
    pane_id: str,
    pattern: str,
    timeout: float,
    cols: int,
    rows: int,
    raw: bool = False,
) -> tuple[re.Match[str], str, float]:
    try:
        compiled = re.compile(pattern, re.MULTILINE)
    except re.error as error:
        raise SystemExit(f"wmuxctl: invalid wait pattern: {error}") from error
    started = time.monotonic()
    while True:
        replay = str(client.read_pane_output(pane_id, cols, rows, timeout=min(10, max(timeout, 1))).get("replay") or "")
        candidate = replay if raw else clean_terminal_text(replay)
        match = compiled.search(candidate)
        if match:
            return match, candidate, time.monotonic() - started
        elapsed = time.monotonic() - started
        if elapsed >= timeout:
            raise SystemExit(f"wmuxctl: timed out after {timeout:g}s waiting for {pattern!r} in pane {pane_id}")
        time.sleep(min(0.5, timeout - elapsed))


def wait_for_shell_ready(
    client: WmuxClient,
    pane_id: str,
    machine_id: str,
    timeout: float,
    cols: int,
    rows: int,
) -> float:
    payload = client.bootstrap()
    machine = next((candidate for candidate in payload.get("machines", []) if candidate.get("id") == machine_id), {})
    kind = machine.get("kind")
    pattern = r"(?m)^PS [^\n>]*>\s*$" if kind in {"powershell", "powershell-ssh"} else r"(?m)^.*(?:[$#%❯])\s*$"
    _match, _output, elapsed = wait_for_output(client, pane_id, pattern, timeout, cols, rows)
    return elapsed


def workspace_title(workspace: dict[str, Any]) -> str:
    for key in ("manualTitle", "title", "autoTitle", "name"):
        value = workspace.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def find_workspace(client: WmuxClient, machine_id: str, title: str) -> dict[str, Any] | None:
    if not title:
        return None
    payload = client.bootstrap()
    matches = [
        workspace
        for workspace in payload.get("workspaces", [])
        if workspace.get("machineId") == machine_id and workspace_title(workspace) == title
    ]
    if not matches:
        return None
    return sorted(matches, key=lambda workspace: workspace.get("updatedAt") or workspace.get("createdAt") or "")[-1]


def get_or_create_workspace(client: WmuxClient, machine_id: str, title: str, force_new: bool) -> tuple[dict[str, Any], bool]:
    if not force_new:
        workspace = find_workspace(client, machine_id, title)
        if workspace:
            return workspace, True
    workspace, _state = client.create_workspace(machine_id)
    if title:
        client.set_workspace_title(workspace["id"], title)
        workspace["manualTitle"] = title
        workspace["name"] = title
    return workspace, False


def resolve_workspace(client: WmuxClient, args: argparse.Namespace) -> dict[str, Any]:
    if args.workspace:
        payload = client.bootstrap()
        for workspace in payload.get("workspaces", []):
            if workspace.get("id") == args.workspace:
                return workspace
        raise SystemExit(f"wmuxctl: workspace not found: {args.workspace}")
    if args.machine and args.title:
        workspace = find_workspace(client, args.machine, args.title)
        if workspace:
            return workspace
        raise SystemExit(f"wmuxctl: no workspace titled {args.title!r} on {args.machine}")
    raise SystemExit("wmuxctl: provide --workspace or both --machine and --title")


def maybe_record_running_event(client: WmuxClient, args: argparse.Namespace, info: dict[str, Any], summary: str) -> None:
    if not getattr(args, "agent_event", False) or getattr(args, "no_event", False):
        return
    client.record_agent_event(
        info["workspaceId"],
        info["tabId"],
        info["paneId"],
        args.agent,
        "running",
        args.title or "wmux task",
        args.summary or summary,
    )


def cmd_open(client: WmuxClient, args: argparse.Namespace) -> int:
    workspace, reused = get_or_create_workspace(client, args.machine, args.title, args.new)
    info = describe_workspace(client.url, workspace, args.tab, args.pane)
    info["reused"] = reused
    info["activeTabId"] = workspace.get("activeTabId")
    info["tabs"] = [
        {
            "id": tab.get("id"),
            "title": tab.get("title"),
            "activePaneId": tab.get("activePaneId"),
            "url": workspace_url(client.url, workspace["id"], tab["id"]),
        }
        for tab in workspace.get("tabs", [])
    ]
    print_json(info)
    return 0


def cmd_tabs(client: WmuxClient, args: argparse.Namespace) -> int:
    workspace = resolve_workspace(client, args)
    print_json(
        {
            "workspaceId": workspace["id"],
            "activeTabId": workspace.get("activeTabId"),
            "tabs": [
                {
                    "id": tab.get("id"),
                    "title": tab.get("title"),
                    "active": tab.get("id") == workspace.get("activeTabId"),
                    "activePaneId": tab.get("activePaneId"),
                    "panes": [pane.get("id") for pane in tab.get("panes", [])],
                    "url": workspace_url(client.url, workspace["id"], tab["id"]),
                }
                for tab in workspace.get("tabs", [])
            ],
        }
    )
    return 0


def cmd_tab_open(client: WmuxClient, args: argparse.Namespace) -> int:
    workspace = resolve_workspace(client, args)
    tab, _state = client.create_tab(workspace["id"], args.target_machine, args.source_pane)
    if args.tab_title:
        client.set_tab_title(workspace["id"], tab["id"], args.tab_title)
        tab["title"] = args.tab_title
    pane = active_pane(tab)
    print_json(
        {
            "workspaceId": workspace["id"],
            "tabId": tab["id"],
            "paneId": pane["id"],
            "machineId": pane["machineId"],
            "title": tab.get("title"),
            "url": workspace_url(client.url, workspace["id"], tab["id"]),
        }
    )
    return 0


def cmd_tab_title(client: WmuxClient, args: argparse.Namespace) -> int:
    workspace = resolve_workspace(client, args)
    select_tab(workspace, args.tab)
    client.set_tab_title(workspace["id"], args.tab, args.tab_title)
    print_json(
        {
            "workspaceId": workspace["id"],
            "tabId": args.tab,
            "title": args.tab_title,
            "url": workspace_url(client.url, workspace["id"], args.tab),
        }
    )
    return 0


def cmd_tab_close(client: WmuxClient, args: argparse.Namespace) -> int:
    workspace = resolve_workspace(client, args)
    select_tab(workspace, args.tab)
    result = client.close_tab(workspace["id"], args.tab)
    print_json({"workspaceId": workspace["id"], "tabId": args.tab, "closed": bool(result.get("removed"))})
    return 0


def append_wait_result(client: WmuxClient, args: argparse.Namespace, info: dict[str, Any], pattern: str) -> None:
    match, _output, elapsed = wait_for_output(
        client,
        info["paneId"],
        pattern,
        args.timeout,
        args.cols,
        args.rows,
        getattr(args, "raw_wait", False),
    )
    info["matched"] = match.group(0)
    info["elapsedSeconds"] = round(elapsed, 3)


def submit_line(client: WmuxClient, pane_id: str, line: str, enter: bool, cols: int, rows: int) -> int:
    text = line[:-1] if enter and line.endswith("\r") else line
    if text:
        client.send_input(pane_id, text, cols, rows)
    if enter:
        # Interactive line editors can process a pasted line asynchronously. A
        # separate Enter request gives PSReadLine time to accept the final bytes.
        time.sleep(0.1)
        client.send_input(pane_id, "\r", cols, rows)
    return len(text.encode("utf-8")) + (1 if enter else 0)


def cmd_send(client: WmuxClient, args: argparse.Namespace) -> int:
    sent_bytes = submit_line(client, args.pane, args.line, args.enter, args.cols, args.rows)
    info = {"paneId": args.pane, "sentBytes": sent_bytes}
    if args.wait_for:
        append_wait_result(client, args, info, args.wait_for)
    print_json(info)
    return 0


def cmd_run(client: WmuxClient, args: argparse.Namespace) -> int:
    workspace, reused = get_or_create_workspace(client, args.machine, args.title, args.new)
    info = describe_workspace(client.url, workspace, args.tab, args.pane, require_explicit_multi_tab=reused)
    if not reused and not args.no_wait_ready:
        info["shellReadySeconds"] = round(
            wait_for_shell_ready(client, info["paneId"], info["machineId"], args.ready_timeout, args.cols, args.rows), 3
        )
    sent_bytes = len(args.line.encode("utf-8")) + (1 if args.enter and not args.line.endswith("\r") else 0)
    maybe_record_running_event(client, args, info, f"sent {sent_bytes} bytes")
    sent_bytes = submit_line(client, info["paneId"], args.line, args.enter, args.cols, args.rows)
    info["reused"] = reused
    info["sentBytes"] = sent_bytes
    if args.wait_for:
        append_wait_result(client, args, info, args.wait_for)
    print_json(info)
    return 0


def read_delegate_prompt(args: argparse.Namespace) -> str:
    if args.prompt_file and args.prompt_file != "-":
        try:
            prompt = Path(args.prompt_file).read_text(encoding="utf-8")
        except OSError as error:
            raise SystemExit(f"wmuxctl: cannot read delegation prompt: {error}") from error
    elif not sys.stdin.isatty():
        prompt = sys.stdin.read()
    else:
        raise SystemExit("wmuxctl: provide --prompt-file or pipe the delegation prompt on stdin")
    if not prompt or len(prompt.encode("utf-8")) > 128 * 1024:
        raise SystemExit("wmuxctl: delegation prompt must be 1..131072 UTF-8 bytes")
    return prompt


def decode_agent_result(output: str, run_id: str) -> tuple[dict[str, Any], int]:
    payload: dict[str, Any] | None = None
    exit_code: int | None = None
    for line in clean_terminal_text(output).splitlines():
        if line.startswith("WMUX_AGENT_RESULT "):
            encoded = line.removeprefix("WMUX_AGENT_RESULT ")
            try:
                candidate = json.loads(base64.b64decode(encoded, validate=True).decode("utf-8"))
            except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
                continue
            if (
                isinstance(candidate, dict)
                and candidate.get("runId") == run_id
                and isinstance(candidate.get("ok"), bool)
            ):
                payload = candidate
            continue
        match = re.fullmatch(r"WMUX_AGENT_DONE ([A-Za-z0-9._-]+) (-?\d+)", line)
        if match and match.group(1) == run_id:
            exit_code = int(match.group(2))
    if payload is None or exit_code is None:
        raise SystemExit("wmuxctl: delegated result was incomplete")
    return payload, exit_code


def redact_delegate_text(value: Any, secrets: list[str], limit: int = 64_000) -> str:
    text = value if isinstance(value, str) else ""
    for secret in secrets:
        if secret:
            text = text.replace(secret, "[redacted]")
    encoded = text.encode("utf-8")
    if len(encoded) > limit:
        text = encoded[:limit].decode("utf-8", errors="ignore")
    return text.strip()


def cmd_delegate(client: WmuxClient, args: argparse.Namespace) -> int:
    prompt = read_delegate_prompt(args)
    if not posixpath.isabs(args.directory) or "\x00" in args.directory:
        raise SystemExit("wmuxctl: delegation directory must be an absolute POSIX path")
    if args.runtime == "opencode" and not args.write_access:
        raise SystemExit("wmuxctl: OpenCode delegation cannot enforce read-only mode; add --write-access explicitly")
    bootstrap = client.bootstrap()
    machine = next((item for item in bootstrap.get("machines", []) if item.get("id") == args.machine), None)
    if not machine or machine.get("reachable") is not True:
        raise SystemExit(f"wmuxctl: machine is not reachable: {args.machine}")
    if machine.get("kind") not in {"local", "ssh"} or machine.get("platform") not in {"linux", "mac"}:
        raise SystemExit("wmuxctl: delegated agent runs require a POSIX local or SSH target")

    title = args.title or f"{args.runtime.capitalize()} delegation"
    workspace, _state = client.create_workspace(args.machine)
    info = describe_workspace(client.url, workspace)
    run_id = str(uuid.uuid4())
    secrets = [prompt, client.token]
    try:
        client.set_workspace_title(workspace["id"], title)
        client.record_agent_event(
            info["workspaceId"], info["tabId"], info["paneId"], args.runtime, "running", title,
            f"{args.runtime.capitalize()} delegation running",
            run_id=run_id,
        )
        info["shellReadySeconds"] = round(
            wait_for_shell_ready(client, info["paneId"], info["machineId"], args.ready_timeout, args.cols, args.rows), 3
        )
        submit_line(client, info["paneId"], "wmux-agent-run", True, args.cols, args.rows)
        wait_for_output(client, info["paneId"], r"(?m)^WMUX_AGENT_READY$", args.ready_timeout, args.cols, args.rows)
        request = {
            "runId": run_id,
            "runtime": args.runtime,
            "prompt": prompt,
            "directory": args.directory,
            "unattended": args.unattended,
            "writeAccess": args.write_access,
            "title": title,
        }
        if args.model:
            request["model"] = args.model
        if args.runtime == "opencode" and args.opencode_agent:
            request["agent"] = args.opencode_agent
        encoded = base64.b64encode(json.dumps(request, separators=(",", ":")).encode()).decode()
        submit_line(client, info["paneId"], encoded, True, args.cols, args.rows)
        recovered = False
        wait_started = time.monotonic()
        try:
            _match, output, elapsed = wait_for_output(
                client,
                info["paneId"],
                rf"(?m)^WMUX_AGENT_DONE {re.escape(run_id)} -?\d+$",
                args.timeout,
                args.cols,
                args.rows,
            )
            payload, exit_code = decode_agent_result(output, run_id)
            ok = exit_code == 0 and payload.get("ok") is True
            detail_source = payload.get("result") if ok else payload.get("error") or payload.get("result")
        except SystemExit as replay_error:
            durable = None
            durable_state = None
            reconcile_deadline = time.monotonic() + 5
            while time.monotonic() < reconcile_deadline:
                try:
                    durable = client.delegation_status(run_id)
                except SystemExit:
                    raise replay_error
                durable_state = durable.get("state") if durable else None
                if durable_state in {"completed", "failed", "error", "cancelled", "stopped", "timed_out"}:
                    break
                time.sleep(0.25)
            if durable_state not in {"completed", "failed", "error", "cancelled", "stopped", "timed_out"}:
                raise replay_error
            recovered = True
            elapsed = time.monotonic() - wait_started
            ok = durable_state == "completed"
            exit_code = 0 if ok else 1
            detail_source = durable.get("result") if ok else durable.get("error") or durable.get("summary")
        detail = redact_delegate_text(detail_source, secrets)
        if not detail:
            detail = "Delegated task completed without text output." if ok else f"Delegated task failed with exit code {exit_code}."
        status = "completed" if ok else "failed"
        if not recovered:
            client.record_agent_event(
                info["workspaceId"], info["tabId"], info["paneId"], args.runtime, status, title,
                f"{args.runtime.capitalize()} delegation {status}", message=detail, run_id=run_id,
            )
        info.update({
            "runId": run_id,
            "runtime": args.runtime,
            "state": status,
            "elapsedSeconds": round(elapsed, 3),
            "result": detail if ok else "",
            "error": "" if ok else detail,
            "closed": False,
        })
        if ok and args.close_on_success:
            try:
                info["closed"] = bool(client.close_workspace(info["workspaceId"]).get("removed"))
            except SystemExit as error:
                info["closeWarning"] = str(error)
        print_json(info)
        return 0 if ok else 1
    except KeyboardInterrupt:
        try:
            client.send_input(info["paneId"], "\x03", args.cols, args.rows)
            client.record_agent_event(
                info["workspaceId"], info["tabId"], info["paneId"], args.runtime, "stopped", title,
                f"{args.runtime.capitalize()} delegation stopped",
                run_id=run_id,
            )
        except SystemExit:
            pass
        info.update({"runId": run_id, "runtime": args.runtime, "state": "stopped", "closed": False})
        print_json(info)
        return 130
    except SystemExit as error:
        try:
            client.send_input(info["paneId"], "\x03", args.cols, args.rows)
        except SystemExit:
            pass
        detail = redact_delegate_text(str(error), secrets)
        try:
            client.record_agent_event(
                info["workspaceId"], info["tabId"], info["paneId"], args.runtime, "failed", title,
                f"{args.runtime.capitalize()} delegation failed", message=detail, run_id=run_id,
            )
        except SystemExit:
            pass
        info.update({"runId": run_id, "runtime": args.runtime, "state": "failed", "error": detail, "closed": False})
        print_json(info)
        return 1


def cmd_output(client: WmuxClient, args: argparse.Namespace) -> int:
    ready = client.read_pane_output(args.pane, args.cols, args.rows, args.timeout)
    replay = str(ready.get("replay") or "")
    output = replay if args.raw else clean_terminal_text(replay)
    if args.tail_chars > 0:
        output = output[-args.tail_chars :]
    sys.stdout.write(output)
    if output and not output.endswith("\n"):
        sys.stdout.write("\n")
    return 0


def cmd_wait(client: WmuxClient, args: argparse.Namespace) -> int:
    match, output, elapsed = wait_for_output(
        client, args.pane, args.pattern, args.timeout, args.cols, args.rows, args.raw
    )
    result: dict[str, Any] = {
        "paneId": args.pane,
        "matched": match.group(0),
        "elapsedSeconds": round(elapsed, 3),
    }
    if args.show_output:
        result["output"] = output[-args.tail_chars :] if args.tail_chars > 0 else output
    print_json(result)
    return 0


def cmd_finish(client: WmuxClient, args: argparse.Namespace) -> int:
    workspace = resolve_workspace(client, args)
    info = describe_workspace(client.url, workspace, args.tab, args.pane)
    client.record_agent_event(
        info["workspaceId"],
        info["tabId"],
        info["paneId"],
        args.agent,
        args.status,
        args.title or workspace_title(workspace) or "wmux task",
        args.summary,
    )
    info["status"] = args.status
    if args.close:
        result = client.close_workspace(info["workspaceId"])
        info["closed"] = bool(result.get("removed"))
    else:
        info["closed"] = False
    print_json(info)
    return 0


def read_script_arg(args: argparse.Namespace) -> str:
    if args.file:
        return read_text(args.file)
    if args.script:
        return args.script
    if not sys.stdin.isatty():
        return sys.stdin.read()
    raise SystemExit("wmuxctl: provide --script, --file, or stdin")


def powershell_encoded_command(script: str, sentinel: str) -> str:
    prelude = "$ErrorActionPreference='Continue'; $ProgressPreference='SilentlyContinue';\n"
    trailer = f"\nWrite-Output '{sentinel}';\n" if sentinel else ""
    return base64.b64encode((prelude + script + trailer).encode("utf-16le")).decode("ascii")


def cmd_ps(client: WmuxClient, args: argparse.Namespace) -> int:
    workspace, reused = get_or_create_workspace(client, args.machine, args.title, args.new)
    info = describe_workspace(client.url, workspace, args.tab, args.pane, require_explicit_multi_tab=reused)
    if not reused and not args.no_wait_ready:
        info["shellReadySeconds"] = round(
            wait_for_shell_ready(client, info["paneId"], info["machineId"], args.ready_timeout, args.cols, args.rows), 3
        )
    script = read_script_arg(args)
    sentinel = "" if args.no_sentinel else f"__WMUX_DONE_{info['paneId']}_{os.getpid()}__"
    encoded = powershell_encoded_command(script, sentinel)
    line = f"pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -EncodedCommand {encoded}"
    if len(line.encode("utf-8")) > 240_000:
        raise SystemExit("wmuxctl: encoded PowerShell command is too large for one pane input")
    maybe_record_running_event(client, args, info, f"PowerShell script sent; sentinel {sentinel}" if sentinel else "PowerShell script sent")
    sent_bytes = submit_line(client, info["paneId"], line, True, args.cols, args.rows)
    info["reused"] = reused
    info["sentBytes"] = sent_bytes
    if sentinel:
        info["sentinel"] = sentinel
    if args.wait:
        if not sentinel:
            raise SystemExit("wmuxctl: --wait requires the completion sentinel; omit --no-sentinel")
        append_wait_result(client, args, info, re.escape(sentinel))
    print_json(info)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Interact with a wmux API.")
    parser.add_argument("--url", default=default_url(), help=f"wmux base URL (default: {DEFAULT_URL})")
    parser.add_argument("--token-path", default=None, help="token file path when WMUX_TOKEN is unset")

    subparsers = parser.add_subparsers(dest="command", required=True)

    machines = subparsers.add_parser("machines", help="list configured machine reachability")
    machines.add_argument("--json", action="store_true", help="emit raw machine JSON")
    machines.set_defaults(func=cmd_machines)

    bootstrap = subparsers.add_parser("bootstrap", help="emit full bootstrap JSON")
    bootstrap.set_defaults(func=cmd_bootstrap)

    open_workspace = subparsers.add_parser("open", help="create or reuse a titled workspace on a machine")
    open_workspace.add_argument("machine", help="machine id, for example linux-box or windows-box")
    open_workspace.add_argument("--title", default="", help="manual workspace title")
    open_workspace.add_argument("--new", action="store_true", help="force a new workspace even when --title already exists")
    open_workspace.add_argument("--tab", default="", help="select a specific existing tab")
    open_workspace.add_argument("--pane", default="", help="select a specific existing pane")
    open_workspace.set_defaults(func=cmd_open)

    tabs = subparsers.add_parser("tabs", help="list tabs and direct URLs for a workspace")
    tabs.add_argument("--workspace", default="", help="workspace id")
    tabs.add_argument("--machine", default="", help="machine id for --title lookup")
    tabs.add_argument("--title", default="", help="workspace title for --machine lookup")
    tabs.set_defaults(func=cmd_tabs)

    tab_open = subparsers.add_parser("tab-open", help="create and name a tab in an existing workspace")
    tab_open.add_argument("--workspace", default="", help="workspace id")
    tab_open.add_argument("--machine", default="", help="workspace machine id for --title lookup")
    tab_open.add_argument("--title", default="", help="workspace title for --machine lookup")
    tab_open.add_argument("--target-machine", required=True, help="machine id for the new tab")
    tab_open.add_argument("--tab-title", default="", help="manual title for the new tab")
    tab_open.add_argument("--source-pane", default="", help="pane whose cwd should seed the new tab")
    tab_open.set_defaults(func=cmd_tab_open)

    tab_title = subparsers.add_parser("tab-title", help="set a manual tab title")
    tab_title.add_argument("--workspace", default="", help="workspace id")
    tab_title.add_argument("--machine", default="", help="workspace machine id for --title lookup")
    tab_title.add_argument("--title", default="", help="workspace title for --machine lookup")
    tab_title.add_argument("--tab", required=True, help="tab id")
    tab_title.add_argument("--tab-title", required=True, help="new manual tab title")
    tab_title.set_defaults(func=cmd_tab_title)

    tab_close = subparsers.add_parser("tab-close", help="close a tab and kill its pane sessions")
    tab_close.add_argument("--workspace", default="", help="workspace id")
    tab_close.add_argument("--machine", default="", help="workspace machine id for --title lookup")
    tab_close.add_argument("--title", default="", help="workspace title for --machine lookup")
    tab_close.add_argument("--tab", required=True, help="tab id")
    tab_close.set_defaults(func=cmd_tab_close)

    send = subparsers.add_parser("send", help="send one terminal input line to an existing pane")
    send.add_argument("pane", help="pane id")
    send.add_argument("--line", required=True, help="text to send exactly, before optional Enter")
    send.add_argument("--no-enter", dest="enter", action="store_false", help="do not append Enter")
    send.add_argument("--wait-for", default="", help="wait until this regular expression appears in pane output")
    send.add_argument("--timeout", type=float, default=30, help="wait timeout in seconds")
    send.add_argument("--raw-wait", action="store_true", help="match --wait-for against raw terminal output")
    send.add_argument("--cols", type=int, default=120)
    send.add_argument("--rows", type=int, default=36)
    send.set_defaults(func=cmd_send, enter=True)

    run = subparsers.add_parser("run", help="create or reuse a titled workspace and send one terminal input line")
    run.add_argument("machine", help="machine id")
    run.add_argument("--line", required=True, help="text to send exactly, before optional Enter")
    run.add_argument("--title", default="", help="manual workspace title")
    run.add_argument("--new", action="store_true", help="force a new workspace even when --title already exists")
    run.add_argument("--tab", default="", help="target tab when reusing a multi-tab workspace")
    run.add_argument("--pane", default="", help="target pane when reusing a multi-tab workspace")
    run.add_argument("--agent", default="codex", help="agent name for the running event")
    run.add_argument("--summary", default="", help="running event summary")
    run.add_argument("--agent-event", action="store_true", help="record a running agent event; call finish later")
    run.add_argument("--no-event", action="store_true", help="deprecated no-op; running agent events are opt-in")
    run.add_argument("--no-enter", dest="enter", action="store_false", help="do not append Enter")
    run.add_argument("--wait-for", default="", help="wait until this regular expression appears in pane output")
    run.add_argument("--timeout", type=float, default=30, help="wait timeout in seconds")
    run.add_argument("--raw-wait", action="store_true", help="match --wait-for against raw terminal output")
    run.add_argument("--ready-timeout", type=float, default=30, help="new-pane shell readiness timeout in seconds")
    run.add_argument("--no-wait-ready", action="store_true", help="send immediately without waiting for a new shell prompt")
    run.add_argument("--cols", type=int, default=120)
    run.add_argument("--rows", type=int, default=36)
    run.set_defaults(func=cmd_run, enter=True)

    delegate = subparsers.add_parser("delegate", help="run a visible one-shot OpenCode, Codex, or Claude task")
    delegate.add_argument("runtime", choices=("opencode", "codex", "claude"), help="agent CLI to run in the target pane")
    delegate.add_argument("machine", help="reachable POSIX machine id")
    delegate.add_argument("--directory", required=True, help="absolute target working directory")
    delegate.add_argument("--prompt-file", default="", help="UTF-8 prompt file; use - or omit with piped stdin")
    delegate.add_argument("--title", default="", help="workspace and lifecycle title")
    delegate.add_argument("--model", default="", help="optional runtime-specific model")
    delegate.add_argument("--opencode-agent", default="", help="optional OpenCode agent name")
    delegate.add_argument("--write-access", action="store_true", help="allow repository edits; otherwise use read-only/plan mode")
    delegate.add_argument("--unattended", action="store_true", help="disable agent approval prompts; dangerous on trusted targets only")
    delegate.add_argument("--close-on-success", action="store_true", help="close the workspace only after success")
    delegate.add_argument("--timeout", type=float, default=900, help="delegated task timeout in seconds")
    delegate.add_argument("--ready-timeout", type=float, default=30, help="shell/helper readiness timeout in seconds")
    delegate.add_argument("--cols", type=int, default=120)
    delegate.add_argument("--rows", type=int, default=36)
    delegate.set_defaults(func=cmd_delegate)

    output = subparsers.add_parser("output", help="print the bounded replay buffer for a pane")
    output.add_argument("pane", help="pane id")
    output.add_argument("--raw", action="store_true", help="preserve terminal escape sequences")
    output.add_argument("--tail-chars", type=int, default=12000, help="print only the last N characters; 0 prints all")
    output.add_argument("--timeout", type=float, default=10, help="websocket timeout in seconds")
    output.add_argument("--cols", type=int, default=120)
    output.add_argument("--rows", type=int, default=36)
    output.set_defaults(func=cmd_output)

    wait = subparsers.add_parser("wait", help="wait for a regular expression in pane replay output")
    wait.add_argument("pane", help="pane id")
    wait.add_argument("--pattern", required=True, help="regular expression to wait for")
    wait.add_argument("--timeout", type=float, default=30, help="wait timeout in seconds")
    wait.add_argument("--raw", action="store_true", help="match against raw terminal output")
    wait.add_argument("--show-output", action="store_true", help="include recent pane output in the JSON result")
    wait.add_argument("--tail-chars", type=int, default=12000, help="output characters included with --show-output")
    wait.add_argument("--cols", type=int, default=120)
    wait.add_argument("--rows", type=int, default=36)
    wait.set_defaults(func=cmd_wait)

    ps = subparsers.add_parser("ps", help="send a PowerShell script through a child pwsh -EncodedCommand")
    ps.add_argument("machine", help="Windows machine id, for example windows-box")
    ps.add_argument("--script", default="", help="PowerShell script text")
    ps.add_argument("--file", default="", help="read PowerShell script from this file")
    ps.add_argument("--title", required=True, help="manual workspace title; reused by default")
    ps.add_argument("--new", action="store_true", help="force a new workspace even when --title already exists")
    ps.add_argument("--tab", default="", help="target tab when reusing a multi-tab workspace")
    ps.add_argument("--pane", default="", help="target pane when reusing a multi-tab workspace")
    ps.add_argument("--agent", default="codex", help="agent name for the running event")
    ps.add_argument("--summary", default="", help="running event summary")
    ps.add_argument("--agent-event", action="store_true", help="record a running agent event; call finish later")
    ps.add_argument("--no-event", action="store_true", help="deprecated no-op; running agent events are opt-in")
    ps.add_argument("--no-sentinel", action="store_true", help="do not append a completion marker")
    ps.add_argument("--wait", action="store_true", help="wait for the generated completion sentinel")
    ps.add_argument("--timeout", type=float, default=120, help="sentinel wait timeout in seconds")
    ps.add_argument("--raw-wait", action="store_true", help="match the sentinel against raw terminal output")
    ps.add_argument("--ready-timeout", type=float, default=30, help="new-pane shell readiness timeout in seconds")
    ps.add_argument("--no-wait-ready", action="store_true", help="send immediately without waiting for a new shell prompt")
    ps.add_argument("--cols", type=int, default=120)
    ps.add_argument("--rows", type=int, default=36)
    ps.set_defaults(func=cmd_ps)

    finish = subparsers.add_parser("finish", help="record final task status and optionally close the workspace")
    finish.add_argument("--workspace", default="", help="workspace id to finish")
    finish.add_argument("--machine", default="", help="machine id for --title lookup")
    finish.add_argument("--title", default="", help="task/workspace title")
    finish.add_argument("--tab", default="", help="override tab id for the final event")
    finish.add_argument("--pane", default="", help="override pane id for the final event")
    finish.add_argument("--agent", default="codex", help="agent name for the final event")
    finish.add_argument("--status", choices=("completed", "failed", "stopped"), required=True)
    finish.add_argument("--summary", required=True, help="final event summary")
    finish.add_argument("--close", action="store_true", help="close the workspace after recording the event")
    finish.set_defaults(func=cmd_finish)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    client = WmuxClient(args.url, default_token(args.token_path))
    return args.func(client, args)


if __name__ == "__main__":
    sys.exit(main())
