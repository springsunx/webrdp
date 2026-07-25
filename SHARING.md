# 多用户共享观看

WebRDP 使用 guacd 的 Join Existing Connection 能力，让多个浏览器加入同一条 RDP 会话。Windows 只接收到一条 RDP 连接：主持人可以控制桌面，其他参与者强制为只读观看者。

## 使用方式

1. 打开 WebRDP，填写 Windows 主机、用户名和密码并连接。
2. 主连接成功后，页面顶部会显示共享观看链接。
3. 点击“复制链接”，发送给观看者。
4. 观看者打开链接后自动加入同一画面，无需知道 Windows 密码。
5. 主持人点击“结束共享”或断开连接后，房间关闭，观看者会自动退出。

观看者的键盘、鼠标、剪贴板、文件传输和远程分辨率修改均由服务端只读 Join Token 限制。

## Docker 配置

先生成 32 字节 Token 加密密钥，并将结果配置到 `.env`：

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

```dotenv
TOKEN_ENCRYPTION_KEY=替换为上一步生成的Base64内容
SESSION_TTL_MS=28800000
JOIN_TOKEN_TTL_MS=60000
MAX_VIEWERS=20
```

然后启动：

```bash
docker compose up -d --build
```

如果没有设置 `TOKEN_ENCRYPTION_KEY`，单实例仍可运行，但应用每次重启都会产生新密钥。生产环境或多个应用实例必须使用相同的持久密钥。

## API

- `POST /api/sessions`：创建主 RDP 会话，返回房间号、主持人密钥和连接 Token。
- `POST /api/sessions/:roomId/join`：为观看者签发短时、一次性、只读 Join Token。
- `GET /api/sessions/:roomId`：查询会话状态和观看人数。
- `DELETE /api/sessions/:roomId`：主持人使用 `x-owner-secret` 结束共享。

房间号是 128 位随机值，不等同于 guacd 的内部连接 ID。Join Token 默认 60 秒过期，未使用的观看名额会自动释放。

## 当前范围

当前实现是单应用实例、单 guacd 的 MVP。若要横向扩容，需要把应用会话状态和 guacamole-lite session registry 替换为 Redis，并确保 Join 请求被路由到主连接所在的 guacd。当前内存状态不会在应用重启后保留。

这项功能用于“多人观看同一桌面”。如果每个人需要独立 Windows 桌面，仍需 Windows Server RDS Session Host 与相应 RDS CAL，或为每位用户分配独立 VM。