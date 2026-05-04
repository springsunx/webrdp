# WebRDP

基于 [Nexus Terminal](https://github.com/Heavrnl/nexus-terminal) 的轻量级 Web RDP 客户端，专注于 RDP 协议，支持 URL 参数快速连接。

[![Docker](https://img.shields.io/badge/Docker-2496ED?style=flat&logo=docker&logoColor=white)](https://www.docker.com/)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![GitHub Actions](https://img.shields.io/badge/GitHub%20Actions-Workflow-success)](.github/workflows/docker-build.yml)

## ✨ 功能特点

- 🚀 **轻量级**：移除了 SSH、VNC、SFTP 等不需要的功能
- 🔗 **URL 参数支持**：通过 URL 直接连接，便于集成
- 🐳 **Docker 部署**：前后端合并，一键部署，开箱即用
- 🖥️ **输入界面**：美观的连接界面，支持记住密码
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

### URL 参数访问

```
http://localhost:3000?host=YOUR_RDP_HOST&port=3389&user=YOUR_USER&password=YOUR_PASSWORD
```

## 📖 使用说明

### 1. 输入界面访问

访问 `http://localhost:3000`，会显示美观的输入界面：

- 输入主机地址、用户名、密码
- 勾选"记住连接信息"（可选）
- 点击"连接"按钮

### 2. URL 参数访问

通过 URL 参数直接连接：

```
http://localhost:3000?host=192.168.1.100&port=3389&user=admin&password=secret&width=1920&height=1080&title=我的电脑
```

### 3. URL 参数说明

| 参数 | 必填 | 默认值 | 描述 |
|------|------|--------|------|
| `host` | ✅ | - | RDP服务器IP或域名 |
| `port` | ❌ | 3389 | RDP端口 |
| `user` | ✅ | - | 用户名 |
| `password` | ✅ | - | 密码 |
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
```

## 🛠️ 开发

### 本地开发

```bash
# 安装依赖
cd packages/backend && npm install

# 启动 Guacd
docker run -d --name guacd -p 4822:4822 guacamole/guacd:latest

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
- [Guacamole Lite](https://github.com/nicknisi/guacamole-lite) - 轻量级 Guacamole 客户端