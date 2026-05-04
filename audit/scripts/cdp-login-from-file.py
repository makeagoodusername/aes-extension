#!/usr/bin/env python3
"""Login wrapper: reads credentials from audit/credentials.json so secrets
never appear in argv or stdout. Usage: cdp-login-from-file.py <port>"""
from __future__ import annotations
import json, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from importlib import import_module
mod = import_module("cdp-login")  # type: ignore

if __name__ == "__main__":
    port = int(sys.argv[1])
    creds = json.loads((ROOT / "credentials.json").read_text())
    mod.login(port, creds["email"], creds["password"])
