# Pinned multi-architecture image indexes. No private runtime image dependency.
ARG NODE_IMAGE=node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
ARG TUNNEL_IMAGE=ghcr.io/openai/tunnel-client:v0.0.15@sha256:119799b778ba8411a124f53588f9dc837fd62ba03e5fadf77d675123c92ab58e
FROM ${TUNNEL_IMAGE} AS tunnel
FROM ${NODE_IMAGE} AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM dependencies AS test
COPY src/ ./src/
COPY test/ ./test/
COPY config/ ./config/
COPY scripts/check.mjs scripts/validate-config.mjs ./scripts/
USER node
RUN --network=none npm test && npm run check && npm run validate-config -- config/thin.example.json

FROM ${NODE_IMAGE} AS runtime
LABEL org.opencontainers.image.title="MCP Gateway" org.opencontainers.image.version="0.7.0-preview.0"
RUN addgroup -S -g 10001 gateway && adduser -S -D -H -u 10001 -G gateway gateway
WORKDIR /app
COPY --from=test --chown=10001:10001 /app/node_modules/ ./node_modules/
COPY --from=test --chown=10001:10001 /app/package.json /app/package-lock.json ./
COPY --from=test --chown=10001:10001 /app/src/ ./src/
COPY --from=test --chown=10001:10001 /app/config/ ./config/
COPY --from=tunnel /usr/bin/tunnel-client /usr/bin/tunnel-client
COPY --from=tunnel /usr/bin/cloudflared /usr/bin/cloudflared
ENV NODE_ENV=production HOME=/tmp GATEWAY_CONFIG_FILE=/run/config/gateway.json
USER 10001:10001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["node", "src/healthcheck.mjs"]
STOPSIGNAL SIGTERM
ENTRYPOINT ["node", "src/runtime.mjs"]
