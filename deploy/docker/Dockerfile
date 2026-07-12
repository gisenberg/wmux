# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS dependencies

WORKDIR /app
RUN DEBIAN_FRONTEND=noninteractive apt-get update \
  && apt-get install -y --no-install-recommends g++ make python3 \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS build

COPY tsconfig.json tsconfig.server.json vite.config.ts ./
COPY src ./src
RUN npm run build

FROM dependencies AS production-dependencies

RUN npm prune --omit=dev \
  && rm -rf node_modules/node-pty/prebuilds \
  && npm cache clean --force

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
  HOME=/home/node \
  WMUX_PORT=3478

WORKDIR /app
RUN DEBIAN_FRONTEND=noninteractive apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl file openssh-client python3 screen tmux \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /home/node/.wmux \
  && chown node:node /home/node/.wmux

COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node scripts ./scripts
COPY deploy/docker/docker-bind-host.mjs deploy/docker/docker-healthcheck.mjs /usr/local/lib/wmux/
COPY deploy/docker/docker-entrypoint.sh /usr/local/bin/wmux-docker-entrypoint
RUN chmod 755 /usr/local/bin/wmux-docker-entrypoint \
  && find /app/scripts -maxdepth 1 -type f -exec sed -i 's/\r$//' {} + \
  && find /app/scripts -maxdepth 1 -type f -exec chmod 755 {} +

USER node
VOLUME ["/home/node/.wmux"]
EXPOSE 3478

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "/usr/local/lib/wmux/docker-healthcheck.mjs"]

ENTRYPOINT ["/usr/local/bin/wmux-docker-entrypoint"]
CMD ["node", "dist/server/index.js"]
