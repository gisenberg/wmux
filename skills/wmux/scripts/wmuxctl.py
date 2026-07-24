#!/usr/bin/env python3
"""Small wmux API helper for Codex skills."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import math
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
DURABLE_REFRESH_QUIET_SECONDS = 0.08
DURABLE_REFRESH_FALLBACK_SECONDS = 0.7
MAX_PANE_REPLAY_BYTES = 2 * 1024 * 1024
MIN_DELEGATION_WAIT_TIMEOUT_SECONDS = 0.1
MAX_DELEGATION_WAIT_TIMEOUT_SECONDS = 14_400
DEFAULT_DELEGATION_WAIT_TIMEOUT_SECONDS = {
    "review": 1_800.0,
    "change": 7_200.0,
    "deploy": 7_200.0,
}
TERMINAL_DELEGATION_STATES = frozenset(
    {"completed", "blocked", "failed", "error", "cancelled", "stopped", "timed_out", "interrupted"}
)
CODEX_READY_PATTERN = r"(?s)OpenAI Codex.*?›(?:\s|$)"
# Bracketed paste is an input protocol, not an escaping boundary. Preserve TAB
# and LF, normalize CRLF below, and reject bare CR plus every other C0/C1/DEL.
UNSAFE_TUI_PROMPT_CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]")


class DelegationObservationError(RuntimeError):
    """The controller could not determine an agent's terminal outcome."""


def resolve_delegation_wait_timeout(
    bootstrap: dict[str, Any],
    mode: str,
    override: float | None,
) -> float:
    if mode not in DEFAULT_DELEGATION_WAIT_TIMEOUT_SECONDS:
        raise SystemExit("wmuxctl: delegation mode must be review, change, or deploy")
    if override is not None:
        if (
            not math.isfinite(override)
            or override < MIN_DELEGATION_WAIT_TIMEOUT_SECONDS
            or override > MAX_DELEGATION_WAIT_TIMEOUT_SECONDS
        ):
            raise SystemExit(
                "wmuxctl: --timeout must be between "
                f"{MIN_DELEGATION_WAIT_TIMEOUT_SECONDS:g} and {MAX_DELEGATION_WAIT_TIMEOUT_SECONDS:g} seconds"
            )
        return override
    configured = (
        bootstrap.get("delegation", {})
        .get("waitTimeoutSeconds", {})
        .get(mode)
    )
    if (
        isinstance(configured, (int, float))
        and not isinstance(configured, bool)
        and math.isfinite(configured)
        and MIN_DELEGATION_WAIT_TIMEOUT_SECONDS <= configured <= MAX_DELEGATION_WAIT_TIMEOUT_SECONDS
    ):
        return float(configured)
    return DEFAULT_DELEGATION_WAIT_TIMEOUT_SECONDS[mode]


def _append_bounded_utf8(buffer: bytearray, value: str) -> None:
    encoded = value.encode("utf-8", errors="replace")
    if not encoded:
        return
    if len(encoded) >= MAX_PANE_REPLAY_BYTES:
        buffer[:] = encoded[-MAX_PANE_REPLAY_BYTES:]
    else:
        buffer.extend(encoded)
        overflow = len(buffer) - MAX_PANE_REPLAY_BYTES
        if overflow > 0:
            del buffer[:overflow]
    while buffer and buffer[0] & 0xC0 == 0x80:
        del buffer[0]


def _read_exact(stream: socket.socket, size: int, deadline: float | None = None) -> bytes:
    chunks: list[bytes] = []
    remaining = size
    while remaining:
        if deadline is not None:
            timeout = deadline - time.monotonic()
            if timeout <= 0:
                raise TimeoutError("read deadline exceeded")
            stream.settimeout(timeout)
        chunk = stream.recv(remaining)
        if not chunk:
            raise OSError("unexpected websocket EOF")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _read_http_headers(stream: socket.socket, deadline: float | None = None) -> str:
    data = bytearray()
    while b"\r\n\r\n" not in data:
        if deadline is not None:
            timeout = deadline - time.monotonic()
            if timeout <= 0:
                raise TimeoutError("websocket upgrade deadline exceeded")
            stream.settimeout(timeout)
        chunk = stream.recv(1)
        if not chunk:
            raise OSError("unexpected EOF during websocket upgrade")
        data.extend(chunk)
        if len(data) > 64 * 1024:
            raise OSError("websocket upgrade headers are too large")
    headers, _separator, _remainder = bytes(data).partition(b"\r\n\r\n")
    return headers.decode("iso-8859-1")


def _read_websocket_frame(stream: socket.socket, deadline: float | None = None) -> tuple[int, bytes]:
    first, second = _read_exact(stream, 2, deadline)
    opcode = first & 0x0F
    masked = bool(second & 0x80)
    length = second & 0x7F
    if length == 126:
        length = int.from_bytes(_read_exact(stream, 2, deadline), "big")
    elif length == 127:
        length = int.from_bytes(_read_exact(stream, 8, deadline), "big")
    if length > 4 * 1024 * 1024:
        raise OSError("websocket frame is too large")
    mask = _read_exact(stream, 4, deadline) if masked else b""
    payload = _read_exact(stream, length, deadline)
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


