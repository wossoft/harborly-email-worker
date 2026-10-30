# Harborly Email Worker

这是 Cloudflare Email Routing Worker。每个 Cloudflare 账号部署一份，对应 Harborly 里的一个用户级邮件连接，该账号下所有产品共用。它把收到的邮件转发到你已验证的个人邮箱，再把信封、纯文本和附件元数据上报给 Harborly。

Harborly 主服务是闭源的。本目录是独立的 MIT 开源适配器。Worker 不做垃圾邮件过滤，也不做 AI 分类，也不持有地址名单；所有送到它的来信都会转发并上报。

Worker 只导出 `email` 处理函数，没有公网 `fetch` 调试入口。

## 处理顺序

1. 转发到 `FORWARD_TO`。这个地址必须是 Cloudflare 里已经验证的 destination。转发失败会记 `forwardStatus: "failed"`，然后继续上报。
2. `ctx.waitUntil` 异步上报。转发抛错时仍然上报。
3. 产品归属由 Harborly 按信封收件地址决定。未在任何产品登记的地址，Harborly 返回 4xx 拒收，Worker 不重试，原因显示在 Harborly 的连接页。

Worker 不直接发任何通知。上报失败只记日志，原件已在个人邮箱；飞书推送统一由 Harborly 负责。

网络目标只来自 Worker 配置。邮件正文、主题和头里的链接不会成为请求地址。

## 在 Harborly 建连接

1. 在 Harborly「账户 → 邮件连接」新建一个连接，取得 connectionId 和连接密钥。密钥只显示一次，直接放进部署环境变量，不要贴到别处。
2. 在每个产品的邮件设置里登记该产品使用的收件地址。地址只在 Harborly 登记，不写进 Worker。

一个 Cloudflare 账号对应一个连接、一份部署。同一账号下新增产品时，只需在 Harborly 登记地址，不用重新部署 Worker。

## 配置

| 名称                | 来源             | 作用                                                                                |
| ------------------- | ---------------- | ----------------------------------------------------------------------------------- |
| `name`              | `wrangler.jsonc` | Worker 名称。同一账号内唯一即可。                                                   |
| `INGEST_URL`        | 可选明文变量     | 默认 `https://harborly.dev/api/workspace/mail-ingest`；自托管时覆盖，只允许 HTTPS。 |
| `CONNECTION_ID`     | 明文变量         | 连接 GUID。                                                                         |
| `CONNECTION_SECRET` | secret           | HMAC 密钥，原始 UTF-8，不做 base64 解码。                                           |
| `FORWARD_TO`        | 明文变量         | 已验证的个人邮箱，所有产品共用。                                                    |

默认 `wrangler.jsonc` 不写真实域名、真实收件地址，也不声明入站路由。明文变量由部署脚本在运行时传入。

## 先验证个人邮箱

`FORWARD_TO` 必须是当前 Cloudflare 账号里已经验证的 destination。没有验证时，指向它的规则会保持禁用，`message.forward` 也会失败。

1. 打开 Dashboard 的 **Compute > Email Service > Email Routing > Destination addresses**。
2. 添加个人邮箱。Cloudflare 会发送验证信。
3. 打开验证信并确认 **Verify email address**。在此之前不要把路由指到这个地址。
4. Destination 属于账号，同一个账号下的所有域名和产品共用这一个转发邮箱。

## 路由：每个域名一条 catch-all

推荐在 Dashboard 手工配置。

1. 进入每个域名的 **Routing rules**。
2. 把 catch-all（`*@example.com`）的 Action 设为 **Send to a Worker**，Worker 选这份部署。之后同一域名下的新产品地址无需再改 Cloudflare，只在 Harborly 登记即可。
3. 不想用 catch-all 时，也可以只为个别地址建立精确规则指向这份 Worker。精确地址规则优先于 catch-all。
4. catch-all 会把该域名任意地址的来信都送到 Worker，因此也都会转发到 `FORWARD_TO`。其中未在 Harborly 登记的地址会被 Harborly 拒收，原因显示在连接页；转发不受影响。
5. catch-all 只覆盖域名 apex。子域地址（如 `support@mail.example.com`）需要该子域自己的规则。
6. 比较按整个收件地址进行。`support+tag@example.com` 不等于 `support@example.com`，需要时在 Harborly 登记完整地址。

### `addresses` 与环境

Wrangler 4.113.0 起可以用顶层 `addresses` 把入站地址交给当前 Worker。本模板故意不写这个字段。

- 省略 `addresses` 时，部署不会修改 Email Routing。
- 把它设成空数组会删除本 Worker 已经管理的路由。不要这样做。
- `addresses` 只能写在顶层，所有 environment 共享。写在 `env` 下面会被忽略。
- 部署或 `wrangler triggers deploy` 会让 Wrangler 对齐它管理的规则：新增、更新，以及删除不再列出的规则。删除或接管已有规则前，Wrangler 会要求确认。非交互环境不会自动确认，确认失败时 Worker 代码可能已经部署，但路由不会被改掉。
- 因此不要在 CI 里用自动确认去接管或删除路由。要改路由时，先在 Dashboard 看清现有规则，再在交互式终端手动执行并确认提示。

