# syntax=docker/dockerfile:1
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
LABEL org.opencontainers.image.title="Barnacle" \
      org.opencontainers.image.description="A self-hosted pixel office where your AI agents work as a team" \
      org.opencontainers.image.source="https://github.com/xiaoxiongbaba/barnacle" \
      org.opencontainers.image.authors="xiaoxiongbaba" \
      org.opencontainers.image.licenses="Apache-2.0"
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=19100 \
    DATA_DIR=/data
WORKDIR /app
COPY --from=build /app/package.json /app/LICENSE /app/NOTICE ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/package.json ./server/
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/packs ./packs
COPY --from=build /app/integrations ./integrations
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 19100
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:19100/api/health || exit 1
CMD ["node", "server/dist/index.js"]
