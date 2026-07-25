FROM node:22-alpine

WORKDIR /app

COPY packages/backend/package*.json ./
RUN npm ci --omit=dev

COPY packages/backend/src ./src
COPY packages/frontend/public ./public

ENV NODE_ENV=production
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1

USER node
CMD ["node", "src/server.js"]