## 部署

要求 Node.js 22 或更新版本，以及本包锁定的 Wrangler（至少 4.113.0）。不要复用 Harborly Web 项目里的旧 Wrangler。

```bash
pnpm install
export CONNECTION_ID="00000000-0000-0000-0000-000000000000"
export CONNECTION_SECRET="replace-me"
export FORWARD_TO="verified-destination@example.invalid"
# 可选：自托管 Harborly 时覆盖，默认 https://harborly.dev/api/workspace/mail-ingest
# export INGEST_URL="https://example.invalid/api/workspace/mail-ingest"
bash scripts/deploy.sh
```

脚本使用 `set -euo pipefail`。它会检查必填变量、地址格式、HTTPS 和 Wrangler 版本；发现 `addresses`、`wrangler.toml` 或 `wrangler.json` 时直接退出。密钥通过 `wrangler secret put` 从 stdin 写入。脚本只写入不删除；早期部署留下的 `FALLBACK_WEBHOOK`、`FALLBACK_SIGN_SECRET` 已不再使用，可用 `pnpm exec wrangler secret delete` 手动删除。脚本不打印变量值，也不把密钥写进仓库。Wrangler 自己的输出仍可能回显明文变量，不要外传部署日志。

也可以把变量写进 `.dev.vars`（从 `.dev.vars.example` 复制），脚本会用它补齐未 export 的变量；已 export 的值优先。脚本按文本解析该文件，只读取上面四个变量，不当作 shell 执行。`.dev.vars` 同时用于本地 `wrangler dev`，已被忽略。示例里只有占位值。注意它里面的值会被直接部署到线上。

## 上报协议

请求体是一份 UTF-8 JSON，只序列化后的这组字节参与签名。超时、429 和 5xx 会用同一份 body、新的 timestamp 和 nonce 重试，最多 4 次，单次超时 4 秒，总预算 12 秒。401、403、413 等其他 4xx 视为配置或请求错误，不盲目重试。2xx（包括 202）视为成功。

请求头：

- `X-Harborly-Connection`：connectionId
- `X-Harborly-Timestamp`：Unix 秒
- `X-Harborly-Nonce`：UUID
- `X-Harborly-Signature`：小写 hex HMAC-SHA256

签名输入是 `connectionId + "\n" + Unix秒 + "\n" + nonce + "\n" + sha256hex(body原始字节)`，密钥按原始 UTF-8 使用。这是协议 v2。

`fetch` 设置 `redirect: "manual"`，遇到重定向就失败，避免密钥被带到另一个地址。`INGEST_URL` 只接受 HTTPS，且不能带账号信息。

JSON 字段：`envelopeFrom`、`envelopeTo`、`messageId`、`subject`、`textBody`、`receivedAt`、`rawSize`、`attachmentsMeta`、`parseStatus`、`bodyTruncated`、`forwardStatus`。附件元数据只有 `fileName`、`contentType`、`size`。不上报 HTML、附件实体或原始 MIME。

限制：

- 原始邮件超过 2 MiB：不读取 raw，`parseStatus` 为 `headers_only`，附件列表为空。
- `postal-mime` 解码失败：`parseStatus` 为 `failed`，不影响已经完成或失败的转发。
- 纯文本最多 32768 个 UTF-16 字符（与后端 `string.Length` 一致），主题 512，附件元数据最多 50 条，文件名 255。
- JSON 正文限制在 256 KiB 以内并留出请求头空间。超限时继续截断正文和附件元数据。
- 畸形头会去掉控制字符和孤立代理项后再截断，避免发出非法 JSON。

`parseStatus` 为 `parsed`、`headers_only` 或 `failed`。`forwardStatus` 为 `succeeded` 或 `failed`。

## 日志

日志只有事件名、失败码、原始大小、上报字节数、耗时和 `forwardStatus`。不记录主题、邮箱、正文、密钥、上报 URL，也不记录异常的原始 message。

`wrangler.jsonc` 关闭了 Workers Logs 的调用日志（`invocation_logs: false`），因为 email 事件的调用元数据自带发件人和收件人地址。

## 检查

```bash
pnpm install
pnpm lint
pnpm format:check
pnpm exec tsc --noEmit
```

提交前对改动过的文件跑 `pnpm exec prettier --write <文件>`（或全仓 `pnpm format`），保持格式一致。`pnpm install` 后会自动启用 pre-commit hook，commit 时对暂存文件做同样的事。

不要从这个包启动 Worker、执行 `wrangler deploy`，或向真实的 Harborly 地址发请求，除非你正在按上面的步骤部署自己的连接。
