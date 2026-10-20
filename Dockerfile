# Two stages: "build" compiles the TypeScript with the full toolchain; "runtime" carries
# only production dependencies and the compiled output.
#
# Both stages use the same base image, pinned by digest. To refresh the pin:
#   docker buildx imagetools inspect node:24-alpine
# and copy the top-level "Digest:" into both FROM lines (keep the tag; it documents intent).

FROM node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f AS build
WORKDIR /app

# Dependencies first, so this layer is reused until the lockfile changes.
COPY package.json package-lock.json ./
RUN NODE_OPTIONS="--no-network-family-autoselection" npm ci --ignore-scripts

# tsconfig.json sets noEmit for the typecheck gate, so the emit settings are given here.
COPY tsconfig.json ./
COPY src ./src
RUN node node_modules/typescript/bin/tsc --noEmit false --outDir dist --rootDir src


FROM node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Stamp the image so GET /api/version identifies what is running. The defaults mirror the
# fallbacks in src/config.ts; an empty value would be rejected there.
ARG APP_VERSION=0.0.0-dev
ARG GIT_COMMIT=unknown
ENV APP_VERSION=$APP_VERSION \
    GIT_COMMIT=$GIT_COMMIT

# Production dependencies only. package.json stays because "type": "module" lives there.
COPY package.json package-lock.json ./
RUN NODE_OPTIONS="--no-network-family-autoselection" npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY public ./public

# The unprivileged user the node image ships with. App files stay root-owned and read-only.
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-3000}/healthz" || exit 1

CMD ["node", "dist/server.js"]
