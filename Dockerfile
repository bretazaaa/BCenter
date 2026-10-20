# BCenter Server : moteur de BCenter + interface web (client léger), pour un homelab.
# docker compose up -d   puis ouvrir http://<serveur>:8080 (code d'installation : docker logs bcenter)

FROM node:24-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run server:build

FROM node:24-alpine
ENV NODE_ENV=production BCENTER_DATA_DIR=/data PORT=8080
WORKDIR /app
COPY package.json package-lock.json ./
# Dépendances d'exécution uniquement (ssh2 fonctionne sans ses modules natifs facultatifs).
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /src/out/server ./out/server
COPY --from=build /src/out/web ./out/web
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "out/server/index.js"]
