# syntax=docker/dockerfile:1

# --- build ------------------------------------------------------------------
FROM node:22-slim AS build
WORKDIR /app

# argon2 compiles a native addon; the toolchain is needed here but not at
# runtime, which is the whole point of the split.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

# Drop dev dependencies from the tree we are about to copy forward.
RUN npm prune --omit=dev

# --- runtime ----------------------------------------------------------------
FROM node:22-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home voicekernel

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Runtime assets: migrations, the vendored the voice provider spec, and the served web app.
COPY db ./db
COPY vendor ./vendor
COPY web ./web
COPY scripts ./scripts

USER voicekernel
EXPOSE 8080

# Fails the container rather than serving traffic with an unreachable database.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://localhost:8080/health || exit 1

CMD ["node", "dist/src/index.js"]
