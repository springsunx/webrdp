# 多用户协作控制

WebRDP 使用 guacd 的 Join Existing Connection 能力，让多个浏览器加入同一条 RDP 会话。Windows 始终只接收到一条 RDP 连接。

## 使用方式

1. 用户打开包含 `host`、`user`、`password` 的统一入口链接，或在页面填写连接信息。
2. 第一个进入的用户自动成为主用户，并创建 RDP 会话。
3. 后续用户打开完全相同的入口链接时，后端按连接指纹识别现有会话并自动加入，默认只能观看。
4. 观看用户可点击“接管操作”获得临时控制权；主用户及其他参与者的输入会立即在服务端被拦截。
5. 临时操作者点击“结束操作并归还”或关闭页面后，控制权自动回到主用户。
6. 主用户断开或点击“结束会话”后，整个协作会话关闭。

同一时间只允许一个参与者操作。服务端会校验参与者身份，并只向当前控制者转发键盘、鼠标、剪贴板、分辨率等主动指令。非控制者仅能发送同步、确认、断开和保活指令。

## 统一入口链接

推荐把连接参数放在 URL Fragment（`#` 后），例如：

```text
https://rdp.example.com/#host=192.0.2.10&port=3389&user=administrator&password=YOUR_PASSWORD&width=1920&height=1080
```

Fragment 不会随 HTTP 请求发送到服务器，也不会进入反向代理访问日志。页面读取参数后会立即从地址栏清除，但主用户界面中的“复制链接”仍可复制原始统一入口。

链接本身包含 Windows 登录凭据，任何获得链接的人都能加入该连接。必须使用 HTTPS，并且只发送给受信任人员。长期方案建议改为一次性业务令牌或接入企业身份认证，不直接分发 Windows 密码。

旧的查询参数形式仍可读取，但不推荐把密码放在 `?password=` 中，因为它可能进入浏览器历史、Referer 和代理日志。

## 会话识别

后端使用持久的 `TOKEN_ENCRYPTION_KEY` 对以下字段生成 HMAC-SHA256 指纹：

- 主机地址
- RDP 端口
- Windows 用户名
- Windows 密码

指纹不可逆且不会返回浏览器。相同凭据会进入同一活跃会话；不同密码或用户名会创建独立会话。分辨率不参与指纹，因此不同屏幕尺寸的参与者仍会加入同一桌面。

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

生产环境必须固定 `TOKEN_ENCRYPTION_KEY`。应用重启或多实例使用不同密钥时，同一连接指纹和连接 Token 将无法保持一致。

## API

- `POST /api/sessions`：按 RDP 凭据创建或加入会话；首位用户返回 `controller`，后续用户返回 `viewer`。
- `POST /api/sessions/:roomId/join`：兼容房间链接，为新参与者签发一次性 Join Token。
- `GET /api/sessions/:roomId`：通过参与者身份头查询人数和当前控制状态。
- `POST /api/sessions/:roomId/control`：当前参与者接管操作。
- `DELETE /api/sessions/:roomId/control`：临时操作者归还控制权。
- `DELETE /api/sessions/:roomId`：主用户使用 `x-owner-secret` 结束整个会话。

参与者接口使用 `x-participant-id` 和 `x-participant-secret` 身份头。Join Token 默认 60 秒过期，未使用的参与名额会自动释放。

## 当前范围

当前实现是单应用实例、单 guacd。若要横向扩容，需要把会话状态和 guacamole-lite session registry 替换为 Redis，并确保 Join 请求被路由到主连接所在的 guacd。

这项功能用于多人协作同一个 Windows 桌面。如果每个人需要独立 Windows 桌面，仍需 Windows Server RDS Session Host 与相应 RDS CAL，或为每位用户分配独立 VM。
