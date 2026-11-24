#!/usr/bin/env bash
set -euo pipefail

# 1. Verify Xvfb display is accessible
xdpyinfo -display "${DISPLAY:-:99}" >/dev/null 2>&1

# 2. Verify Chromium CDP endpoint is responding on localhost
curl -sf --max-time 3 "http://127.0.0.1:${CDP_PORT:-9222}/json/version" >/dev/null

# 3. Verify noVNC HTTP endpoint is responding
curl -sf --max-time 3 "http://127.0.0.1:${NOVNC_PORT:-6080}/vnc.html" >/dev/null

exit 0
