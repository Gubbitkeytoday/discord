# ============================================================================
#  Antigravity Discord — production image
#
#  Two stages: the first installs every dependency and builds the SPA, the second
#  keeps only production dependencies and the built assets. Building in the image
#  rather than copying a local dist/ means the artefact is reproducible from the
#  repository alone.
# ============================================================================

# --- stage 1: build the client ------------------------------------------------
FROM node:22-bookworm-slim AS build

WORKDIR /app

# Copy manifests first so `npm ci` is cached until a dependency actually changes.
COPY package.json package-lock.json* ./
RUN npm ci

COPY . .
RUN npm run build


# --- stage 2: runtime ---------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

# sharp needs libvips at runtime for image variants; without it the app still
# runs and simply stores originals unchanged.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libvips42 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=3001 \
    HOST=0.0.0.0 \
    SERVE_STATIC=1 \
    STATIC_DIR=dist \
    LOG_FORMAT=json \
    DB_PATH=/data/discord.db \
    STORAGE_ROOT=/data/uploads

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

# Application code and the client bundle from stage 1.
COPY --from=build /app/dist ./dist
COPY server.js ./
COPY db.js ./
COPY lib ./lib
COPY db ./db
COPY routes ./routes
COPY services ./services
COPY scripts ./scripts

# The database and uploads live on a volume; everything else is immutable.
RUN mkdir -p /data/uploads && chown -R node:node /data /app

USER node
VOLUME ["/data"]
EXPOSE 3001

# Readiness is the honest health signal: it checks the database, and reports
# unhealthy while the process is draining.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Node as PID 1 handles SIGTERM itself — server.js installs the handler and
# drains connections, so no init shim is needed.
CMD ["node", "server.js"]
