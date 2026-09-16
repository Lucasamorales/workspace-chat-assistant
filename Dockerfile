# One image, two services: the start command is chosen at deploy time.
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY modules/basics/package.json modules/basics/
COPY modules/files/package.json modules/files/
COPY modules/asana/package.json modules/asana/
COPY apps/chat-gateway/package.json apps/chat-gateway/
COPY apps/oauth-gateway/package.json apps/oauth-gateway/
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY packages ./packages
COPY modules ./modules
COPY apps ./apps
USER node
CMD ["node", "apps/chat-gateway/src/index.js"]
