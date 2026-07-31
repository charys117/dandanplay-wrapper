# dandanplay-wrapper

部署在 Cloudflare Workers 上的弹弹play开放弹幕网络反向代理。

它解决播放器无法配置 HTTP 请求头的问题：调用方把代理访问令牌放在 URL 的第一个路径段，Worker 校验令牌、移除该路径段，然后自动为上游请求生成弹弹play应用签名。

## URL 规则

```text
https://<你的Worker域名>/<PROXY_TOKEN>/<弹弹play API路径>?<原查询参数>
```

例如：

```text
上游：https://api.dandanplay.net/api/v2/comment/123450001?withRelated=true
代理：https://dandanplay-wrapper.example.workers.dev/<PROXY_TOKEN>/api/v2/comment/123450001?withRelated=true
```

除第一个令牌路径段外，请求方法、路径、查询参数、请求体和大部分请求头都会透传。Worker 会覆盖 `X-AppId`、`X-Timestamp`、`X-Signature`，因此调用方不需要设置这些请求头。

> URL 可能出现在播放器历史、代理日志或浏览器历史中。请使用足够长的随机令牌、只通过 HTTPS 调用，并在泄露后立即轮换 `PROXY_TOKEN`。

## 缓存行为

- 无 `Authorization` 和 `Cookie` 的成功 `GET` 响应会写入 Cloudflare Cache API。
- 默认 TTL 为 86400 秒（24 小时）。即使把 `CACHE_TTL_SECONDS` 配成更小的值，Worker 也会强制使用至少 24 小时。
- 带用户凭据的请求、非 GET 请求、非 200 响应以及带 `Set-Cookie` 的响应不会缓存。
- `X-Proxy-Cache` 响应头会显示 `HIT`、`MISS` 或 `BYPASS`。
- Cloudflare Cache API 按数据中心缓存，TTL 表示最长新鲜时间；低频对象仍可能因边缘缓存空间策略提前被逐出。

如果需要主动绕过缓存，可发送 `Cache-Control: no-cache`。不支持自定义请求头的播放器可以给请求添加一个无业务影响且不同的查询参数来形成新的缓存键，但应避免高频使用。

## 本地开发

要求 Node.js 22 或更高版本。

```bash
npm install
cp .dev.vars.example .dev.vars
```

编辑 `.dev.vars`：

```dotenv
DANDANPLAY_APP_ID="你的AppId"
DANDANPLAY_APP_SECRET="你的AppSecret"
PROXY_TOKEN="一个足够长的随机URL安全令牌"
```

可以这样生成访问令牌：

```bash
openssl rand -hex 32
```

启动：

```bash
npm run dev
```

示例请求：

```bash
curl "http://localhost:8787/<PROXY_TOKEN>/api/v2/search/episodes?anime=%E8%91%AC%E9%80%81%E7%9A%84%E8%8A%99%E8%8E%89%E8%8E%B2&episode=1&v2=true"
```

检查代码：

```bash
npm test
npm run check
```

## 通过 GitHub 自动部署

1. 把本仓库推送到 GitHub。
2. 在 Cloudflare Dashboard 打开 **Workers & Pages → Create application → Import a repository**。
3. 选择该 GitHub 仓库；项目根目录保持为空，部署命令使用默认的 `npx wrangler deploy`。
4. Worker 名称应为 `dandanplay-wrapper`，需要与 `wrangler.jsonc` 的 `name` 一致。
5. 首次创建后，进入 **Settings → Variables and Secrets**，添加三个运行时 Secret：
   - `DANDANPLAY_APP_ID`
   - `DANDANPLAY_APP_SECRET`
   - `PROXY_TOKEN`
6. 重新部署。以后推送到生产分支会自动构建并部署；其他分支可在 Branch control 中启用预览构建。

`CACHE_TTL_SECONDS` 已在 `wrangler.jsonc` 中设为 `86400`，不是敏感配置。如需延长缓存，可以改为更大的秒数。

也可以先通过 CLI 手动部署：

```bash
npx wrangler login
npx wrangler secret put DANDANPLAY_APP_ID
npx wrangler secret put DANDANPLAY_APP_SECRET
npx wrangler secret put PROXY_TOKEN
npm run deploy
```

## 兼容性说明

- 上游固定为 `https://api.dandanplay.net`，避免代理被用于访问任意地址。
- 弹幕接口的 302 跳转由 Worker 跟随，调用方收到最终响应。
- 弹弹play业务错误可能使用 HTTP 200 返回；本代理不改写其响应体。
- 如果将来使用需要用户登录的受限接口，仍需提供原 API 要求的 `Authorization: Bearer <JWT>`，并且此类请求会自动绕过缓存。
- 请遵守弹弹play开放弹幕网络的缓存、配额、署名和非商业使用约定。
