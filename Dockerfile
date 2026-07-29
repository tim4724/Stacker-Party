# Build stage — full install (incl. esbuild devDep) so we can bundle.
FROM node:24-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY server/ ./server/
COPY public/ ./public/
COPY partyplug/ ./partyplug/
COPY scripts/ ./scripts/
# Bundle the web apps (content-hashed bundles + dist/web-manifest.json) and the
# native core, then generate the AirConsole HTML entry points. `npm run build`
# chains both. Prod serves the bundles, so this MUST run or the server falls back
# to ~20 no-store script tags. (The prod HTML pages are rendered + cached at
# server boot, so there's no separate HTML build step.)
#
# BUILD_COMPRESSION=max is the ONLY place brotli quality 11 is paid for: this
# image's bundles are the ones real users download, so ~9% off the wire is worth
# the extra build seconds. Dev/e2e/AirConsole builds use the fast tier — see
# scripts/write-compressed.js. Guarded by tests/build-compression.test.js.
RUN BUILD_COMPRESSION=max npm run build
# Drop devDeps so the runtime node_modules carries only production deps.
RUN npm prune --omit=dev

# Production stage
FROM node:24-alpine
RUN addgroup -g 1001 nodejs && adduser -u 1001 -G nodejs -s /bin/sh -D nodejs
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/server/ ./server/
# public/ carries the built hashed bundles and the generated AC entry HTML;
# dist/ carries web-manifest.json (hashed bundle names) the server reads at boot.
COPY --from=builder /app/public/ ./public/
COPY --from=builder /app/dist/ ./dist/
# PartyPlug kit lives at the repo root (served under /partyplug/, see
# server/index.js). Must be copied into the image or /partyplug/* 404s.
COPY --from=builder /app/partyplug/ ./partyplug/
# scripts/asset-manifest.js is require()d by server/index.js at RUNTIME (the
# canonical script load order), so the scripts dir ships in the runtime image.
COPY --from=builder /app/scripts/ ./scripts/
USER nodejs
EXPOSE 4000
# This image always builds the web bundles (builder stage), so it always serves
# them, independent of APP_ENV. Bundling is a property of the artifact, not the
# environment — so production and preview both get the bundle without each deploy
# having to opt in. (Local source dev, which never sets this, still serves the
# individual files for instant edits.)
ENV SERVE_BUNDLES=1
ENV NODE_ENV=production PORT=4000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD wget --no-verbose --tries=1 --spider http://localhost:4000/health || exit 1
CMD ["node", "server/index.js"]
