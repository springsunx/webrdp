FROM node:18-alpine

# 设置工作目录
WORKDIR /app

# 复制后端代码
COPY packages/backend/package*.json ./

# 安装后端依赖
RUN npm ci --only=production

# 复制后端源代码
COPY packages/backend/src ./src

# 复制前端文件
COPY packages/frontend/public ./public

# 安装 guacamole-common-js 库（前端需要）
RUN mkdir -p ./public/guacamole-common-js/dist && \
    npm pack guacamole-common-js@1.5.0 && \
    tar -xzf guacamole-common-js-1.5.0.tgz && \
    cp package/dist/cjs/guacamole-common.min.js ./public/guacamole-common-js/dist/ && \
    rm -rf package guacamole-common-js-1.5.0.tgz

# 暴露端口
EXPOSE 3000

# 启动应用
CMD ["node", "src/server.js"]