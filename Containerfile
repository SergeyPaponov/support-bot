# syntax=docker/dockerfile:1
# Pin NODE_IMAGE to an approved digest in your release process.
ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /opt/support-bot
COPY package.json package-lock.json ./
# The optional CA mount extends trust for corporate build proxies without adding
# the certificate (or credentials) to any image layer. Keep TLS verification on.
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src/ ./src/
COPY test/ ./test/
RUN npm run build

FROM ${NODE_IMAGE} AS production-dependencies
WORKDIR /opt/support-bot
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm ci --omit=dev --no-audit --no-fund

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
WORKDIR /opt/support-bot
COPY --from=production-dependencies /opt/support-bot/node_modules/ ./node_modules/
COPY --from=build /opt/support-bot/dist/src/ ./dist/src/
COPY package.json ./
COPY config/sanitization-policy.json ./config/sanitization-policy.json
# No writable application directory, fixed fsGroup or passwd entry is needed.
# Any OpenShift-assigned UID can read the application and default policy.
RUN mkdir -p /etc/support-bot && chmod -R a=rX /opt/support-bot && chmod 755 /etc/support-bot
USER 1001:0
EXPOSE 3000
STOPSIGNAL SIGTERM
# Same production command as npm start, exec-form so Node receives SIGTERM.
CMD ["node", "--use-env-proxy", "--env-file-if-exists=.env", "dist/src/index.js"]
