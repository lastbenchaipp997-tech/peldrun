"""Starts the backend exactly like the desktop shell does and checks /api/health.

Cross-platform (used by CI on Windows, macOS and Linux):
    python desktop/scripts/backend-smoke.py [--port 18088] [--timeout 120]
Run it from anywhere; it needs the backend requirements installed.
"""
import argparse
import os
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--port", type=int, default=18088)
parser.add_argument("--timeout", type=int, default=120)
args = parser.parse_args()

backend = Path(__file__).resolve().parents[2] / "backend"
storage = tempfile.mkdtemp(prefix="peldrun-smoke-")
code = (
    "import asyncio, sys, uvicorn\n"
    + ("asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())\n" if sys.platform == "win32" else "")
    + f"uvicorn.run('omweb.main:app', host='127.0.0.1', port={args.port}, reload=False)"
)
env = {**os.environ, "PYTHONUNBUFFERED": "1", "PYTHONUTF8": "1", "PELDRUN_STORAGE_ROOT": storage}
proc = subprocess.Popen([sys.executable, "-c", code], cwd=backend, env=env)
try:
    deadline = time.time() + args.timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            sys.exit(f"backend exited early with code {proc.returncode}")
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{args.port}/api/health", timeout=2) as r:
                if r.status == 200:
                    print("backend smoke test: OK", r.read().decode())
                    sys.exit(0)
        except OSError:
            time.sleep(0.5)
    sys.exit("timed out waiting for /api/health")
finally:
    proc.terminate()
    try:
        proc.wait(10)
    except subprocess.TimeoutExpired:
        proc.kill()
