# WebRDP (v2.0 多人协作重写版)

基于 Apache Guacamole (`guacd`) 的轻量级 Web RDP 客户端，完整保留 [springsunx/webrdp](https://github.com/springsunx/webrdp) 的单端口 Docker 部署方式与 URL 参数直连习惯，并重构了服务端会话管理、多人共享控制权、异常恢复与移动端交互体验。

## ✨ 核心特性

- **原样保留连接体验**：支持登录表单与 URL Query / Fragment 参数直连（`host`、`port`、`user`、`password`、`width`、`height`、`title`、`auto` 等），保留 URL 密码兼容以支持刷新与书签恢复，并通过 `Referrer-Policy: no-referrer` 与一次性票据防止凭据外泄。
- **服务端权威的多人共享与单操作者控制**：
  - 相同目标与凭据自动进入同一共享会话（由网关持有 guacd 锚点连接，浏览器刷新不中断 Windows 会话）。
  - 首位进入者为**主用户**并默认拥有控制权；后续用户默认观看。
  - 观看者可一键**接管**；临时操作者可**归还**；主用户随时可**抢回**。
  - 临时操作者主动退出或断线时，控制权自动回归主用户并释放其按住的键鼠状态。
  - 主用户断线后保留主控身份（默认 `PRIMARY_GRACE_SECONDS=180` 秒），期间无人控制且观看者可接管；主用户在保留期内重连自动恢复主控身份与抢回权限；超时未回则自动晋升最早在线观看者。
  - 服务端在协议层严格拦截非操作者的键鼠/剪贴板/分辨率指令。
- **移动端与平板深度优化**：
  - 紧凑单行顶栏（适配刘海与 `safe-area-inset`），接管/抢回不膨胀为多行横幅。
  - 统一手势引擎：支持**触控板**与**直接触控**两种模式随时切换；覆盖点击、拖拽、长按/双指轻点右键、双指滚动/拖动画布、捏合缩放、三指轻点呼出/关闭软键盘（支持中文 IME 与快捷扩展键栏）。
  - 基于服务端 `connectedAt` 与时钟偏移校准的真实会话时长显示，刷新后连续计时，断开后冻结，不伪造在线时长。
  - 指数退避自动重连与非阻塞状态提示，不遮挡主要远程画面。

## 🚀 快速部署（兼容 springsunx/webrdp）

```bash
docker compose up -d --build
```

访问应用：
- 表单入口：`http://localhost:3000`
- URL 参数直连：`http://localhost:3000/?host=YOUR_RDP_HOST&port=3389&user=YOUR_USER&password=YOUR_PASSWORD&width=1280&height=720&title=办公电脑`
- Fragment 参数直连：`http://localhost:3000/#host=YOUR_RDP_HOST&port=3389&user=YOUR_USER&password=YOUR_PASSWORD`

更多部署、反向代理与环境变量说明请见 [DEPLOYMENT.md](DEPLOYMENT.md)。

## 🛠️ 本地开发与测试

```bash
cd packages/backend
npm install

# 运行全部单元测试与集成测试（内置 fake-guacd，无需真实 Windows）
npm test

# 启动本地演示环境（内置 fake-guacd + 网关）
npm run dev:fake
```

## 📄 许可证

[MIT License](LICENSE)
