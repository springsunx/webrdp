# WebRDP 部署指南

## 概述

WebRDP 是基于 [Nexus Terminal](https://github.com/Heavrnl/nexus-terminal) 的轻量级 Web RDP 客户端，专注于 RDP 协议，支持 URL 参数快速连接。

## 架构

```
┌─────────────┐    WebSocket    ┌─────────────────┐    Guacd    ┌─────────────┐
│   前端      │ ◄────────────► │  Remote Gateway │ ◄─────────► │   Guacd     │
│ (HTML/JS)   │                │  (Node.js)      │             │ (Docker)    │
└─────────────┘                └─────────────────┘             └─────────────┘
       │                              │
       │                              │
       ▼                              ▼
   URL 参数                    加密令牌 API
```

## 快速部署

### 方法一：Docker Compose（推荐）

1. **克隆项目**
```bash
git clone <repository-url>
cd webrdp
```

2. **启动服务**
```bash
# 使用启动脚本
./start.sh

# 或者手动启动
docker-compose up -d
```

3. **访问应用**
```
http://localhost:3000?host=YOUR_RDP_HOST&port=3389&user=YOUR_USER&password=YOUR_PASSWORD
```

### 方法二：本地开发

1. **安装依赖**
```bash
# 后端
cd packages/backend
npm install

# 前端
cd ../frontend
npm install
```

2. **启动 Guacd**
```bash
docker run -d --name guacd -p 4822:4822 guacamole/guacd:latest
```

3. **启动后端**
```bash
cd packages/backend
npm run dev
```

4. **启动前端**
```bash
cd ../frontend
npm run dev
```

## 环境变量配置

在 `.env` 文件中配置以下变量：

```bash
# Guacd 配置
GUACD_HOST=guacd          # Guacd 主机地址
GUACD_PORT=4822           # Guacd 端口

# 后端配置
BACKEND_PORT=3001         # 后端 API 端口
WEBSOCKET_PORT=3002       # WebSocket 端口

# 前端配置
FRONTEND_PORT=3000        # 前端端口
FRONTEND_URL=http://localhost:3000  # 前端 URL
```

## URL 参数说明

| 参数 | 必填 | 默认值 | 描述 |
|------|------|--------|------|
| `host` | ✅ | - | 远程主机 IP 或域名 |
| `port` | ❌ | 3389 | RDP 端口 |
| `user` | ✅ | - | 用户名 |
| `password` | ✅ | - | 密码 |
| `width` | ❌ | 1024 | 屏幕宽度 |
| `height` | ❌ | 768 | 屏幕高度 |

**示例 URL**：
```
http://localhost:3000?host=192.168.1.100&port=3389&user=admin&password=secret&width=1920&height=1080
```

## 与反向代理集成

### Nginx Proxy Manager (NPMplus)

1. 创建新的代理主机
2. 设置域名或 IP
3. 指向 `http://rdp-lite-frontend:3000`
4. 启用 WebSocket 支持
5. 配置 SSL（可选）

### Nginx 配置示例

```nginx
server {
    listen 80;
    server_name rdp.example.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## 安全注意事项

### 1. 密码安全
- URL 中的密码可能被记录在浏览器历史中
- 仅在内网或可信环境中使用
- 考虑使用其他认证方式（如令牌）

### 2. 网络安全
- 确保 RDP 服务器仅对必要网络开放
- 使用防火墙限制访问
- 考虑使用 VPN 访问内部网络

### 3. HTTPS 配置
- 生产环境建议使用 HTTPS
- 通过反向代理配置 SSL
- 使用 Let's Encrypt 获取免费证书

## 故障排除

### 连接失败
1. 检查目标主机 IP、端口、用户名和密码
2. 确保目标主机已启用远程桌面
3. 确保网络可达
4. 检查防火墙设置

### 黑屏问题
1. 检查目标主机的远程桌面设置
2. 尝试调整分辨率参数
3. 检查颜色深度设置

### 性能问题
1. 降低颜色深度
2. 调整分辨率
3. 检查网络带宽
4. 优化 RDP 设置

### Docker 问题
1. 检查 Docker 服务是否运行
2. 查看容器日志：`docker-compose logs`
3. 检查端口冲突
4. 验证网络配置

## 日志查看

```bash
# 查看所有容器日志
docker-compose logs -f

# 查看特定容器日志
docker-compose logs -f backend
docker-compose logs -f frontend
docker-compose logs -f guacd
```

## 更新部署

```bash
# 停止服务
docker-compose down

# 拉取最新代码
git pull

# 重新构建并启动
docker-compose up -d --build
```

## 备份与恢复

### 备份
```bash
# 备份数据
tar -czf webrdp-backup.tar.gz data/

# 备份配置
cp .env .env.backup
cp docker-compose.yml docker-compose.yml.backup
```

### 恢复
```bash
# 恢复数据
tar -xzf webrdp-backup.tar.gz

# 恢复配置
cp .env.backup .env
cp docker-compose.yml.backup docker-compose.yml

# 重启服务
docker-compose up -d
```

## 性能优化

### 1. Guacd 优化
- 调整 Guacd 缓存设置
- 优化 RDP 协议参数
- 配置连接池

### 2. 网络优化
- 使用 WebSocket 压缩
- 配置 TCP 优化
- 使用 CDN 加速静态资源

### 3. 前端优化
- 启用浏览器缓存
- 压缩静态资源
- 使用 Service Worker

## 监控与告警

### 1. 健康检查
```bash
# 检查服务状态
docker-compose ps

# 检查端口监听
netstat -tlnp | grep -E ':(3000|3001|3002|4822)'
```

### 2. 日志监控
- 使用 ELK Stack 收集日志
- 配置日志轮转
- 设置告警规则

### 3. 性能监控
- 监控 CPU 和内存使用
- 监控网络流量
- 监控连接数

## 扩展功能

### 1. 多用户支持
- 添加用户认证
- 实现权限管理
- 支持多租户

### 2. 会话管理
- 保存连接配置
- 支持会话录制
- 实现会话回放

### 3. 高级功能
- 文件传输
- 剪贴板同步
- 音频重定向
- 打印机重定向

## 技术支持

如有问题，请查看：
- `README.md` - 项目概述
- `DEPLOYMENT.md` - 部署指南
- 源代码中的注释
- GitHub Issues