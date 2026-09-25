#!/usr/bin/env python3
"""Read-only Linux evidence for wmux exact-task attachment.

Input is one bounded JSON object on stdin.  This program never resumes a
thread, changes guard configuration, or starts/stops a service.  The server
keeps its receipt private and binds it to the following managed launch.
"""
import hashlib
import json
import os
import pathlib
import socket
import stat
import subprocess
import sys

MAX = 8192

def fail(reason=None):
    print(json.dumps({"ok": False, **({"reason": reason} if reason else {})}))
    return 1

def digest_file(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for block in iter(lambda: f.read(65536), b""):
            h.update(block)
    return h.hexdigest()

def digest_tree(root):
    root = pathlib.Path(root).resolve(strict=True)
    h = hashlib.sha256()
    count = 0
    for p in sorted(root.rglob("*")):
        if not p.is_file() or p.is_symlink():
            continue
        relative = p.relative_to(root)
        # Guard readiness may create Python bytecode.  Hash release sources,
        # executable wrappers and descriptors, never generated `__pycache__`
        # artifacts, so re-attestation detects source drift without inventing
        # a false generation change merely by checking readiness.
        if "__pycache__" in relative.parts or p.suffix in (".pyc", ".pyo"):
            continue
        count += 1
        if count > 4096 or p.stat().st_size > 16 * 1024 * 1024:
            raise ValueError()
        h.update(str(relative).encode() + b"\0" + bytes.fromhex(digest_file(p)))
    return h.hexdigest()

def private_regular(p):
    s = os.lstat(p)
    return stat.S_ISREG(s.st_mode) and not stat.S_ISLNK(s.st_mode) and s.st_uid == os.getuid() and not (s.st_mode & 0o077)

def socket_peer(p):
    s = os.lstat(p)
    if not stat.S_ISSOCK(s.st_mode) or s.st_uid != os.getuid() or s.st_mode & 0o077:
        raise ValueError()
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.settimeout(1)
    try:
        client.connect(p)
        connected = os.lstat(p)
        if (connected.st_dev, connected.st_ino, connected.st_uid, connected.st_mode) != (s.st_dev, s.st_ino, s.st_uid, s.st_mode):
            raise ValueError()
        creds = client.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
        pid = int.from_bytes(creds[0:4], sys.byteorder)
        uid = int.from_bytes(creds[4:8], sys.byteorder)
    finally:
        client.close()
    if uid != os.getuid() or pid <= 1:
        raise ValueError()
    # `/proc/PID/stat`'s second field is parenthesized and can contain spaces;
    # splitting the whole line would read the wrong starttime for such a
    # process.  Field 22 is index 19 after state (field 3).
    raw = pathlib.Path("/proc", str(pid), "stat").read_text()
    close = raw.rfind(")")
    fields = raw[close + 2:].split()
    if close < 2 or len(fields) <= 19: raise ValueError()
    start = fields[19]
    exe = os.path.realpath(f"/proc/{pid}/exe")
    return os.path.realpath(p), s.st_dev, s.st_ino, pid, start, exe

def inspect(data):
    if sys.platform != "linux" or not isinstance(data, dict): raise ValueError()
    socket_path, launcher, deployment = (data.get(k) for k in ("socketPath", "launcherPath", "deploymentPath"))
    if not all(isinstance(x, str) and x.startswith("/") and len(x) <= 4096 for x in (socket_path, launcher, deployment)):
        raise ValueError()
    launcher = os.path.realpath(launcher)
    deployment = os.path.realpath(deployment)
    # The user-facing launcher is a small private shim outside the immutable
    # release.  Pin its bytes and require it to exec this exact release binary.
    if not private_regular(launcher):
        raise ValueError()
    deployment_stat = os.lstat(deployment)
    if not stat.S_ISDIR(deployment_stat.st_mode) or os.path.islink(deployment) or deployment_stat.st_uid != os.getuid() or deployment_stat.st_mode & 0o077: raise ValueError()
    release_cli = os.path.join(deployment, "bin", "codex-guard")
    if not private_regular(release_cli) or release_cli.encode() not in pathlib.Path(launcher).read_bytes():
        raise ValueError()
    sock, socket_dev, socket_ino, pid, start, exe = socket_peer(socket_path)
    descriptor = os.path.join(deployment, "etc", "enforce.json")
    guard_python = os.path.join(deployment, "venv", "bin", "python")
    cwd = data.get("cwd")
    if cwd is not None and (not isinstance(cwd, str) or not cwd.startswith("/")): raise ValueError()
    if not private_regular(descriptor) or not os.path.exists(guard_python): raise ValueError()
    config = json.loads(pathlib.Path(descriptor).read_text())
    if config.get("socket") != socket_path or config.get("upstream_socket") != socket_path or config.get("policy", {}).get("mode") != "enforce": raise ValueError()
    command = [guard_python, "-I", "-m", "codex_usage_guard", "installation-status", "--config", descriptor, "--require-ready"]
    if cwd: command.extend(["--cwd", cwd])
    status = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=3, check=False, text=True)
    if status.returncode != 0:
        raise ValueError()
    # The managed TUI can use the exact running server image even after a CLI
    # package update unlinks it. Keep native version qualification in the guard.
    native_path = f"/proc/{pid}/exe"
    executable = os.stat(native_path)
    qualified = subprocess.run([guard_python, "-I", "-c",
        "import sys; from codex_usage_guard.launch import check_native; check_native(sys.argv[1])", native_path],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=3, check=False)
    if qualified.returncode != 0:
        raise ValueError("attachment_native_version_unqualified")
    current_executable = os.stat(native_path)
    if socket_peer(socket_path) != (sock, socket_dev, socket_ino, pid, start, exe) or any(
        getattr(current_executable, key) != getattr(executable, key) for key in ("st_dev", "st_ino", "st_size", "st_mtime_ns")
    ):
        raise ValueError()
    generation = hashlib.sha256(f"{sock}\0{socket_dev}\0{socket_ino}\0{pid}\0{start}\0{exe}".encode()).hexdigest()
    return {"ready": True, "policy": "enforce", "account": os.getuid(), "socket": sock,
            "socketDev": socket_dev, "socketIno": socket_ino, "peerPid": pid, "peerStart": start, "peerExe": exe, "generation": generation,
            "nativePath": native_path, "peerExeDev": executable.st_dev, "peerExeIno": executable.st_ino,
            "launcherHash": digest_file(launcher), "descriptorHash": digest_file(descriptor),
            "deploymentHash": digest_tree(deployment)}

def main():
    try:
        raw = sys.stdin.buffer.read(MAX + 1)
        if len(raw) > MAX: return fail()
        data = json.loads(raw)
        if len(sys.argv) != 2 or sys.argv[1] not in ("inspect", "attest"): return fail()
        receipt = inspect(data)
        # `attest` is the launcher-side immediate recheck.  The server binds
        # this receipt to endpoint/thread/fingerprint; the helper only owns
        # the live route generation and must see it unchanged.
        expected = data.get("expectedReceipt")
        if sys.argv[1] == "attest" and (not isinstance(expected, dict) or expected != receipt): return fail()
        print(json.dumps({"ok": True, "receipt": receipt}, separators=(",", ":")))
        return 0
    except ValueError as error:
        return fail(str(error) if str(error) == "attachment_native_version_unqualified" else None)
    except Exception:
        return fail()

if __name__ == "__main__": sys.exit(main())
