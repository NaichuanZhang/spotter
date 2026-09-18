# syntax=docker/dockerfile:1
#
# SPOTTER container for Instacloud compute.
#
# Instacloud needs a Dockerfile and listens on exactly ONE http port, with no
# private networking and no raw TCP. That is fine: the realtime WebSocket goes
# browser -> api.boson.ai directly, so this image only has to mint tokens and
# serve static files.

# ---------------------------------------------------------------- build stage
FROM node:22-alpine AS build
WORKDIR /app

# Dependencies first so a source-only edit reuses the npm layer.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json vite.config.ts index.html ./
COPY scripts ./scripts
COPY public ./public
COPY src ./src

# Vendor the MediaPipe model + wasm INTO the image. public/vendor is gitignored
# (large binaries), so without this step an image built from a clean checkout
# would ship an app that tries to hit a CDN at demo time. The script is
# idempotent, so if public/vendor came in from the build context it is a no-op.
RUN node scripts/fetch-mediapipe.mjs

RUN npm run build

# ------------------------------------------------------- production deps stage
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# -------------------------------------------------------------- runtime stage
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY server ./server

# BOSON_API_KEY is injected at deploy time (`insta secrets`); never baked in.
EXPOSE 8080

USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node","server/index.mjs"]
