FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    DISPLAY=:99 \
    SCREEN_WIDTH=1920 \
    SCREEN_HEIGHT=1080 \
    SCREEN_DEPTH=24

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    xvfb \
    openbox \
    x11vnc \
    novnc \
    websockify \
    python3-numpy \
    dbus-x11 \
    autocutsel \
    xclip \
    xdotool \
    x11-utils \
    socat \
    curl \
    jq \
    procps \
    ca-certificates \
    tini \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    fonts-liberation \
    fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

# Create non-root sandbox user matching Ubuntu host UID/GID 1000
RUN groupadd -g 1000 sandbox \
    && useradd -m -u 1000 -g 1000 -s /bin/bash sandbox

# Managed Chromium policy: set default download dir and restore session on startup
RUN mkdir -p /etc/chromium/policies/managed \
    && cat <<'EOF' > /etc/chromium/policies/managed/sandbox-policy.json
{
  "DownloadDirectory": "/data/downloads",
  "PromptForDownloadLocation": false,
  "DefaultBrowserSettingEnabled": false,
  "MetricsReportingEnabled": false,
  "RestoreOnStartup": 1,
  "CloudReportingEnabled": false,
  "BrowserSignin": 0,
  "SyncDisabled": true
}
EOF

# Redirect noVNC root to auto-connecting scaled VNC client
RUN cat <<'EOF' > /usr/share/novnc/index.html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="refresh" content="0; url=vnc.html?autoconnect=true&resize=scale&reconnect=true&reconnect_delay=2000&path=websockify" />
  <title>Browser Sandbox - noVNC</title>
</head>
<body>
  <p>Redirecting to <a href="vnc.html?autoconnect=true&resize=scale&reconnect=true&reconnect_delay=2000&path=websockify">noVNC</a>...</p>
</body>
</html>
EOF

WORKDIR /app
COPY browser/ /app/browser/
COPY config/ /app/config/

RUN chmod +x /app/browser/*.sh \
    && mkdir -p /data/chrome-profile /data/downloads /data/screenshots /logs \
    && chown -R sandbox:sandbox /app /data /logs

USER sandbox

EXPOSE 6080 9223

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD /app/browser/healthcheck.sh

ENTRYPOINT ["/usr/bin/tini", "--", "/app/browser/entrypoint.sh"]
