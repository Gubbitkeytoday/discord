# ============================================================================
#  Antigravity Discord — production image
#
#  Two stages: the first installs every dependency, builds the SPA and then
#  prunes to production dependencies; the second copies that pruned tree and the
#  built assets. Native modules (sqlite3, sharp) are therefore installed once,
#  in a stage that has a compiler available if no prebuilt binary matches the
#  platform, and the runtime image needs neither a toolchain nor network access
#  to npm. Both stages use the same base image, so the native ABI matches.
# ============================================================================

# --- stage 1: build ------------------------------------------------------------
FROM node:22-bookworm-slim AS build

# Only used when sqlite3 has no prebuilt binary for this platform/arch and has
# to compile from source (node-gyp). Never reaches the runtime image.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy manifests first so `npm ci` is cached until a dependency actually changes.
COPY package.json package-lock.json ./
# sqlite3 6.x ships prebuilt binaries linked against glibc 2.38, newer than
# bookworm's 2.36, so compile it against this image's libc instead.
RUN npm ci \
 && npm rebuild sqlite3 --build-from-source

COPY . .
RUN npm run build \
 && npm prune --omit=dev \
 && npm cache clean --force


# --- stage 2: runtime ---------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

# sharp ships its own libvips (@img/sharp-libvips-*), so no system libvips is
# needed. Without sharp at all the app still runs and stores originals as-is.

# media pipeline: optional ffmpeg for video posters/probing (docker build --build-arg WITH_FFMPEG=1).
ARG WITH_FFMPEG=0
RUN if [ "$WITH_FFMPEG" = "1" ]; then apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*; fi

ENV NODE_ENV=production \
    PORT=3001 \
    HOST=0.0.0.0 \
    SERVE_STATIC=1 \
    STATIC_DIR=dist \
    LOG_FORMAT=json \
    DB_PATH=/data/discord.db \
    STORAGE_ROOT=/data/uploads \
    BACKUP_DIR=/backups

WORKDIR /app

COPY package.json package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# Server code. Every root-level module server.js imports must be listed here —
# a missing one only shows up as ERR_MODULE_NOT_FOUND when the container boots.
COPY server.js realtime.js db.js storageService.js ./
COPY lib ./lib
COPY db ./db
COPY routes ./routes
COPY services ./services
COPY scripts ./scripts

# The database and uploads live on a volume, backups on another. The code stays
# owned by root, so a compromised process cannot rewrite it. Named volumes
# inherit this ownership on first mount, so the unprivileged user can write.
RUN mkdir -p /data/uploads /backups && chown -R node:node /data /backups

USER node
VOLUME ["/data", "/backups"]
EXPOSE 3001

# Liveness, not readiness: Docker restarts a container that is unhealthy
# (under an orchestrator or `autoheal`), and a database blip or a graceful drain
# should not get the process killed. /api/ready is for the reverse proxy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Node as PID 1 handles SIGTERM itself — server.js installs the handler and
# drains connections. --init in compose (init: true) reaps any stray children.
CMD ["node", "server.js"]
