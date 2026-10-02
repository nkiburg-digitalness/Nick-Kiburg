FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY deploy/launch.mjs ./deploy/launch.mjs
ENV NODE_ENV=production DB_FILE=/data/voorraad.db BACKUP_DIR=/data/backups TRUST_PROXY=true
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=60s --timeout=5s --retries=3 CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/health" || exit 1
# Starts as root only to fix permissions of the data disk, then runs as user "node".
CMD ["node", "--disable-warning=ExperimentalWarning", "deploy/launch.mjs"]
