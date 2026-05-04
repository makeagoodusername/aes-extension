#!/usr/bin/env bash
# run-eight.sh — launch 8 Chrome instances, one per AES audit agent.
#
# Each instance gets its own --user-data-dir (so storage + login state
# stay isolated), its own --remote-debugging-port (9233-9240), and the
# AES extension loaded from the real path (NOT a symlink — see
# F-9226-LIVE-003 in audit/live-port-9226.md).
#
# After all 8 are up and the CDP sockets respond, this script hands off
# to run-eight.py to inject credentials and navigate each Chrome to its
# agent's landing URL.
#
# Usage:
#   bash audit/scripts/run-eight.sh           # cold start
#   bash audit/scripts/run-eight.sh --no-login   # launch only, skip login

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUDIT_DIR="$(dirname "$SCRIPT_DIR")"
EXT_DIR="$(dirname "$AUDIT_DIR")"
PIDS_DIR="$AUDIT_DIR/.pids"
CREDS_FILE="$AUDIT_DIR/credentials.json"

DEFAULT_CHROME="$HOME/.cache/chrome-for-testing/chrome/mac_arm-148.0.7778.97/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
FALLBACK_CHROME_1="$HOME/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
FALLBACK_CHROME_2="$HOME/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
if [ -n "${CHROME_BIN:-}" ]; then
  CHROME="$CHROME_BIN"
elif [ -x "$DEFAULT_CHROME" ]; then
  CHROME="$DEFAULT_CHROME"
elif [ -x "$FALLBACK_CHROME_1" ]; then
  CHROME="$FALLBACK_CHROME_1"
elif [ -x "$FALLBACK_CHROME_2" ]; then
  CHROME="$FALLBACK_CHROME_2"
else
  CHROME="$DEFAULT_CHROME"
fi
if [ ! -x "$CHROME" ]; then
  echo "ERROR: Chrome for Testing binary not found at: $CHROME" >&2
  echo "       Stable Google Chrome currently ignores --load-extension in this setup." >&2
  echo "       Run 'npx playwright install chromium' or set CHROME_BIN to a Chrome for Testing/Chromium binary." >&2
  exit 1
fi

CHROME_VERSION="$("$CHROME" --version 2>/dev/null || true)"
case "$CHROME_VERSION" in
  *"Chrome for Testing"*|*"Chromium"*) ;;
  *)
    echo "ERROR: Refusing to use this Chrome binary for extension testing:" >&2
    echo "       $CHROME" >&2
    echo "       version: ${CHROME_VERSION:-unknown}" >&2
    echo "       Stable Google Chrome silently ignores --load-extension here; use Chrome for Testing." >&2
    exit 1
    ;;
esac

if [ ! -f "$CREDS_FILE" ]; then
  echo "ERROR: credentials file missing: $CREDS_FILE" >&2
  exit 1
fi

# Validate credentials are filled in (skip when --no-login).
DO_LOGIN=1
for arg in "$@"; do
  case "$arg" in
    --no-login) DO_LOGIN=0 ;;
  esac
done

if [ "$DO_LOGIN" = "1" ]; then
  python3 - "$CREDS_FILE" <<'PY'
import json, sys
p = sys.argv[1]
with open(p) as f:
    creds = json.load(f)
if not creds.get("email"):
    sys.exit("credentials.json: 'email' is empty — fill in your AS login")
if not creds.get("password"):
    sys.exit("credentials.json: 'password' is empty — fill in your AS login")
PY
fi

mkdir -p "$PIDS_DIR"

# Parallel arrays — index 0 = agent 1, ..., index 7 = agent 8.
PORTS=(9233 9234 9235 9236 9237 9238 9239 9240)
PROFILES=(
  "/tmp/chrome-aes-1"
  "/tmp/chrome-aes-2"
  "/tmp/chrome-aes-3"
  "/tmp/chrome-aes-4"
  "/tmp/chrome-aes-5"
  "/tmp/chrome-aes-6"
  "/tmp/chrome-aes-7"
  "/tmp/chrome-aes-8"
)
# Window-tile positions (4 across, 2 down).
POS_X=(0 720 1440 2160 0 720 1440 2160)
POS_Y=(0 0 0 0 720 720 720 720)

# 4x2 grid; AS pages need at least ~1100px wide to render the dashboard
# without horizontal scroll, but we trade fidelity for visibility here.
WIN_W=720
WIN_H=720

echo "Launching 8 Chrome for Testing instances from extension: $EXT_DIR"
echo "Chrome binary: $CHROME"
echo "(close them via: bash audit/scripts/stop-eight.sh)"
echo

for i in 0 1 2 3 4 5 6 7; do
  AGENT_NUM=$((i + 1))
  PORT="${PORTS[$i]}"
  PROFILE="${PROFILES[$i]}"
  X="${POS_X[$i]}"
  Y="${POS_Y[$i]}"
  PID_FILE="$PIDS_DIR/agent-$AGENT_NUM.pid"

  if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "[agent-$AGENT_NUM] port $PORT already in use — skipping launch."
    echo "                   If this is a stale Chrome from a previous run,"
    echo "                   run 'bash audit/scripts/stop-eight.sh' first."
    continue
  fi

  mkdir -p "$PROFILE"

  "$CHROME" \
    --user-data-dir="$PROFILE" \
    --remote-debugging-port="$PORT" \
    --load-extension="$EXT_DIR" \
    --disable-extensions-except="$EXT_DIR" \
    --no-first-run \
    --no-default-browser-check \
    --disable-features=ChromeWhatsNewUI \
    --window-position="$X","$Y" \
    --window-size="$WIN_W","$WIN_H" \
    "about:blank" \
    >/dev/null 2>&1 &

  CHROME_PID=$!
  echo "$CHROME_PID" > "$PID_FILE"
  echo "[agent-$AGENT_NUM] port=$PORT  pid=$CHROME_PID  profile=$PROFILE"
done

echo
echo "Waiting up to 30s for CDP sockets to come up..."
for i in 0 1 2 3 4 5 6 7; do
  AGENT_NUM=$((i + 1))
  PORT="${PORTS[$i]}"
  PID_FILE="$PIDS_DIR/agent-$AGENT_NUM.pid"
  [ -f "$PID_FILE" ] || continue

  for _ in $(seq 1 60); do
    if curl -sf "http://localhost:$PORT/json/version" >/dev/null 2>&1; then
      echo "[agent-$AGENT_NUM] CDP ready on $PORT"
      break
    fi
    sleep 0.5
  done
done

if [ "$DO_LOGIN" = "0" ]; then
  echo
  echo "--no-login set; skipping credential injection + URL navigation."
  exit 0
fi

echo
echo "Handing off to run-eight.py for login + landing-URL navigation..."
exec python3 "$SCRIPT_DIR/run-eight.py"