def default_token(token_path: str | None, automation_token_path: str | None, scoped_auth: bool) -> str:
    env_configured = "WMUX_AUTOMATION_TOKEN" in os.environ
    env_token = os.environ.get("WMUX_AUTOMATION_TOKEN", "").strip()
    if env_configured:
        if not re.fullmatch(r"[A-Za-z0-9_-]{32,256}", env_token):
            raise SystemExit("wmuxctl: configured automation token is empty or malformed")
    path_configured = automation_token_path is not None or "WMUX_AUTOMATION_TOKEN_PATH" in os.environ
    configured_automation_path = automation_token_path if automation_token_path is not None else os.environ.get("WMUX_AUTOMATION_TOKEN_PATH")
    if path_configured and not (configured_automation_path or "").strip():
        raise SystemExit("wmuxctl: configured automation token path is empty")
    automation_path = configured_automation_path or "~/.wmux/automation-token"
    automation_token = read_text(automation_path) if path_configured or not env_configured else ""
    if path_configured and automation_token:
        if not re.fullmatch(r"[A-Za-z0-9_-]{32,256}", automation_token):
            raise SystemExit("wmuxctl: configured automation token file is malformed")
    if path_configured and not automation_token:
        raise SystemExit("wmuxctl: configured automation token file is empty or unreadable")
    if env_configured:
        return env_token
    if automation_token:
        if not re.fullmatch(r"[A-Za-z0-9_-]{32,256}", automation_token):
            raise SystemExit("wmuxctl: configured automation token file is malformed")
        return automation_token
    if Path(automation_path).expanduser().exists():
        raise SystemExit("wmuxctl: configured automation token file is empty or unreadable")
    if scoped_auth:
        raise SystemExit("wmuxctl: scoped authentication requires WMUX_AUTOMATION_TOKEN or a readable automation token file")
    if os.environ.get("WMUX_BROWSER_AUTH_MODE", "shared-or-login") == "login-only":
        raise SystemExit("wmuxctl: login-only mode requires an automation token")
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
                raise SystemExit("wmuxctl: unauthorized; verify the selected automation or compatibility credential") from error
            raise SystemExit(f"wmuxctl: HTTP {error.code} for {path}: {detail}") from error
        except urllib.error.URLError as error:
            raise SystemExit(f"wmuxctl: cannot reach {self.url}: {error.reason}") from error
        if not raw:
            return None
        return json.loads(raw.decode("utf-8"))

    def bootstrap(self) -> dict[str, Any]:
        return self.request("GET", "/api/bootstrap")

    def create_workspace(self, machine_id: str, parent_pane_id: str = "") -> tuple[dict[str, Any], dict[str, Any]]:
        body = {"machineId": machine_id, "createdBy": "agent"}
        if parent_pane_id:
            body["parentPaneId"] = parent_pane_id
        result = self.request("POST", "/api/workspaces", body)
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
        if timeout <= 0:
            raise SystemExit("wmuxctl: pane output timeout must be greater than zero")
        overall_deadline = time.monotonic() + timeout

        def remaining_timeout(phase: str) -> float:
            remaining = overall_deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(f"timed out waiting for pane output {phase} after {timeout:g}s")
            return remaining

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

        raw_socket: socket.socket | None = None
        stream: socket.socket | None = None
        try:
            raw_socket = socket.create_connection(
                (parsed.hostname, port), timeout=remaining_timeout("connection")
            )
            raw_socket.settimeout(remaining_timeout("TLS handshake" if parsed.scheme == "https" else "upgrade"))
            if parsed.scheme == "https":
                stream = ssl.create_default_context().wrap_socket(raw_socket, server_hostname=parsed.hostname)
            else:
                stream = raw_socket
            stream.settimeout(remaining_timeout("upgrade"))
            stream.sendall("\r\n".join(headers).encode("ascii"))
            response = _read_http_headers(stream, overall_deadline)
            status_line, _, header_block = response.partition("\r\n")
            if " 101 " not in f" {status_line} ":
                raise SystemExit(f"wmuxctl: pane output websocket upgrade failed: {status_line}")
            accept_match = re.search(r"(?im)^sec-websocket-accept:\s*(\S+)\s*$", header_block)
            expected_accept = base64.b64encode(
                hashlib.sha1((key + WEBSOCKET_GUID).encode("ascii")).digest()
            ).decode("ascii")
            if not accept_match or accept_match.group(1) != expected_accept:
                raise SystemExit("wmuxctl: pane output websocket returned an invalid handshake")
            ready: dict[str, Any] | None = None
            refresh_output = bytearray()
            refresh_deadline = 0.0
            quiet_deadline = 0.0

            def finish_refresh() -> dict[str, Any]:
                assert ready is not None
                ready["replay"] = refresh_output.decode("utf-8")
                return ready

            while True:
                if ready is not None:
                    completion_deadline = min(quiet_deadline or refresh_deadline, refresh_deadline)
                    deadline = min(completion_deadline, overall_deadline)
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        if overall_deadline <= completion_deadline:
                            raise TimeoutError(
                                f"timed out waiting for pane output refresh after {timeout:g}s"
                            )
                        return finish_refresh()
                    stream.settimeout(remaining)
                    read_deadline = deadline
                else:
                    stream.settimeout(remaining_timeout("ready state"))
                    read_deadline = overall_deadline
                try:
                    opcode, payload = _read_websocket_frame(stream, read_deadline)
                except TimeoutError:
                    if ready is None:
                        raise TimeoutError(
                            f"timed out waiting for pane output ready state after {timeout:g}s"
                        )
                    completion_deadline = min(quiet_deadline or refresh_deadline, refresh_deadline)
                    if overall_deadline <= completion_deadline:
                        raise TimeoutError(
                            f"timed out waiting for pane output refresh after {timeout:g}s"
                        )
                    return finish_refresh()
                if opcode == 0x8:
                    raise SystemExit("wmuxctl: pane output websocket closed before sending ready state")
                if opcode == 0x9:
                    _write_websocket_frame(stream, 0xA, payload)
                    continue
                if opcode != 0x1:
                    continue
                message = json.loads(payload.decode("utf-8"))
                if message.get("type") == "ready":
                    if not message.get("waitForRefresh"):
                        return message
                    ready = message
                    _append_bounded_utf8(refresh_output, str(ready.get("replay") or ""))
                    ready["replay"] = ""
                    refresh_deadline = min(
                        time.monotonic() + DURABLE_REFRESH_FALLBACK_SECONDS,
                        overall_deadline,
                    )
                    continue
                if ready is not None and message.get("type") == "output" and isinstance(message.get("data"), str):
                    _append_bounded_utf8(refresh_output, message["data"])
                    quiet_deadline = time.monotonic() + DURABLE_REFRESH_QUIET_SECONDS
        except (OSError, ValueError, json.JSONDecodeError) as error:
            raise SystemExit(f"wmuxctl: cannot read pane output: {error}") from error
        finally:
            if stream is not None:
                stream.close()
            elif raw_socket is not None:
                raw_socket.close()


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


