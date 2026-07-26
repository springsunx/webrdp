FROM node:22-alpine

WORKDIR /app

COPY packages/backend/package*.json ./
RUN npm ci --omit=dev

COPY packages/backend/src ./src
COPY packages/frontend/public ./public

ENV NODE_ENV=production
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["node", "-e", "const http=require('node:http');const request=http.get({host:'127.0.0.1',port:process.env.PORT||3000,path:'/api/health'},response=>{response.resume();process.exit(response.statusCode===200?0:1)});request.on('error',()=>process.exit(1));request.setTimeout(4000,()=>{request.destroy();process.exit(1)})"]

USER node
CMD ["node", "src/server.js"]
