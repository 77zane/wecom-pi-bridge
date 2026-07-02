FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build
RUN npm prune --omit=dev --ignore-scripts

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ARG PI_VERSION=0.80.2
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/app/data \
    PI_COMMAND=pi

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates tini \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g --ignore-scripts "@earendil-works/pi-coding-agent@${PI_VERSION}" \
  && npm cache clean --force

COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 3000
ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/server/src/server/main.js"]
