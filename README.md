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

Worker 不缓存代理响应，并统一返回 `Cache-Control: no-store`。每次请求都会实时转发到弹弹play API。

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
- 如果将来使用需要用户登录的受限接口，仍需提供原 API 要求的 `Authorization: Bearer <JWT>`。
- 请遵守弹弹play开放弹幕网络的缓存、配额、署名和非商业使用约定。
