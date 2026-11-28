FROM node:20-alpine

WORKDIR /app

# 安装后端生产依赖（包含 guacamole-common-js，由后端直接提供静态路由）
COPY packages/backend/package*.json ./
RUN npm ci --omit=dev

# 复制后端与前端静态文件
COPY packages/backend/src ./src
COPY packages/frontend/public ./public

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "src/server.js"]
