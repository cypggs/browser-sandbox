#!/usr/bin/env bash
set -euo pipefail

export DISPLAY="${DISPLAY:-:99}"
SCREEN_WIDTH="${SCREEN_WIDTH:-1920}"
SCREEN_HEIGHT="${SCREEN_HEIGHT:-1080}"
SCREEN_DEPTH="${SCREEN_DEPTH:-24}"
NOVNC_PORT="${NOVNC_PORT:-6080}"
CDP_PORT="${CDP_PORT:-9222}"
CDP_PROXY_PORT="${CDP_PROXY_PORT:-9223}"
LOG_DIR="/logs"

mkdir -p "$LOG_DIR" /data/chrome-profile /data/downloads /data/screenshots

log() {
  echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] [entrypoint] $*"
}

if [ -z "${VNC_PASSWORD:-}" ]; then
  log "ERROR: VNC_PASSWORD is required and must not be empty."
  exit 1
fi

PIDS=()
BROWSER_WATCHDOG_PID=""

cleanup() {
  log "Received termination signal, shutting down gracefully..."
  if [ -n "$BROWSER_WATCHDOG_PID" ] && kill -0 "$BROWSER_WATCHDOG_PID" 2>/dev/null; then
    kill -TERM "$BROWSER_WATCHDOG_PID" 2>/dev/null || true
    wait "$BROWSER_WATCHDOG_PID" 2>/dev/null || true
  fi
  for pid in "${PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
    fi
  done
  wait 2>/dev/null || true
  rm -f /tmp/.vncpass
  log "Shutdown complete."
  exit 0
}

trap cleanup SIGTERM SIGINT

# Clean up any stale X lock for :99 after an unclean crash
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99

# Start D-Bus session for Chromium IPC/clipboard/desktop integration
if command -v dbus-launch >/dev/null 2>&1; then
  eval "$(dbus-launch --sh-syntax)"
  export DBUS_SESSION_BUS_ADDRESS
fi

log "Starting Xvfb on ${DISPLAY} (${SCREEN_WIDTH}x${SCREEN_HEIGHT}x${SCREEN_DEPTH})..."
Xvfb "${DISPLAY}" -screen 0 "${SCREEN_WIDTH}x${SCREEN_HEIGHT}x${SCREEN_DEPTH}" -ac +extension GLX +render -noreset \
  >"${LOG_DIR}/xvfb.log" 2>&1 &
PIDS+=($!)

for i in $(seq 1 30); do
  if xdpyinfo -display "${DISPLAY}" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

if ! xdpyinfo -display "${DISPLAY}" >/dev/null 2>&1; then
  log "ERROR: Xvfb failed to start."
  exit 1
fi
log "Xvfb ready."

# Start Openbox window manager
log "Starting Openbox..."
openbox --config-file /app/config/openbox/rc.xml >"${LOG_DIR}/openbox.log" 2>&1 &
PIDS+=($!)
sleep 0.5

# Enable X11 clipboard synchronization for copy/paste via noVNC
autocutsel -fork -selection CLIPBOARD >/dev/null 2>&1 || true
autocutsel -fork -selection PRIMARY >/dev/null 2>&1 || true

# Configure x11vnc password without logging it
VNC_PASS_FILE="/tmp/.vncpass"
rm -f "${VNC_PASS_FILE}"
x11vnc -storepasswd "${VNC_PASSWORD}" "${VNC_PASS_FILE}" >/dev/null 2>&1
chmod 600 "${VNC_PASS_FILE}"

log "Starting x11vnc on 127.0.0.1:5900..."
x11vnc \
  -display "${DISPLAY}" \
  -rfbport 5900 \
  -listen 127.0.0.1 \
  -rfbauth "${VNC_PASS_FILE}" \
  -forever \
  -shared \
  -noxdamage \
  -xkb \
  -repeat \
  -cursor arrow \
  -o "${LOG_DIR}/x11vnc.log" >/dev/null 2>&1 &
PIDS+=($!)

log "Starting websockify/noVNC on 0.0.0.0:${NOVNC_PORT}..."
websockify --web=/usr/share/novnc/ "0.0.0.0:${NOVNC_PORT}" 127.0.0.1:5900 \
  >"${LOG_DIR}/novnc.log" 2>&1 &
PIDS+=($!)

# Forward container eth0:9223 -> 127.0.0.1:9222 so Docker host loopback (127.0.0.1:9222) works
log "Starting internal CDP loopback bridge (0.0.0.0:${CDP_PROXY_PORT} -> 127.0.0.1:${CDP_PORT})..."
socat "TCP-LISTEN:${CDP_PROXY_PORT},bind=0.0.0.0,fork,reuseaddr" "TCP:127.0.0.1:${CDP_PORT}" \
  >"${LOG_DIR}/cdp-proxy.log" 2>&1 &
PIDS+=($!)

log "Starting Chromium watchdog..."
/app/browser/start-browser.sh &
BROWSER_WATCHDOG_PID=$!

# Keep container alive as long as watchdog is running
wait "$BROWSER_WATCHDOG_PID"
