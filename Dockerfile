# syntax=docker/dockerfile:1

###############################################################################
# Stage 1: deps — install production + dev dependencies (native modules like
# better-sqlite3 and node-pty must compile, so devDependencies + build tools
# are required in this stage).
###############################################################################
FROM node:22-bookworm-slim AS deps

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ git \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./

# Install all deps without lifecycle scripts (the repo's fix-node-pty
# postinstall is Windows-oriented and fails in a Linux slim build). Native
# modules are compiled explicitly right after so better-sqlite3 and node-pty
# ship working binaries built against this container's Node ABI.
RUN npm ci --include=dev --ignore-scripts \
  && npm rebuild better-sqlite3 node-pty

###############################################################################
# Stage 2: build — compile the client (vite) and server (tsc + tsc-alias)
###############################################################################
FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN npm run build

###############################################################################
# Stage 3: runtime — production image with compiled artifacts
###############################################################################
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV SERVER_PORT=3001
# CloudCLI persists SQLite/auth/assets under the user home by default. Point
# HOME and the DB at /data so ALL app state lives under one persistent
# directory that a single volume/bind mount can back.
ENV HOME=/data
ENV DATABASE_PATH=/data/auth.db

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Compiled artifacts + node_modules with native modules already built in the
# deps stage (same Node ABI). shared/ and electron/ are referenced by the
# compiled server for path resolution and assets.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/public ./public
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/shared ./shared
COPY --from=build /app/electron ./electron

RUN mkdir -p /data /home/node \
  && chown -R node:node /data /home/node

# Coding-agent CLIs so provider auth/session features work out of the box.
# Installed for the node user under /home/node (ephemeral — reinstalled on
# image rebuild); app state persists under /data via HOME/DATABASE_PATH.
USER node
ENV PATH=/home/node/.npm-global/bin:$PATH
ENV NPM_CONFIG_PREFIX=/home/node/.npm-global
RUN npm install -g @anthropic-ai/claude-code @openai/codex command-code 2>/dev/null || true

VOLUME ["/data"]

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.SERVER_PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist-server/server/index.js"]
