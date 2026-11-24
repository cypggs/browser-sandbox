FROM node:22-bookworm-slim AS builder

WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install
COPY src/ ./src/
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# Run as existing non-root user 'node' (UID 1000, GID 1000) matching host ubuntu & browser sandbox user
RUN mkdir -p /data/downloads /data/screenshots /logs \
    && chown -R node:node /app /data /logs

USER node

ENV NODE_ENV=production \
    AGENT_HOST=0.0.0.0 \
    AGENT_PORT=3800 \
    CDP_URL=http://127.0.0.1:9222 \
    DOWNLOADS_DIR=/data/downloads \
    SCREENSHOTS_DIR=/data/screenshots

EXPOSE 3800

HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -sf --max-time 3 http://127.0.0.1:3800/health >/dev/null || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "node", "dist/server.js"]