def safe_http_base(value: str, label: str) -> str:
    candidate = value.rstrip("/")
    try:
        parsed = urllib.parse.urlsplit(candidate)
        _port = parsed.port
    except ValueError as error:
        raise SystemExit(f"wmuxctl: {label} must be a valid absolute HTTP(S) URL") from error
    if (
        not candidate
        or any(ord(character) <= 32 or ord(character) == 127 for character in candidate)
        or parsed.scheme not in {"http", "https"}
        or not parsed.netloc
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise SystemExit(
            f"wmuxctl: {label} must be an absolute credential-free HTTP(S) URL without a query or fragment"
        )
    return candidate


def safe_public_url(value: str, fallback: str) -> str:
    return safe_http_base(value if value else fallback, "--public-url/WMUX_PUBLIC_URL")


def urls(base_url: str, public_url: str, workspace_id: str, tab_id: str) -> dict[str, str]:
    local = workspace_url(base_url, workspace_id, tab_id)
    public = workspace_url(safe_public_url(public_url, base_url), workspace_id, tab_id)
    return {"url": public, "localUrl": local, "publicUrl": public}


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


def invoking_parent_pane_id() -> str:
    return os.environ.get("WMUX_PANE_ID", "")


def get_or_create_workspace(client: WmuxClient, machine_id: str, title: str, force_new: bool) -> tuple[dict[str, Any], bool]:
    if not force_new:
        workspace = find_workspace(client, machine_id, title)
        if workspace:
            return workspace, True
    workspace, _state = client.create_workspace(machine_id, invoking_parent_pane_id())
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


def submit_interactive_prompt(client: WmuxClient, pane_id: str, prompt: str, cols: int, rows: int) -> int:
    client.send_input(pane_id, "\x1b[200~", cols, rows)
    for offset in range(0, len(prompt), 256):
        client.send_input(pane_id, prompt[offset:offset + 256], cols, rows)
    client.send_input(pane_id, "\x1b[201~", cols, rows)
    time.sleep(0.1)
    client.send_input(pane_id, "\r", cols, rows)
    return len(prompt.encode("utf-8")) + 13


def powershell_single_quote(value: str, label: str) -> str:
    if any(ord(character) < 32 or ord(character) == 127 for character in value):
        raise SystemExit(f"wmuxctl: {label} cannot contain control characters")
    return "'" + value.replace("'", "''") + "'"


def windows_codex_command(args: argparse.Namespace, ready_marker: str) -> str:
    sandbox = args.sandbox or ("workspace-write" if args.write_access else "read-only")
    parts = [
        f"$env:WMUX_DELEGATED_RUN={powershell_single_quote('1', 'delegation environment')}",
        "Remove-Item Env:WMUX_DELEGATION_RUN_ID -ErrorAction SilentlyContinue",
        f"Set-Location -LiteralPath {powershell_single_quote(args.directory, 'delegation directory')}",
        f"Write-Output {powershell_single_quote(ready_marker, 'Codex readiness marker')}",
        f"codex --sandbox {powershell_single_quote(sandbox, 'sandbox mode')} --no-alt-screen",
    ]
    if args.model:
        parts[-1] += f" --model {powershell_single_quote(args.model, 'model')}"
    if args.unattended:
        parts[-1] += " --ask-for-approval never"
    return "; ".join(parts)


def interactive_delegate_prompt(prompt: str, structured_outcome: bool) -> str:
    if not structured_outcome:
        return prompt
    return prompt + (
        "\n\nReturn the entire final response as exactly one JSON object with these string fields: "
        '{"outcome":"completed|blocked|failed","summary":"concise summary"}. '
        "Choose exactly one listed outcome, emit no other fields, and do not use Markdown fences or surrounding text."
    )


def wait_for_prompt_acceptance(
    client: WmuxClient,
    pane_id: str,
    run_id: str,
    runtime: str,
    timeout: float,
    cols: int,
    rows: int,
) -> None:
    started = time.monotonic()
    next_enter = started + 1
    last_status_error = ""
    while True:
        try:
            durable = client.delegation_status(run_id)
        except SystemExit as error:
            last_status_error = str(error)
        else:
            if durable:
                state = durable.get("state")
                summary = durable.get("summary")
                if state in TERMINAL_DELEGATION_STATES:
                    return
                if state == "running" and isinstance(summary, str) and summary.strip().lower() == f"{runtime} running":
                    return
            last_status_error = ""

        now = time.monotonic()
        if now - started >= timeout:
            detail = f": {last_status_error}" if last_status_error else ""
            raise DelegationObservationError(
                f"wmuxctl: {runtime.capitalize()} did not acknowledge the submitted prompt within {timeout:g}s{detail}"
            )
        if now >= next_enter:
            client.send_input(pane_id, "\r", cols, rows)
            next_enter = now + 1
        time.sleep(min(0.25, timeout - (now - started)))


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


def read_tui_prompt(args: argparse.Namespace) -> str | None:
    sources = int(bool(args.prompt_file)) + int(bool(args.no_prompt))
    if sources > 1:
        raise SystemExit("wmuxctl: --no-prompt conflicts with --prompt-file")
    if args.no_prompt:
        return None
    if args.prompt_file and args.prompt_file != "-":
        try:
            with Path(args.prompt_file).open("r", encoding="utf-8", newline="") as handle:
                prompt = handle.read()
        except (OSError, UnicodeError) as error:
            raise SystemExit(f"wmuxctl: cannot read TUI prompt: {error}") from error
    elif args.prompt_file == "-" or not sys.stdin.isatty():
        try:
            prompt = sys.stdin.buffer.read().decode("utf-8")
        except UnicodeError as error:
            raise SystemExit(f"wmuxctl: cannot read TUI prompt: {error}") from error
    else:
        raise SystemExit("wmuxctl: provide --prompt-file, pipe a prompt on stdin, or use --no-prompt")
    prompt = prompt.replace("\r\n", "\n")
    if not prompt or len(prompt.encode("utf-8")) > 128 * 1024:
        raise SystemExit("wmuxctl: TUI prompt must be 1..131072 UTF-8 bytes")
    if UNSAFE_TUI_PROMPT_CONTROL.search(prompt):
        raise SystemExit(
            "wmuxctl: TUI prompt contains an unsafe terminal control character; only TAB and LF are allowed"
        )
    return prompt


def require_posix_machine(client: WmuxClient, machine_id: str) -> dict[str, Any]:
    payload = client.bootstrap()
    machine = next((item for item in payload.get("machines", []) if item.get("id") == machine_id), None)
    if not machine or machine.get("reachable") is not True:
        raise SystemExit(f"wmuxctl: machine is not reachable: {machine_id}")
    if machine.get("kind") not in {"local", "ssh"} or machine.get("platform") not in {"linux", "mac"}:
        raise SystemExit("wmuxctl: interactive TUI requires a POSIX local or SSH target")
    return machine


def machine_identity(machine: dict[str, Any]) -> tuple[tuple[str, Any], ...]:
    # Deliberately omit volatile reachability/health prose while pinning the
    # connection descriptor exposed by bootstrap, including dynamic sources.
    keys = ("id", "kind", "platform", "source", "endpoint", "host", "user", "port", "address", "sessionBackend")
    return tuple((key, machine.get(key)) for key in keys if isinstance(machine.get(key), (str, int, bool, type(None))))


def validate_tui_args(args: argparse.Namespace) -> None:
    for key in ("timeout", "ready_timeout", "gate_timeout"):
        value = getattr(args, key)
        if not math.isfinite(value) or value <= 0:
            raise SystemExit(f"wmuxctl: --{key.replace('_', '-')} must be positive and finite")
    for key in ("cols", "rows"):
        if not 1 <= getattr(args, key) <= 1000:
            raise SystemExit(f"wmuxctl: --{key} must be between 1 and 1000")
    for key in ("title", "model", "opencode_agent"):
        value = getattr(args, key)
        if not isinstance(value, str) or len(value) > 512 or "\x00" in value:
            raise SystemExit(f"wmuxctl: invalid --{key.replace('_', '-')}")
    if args.opencode_agent and args.runtime != "opencode":
        raise SystemExit("wmuxctl: --opencode-agent is only valid for OpenCode")
    if not posixpath.isabs(args.directory) or len(args.directory) > 4096 or "\x00" in args.directory:
        raise SystemExit("wmuxctl: TUI directory must be an absolute POSIX path of at most 4096 characters")


def replay_digest(client: WmuxClient, pane_id: str, cols: int, rows: int) -> tuple[str, str]:
    replay = str(client.read_pane_output(pane_id, cols, rows).get("replay") or "")
    return hashlib.sha256(replay.encode("utf-8")).hexdigest(), replay


def helper_failure(replay: str, run_id: str) -> str:
    payload: dict[str, Any] | None = None
    done_code: int | None = None
    tui_exit_code: int | None = None
    for line in clean_terminal_text(replay).splitlines():
        if line.startswith("WMUX_AGENT_RESULT "):
            try:
                candidate = json.loads(
                    base64.b64decode(line.removeprefix("WMUX_AGENT_RESULT "), validate=True).decode("utf-8")
                )
            except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
                continue
            if isinstance(candidate, dict) and candidate.get("runId") == run_id and candidate.get("ok") is False:
                payload = candidate
        match = re.fullmatch(r"WMUX_AGENT_DONE ([A-Za-z0-9._-]+) (-?\d+)", line)
        if match and match.group(1) == run_id:
            done_code = int(match.group(2))
        match = re.fullmatch(r"WMUX_AGENT_TUI_EXIT ([A-Za-z0-9._-]+) (-?\d+)", line)
        if match and match.group(1) == run_id:
            tui_exit_code = int(match.group(2))
    if payload is not None:
        detail = payload.get("error") or payload.get("result")
        return detail if isinstance(detail, str) and detail.strip() else "interactive helper rejected the launch request"
    if done_code is not None and done_code != 0:
        return f"interactive helper failed with exit code {done_code}"
    if tui_exit_code is not None:
        return f"interactive runtime exited with code {tui_exit_code}"
    return ""


def wait_for_helper_marker(
    client: WmuxClient,
    pane_id: str,
    previous: str,
    marker: str,
    run_id: str,
    timeout: float,
    cols: int,
    rows: int,
) -> str:
    started = time.monotonic()
    while True:
        digest, replay = replay_digest(client, pane_id, cols, rows)
        failure = helper_failure(replay, run_id)
        if failure:
            raise SystemExit(f"wmuxctl: interactive helper failed: {failure}")
        if digest != previous and marker in clean_terminal_text(replay).splitlines():
            return replay
        elapsed = time.monotonic() - started
        if elapsed >= timeout:
            raise SystemExit(f"wmuxctl: timed out after {timeout:g}s waiting for interactive helper marker {marker!r}")
        time.sleep(min(0.25, timeout - elapsed))


TRUST_PROMPT = re.compile(
    r"(?:do you trust (?:the contents of )?(?:this|the current) (?:directory|folder|repository)|"
    r"trust this (?:directory|folder|repository)|repository trust)",
    re.I,
)
TRUST_CHOICE = re.compile(r"^(?:[>❯]\s*)?1[.)]?\s+(?:yes|trust|continue)", re.I)
LOGIN_PROMPT = re.compile(
    r"^(?:sign[ -]?in(?: required| to .*)?|log[ -]?in(?: required| to .*)?|authentication required|"
    r"enter (?:your )?(?:api key|access token|credentials?)|paste (?:your )?(?:api key|access token)|"
    r"(?:open|visit) .*(?:device code|authenticate))\s*[:?]?\s*$",
    re.I,
)
FIRST_RUN_PROMPT = re.compile(
    r"^(?:press (?:enter|return|any key) to continue|first[ -]?run setup(?: required)?|"
    r"let'?s get started|complete (?:the )?(?:initial )?setup|"
    r"welcome[^\n]*(?:let'?s get started|complete setup)|"
    r"(?:choose|select) (?:a |your )?(?:theme|color scheme|login method))\s*[:?]?\s*$",
    re.I,
)
UNKNOWN_GATE = re.compile(
    r"^(?:would you like to .*[?]|(?:select|choose) (?:an? |your )?[^:]{1,80}:|.*\[(?:y/n|Y/n|y/N)\]\s*)$",
    re.I,
)
UI_CHOICE = re.compile(r"^(?:[>❯*•]\s*)?(?:\d+[.)]?\s+|\[[ xX]\]\s*)?(?:yes|no|continue|cancel|exit|trust|sign in|log in).*$", re.I)


def active_tui_lines(replay: str) -> list[str]:
    lines = [line.strip(" \t│┃┆┇┊┋┌┐└┘┏┓┗┛─━") for line in clean_terminal_text(replay).splitlines()]
    return [line for line in lines if line][-12:]


def classify_tui_gate(replay: str) -> str:
    lines = active_tui_lines(replay)
    for index, line in enumerate(lines):
        if TRUST_PROMPT.search(line):
            trailing = lines[index + 1 :]
            if any(TRUST_CHOICE.search(candidate) for candidate in trailing) and all(
                UI_CHOICE.search(candidate) for candidate in trailing
            ):
                return "trust"
            if not trailing or all(
                UI_CHOICE.search(candidate) or UNKNOWN_GATE.fullmatch(candidate) for candidate in trailing
            ):
                return "unknown-first-run"
    for index, line in enumerate(lines):
        if LOGIN_PROMPT.fullmatch(line):
            trailing = lines[index + 1 :]
            if not trailing or all(UI_CHOICE.search(candidate) for candidate in trailing):
                return "login"
    for index, line in enumerate(lines):
        if FIRST_RUN_PROMPT.fullmatch(line) or UNKNOWN_GATE.fullmatch(line):
            trailing = lines[index + 1 :]
            if not trailing or all(UI_CHOICE.search(candidate) for candidate in trailing):
                return "unknown-first-run"
    return ""


def wait_for_tui_snapshot(
    client: WmuxClient,
    pane_id: str,
    previous_digest: str,
    run_id: str,
    timeout: float,
    cols: int,
    rows: int,
    observe_gates: bool = True,
    gate_timeout: float = 0,
) -> tuple[str, str]:
    """Require fresh child output, then continuously observe bounded startup gates."""
    started = time.monotonic()
    first_change_at: float | None = None
    latest_replay = ""
    while True:
        digest, replay = replay_digest(client, pane_id, cols, rows)
        failure = helper_failure(replay, run_id)
        if failure:
            raise SystemExit(f"wmuxctl: interactive helper failed: {failure}")
        changed = digest != previous_digest
        if changed or first_change_at is not None:
            gate = classify_tui_gate(replay)
            if gate:
                return replay, gate
        if changed:
            latest_replay = replay
            first_change_at = first_change_at or time.monotonic()
            if not observe_gates:
                return latest_replay, ""
        elif first_change_at is not None:
            latest_replay = replay
        now = time.monotonic()
        if first_change_at is not None and now - first_change_at >= gate_timeout:
            return latest_replay, ""
        elapsed = now - started
        if first_change_at is None and elapsed >= timeout:
            raise SystemExit(f"wmuxctl: timed out after {timeout:g}s waiting for post-start TUI output")
        remaining = timeout - elapsed if first_change_at is None else gate_timeout - (now - first_change_at)
        time.sleep(min(0.1, max(0, remaining)))


def launch_posix_tui(
    client: WmuxClient,
    info: dict[str, Any],
    runtime: str,
    directory: str,
    model: str,
    opencode_agent: str,
    accept_trust: bool,
    ready_timeout: float,
    gate_timeout: float,
    cols: int,
    rows: int,
    request_options: dict[str, Any] | None = None,
) -> str:
    launch_run_id = info["runId"]
    before, _ = replay_digest(client, info["paneId"], cols, rows)
    submit_line(client, info["paneId"], f"wmux-agent-run tui {launch_run_id}", True, cols, rows)
    ready = wait_for_helper_marker(
        client,
        info["paneId"],
        before,
        f"WMUX_AGENT_TUI_READY {launch_run_id}",
        launch_run_id,
        ready_timeout,
        cols,
        rows,
    )
    request: dict[str, Any] = {
        "runId": launch_run_id,
        "runtime": runtime,
        "directory": directory,
        **(request_options or {}),
    }
    if model:
        request["model"] = model
    if runtime == "opencode" and opencode_agent:
        request["agent"] = opencode_agent
    encoded = base64.b64encode(json.dumps(request, separators=(",", ":")).encode()).decode()
    submit_line(client, info["paneId"], encoded, True, cols, rows)
    launched = wait_for_helper_marker(
        client,
        info["paneId"],
        hashlib.sha256(ready.encode()).hexdigest(),
        f"WMUX_AGENT_TUI_LAUNCH {launch_run_id}",
        launch_run_id,
        ready_timeout,
        cols,
        rows,
    )
    launch_digest = hashlib.sha256(launched.encode()).hexdigest()
    submit_line(client, info["paneId"], f"WMUX_AGENT_TUI_ACK {launch_run_id}", True, cols, rows)
    launched, gate = wait_for_tui_snapshot(
        client,
        info["paneId"],
        launch_digest,
        launch_run_id,
        ready_timeout,
        cols,
        rows,
        gate_timeout=gate_timeout,
    )
    if gate == "trust":
        if not accept_trust:
            raise SystemExit("wmuxctl: repository-trust prompt detected; rerun with --accept-trust after review")
        submit_line(client, info["paneId"], "1", True, cols, rows)
        launched, gate = wait_for_tui_snapshot(
            client,
            info["paneId"],
            hashlib.sha256(launched.encode()).hexdigest(),
            launch_run_id,
            ready_timeout,
            cols,
            rows,
            gate_timeout=gate_timeout,
        )
        if gate:
            raise SystemExit("wmuxctl: TUI remained at a safety prompt after trust response")
    elif gate:
        raise SystemExit(f"wmuxctl: {gate} prompt detected; refusing to automate it")
    return launched


def cmd_tui(client: WmuxClient, args: argparse.Namespace) -> int:
    validate_tui_args(args)
    prompt = read_tui_prompt(args)
    public_base = safe_public_url(args.public_url, client.url)
    initial_machine = require_posix_machine(client, args.machine)
    initial_identity = machine_identity(initial_machine)
    workspace, _state = client.create_workspace(args.machine, invoking_parent_pane_id())
    info = describe_workspace(client.url, workspace)
    info.update(urls(client.url, public_base, info["workspaceId"], info["tabId"]))
    info.update({"runId": str(uuid.uuid4()), "runtime": args.runtime, "state": "failed", "closed": False,
                 "promptSubmitted": False, "activityVerified": False})
    try:
        client.set_workspace_title(info["workspaceId"], args.title or f"{args.runtime.capitalize()} TUI")
        wait_for_shell_ready(client, info["paneId"], info["machineId"], args.ready_timeout, args.cols, args.rows)
        # Recheck after pane creation so a dynamic registration cannot drift.
        current_machine = require_posix_machine(client, args.machine)
        if machine_identity(current_machine) != initial_identity:
            raise SystemExit("wmuxctl: machine identity changed before TUI launch")
        launched = launch_posix_tui(
            client,
            info,
            args.runtime,
            args.directory,
            args.model,
            args.opencode_agent,
            args.accept_trust,
            args.ready_timeout,
            args.gate_timeout,
            args.cols,
            args.rows,
        )
        launch_digest = hashlib.sha256(launched.encode()).hexdigest()
        info["state"] = "ready"
        if prompt is not None:
            paste = "\x1b[200~" + prompt + "\x1b[201~"
            if len(paste.encode()) >= 256 * 1024:
                raise SystemExit("wmuxctl: bracketed prompt exceeds pane input limit")
            client.send_input(info["paneId"], paste, args.cols, args.rows)
            pasted, _gate = wait_for_tui_snapshot(
                client, info["paneId"], launch_digest, info["runId"], args.timeout, args.cols, args.rows, False
            )
            client.send_input(info["paneId"], "\r", args.cols, args.rows)
            wait_for_tui_snapshot(
                client, info["paneId"], hashlib.sha256(pasted.encode()).hexdigest(), info["runId"],
                args.timeout, args.cols, args.rows, False,
            )
            info.update({"state": "active", "promptSubmitted": True, "activityVerified": True})
        print_json(info)
        return 0
    except SystemExit as error:
        info["error"] = redact_delegate_text(str(error), [prompt or "", client.token])
        print_json(info)
        return 1


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
        if not secret:
            continue
        forms = {secret, json.dumps(secret, ensure_ascii=False)[1:-1], json.dumps(secret)[1:-1]}
        for form in forms:
            if form:
                text = text.replace(form, "[redacted]")
    encoded = text.encode("utf-8")
    if len(encoded) > limit:
        text = encoded[:limit].decode("utf-8", errors="ignore")
    return text.strip()


def wait_for_delegation_result(
    client: WmuxClient,
    pane_id: str,
    run_id: str,
    timeout: float,
    cols: int,
    rows: int,
    structured_outcome: bool = False,
) -> tuple[bool, Any, int, bool, float, str]:
    started = time.monotonic()
    done_pattern = re.compile(rf"(?m)^WMUX_AGENT_DONE {re.escape(run_id)} -?\d+$")
    last_replay_error = ""
    last_status_error = ""
    while True:
        remaining = timeout - (time.monotonic() - started)
        if remaining <= 0:
            detail = last_status_error or last_replay_error or "no terminal result was observed"
            raise DelegationObservationError(
                f"wmuxctl: timed out after {timeout:g}s waiting for delegated result: {detail}"
            )

        try:
            replay = str(
                client.read_pane_output(pane_id, cols, rows, timeout=min(1, max(remaining, 0.1))).get("replay")
                or ""
            )
            output = clean_terminal_text(replay)
            if done_pattern.search(output):
                try:
                    payload, exit_code = decode_agent_result(output, run_id)
                except SystemExit as error:
                    last_replay_error = str(error)
                else:
                    ok = exit_code == 0 and payload.get("ok") is True
                    detail = payload.get("result") if ok else payload.get("error") or payload.get("result")
                    outcome = payload.get("outcome")
                    if outcome not in {"completed", "blocked", "failed"}:
                        outcome = "completed" if ok else "failed"
                    return ok, detail, exit_code, False, time.monotonic() - started, outcome
        except (SystemExit, OSError) as error:
            last_replay_error = str(error)

        try:
            durable = client.delegation_status(run_id)
        except SystemExit as error:
            last_status_error = str(error)
        else:
            last_status_error = ""
            durable_state = durable.get("state") if durable else None
            if durable_state in TERMINAL_DELEGATION_STATES:
                ok = durable_state == "completed"
                detail = durable.get("result") if ok else durable.get("error") or durable.get("summary")
                outcome = durable_state
                if ok and structured_outcome:
                    try:
                        parsed = json.loads(detail)
                    except (TypeError, json.JSONDecodeError):
                        parsed = None
                    if not isinstance(parsed, dict) or set(parsed) != {"outcome", "summary"}:
                        return (
                            False,
                            "Codex did not return the required structured outcome.",
                            1,
                            True,
                            time.monotonic() - started,
                            "failed",
                        )
                    outcome = parsed.get("outcome")
                    summary = parsed.get("summary")
                    if (
                        outcome not in {"completed", "blocked", "failed"}
                        or not isinstance(summary, str)
                        or not summary.strip()
                    ):
                        return (
                            False,
                            "Codex did not return the required structured outcome.",
                            1,
                            True,
                            time.monotonic() - started,
                            "failed",
                        )
                    ok = outcome == "completed"
                    detail = summary.strip()
                return ok, detail, 0 if ok else 1, True, time.monotonic() - started, outcome

        remaining = timeout - (time.monotonic() - started)
        if remaining > 0:
            time.sleep(min(0.5, remaining))


def record_detached_delegation(
    client: WmuxClient,
    info: dict[str, Any],
    runtime: str,
    title: str,
    run_id: str,
    detail: str,
) -> None:
    events = (
        (
            "observer_error",
            f"Lost contact with {runtime} delegation",
            detail,
        ),
        (
            "waiting",
            f"{runtime.capitalize()} delegation detached; worker may still be running",
            "",
        ),
    )
    for status, summary, message in events:
        try:
            client.record_agent_event(
                info["workspaceId"],
                info["tabId"],
                info["paneId"],
                runtime,
                status,
                title,
                summary,
                message=message,
                run_id=run_id,
            )
        except SystemExit:
            continue


def session_workspace(
    bootstrap: dict[str, Any],
    workspace_id: str,
    machine_id: str,
    runtime: str,
) -> dict[str, Any]:
    if not re.fullmatch(r"ws_[A-Za-z0-9]+", workspace_id):
        raise SystemExit("wmuxctl: invalid session workspace ID")
    workspace = next(
        (candidate for candidate in bootstrap.get("workspaces", []) if candidate.get("id") == workspace_id),
        None,
    )
    if workspace is None:
        raise SystemExit("wmuxctl: session workspace does not exist")
    if workspace.get("machineId") != machine_id or workspace.get("createdBy") != "agent":
        raise SystemExit("wmuxctl: session workspace does not belong to the requested agent target")
    info = describe_workspace("", workspace, require_explicit_multi_tab=True)
    active = next(
        (
            delegation
            for delegation in bootstrap.get("delegations", [])
            if delegation.get("paneId") == info["paneId"]
            and delegation.get("state") not in TERMINAL_DELEGATION_STATES
        ),
        None,
    )
    if active:
        raise SystemExit(f"wmuxctl: {runtime.capitalize()} session is already running turn {active.get('runId')}")
    return workspace


def cmd_delegate(client: WmuxClient, args: argparse.Namespace) -> int:
    prompt = read_delegate_prompt(args)
    mode = args.mode or ("change" if args.write_access else "review")
    if mode not in DEFAULT_DELEGATION_WAIT_TIMEOUT_SECONDS:
        raise SystemExit("wmuxctl: delegation mode must be review, change, or deploy")
    if args.timeout is not None and (
        not math.isfinite(args.timeout)
        or args.timeout < MIN_DELEGATION_WAIT_TIMEOUT_SECONDS
        or args.timeout > MAX_DELEGATION_WAIT_TIMEOUT_SECONDS
    ):
        raise SystemExit(
            "wmuxctl: --timeout must be between "
            f"{MIN_DELEGATION_WAIT_TIMEOUT_SECONDS:g} and {MAX_DELEGATION_WAIT_TIMEOUT_SECONDS:g} seconds"
        )
    if args.session_workspace and not args.session:
        raise SystemExit("wmuxctl: --session-workspace requires --session")
    if args.session and args.runtime != "codex":
        raise SystemExit("wmuxctl: durable sessions currently require the Codex runtime")
    if args.session and args.structured_outcome:
        raise SystemExit("wmuxctl: durable sessions return native agent responses; omit --structured-outcome")
    if args.session and args.close_on_success:
        raise SystemExit("wmuxctl: durable sessions cannot use --close-on-success")
    if args.session:
        if UNSAFE_TUI_PROMPT_CONTROL.search(prompt):
            raise SystemExit(
                "wmuxctl: session prompt contains an unsafe terminal control character; only TAB and LF are allowed"
            )
        for key in ("ready_timeout", "gate_timeout"):
            value = getattr(args, key)
            if not math.isfinite(value) or value <= 0:
                raise SystemExit(f"wmuxctl: --{key.replace('_', '-')} must be positive and finite")
    if args.runtime == "opencode" and not args.write_access:
        raise SystemExit("wmuxctl: OpenCode delegation cannot enforce read-only mode; add --write-access explicitly")
    if args.sandbox and args.runtime != "codex":
        raise SystemExit("wmuxctl: explicit sandbox modes currently require the Codex runtime")
    if args.structured_outcome and args.runtime != "codex":
        raise SystemExit("wmuxctl: structured outcomes currently require the Codex runtime")
    bootstrap = client.bootstrap()
    args.timeout = resolve_delegation_wait_timeout(bootstrap, mode, args.timeout)
    machine = next((item for item in bootstrap.get("machines", []) if item.get("id") == args.machine), None)
    if not machine or machine.get("reachable") is not True:
        raise SystemExit(f"wmuxctl: machine is not reachable: {args.machine}")
    is_posix = machine.get("kind") in {"local", "ssh"} and machine.get("platform") in {"linux", "mac"}
    is_windows = machine.get("kind") == "powershell-ssh" and machine.get("platform") in {"win", "windows"}
    if not is_posix and not is_windows:
        raise SystemExit("wmuxctl: delegated agent runs require a POSIX local/SSH or Windows PowerShell SSH target")
    if is_posix and (not posixpath.isabs(args.directory) or "\x00" in args.directory):
        raise SystemExit("wmuxctl: delegation directory must be an absolute POSIX path")
    if is_windows and not (
        re.fullmatch(r"[A-Za-z]:[\\/].+", args.directory) or re.fullmatch(r"~[\\/].+", args.directory)
    ):
        raise SystemExit("wmuxctl: Windows delegation directory must be drive-absolute or home-relative")
    if is_windows and args.runtime != "codex":
        raise SystemExit("wmuxctl: Windows delegation currently supports the Codex runtime")
    title = args.title or f"{args.runtime.capitalize()} delegation"
    workspace = None
    reused = False
    if args.session_workspace:
        workspace = session_workspace(bootstrap, args.session_workspace, args.machine, args.runtime)
        reused = True
    elif is_windows and args.title and not args.session:
        candidates = [
            candidate
            for candidate in bootstrap.get("workspaces", [])
            if candidate.get("machineId") == args.machine and workspace_title(candidate) == title
        ]
        candidates.sort(key=lambda candidate: candidate.get("updatedAt") or candidate.get("createdAt") or "", reverse=True)
        for candidate in candidates:
            candidate_info = describe_workspace(client.url, candidate)
            latest_event = next(
                (
                    event
                    for event in bootstrap.get("agentEvents", [])
                    if event.get("paneId") == candidate_info["paneId"]
                    and event.get("agent") == "codex"
                    and event.get("runId")
                ),
                None,
            )
            if not latest_event:
                continue
            active_delegation = next(
                (
                    delegation
                    for delegation in bootstrap.get("delegations", [])
                    if delegation.get("runId") == latest_event.get("runId")
                    and delegation.get("state") not in TERMINAL_DELEGATION_STATES
                ),
                None,
            )
            if active_delegation:
                raise SystemExit(f"wmuxctl: Codex workspace {title!r} is already running a delegated task")
            workspace = candidate
            reused = True
            break
    if workspace is None:
        # This is inherited only by a newly created delegated workspace. Reused
        # title matches retain their server-owned parent relationship.
        workspace, _state = client.create_workspace(args.machine, invoking_parent_pane_id())
    info = describe_workspace(client.url, workspace)
    run_id = str(uuid.uuid4())
    info["runId"] = run_id
    secrets = [prompt, client.token]
    worker_submitted = False
    try:
        if reused:
            replay = str(
                client.read_pane_output(
                    info["paneId"],
                    args.cols,
                    args.rows,
                    timeout=min(args.ready_timeout, 10),
                ).get("replay")
                or ""
            )
            clean_replay = clean_terminal_text(replay)
            shell_ready = (
                re.search(r"(?m)^PS [^\n>]*>\s*$", clean_replay)
                if is_windows
                else re.search(r"(?m)^.*(?:[$#%❯])\s*$", clean_replay)
            )
            if shell_ready:
                reused = False
            elif not re.search(CODEX_READY_PATTERN, clean_replay):
                raise SystemExit("wmuxctl: saved Codex session is not at an idle agent prompt")
        if not reused:
            client.set_workspace_title(workspace["id"], title)
        client.record_agent_event(
            info["workspaceId"], info["tabId"], info["paneId"], args.runtime, "running", title,
            f"{args.runtime.capitalize()} delegation running",
            run_id=run_id,
        )
        if is_windows:
            ready_pattern = CODEX_READY_PATTERN
            if not reused:
                info["shellReadySeconds"] = round(
                    wait_for_shell_ready(
                        client,
                        info["paneId"],
                        info["machineId"],
                        args.ready_timeout,
                        args.cols,
                        args.rows,
                    ),
                    3,
                )
                ready_marker = f"WMUX_CODEX_START_{run_id}"
                submit_line(
                    client,
                    info["paneId"],
                    windows_codex_command(args, ready_marker),
                    True,
                    args.cols,
                    args.rows,
                )
                ready_pattern = rf"(?s){re.escape(ready_marker)}.*?OpenAI Codex.*?›(?:\s|$)"
            wait_for_output(
                client,
                info["paneId"],
                ready_pattern,
                args.ready_timeout,
                args.cols,
                args.rows,
            )
            worker_submitted = True
            submit_interactive_prompt(
                client,
                info["paneId"],
                interactive_delegate_prompt(prompt, args.structured_outcome),
                args.cols,
                args.rows,
            )
            wait_for_prompt_acceptance(
                client,
                info["paneId"],
                run_id,
                args.runtime,
                args.ready_timeout,
                args.cols,
                args.rows,
            )
        elif args.session:
            if not reused:
                info["shellReadySeconds"] = round(
                    wait_for_shell_ready(
                        client,
                        info["paneId"],
                        info["machineId"],
                        args.ready_timeout,
                        args.cols,
                        args.rows,
                    ),
                    3,
                )
                current_machine = require_posix_machine(client, args.machine)
                if machine_identity(current_machine) != machine_identity(machine):
                    raise SystemExit("wmuxctl: machine identity changed before durable session launch")
                launch_posix_tui(
                    client,
                    info,
                    args.runtime,
                    args.directory,
                    args.model,
                    args.opencode_agent,
                    args.accept_trust,
                    args.ready_timeout,
                    args.gate_timeout,
                    args.cols,
                    args.rows,
                    {
                        "unattended": args.unattended,
                        "writeAccess": args.write_access,
                        "sandboxMode": args.sandbox or ("workspace-write" if args.write_access else "read-only"),
                    },
                )
            worker_submitted = True
            submit_interactive_prompt(client, info["paneId"], prompt, args.cols, args.rows)
            wait_for_prompt_acceptance(
                client,
                info["paneId"],
                run_id,
                args.runtime,
                args.ready_timeout,
                args.cols,
                args.rows,
            )
        else:
            info["shellReadySeconds"] = round(
                wait_for_shell_ready(
                    client,
                    info["paneId"],
                    info["machineId"],
                    args.ready_timeout,
                    args.cols,
                    args.rows,
                ),
                3,
            )
            ready_marker = f"WMUX_AGENT_READY {run_id}"
            submit_line(
                client,
                info["paneId"],
                f"wmux-agent-run request {run_id}",
                True,
                args.cols,
                args.rows,
            )
            wait_for_output(
                client,
                info["paneId"],
                rf"(?m)^{re.escape(ready_marker)}$",
                args.ready_timeout,
                args.cols,
                args.rows,
            )
            request = {
                "runId": run_id,
                "runtime": args.runtime,
                "prompt": prompt,
                "directory": args.directory,
                "unattended": args.unattended,
                "writeAccess": args.write_access,
                "title": title,
            }
            if args.sandbox:
                request["sandboxMode"] = args.sandbox
            if args.structured_outcome:
                request["resultFormat"] = "outcome-v1"
            if args.model:
                request["model"] = args.model
            if args.runtime == "opencode" and args.opencode_agent:
                request["agent"] = args.opencode_agent
            encoded = base64.b64encode(json.dumps(request, separators=(",", ":")).encode()).decode()
            worker_submitted = True
            submit_line(client, info["paneId"], encoded, True, args.cols, args.rows)
        ok, detail_source, exit_code, recovered, elapsed, outcome = wait_for_delegation_result(
            client,
            info["paneId"],
            run_id,
            args.timeout,
            args.cols,
            args.rows,
            args.structured_outcome and is_windows,
        )
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
            "mode": mode,
            "waitTimeoutSeconds": args.timeout,
            "state": status,
            "outcome": outcome,
            "elapsedSeconds": round(elapsed, 3),
            "result": detail if ok else "",
            "error": "" if ok else detail,
            "closed": False,
            "reused": reused,
            "session": args.session,
        })
        if outcome == "blocked":
            info["state"] = "blocked"
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
    except DelegationObservationError as error:
        detail = redact_delegate_text(str(error), secrets)
        record_detached_delegation(client, info, args.runtime, title, run_id, detail)
        info.update({
            "runId": run_id,
            "runtime": args.runtime,
            "mode": mode,
            "waitTimeoutSeconds": args.timeout,
            "state": "waiting",
            "failureKind": "observer",
            "error": detail,
            "closed": False,
        })
        print_json(info)
        return 2
    except SystemExit as error:
        if worker_submitted:
            detail = redact_delegate_text(str(error), secrets)
            record_detached_delegation(client, info, args.runtime, title, run_id, detail)
            info.update({
                "runId": run_id,
                "runtime": args.runtime,
                "mode": mode,
                "waitTimeoutSeconds": args.timeout,
                "state": "waiting",
                "failureKind": "observer",
                "error": detail,
                "closed": False,
            })
            print_json(info)
            return 2
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
        info.update({
            "runId": run_id,
            "runtime": args.runtime,
            "mode": mode,
            "waitTimeoutSeconds": args.timeout,
            "state": "failed",
            "error": detail,
            "closed": False,
        })
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
    parser.add_argument("--public-url", default=os.environ.get("WMUX_PUBLIC_URL", ""), help="safe public http(s) base URL for handoff links")
    parser.add_argument("--token-path", default=None, help="token file path when WMUX_TOKEN is unset")
    parser.add_argument("--automation-token-path", default=None, help="automation token file path")
    parser.add_argument("--scoped-auth", action="store_true", help="require automation auth and disable compatibility fallback")

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

    delegate = subparsers.add_parser("delegate", help="run a visible OpenCode, Codex, or Claude task")
    delegate.add_argument("runtime", choices=("opencode", "codex", "claude"), help="agent CLI to run in the target pane")
    delegate.add_argument("machine", help="reachable POSIX or Windows machine id")
    delegate.add_argument("--directory", required=True, help="absolute target working directory")
    delegate.add_argument("--prompt-file", default="", help="UTF-8 prompt file; use - or omit with piped stdin")
    delegate.add_argument("--title", default="", help="workspace and lifecycle title")
    delegate.add_argument("--model", default="", help="optional runtime-specific model")
    delegate.add_argument("--opencode-agent", default="", help="optional OpenCode agent name")
    delegate.add_argument("--write-access", action="store_true", help="allow repository edits; otherwise use read-only/plan mode")
    delegate.add_argument(
        "--sandbox", choices=("read-only", "workspace-write", "danger-full-access"), default="",
        help="explicit Codex sandbox mode; defaults from --write-access",
    )
    delegate.add_argument(
        "--structured-outcome", action="store_true",
        help="require Codex to return completed, blocked, or failed with a summary",
    )
    delegate.add_argument("--unattended", action="store_true", help="disable agent approval prompts; dangerous on trusted targets only")
    delegate.add_argument("--close-on-success", action="store_true", help="close the workspace only after success")
    delegate.add_argument("--session", action="store_true", help="reuse a persistent Codex TUI for correlated turns")
    delegate.add_argument("--session-workspace", default="", help="agent workspace ID returned by an earlier session turn")
    delegate.add_argument("--accept-trust", action="store_true", help="accept only a recognized repository-trust prompt on session launch")
    delegate.add_argument(
        "--mode",
        choices=("review", "change", "deploy"),
        default="",
        help="delegation wait profile; inferred from --write-access when omitted",
    )
    delegate.add_argument(
        "--timeout",
        type=float,
        default=None,
        help="bounded controller wait override in seconds; does not limit worker runtime",
    )
    delegate.add_argument("--ready-timeout", type=float, default=30, help="shell/helper readiness timeout in seconds")
    delegate.add_argument("--gate-timeout", type=float, default=5, help="post-start session safety-gate observation in seconds")
    delegate.add_argument("--cols", type=int, default=120)
    delegate.add_argument("--rows", type=int, default=36)
    delegate.set_defaults(func=cmd_delegate)

    tui = subparsers.add_parser("tui", help="start a visible interactive OpenCode, Codex, or Claude TUI on a POSIX target")
    tui.add_argument("runtime", choices=("opencode", "codex", "claude"), help="agent CLI to start")
    tui.add_argument("machine", help="reachable POSIX machine id")
    tui.add_argument("--directory", required=True, help="absolute target working directory")
    tui.add_argument("--prompt-file", default="", help="UTF-8 prompt file; use - or pipe stdin")
    tui.add_argument("--no-prompt", action="store_true", help="start the TUI without submitting a prompt")
    tui.add_argument("--accept-trust", action="store_true", help="accept only a recognized repository-trust prompt")
    tui.add_argument("--title", default="", help="manual workspace title")
    tui.add_argument("--model", default="", help="optional runtime model")
    tui.add_argument("--opencode-agent", default="", help="optional OpenCode agent name")
    tui.add_argument("--timeout", type=float, default=30, help="prompt/activity verification timeout in seconds")
    tui.add_argument("--ready-timeout", type=float, default=30, help="shell/helper readiness timeout in seconds")
    tui.add_argument("--gate-timeout", type=float, default=5, help="post-start safety-gate observation in seconds (default: 5)")
    tui.add_argument("--cols", type=int, default=120)
    tui.add_argument("--rows", type=int, default=36)
    tui.set_defaults(func=cmd_tui)

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
    client = WmuxClient(
        safe_http_base(args.url, "--url/WMUX_URL"),
        default_token(args.token_path, args.automation_token_path, args.scoped_auth),
    )
    return args.func(client, args)


if __name__ == "__main__":
    sys.exit(main())
