# Harborly Email Worker

这是按产品部署的 Cloudflare Email Routing Worker。它把收到的邮件转发到该产品已经验证过的个人邮箱，再把信封、纯文本和附件元数据上报给 Harborly。

Harborly 主服务是闭源的。本目录是独立的 MIT 开源适配器，同一个模板为每个产品部署一份。Worker 不做垃圾邮件过滤，也不做 AI 分类；所有通过本产品地址校验的来信都会转发并上报。

Worker 只导出 `email` 处理函数，没有公网 `fetch` 调试入口。

## 处理顺序

1. 用 `ALLOWED_RECIPIENTS` 核对信封收件人。精确地址优先，其次才是可选的 `*@apex`。不在名单里的地址会直接 `setReject`，不转发，也不上报，避免进到错误产品。
2. 转发到 `FORWARD_TO`。这个地址必须是 Cloudflare 里已经验证的 destination。转发失败会记 `forwardStatus: "failed"`，然后继续上报。
3. `ctx.waitUntil` 异步上报。转发抛错时仍然上报。
4. 上报最终失败后，如果配置了飞书兜底，再发一条只含产品名、接收时间和失败码的告警。

网络目标只来自 Worker 配置。邮件正文、主题和头里的链接不会成为请求地址。

## 每个产品一份

复制本模板后，至少改这些配置：

| 名称 | 来源 | 作用 |
| --- | --- | --- |
| `name` | `wrangler.jsonc` | 该产品专用的 Worker 名称。同名部署会覆盖另一个产品。 |
| `INGEST_URL` | 明文变量 | Harborly `POST /api/workspace/mail-ingest`，只允许 HTTPS。 |
| `INTEGRATION_ID` | 明文变量 | 集成 GUID。 |
| `INTEGRATION_SECRET` | secret | HMAC 密钥，原始 UTF-8，不做 base64 解码。 |
| `FORWARD_TO` | 明文变量 | 已验证的个人邮箱。 |
| `ALLOWED_RECIPIENTS` | 明文变量 | 逗号分隔。精确地址，或可选的 `*@apex`。 |
| `PRODUCT_NAME` | 明文变量 | 飞书兜底里显示的产品名，最长 80 字符。 |
| `FALLBACK_WEBHOOK` | 可选 secret | 只允许 `https://open.feishu.cn/open-apis/bot/v2/hook/<uuid>`。 |
| `FALLBACK_SIGN_SECRET` | 可选 secret | 飞书机器人签名密钥。 |

默认 `wrangler.jsonc` 不写真实域名、真实收件地址，也不声明入站路由。明文变量由部署脚本在运行时传入。

## 先验证个人邮箱

`FORWARD_TO` 必须是当前 Cloudflare 账号里已经验证的 destination。没有验证时，指向它的规则会保持禁用，`message.forward` 也会失败。

1. 打开 Dashboard 的 **Compute > Email Service > Email Routing > Destination addresses**。
2. 添加个人邮箱。Cloudflare 会发送验证信。
3. 打开验证信并确认 **Verify email address**。在此之前不要把路由指到这个地址。
4. Destination 属于账号，同一个账号下的域名可以复用。

## 路由：精确地址优先，catch-all 可选

推荐先在 Dashboard 手工切换，再考虑用配置声明路由。

