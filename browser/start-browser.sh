#!/usr/bin/env bash
set -euo pipefail

CONFIG_FILE="${BROWSER_CONFIG:-/app/config/browser.json}"
USER_DATA_DIR="${USER_DATA_DIR:-$(jq -r '.userDataDir // "/data/chrome-profile"' "$CONFIG_FILE")}"
CDP_PORT="${CDP_PORT:-$(jq -r '.cdpPort // 9222' "$CONFIG_FILE")}"
SCREEN_WIDTH="${SCREEN_WIDTH:-$(jq -r '.viewport.width // 1920' "$CONFIG_FILE")}"
SCREEN_HEIGHT="${SCREEN_HEIGHT:-$(jq -r '.viewport.height // 1080' "$CONFIG_FILE")}"
STARTUP_URL="${STARTUP_URL:-$(jq -r '.startupUrl // "about:blank"' "$CONFIG_FILE")}"
LOG_DIR="/logs"

mkdir -p "$USER_DATA_DIR" "$LOG_DIR"

log() {
  echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] [browser] $*"
}

# Enforce single Chromium instance per profile using flock
LOCK_FILE="${USER_DATA_DIR}/.browser-sandbox.lock"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "ERROR: Another browser instance already holds lock ${LOCK_FILE}. Aborting to prevent profile corruption."
  exit 1
fi

STOP_REQUESTED=0
CHROME_PID=""

handle_term() {
  STOP_REQUESTED=1
  log "Graceful shutdown requested for Chromium..."
  if [ -n "$CHROME_PID" ] && kill -0 "$CHROME_PID" 2>/dev/null; then
    # Close Chromium windows cleanly over X11 first so Cookies/LocalStorage/IndexedDB flush immediately
    for win in $(xdotool search --onlyvisible --class chromium 2>/dev/null || true); do
      xdotool windowclose "$win" 2>/dev/null || true
    done
    sleep 1
    if kill -0 "$CHROME_PID" 2>/dev/null; then
      kill -TERM "$CHROME_PID" 2>/dev/null || true
    fi
    for _ in $(seq 1 40); do
      if ! kill -0 "$CHROME_PID" 2>/dev/null; then
        break
      fi
      sleep 0.25
    done
    if kill -0 "$CHROME_PID" 2>/dev/null; then
      log "Chromium did not exit in time; sending SIGKILL."
      kill -KILL "$CHROME_PID" 2>/dev/null || true
    fi
  fi
  exit 0
}

trap handle_term SIGTERM SIGINT

# Read extraArgs from config/browser.json
mapfile -t EXTRA_ARGS < <(jq -r '.extraArgs[]? // empty' "$CONFIG_FILE")

while [ "$STOP_REQUESTED" -eq 0 ]; do
  # Only clear stale Chromium singleton locks when no chromium process is running
  if ! pgrep -u "$(id -u)" -x chromium >/dev/null 2>&1; then
    rm -f "${USER_DATA_DIR}/SingletonLock" "${USER_DATA_DIR}/SingletonSocket" "${USER_DATA_DIR}/SingletonCookie"
  else
    log "WARNING: Existing chromium process detected; waiting before launch..."
    sleep 2
    continue
  fi

  ARGS=(
    "--user-data-dir=${USER_DATA_DIR}"
    "--remote-debugging-port=${CDP_PORT}"
    "--remote-debugging-address=127.0.0.1"
    "--window-position=0,0"
    "--window-size=${SCREEN_WIDTH},${SCREEN_HEIGHT}"
    "--lang=zh-CN"
  )
  ARGS+=("${EXTRA_ARGS[@]}")

  # If this is a fresh profile (no Preferences yet), open startup URL; otherwise let RestoreOnStartup reopen previous tabs
  if [ ! -f "${USER_DATA_DIR}/Default/Preferences" ]; then
    ARGS+=("${STARTUP_URL}")
  fi

  log "Launching Chromium (PID watchdog) with persistent profile: ${USER_DATA_DIR}"
  /usr/bin/chromium "${ARGS[@]}" >>"${LOG_DIR}/chromium.log" 2>&1 &
  CHROME_PID=$!
  log "Chromium started with PID ${CHROME_PID}"

  set +e
  wait "$CHROME_PID"
  EXIT_CODE=$?
  set -e
  CHROME_PID=""

  if [ "$STOP_REQUESTED" -eq 1 ]; then
    log "Chromium exited cleanly during shutdown (code=${EXIT_CODE})."
    break
  fi

  log "Chromium exited unexpectedly (code=${EXIT_CODE}). Restarting in 2s..."
  sleep 2
done
