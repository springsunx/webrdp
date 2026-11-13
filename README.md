# WebRDP

基于 [Nexus Terminal](https://github.com/Heavrnl/nexus-terminal) 的轻量级 Web RDP 客户端，专注于 RDP 协议，支持同一 RDP 会话的多用户协作与控制权交接。

[![Docker](https://img.shields.io/badge/Docker-2496ED?style=flat&logo=docker&logoColor=white)](https://www.docker.com/)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![GitHub Actions](https://img.shields.io/badge/GitHub%20Actions-Workflow-success)](.github/workflows/docker-build.yml)

## ✨ 功能特点

- 🚀 **轻量级**：移除了 SSH、VNC、SFTP 等不需要的功能
- 🔗 **统一入口链接**：相同凭据自动进入同一 RDP 会话
- 🐳 **Docker 部署**：前后端合并，一键部署，开箱即用
- 👥 **协作控制**：首位用户主控，后续用户可临时接管，主用户可随时抢回
- 📱 **响应式设计**：支持手机、平板、桌面多种设备
- 🖱️ **鼠标操作**：支持左键、右键、滚轮

## 🚀 快速开始

### Docker 部署（推荐）

```bash
# 克隆项目
git clone https://github.com/springsunx/webrdp.git
cd webrdp

# 启动服务
docker compose up -d

# 访问应用
http://localhost:3000
```

### 统一协作入口

```
http://localhost:3000/#host=YOUR_RDP_HOST&port=3389&user=YOUR_USER&password=YOUR_PASSWORD
```

## 📖 使用说明

### 1. 输入界面访问

访问 `http://localhost:3000`，会显示美观的输入界面：

- 输入主机地址、用户名、密码
- 勾选"记住连接信息"（可选，不保存密码）
- 点击"连接"按钮

### 2. 统一入口访问

完整凭据放在 URL Fragment（# 后）。第一个用户成为主用户，后续用户自动观看并可点击接管：

连接后会保留 URL 中的凭据（兼容查询参数和 Fragment），刷新时可重新读取密码，用于会话恢复或失效后重建。密码不会额外写入本地存储；带密码的链接请仅分享给可信用户。点击返回登录页时会清除 URL 参数。

```
http://localhost:3000/#host=192.168.1.100&port=3389&user=admin&password=YOUR_PASSWORD&width=1920&height=1080&title=我的电脑
```

### 3. Fragment 参数说明

| 参数 | 必填 | 默认值 | 描述 |
|------|------|--------|------|
| `host` | ✅ | - | RDP服务器IP或域名 |
| `port` | ❌ | 3389 | RDP端口 |
| `user` | ✅ | - | 用户名 |
| `password` | ✅ | - | 密码，仅建议放在 URL Fragment 中 |
| `width` | ❌ | 自动计算 | 屏幕宽度 |
| `height` | ❌ | 自动计算 | 屏幕高度 |
| `title` | ❌ | WebRDP | 页面标题 |
| `auto` | ❌ | false | 自动计算分辨率 |

## 🏗️ 架构

```
┌─────────────────────────────────────────────────────────┐
│                    应用容器 (端口 3000)                   │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐      │
│  │  静态文件   │  │  REST API   │  │  WebSocket  │      │
│  │  (前端)     │  │  (后端)     │  │  (Guacamole)│      │
│  └─────────────┘  └─────────────┘  └─────────────┘      │
└─────────────────────────────────────────────────────────┘
                           │
                           │ WebSocket
                           ▼
┌─────────────────────────────────────────────────────────┐
│                    Guacd 容器 (端口 4822)                │
└─────────────────────────────────────────────────────────┘
```

## 🐳 Docker 配置

### 端口说明

| 服务 | 端口 | 说明 |
|------|------|------|
| 应用（前端+后端+WebSocket） | 3000 | Web 界面 + REST API + WebSocket |
| Guacd | 4822 | RDP 协议代理 |

**注意**：HTTP、REST API 和 WebSocket 都使用同一个端口（3000），方便反向代理配置。

### 环境变量

```yaml
# docker-compose.yml
environment:
  - GUACD_HOST=guacd
  - GUACD_PORT=4822
  - PORT=3000
  - SESSION_TTL_MS=28800000
  - PRIMARY_RECONNECT_GRACE_MS=86400000
  - GUACAMOLE_MAX_INACTIVITY_MS=0
  - GUACD_BROWSER_IDLE_TIMEOUT_MS=60000
```

服务端独立持有 guacd 主连接。浏览器断线或手机锁屏时，服务端连接及其他观看者保持在线；主用户返回后重新加入同一会话。
所有浏览器均离线时，会话最多保留 `PRIMARY_RECONNECT_GRACE_MS`；默认 `86400000` 表示 24 小时，超时后自动关闭以释放资源。仍有观看者在线时不会因该时限清理。
应用进程、guacd 或 Windows RDP 服务重启时，网络连接无法保留，需重新建立。主动结束会话会立即关闭服务端连接。
`GUACAMOLE_MAX_INACTIVITY_MS=0` 表示禁用应用层空闲断开，Windows RDP 服务端策略仍然生效。
`GUACD_BROWSER_IDLE_TIMEOUT_MS` 控制浏览器连接在 guacd 无响应时的等待时间，默认 60 秒；浏览器隧道同样等待 60 秒。手机系统仍可能主动中断后台连接，恢复前台后会自动重新加入。
浏览器连接仍然存在时，服务端每 3 秒向 guacd 发送 `nop`，避免手机后台暂停时因用户指令超时而被断开；画面同步确认仍由浏览器处理。
服务端还会发送 WebSocket ping，让反向代理在画面静止时持续收到流量；未收到 pong 不会触发服务端主动断开。

## 🛠️ 开发

### 本地开发

```bash
# 安装依赖
cd packages/backend && npm install

# 启动 Guacd
docker run -d --name guacd -p 4822:4822 guacamole/guacd:1.6.0

# 启动后端
cd packages/backend && npm run dev

# 访问应用
http://localhost:3000
```

### 项目结构

```
webrdp/
├── packages/
│   ├── backend/          # 后端服务
│   │   └── src/
│   │       └── server.js
│   └── frontend/         # 前端界面
│       └── public/
│           ├── index.html
│           ├── app.js
│           └── guacamole-common-js/
├── docker-compose.yml
├── Dockerfile
└── .github/workflows/    # GitHub Actions
```

## 📚 文档

- [输入界面使用说明](INPUT_FORM.md)
- [部署指南](DEPLOYMENT.md)
- [多用户协作控制](SHARING.md)

## 🔧 故障排除

### 连接失败

1. 检查 RDP 服务器是否启用远程桌面
2. 验证用户名和密码
3. 检查网络连接

### 黑屏问题

1. 调整分辨率参数
2. 检查目标主机的显示设置

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 📄 许可证

[MIT License](LICENSE)

## 🙏 致谢

- [Nexus Terminal](https://github.com/Heavrnl/nexus-terminal) - 原始项目
- [Apache Guacamole](https://guacamole.apache.org/) - RDP 协议支持
- [Guacamole Lite](https://github.com/vadimpronin/guacamole-lite) - 轻量级 Guacamole 客户端
