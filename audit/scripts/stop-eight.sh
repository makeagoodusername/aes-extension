#!/usr/bin/env bash
# stop-eight.sh — graceful shutdown of all 8 audit Chromes.
#
# Reads PIDs from audit/.pids/agent-*.pid and TERMs each Chrome.
# Profile dirs at /tmp/chrome-aes-* are preserved by default so the next
# run-eight.sh skips re-login. Pass --clean to wipe profiles too.
#
# Usage:
#   bash audit/scripts/stop-eight.sh
#   bash audit/scripts/stop-eight.sh --clean

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUDIT_DIR="$(dirname "$SCRIPT_DIR")"
PIDS_DIR="$AUDIT_DIR/.pids"

CLEAN=0
for arg in "$@"; do
  case "$arg" in
    --clean) CLEAN=1 ;;
  esac
done

if [ ! -d "$PIDS_DIR" ]; then
  echo "No pidfiles at $PIDS_DIR — nothing to stop."
  exit 0
fi

shopt -s nullglob
PIDFILES=("$PIDS_DIR"/agent-*.pid)
if [ "${#PIDFILES[@]}" -eq 0 ]; then
  echo "No pidfiles in $PIDS_DIR — nothing to stop."
  exit 0
fi

for PIDFILE in "${PIDFILES[@]}"; do
  AGENT=$(basename "$PIDFILE" .pid)
  PID=$(cat "$PIDFILE" 2>/dev/null || echo "")
  if [ -z "$PID" ]; then
    rm -f "$PIDFILE"
    continue
  fi
  if kill -0 "$PID" 2>/dev/null; then
    kill -TERM "$PID" 2>/dev/null || true
    echo "[$AGENT] sent SIGTERM to pid $PID"
  else
    echo "[$AGENT] pid $PID already gone"
  fi
done

# Give Chrome up to 5s to wind down; then SIGKILL the holdouts.
sleep 5
for PIDFILE in "${PIDFILES[@]}"; do
  AGENT=$(basename "$PIDFILE" .pid)
  PID=$(cat "$PIDFILE" 2>/dev/null || echo "")
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    kill -KILL "$PID" 2>/dev/null || true
    echo "[$AGENT] hard-killed pid $PID"
  fi
  rm -f "$PIDFILE"
done

if [ "$CLEAN" = "1" ]; then
  for i in 1 2 3 4 5 6 7 8; do
    DIR="/tmp/chrome-aes-$i"
    if [ -d "$DIR" ]; then
      rm -rf "$DIR"
      echo "removed profile dir: $DIR"
    fi
  done
fi

echo "Done."
