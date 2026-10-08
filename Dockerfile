# Multi-stage build for the Generic REST Adapter (Mode B)
# Final image: ~150MB, non-root, healthcheck-aware.

# ---- build stage ----
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* tsconfig.json nest-cli.json ./
RUN npm ci --include=dev
COPY src ./src
RUN npm run build

# ---- runtime stage ----
FROM node:20-alpine AS runtime
WORKDIR /app

RUN addgroup -S adapter && adduser -S adapter -G adapter

# Dependencies and code are installed as root and stay root-owned, so the
# running process cannot modify its own code. (Installing as `adapter` into
# the root-owned /app failed with EACCES: the image never built.)
COPY --from=builder /app/package.json /app/package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=builder /app/dist ./dist

# The example config ships in the image so a distributor can start from it
# without the source tree: docker run --rm <image> cat /app/configs.example/example.json
# Owner-only mode so --validate-only passes the strict file-permission check.
# The directory is created first: COPY --chmod would apply 0600 to it as well.
RUN mkdir -m 0755 configs.example
COPY --chown=adapter:adapter --chmod=0600 configs/example.json ./configs.example/example.json
# LICENSE is added to the context by scripts/release-connector.sh. package.json
# keeps the wildcard COPY valid when building from the monorepo without one.
COPY package.json LICENSE* ./

# Fallback audit log (FallbackAuditService). The code default,
# ${CONFIG_DIR}/../fallback-audit.jsonl, is /fallback-audit.jsonl here, which
# the adapter user cannot write. Point it at an adapter-owned directory; mount
# a volume on it to keep the log across container restarts. Overridable with
# -e FALLBACK_AUDIT_LOG_PATH=...
RUN mkdir -p /var/lib/floatra-adapter \
 && chown adapter:adapter /var/lib/floatra-adapter \
 && chmod 0750 /var/lib/floatra-adapter
ENV FALLBACK_AUDIT_LOG_PATH=/var/lib/floatra-adapter/fallback-audit.jsonl

# Non-root at runtime: matches the rest of the Floatra stack.
USER adapter:adapter

# CONFIG_DIR is bind-mounted at deploy time:
#   docker run -v /opt/floatra-adapter-configs:/configs -e CONFIG_DIR=/configs ...
ENV CONFIG_DIR=/configs
ENV PORT=3100
EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3100/adapter/health || exit 1

CMD ["node", "dist/main.js"]
