ARG NODE_IMAGE=node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436

FROM ${NODE_IMAGE} AS build
WORKDIR /app

COPY .npmrc package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build \
  && npm prune --omit=dev --ignore-scripts \
  && npm cache clean --force

FROM ${NODE_IMAGE} AS runtime
ARG VERSION=2.2.1
ARG REVISION=local

LABEL org.opencontainers.image.title="GuildControl MCP" \
  org.opencontainers.image.description="Safety-first MCP server for Discord with privacy-safe reads, audits, and reviewed administration" \
  org.opencontainers.image.url="https://docs.guildcontrol.lasers.app" \
  org.opencontainers.image.source="https://github.com/j-256/guildcontrol" \
  org.opencontainers.image.documentation="https://github.com/j-256/guildcontrol/blob/v${VERSION}/README.md" \
  org.opencontainers.image.licenses="AGPL-3.0-only" \
  org.opencontainers.image.version="${VERSION}" \
  org.opencontainers.image.revision="${REVISION}" \
  io.modelcontextprotocol.server.name="app.lasers.guildcontrol/discord"

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json LICENSE ./
COPY --chown=node:node README.md PRIVACY.md SECURITY.md SUPPORT.md ./
COPY --chown=node:node docs/comparison.md docs/getting-started.md docs/limitations.md docs/migration.md docs/reference.md docs/releasing.md docs/safety-usability.md ./docs/

USER node
ENTRYPOINT ["node", "--no-expose-wasm", "--lite-mode", "dist/cli.js"]
CMD ["catalog"]
