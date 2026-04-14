# syntax=docker/dockerfile:1
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src/ ./src/
RUN npm run build && npm prune --omit=dev

FROM node:20-alpine AS runtime
RUN apk add --no-cache tini universal-ctags
RUN npm install -g typescript-language-server typescript
RUN addgroup -S bridge && adduser -S bridge -G bridge
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
RUN mkdir -p /data/claude/ide && chown -R bridge:bridge /data /app
USER bridge
ENV CLAUDE_CONFIG_DIR=/data/claude
# Expose on all interfaces inside the container so the host can reach it
ENV BRIDGE_BIND_ADDRESS=0.0.0.0
EXPOSE 18765
HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-18765}/ping" || exit 1
ENTRYPOINT ["tini", "--", "node", "dist/index.js"]
CMD ["--workspace", "/workspace", "--bind", "0.0.0.0"]
