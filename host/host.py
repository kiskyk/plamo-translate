"""Native messaging host: lets the extension start/stop the local PLaMo server.

Messages (JSON): {"cmd": "status"} / {"cmd": "start", "size": "2b"} / {"cmd": "stop"}
Reply: {"ok": bool, "up": bool, "model": str, "log": str}
"""
import json
import os
import struct
import subprocess
import sys
import tempfile
import urllib.request

PORT = 11437
SCRIPTS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server")
SIZES = {"0.8b", "2b", "8b"}
# The browser may run hosts inside a job object that kills children on exit; break away from it.
CREATE_BREAKAWAY_FROM_JOB = 0x01000000
FLAGS = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW


def read_msg():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    n = struct.unpack("<I", raw)[0]
    return json.loads(sys.stdin.buffer.read(n).decode("utf-8"))


def send(obj):
    data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)) + data)
    sys.stdout.buffer.flush()


def status():
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/props", timeout=2) as r:
            p = json.loads(r.read())
        return {"up": True, "model": os.path.basename(str(p.get("model_path", "")))}
    except Exception:
        return {"up": False, "model": ""}


def run_ps(script, *args, timeout=120):
    """Runs a script and returns its output. Output goes through a temp file, not a pipe:
    llama-server inherits the handles, and a pipe would never reach EOF while it runs."""
    cmd = ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", f"{SCRIPTS}/{script}", *args]
    with tempfile.TemporaryFile() as out:
        kw = dict(stdout=out, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, timeout=timeout)
        try:
            subprocess.run(cmd, creationflags=FLAGS | CREATE_BREAKAWAY_FROM_JOB, **kw)
        except OSError:  # job does not allow breakaway
            subprocess.run(cmd, creationflags=FLAGS, **kw)
        out.seek(0)
        return out.read().decode("utf-8", "replace").strip()


def main():
    msg = read_msg() or {}
    cmd = msg.get("cmd", "status")
    log = ""
    try:
        if cmd == "start":
            size = msg.get("size", "2b")
            if size not in SIZES:
                raise ValueError("size")
            log = run_ps("start-plamo.ps1", "-Size", size)
        elif cmd == "stop":
            log = run_ps("stop-plamo.ps1", timeout=30)
        send({"ok": True, **status(), "log": log})
    except Exception as e:
        send({"ok": False, **status(), "log": f"{type(e).__name__}: {e} {log}"})


if __name__ == "__main__":
    main()
