# syntax=docker/dockerfile:1.7
# ============================================================================
#  Antigravity Discord — production image
#
#  Two stages on the same Debian release (13 "trixie", glibc 2.41):
#
#   build    node:24-trixie-slim — installs every dependency, builds the SPA,
#            prunes to production dependencies. Has a compiler, used only if a
#            native module (sqlite3, sharp) has no prebuilt binary that loads.
#   runtime  gcr.io/distroless/nodejs24-debian13:nonroot — Node 24 LTS and
#            glibc/libstdc++ only: no shell, no package manager, uid 65532.
#
#  Native modules are compiled/verified in the build stage and copied over;
#  both stages share the Debian release, so the libc ABI matches. sqlite3 6.x
#  prebuilt binaries need glibc >= 2.38 (bookworm has 2.36, trixie 2.41), and
#  the build falls back to compiling from source if the prebuilt does not load.
#
#  Read-only root filesystem compatible: the app writes only to /data
#  (database + uploads) and /backups, both volumes. See DEPLOYMENT.md,
#  "Container hardening".
#
#  Build args (CI passes them; all optional):
#    GIT_SHA     → APP_RELEASE (error-tracking release, /api/telemetry/config)
#    BUILD_DATE  → org.opencontainers.image.created
#    VERSION     → org.opencontainers.image.version
# ============================================================================

ARG NODE_IMAGE=node:24-trixie-slim
ARG RUNTIME_IMAGE=gcr.io/distroless/nodejs24-debian13:nonroot

# --- stage 1: build ------------------------------------------------------------
FROM ${NODE_IMAGE} AS build

# python3/make/g++: node-gyp fallback only. tini: copied (static) into runtime.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Manifests first so `npm ci` is cached until a dependency actually changes.
COPY package.json package-lock.json ./
RUN npm ci \
 && (node -e "require('sqlite3')" || npm rebuild sqlite3 --build-from-source) \
 && node -e "require('sqlite3')"

# After pruning: drop musl (Alpine) binaries npm installs alongside the glibc
# ones (~35 MB, never loaded here), fail the build — not the first boot — if a
# native module cannot load, and create the volume mount points for runtime.
COPY . .
RUN npm run build \
 && npm prune --omit=dev \
 && npm cache clean --force \
 && rm -rf node_modules/@img/*musl* node_modules/lightningcss-*-musl node_modules/@tailwindcss/oxide-*-musl \
 && node -e "require('sqlite3'); try { require('sharp') } catch (e) { console.warn('sharp unavailable:', e.message) }" \
 && mkdir -p /rootfs/data/uploads /rootfs/backups


# --- stage 2: runtime ---------------------------------------------------------
FROM ${RUNTIME_IMAGE} AS runtime

ARG GIT_SHA=unknown
ARG BUILD_DATE=unknown
ARG VERSION=1.0.0

LABEL org.opencontainers.image.title="antigravity-discord" \
      org.opencontainers.image.description="Self-hosted Discord-style chat: Express + Socket.IO + React" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.base.name="gcr.io/distroless/nodejs24-debian13:nonroot" \
      org.opencontainers.image.licenses="UNLICENSED"

# sharp ships its own libvips (@img/sharp-libvips-*); distroless provides the
# glibc/libstdc++ it links against. Without sharp the app still runs and stores
# originals as-is. /nodejs/bin on PATH so `docker compose exec app node …` works.
ENV NODE_ENV=production \
    PATH=/nodejs/bin:/usr/local/bin:/usr/bin:/bin \
    PORT=3001 \
    HOST=0.0.0.0 \
    SERVE_STATIC=1 \
    STATIC_DIR=dist \
    LOG_FORMAT=json \
    DB_PATH=/data/discord.db \
    STORAGE_ROOT=/data/uploads \
    BACKUP_DIR=/backups \
    APP_RELEASE=${GIT_SHA}

WORKDIR /app

# tini as PID 1: forwards SIGTERM to node (server.js drains on it) and reaps
# zombies. The static build needs nothing from the base image.
COPY --from=build /usr/bin/tini-static /usr/bin/tini

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# Server code. Every root-level module server.js imports must be listed here —
# a missing one only shows up as ERR_MODULE_NOT_FOUND when the container boots.
# Owned by root, so a compromised process cannot rewrite it.
COPY --from=build /app/server.js /app/realtime.js /app/db.js /app/storageService.js ./
COPY --from=build /app/lib ./lib
COPY --from=build /app/db ./db
COPY --from=build /app/routes ./routes
COPY --from=build /app/services ./services
COPY --from=build /app/scripts ./scripts

# Named volumes inherit this ownership on first mount, so the unprivileged
# user can write to them.
COPY --from=build --chown=65532:65532 /rootfs/data /data
COPY --from=build --chown=65532:65532 /rootfs/backups /backups

USER 65532:65532
VOLUME ["/data", "/backups"]
EXPOSE 3001

# Liveness, not readiness: Docker restarts a container that is unhealthy
# (under an orchestrator or `autoheal`), and a database blip or a graceful drain
# should not get the process killed. /api/ready is for the reverse proxy.
# Exec form: there is no shell in this image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# -s: tini also works when compose's `init: true` already put docker-init at
# PID 1. The command starts with `node` (resolved via PATH) so that
# `docker compose run --rm app node scripts/backup.mjs …` keeps working. The
# OpenTelemetry preload is a no-op unless OTEL_EXPORTER_OTLP_ENDPOINT is set.
ENTRYPOINT ["/usr/bin/tini", "-s", "--"]
CMD ["node", "--import", "./lib/otel-preload.mjs", "server.js"]