1. 进入对应域名的 **Routing rules**。
2. 为这个产品的每一个公开地址建立规则，Action 选 **Send to a Worker**，Worker 选该产品这份部署。
3. 精确地址规则优先于 catch-all。`support@example.com` 已有规则时，不会掉进 `*@example.com`。
4. catch-all 只支持域名 apex，例如 `*@example.com`。它会接住该主机上没有精确规则的本地部分。子域不会被父域 catch-all 匹配；`support@mail.example.com` 需要单独写精确地址。
5. 同一个 apex 上有多个产品时，不要给其中某一个产品打开 catch-all，否则其余地址会进入那个产品。Wrangler 4.156 的配置说明里，apex catch-all 还会收到该 zone 中没有精确规则的子域来信。本 Worker 的 `*@apex` 只匹配那个主机本身，不匹配子域；子域地址要逐个写入名单，否则会拒绝。
6. `ALLOWED_RECIPIENTS` 是产品边界。即使 Email Routing 把信送到了这个 Worker，名单之外的收件人仍然不会转发到本产品的 `FORWARD_TO`。
7. 比较按整个收件地址进行。`support+tag@example.com` 不等于 `support@example.com`。需要加号地址时，把完整地址写进名单，或只在该 apex 确实属于这个产品时使用 catch-all。

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
export INGEST_URL="https://example.invalid/api/workspace/mail-ingest"
export INTEGRATION_ID="00000000-0000-0000-0000-000000000000"
export FORWARD_TO="verified-destination@example.invalid"
export ALLOWED_RECIPIENTS="support@example.invalid,*@example.invalid"
export PRODUCT_NAME="example-product"
export INTEGRATION_SECRET="replace-me"
# 可选
# export FALLBACK_WEBHOOK="https://open.feishu.cn/open-apis/bot/v2/hook/00000000-0000-0000-0000-000000000000"
# export FALLBACK_SIGN_SECRET="replace-me"
bash scripts/deploy.sh
```

脚本使用 `set -euo pipefail`。它会检查必填变量、地址格式、HTTPS、飞书官方地址和 Wrangler 版本；发现 `addresses`、`wrangler.toml` 或 `wrangler.json` 时直接退出。密钥通过 `wrangler secret put` 从 stdin 写入。脚本只写入不删除：之后取消飞书兜底时，需要手动执行 `pnpm exec wrangler secret delete FALLBACK_WEBHOOK`（以及 `FALLBACK_SIGN_SECRET`）。脚本不打印变量值，也不把密钥写进仓库。Wrangler 自己的输出仍可能回显明文变量，不要外传部署日志。

本地开发可以把 `.dev.vars.example` 复制为 `.dev.vars`。`.dev.vars` 已被忽略。示例里只有占位值。

## 上报协议

请求体是一份 UTF-8 JSON，只序列化后的这组字节参与签名。超时、429 和 5xx 会用同一份 body、新的 timestamp 和 nonce 重试，最多 4 次，单次超时 4 秒，总预算 12 秒。401、403、413 等其他 4xx 视为配置或请求错误，不盲目重试。2xx（包括 202）视为成功。

请求头：

- `X-Harborly-Integration`
- `X-Harborly-Timestamp`：Unix 秒
- `X-Harborly-Nonce`：UUID
- `X-Harborly-Signature`：小写 hex HMAC-SHA256

签名输入是 `integrationId\n秒\nnonce\nsha256hex(body原始UTF8)`。

`fetch` 设置 `redirect: "manual"`，遇到重定向就失败，避免密钥被带到另一个地址。`INGEST_URL` 只接受 HTTPS，且不能带账号信息。

JSON 字段：`envelopeFrom`、`envelopeTo`、`messageId`、`subject`、`textBody`、`receivedAt`、`rawSize`、`attachmentsMeta`、`parseStatus`、`bodyTruncated`、`forwardStatus`。附件元数据只有 `fileName`、`contentType`、`size`。不上报 HTML、附件实体或原始 MIME。

限制：

- 原始邮件超过 2 MiB：不读取 raw，`parseStatus` 为 `headers_only`，附件列表为空。
- `postal-mime` 解码失败：`parseStatus` 为 `failed`，不影响已经完成或失败的转发。
- 纯文本最多 32768 个 UTF-16 字符（与后端 `string.Length` 一致），主题 512，附件元数据最多 50 条，文件名 255。
- JSON 正文限制在 256 KiB 以内并留出请求头空间。超限时继续截断正文和附件元数据。
- 畸形头会去掉控制字符和孤立代理项后再截断，避免发出非法 JSON。

`parseStatus` 为 `parsed`、`headers_only` 或 `failed`。`forwardStatus` 为 `succeeded` 或 `failed`。

## 飞书兜底

只在 Harborly 上报最终失败时发送。消息只有产品名、接收时间和失败码，没有发件人、主题或正文。

Webhook 必须是 `https://open.feishu.cn/open-apis/bot/v2/hook/<uuid>`，不能带端口、查询串或其他路径。请求同样禁止跟随重定向。配置了签名密钥时，按飞书自定义机器人的算法签名：密钥材料是 `timestamp\nsecret`，对空字节做 HMAC-SHA256，再做 Base64，放进 JSON 的 `timestamp` 和 `sign`。HTTP 状态和飞书返回的 `code` / `StatusCode` 都必须表示成功。

## 日志

日志只有事件名、失败码、原始大小、上报字节数、耗时和 `forwardStatus`。不记录主题、邮箱、正文、密钥、上报 URL、Webhook token，也不记录异常的原始 message。

`wrangler.jsonc` 关闭了 Workers Logs 的调用日志（`invocation_logs: false`），因为 email 事件的调用元数据自带发件人和收件人地址。

## 检查

```bash
pnpm install
pnpm exec tsc --noEmit
```

不要从这个包启动 Worker、执行 `wrangler deploy`，或向真实的 Harborly / 飞书地址发请求，除非你正在按上面的步骤部署自己的产品。
