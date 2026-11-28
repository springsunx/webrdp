# WebRDP 部署指南

本项目延续 [springsunx/webrdp](https://github.com/springsunx/webrdp) 的合并容器部署方式：前端静态文件、REST API 与 WebSocket 隧道共用同一端口（默认 `3000`），配合 `guacamole/guacd` 容器运行。

## 架构概览

```text
浏览器 (HTML/JS + Guacamole Client)
   │  HTTP / WebSocket (/api/session, /tunnel) — 单端口 3000
   ▼
webrdp-app (Node.js 网关: 会话锚点 + 控制权状态机 + 输入门控)
   │  Guacamole TCP 协议 (4822)
   ▼
webrdp-guacd (guacamole/guacd) ──► Windows RDP (3389)
```

## 快速部署（Docker Compose）

```bash
docker compose up -d --build
```

查看运行状态与健康检查：

```bash
docker compose ps
curl http://localhost:3000/healthz?deep=1
```

## 环境变量

可在 `.env` 或 `docker-compose.yml` 中配置：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3000` | 应用对外端口（HTTP + WebSocket） |
| `GUACD_HOST` | `guacd` | `guacd` 主机地址 |
| `GUACD_PORT` | `4822` | `guacd` 端口 |
| `PRIMARY_GRACE_SECONDS` | `180` | 主用户离线后保留主控身份的宽限秒数 |
| `SESSION_IDLE_SECONDS` | `120` | 全部客户端离线后保留 RDP 会话的宽限秒数 |
| `CONNECT_TIMEOUT_SECONDS` | `30` | 连接 `guacd`/RDP 的超时时间（秒） |
| `MAX_SESSIONS` | `50` | 最大并发共享会话数 |
| `MAX_PARTICIPANTS` | `20` | 单个会话最大并发人数 |
| `ALLOWED_HOSTS` | *(空)* | 可选：允许连接的 RDP 主机白名单（逗号分隔） |
| `LOG_LEVEL` | `info` | 日志级别：`debug` / `info` / `warn` / `error` |

## URL 参数说明

同时兼容 Query (`?host=...`) 与 Fragment (`#host=...`) 两种传参方式，Fragment 同名参数优先级高于 Query：

| 参数 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `host` | ✅ | - | RDP 主机 IP 或域名 |
| `port` | ❌ | `3389` | RDP 端口 |
| `user` | ✅ | - | 用户名 |
| `password` | ✅ | - | 密码（按需求原样保留在 URL 中以便刷新/重连） |
| `width` | ❌ | 自动计算 | 屏幕宽度 |
| `height` | ❌ | 自动计算 | 屏幕高度 |
| `title` | ❌ | `WebRDP` | 页面与顶栏标题 |
| `auto` | ❌ | `false` | 设为 `true`/`1` 时自动计算分辨率 |
| `domain` | ❌ | *(空)* | Windows 域 |
| `name` | ❌ | 自动编号 | 多人成员列表中的显示昵称 |
| `mode` | ❌ | 自动 | 触屏模式：`touchpad` 或 `touch` |
| `zoom` | ❌ | 自动 | 缩放预设：`fit`、`height` 或 `1` |

## Nginx 反向代理示例

```nginx
server {
    listen 80;
    server_name rdp.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
    }
}
```
