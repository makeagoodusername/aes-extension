#!/usr/bin/env python3
"""Login wrapper: reads credentials from audit/credentials.json so secrets
never appear in argv or stdout. Usage: cdp-login-from-file.py <port>"""
from __future__ import annotations
import json, sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
ROOT = SCRIPT_DIR.parent
sys.path.insert(0, str(SCRIPT_DIR))
from importlib import import_module
mod = import_module("cdp-login-v2")  # type: ignore

if __name__ == "__main__":
    port = int(sys.argv[1])
    creds = json.loads((ROOT / "credentials.json").read_text())
    mod.login(port, creds["email"], creds["password"])
