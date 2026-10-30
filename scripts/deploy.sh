#!/usr/bin/env bash
# 部署某一个产品的 Email Worker。
# 本脚本不创建、不接管、不删除 Email Routing 规则。路由请先在 Dashboard 手工切换。
set -euo pipefail

cd "$(dirname "$0")/.."

die() {
  printf '%s\n' "$1" >&2
  exit 1
}

[[ -f package.json && -f wrangler.jsonc ]] || die "请在 harborly-email-worker 目录中运行"
[[ ! -f wrangler.toml && ! -f wrangler.json ]] || die "只使用 wrangler.jsonc。请删除 wrangler.toml 和 wrangler.json，避免另一份配置改动路由。"

if grep -Eq '"addresses"[[:space:]]*:' wrangler.jsonc; then
  die "拒绝部署：wrangler.jsonc 含有 addresses。本脚本不会创建、接管或删除 Email Routing 规则。请删除该字段，并先在 Dashboard 手工切换路由。"
fi

command -v pnpm >/dev/null 2>&1 || die "需要已安装的 pnpm。本脚本不会安装全局工具。"
command -v node >/dev/null 2>&1 || die "需要 Node.js 22 或更新版本。"

for name in INGEST_URL INTEGRATION_ID FORWARD_TO ALLOWED_RECIPIENTS PRODUCT_NAME INTEGRATION_SECRET; do
  if [[ -z "${!name:-}" ]]; then
    die "缺少环境变量 ${name}"
  fi
done

node --input-type=module <<'NODE'
const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

const email =
  /^[a-z0-9._%+\-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const catchAll =
  /^\*@([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$/;
const ipv4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const uuid =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function isExact(value) {
  if (value.length > 320) return false;
  const at = value.lastIndexOf("@");
  if (at < 1 || at > 64) return false;
  const domain = value.slice(at + 1);
  if (domain.length > 253 || ipv4.test(domain)) return false;
  return email.test(value);
}

const ingest = process.env.INGEST_URL ?? "";
if (ingest.length === 0 || ingest.length > 2048 || /[\u0000-\u001F\u007F]/.test(ingest)) {
  fail("INGEST_URL 必须是 HTTPS 地址");
}
let ingestUrl;
try {
  ingestUrl = new URL(ingest.trim());
} catch {
  fail("INGEST_URL 必须是 HTTPS 地址");
}
if (ingestUrl.protocol !== "https:" || ingestUrl.username || ingestUrl.password || ingestUrl.hostname.length === 0) {
  fail("INGEST_URL 必须是不含账号信息的 HTTPS 地址");
}

if (!uuid.test((process.env.INTEGRATION_ID ?? "").trim())) fail("INTEGRATION_ID 必须是 GUID");

if (!isExact((process.env.FORWARD_TO ?? "").trim().toLowerCase())) {
  fail("FORWARD_TO 必须是单个邮箱地址，且该地址要先在 Cloudflare 完成 destination 验证");
}

const product = process.env.PRODUCT_NAME ?? "";
if (product.trim().length === 0 || product.length > 80 || /[\u0000-\u001F\u007F]/.test(product)) {
  fail("PRODUCT_NAME 不能为空、不能超过 80 个字符，且不能包含控制字符");
}

const secret = process.env.INTEGRATION_SECRET ?? "";
if (secret.length === 0 || secret.length > 4096 || /[\r\n]/.test(secret)) fail("INTEGRATION_SECRET 无效");

const allow = process.env.ALLOWED_RECIPIENTS ?? "";
if (allow.trim().length === 0 || /[\u0000-\u001F\u007F]/.test(allow)) fail("ALLOWED_RECIPIENTS 无效");
const parts = allow.split(",");
let usable = 0;
parts.forEach((part, index) => {
  const entry = part.trim().toLowerCase();
  const label = `ALLOWED_RECIPIENTS 第 ${index + 1} 项`;
  if (!entry) fail(`${label}为空`);
  if (entry.startsWith("*@")) {
    const match = catchAll.exec(entry);
    const domain = match?.[1] ?? "";
    if (!match || domain.length > 253 || ipv4.test(domain)) fail(`${label}不是 apex catch-all`);
    usable += 1;
    return;
  }
  if (!isExact(entry)) fail(`${label}不是精确地址`);
  usable += 1;
});
if (usable === 0) fail("ALLOWED_RECIPIENTS 没有可用地址");

const hook = (process.env.FALLBACK_WEBHOOK ?? "").trim();
const sign = process.env.FALLBACK_SIGN_SECRET ?? "";
if (/[\r\n]/.test(sign) || sign.length > 4096) fail("FALLBACK_SIGN_SECRET 无效");
if (sign.length > 0 && hook.length === 0) fail("设置了 FALLBACK_SIGN_SECRET 时必须同时设置 FALLBACK_WEBHOOK");
if (hook.length > 0) {
  let hookUrl;
  try {
    hookUrl = new URL(hook);
  } catch {
    fail("FALLBACK_WEBHOOK 必须是飞书官方 HTTPS 地址");
  }
  const matched = hookUrl.pathname.match(/^\/open-apis\/bot\/v2\/hook\/([0-9a-fA-F-]{36})$/);
  const id = matched?.[1] ?? "";
  const canonical = uuid.test(id) ? `https://open.feishu.cn/open-apis/bot/v2/hook/${id.toLowerCase()}` : "";
  if (
    hookUrl.protocol !== "https:" ||
    hookUrl.hostname !== "open.feishu.cn" ||
    hookUrl.port !== "" ||
    hookUrl.username ||
    hookUrl.password ||
    hookUrl.search !== "" ||
    hookUrl.hash !== "" ||
    hookUrl.href !== canonical
  ) {
    fail("FALLBACK_WEBHOOK 只允许 https://open.feishu.cn/open-apis/bot/v2/hook/<uuid>");
  }
}
NODE

raw_version="$(pnpm exec wrangler --version 2>/dev/null || true)"
version="$(printf '%s\n' "$raw_version" | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -n 1 || true)"
[[ -n "$version" ]] || die "找不到本包的 Wrangler。请先在本目录执行 pnpm install。需要 Wrangler >= 4.113.0，不要复用主仓库 web 的旧版本。"

if ! awk -v got="$version" 'BEGIN {
  split(got, a, ".");
  split("4.113.0", b, ".");
  for (i = 1; i <= 3; i++) {
    av = a[i] + 0;
    bv = b[i] + 0;
    if (av > bv) exit 0;
    if (av < bv) exit 1;
  }
  exit 0;
}'; then
  die "Wrangler ${version} 低于 4.113.0。请使用本包锁定的 Wrangler，不要复用主仓库 web 的旧版本。"
fi

worker_name="$(sed -n 's/^[[:space:]]*"name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' wrangler.jsonc | head -n 1)"
[[ -n "$worker_name" ]] || die "wrangler.jsonc 缺少 Worker name"

cat <<EOF
即将部署 Worker「${worker_name}」，Wrangler ${version}。
每个产品要使用不同的 Worker 名称，并各自配置 INTEGRATION_ID、FORWARD_TO 和 ALLOWED_RECIPIENTS。

本脚本不会声明 addresses，因此不会创建、接管或删除 Email Routing 规则。
请先在 Dashboard 把本产品的精确地址改成 Send to a Worker，并人工确认目标就是「${worker_name}」。
精确地址规则优先于 catch-all。apex catch-all 可选，只在整个 apex 都属于这个产品时使用。
addresses 是顶层字段，所有 Wrangler environment 共享；写在 env 下会被忽略。
不要把 addresses 设为空数组，那会删除本 Worker 管理的全部路由。
非交互环境不会自动确认删除或接管；不要在 CI 里跳过确认去改路由。

变量和密钥的值不会在这里打印。Wrangler 自己的输出仍可能回显明文变量，不要把部署日志贴到工单或聊天。
密钥通过 wrangler secret put 从 stdin 写入，仓库和脚本都不保存真实密钥。
EOF

secret_put() {
  local key="$1"
  local value="$2"
  printf '%s' "$value" | pnpm exec wrangler secret put "$key" --config wrangler.jsonc
}

secret_put INTEGRATION_SECRET "$INTEGRATION_SECRET"
if [[ -n "${FALLBACK_SIGN_SECRET:-}" ]]; then
  secret_put FALLBACK_SIGN_SECRET "$FALLBACK_SIGN_SECRET"
fi
if [[ -n "${FALLBACK_WEBHOOK:-}" ]]; then
  secret_put FALLBACK_WEBHOOK "$FALLBACK_WEBHOOK"
fi

deploy_args=(
  deploy
  --config wrangler.jsonc
  --var "INGEST_URL:${INGEST_URL}"
  --var "INTEGRATION_ID:${INTEGRATION_ID}"
  --var "FORWARD_TO:${FORWARD_TO}"
  --var "ALLOWED_RECIPIENTS:${ALLOWED_RECIPIENTS}"
  --var "PRODUCT_NAME:${PRODUCT_NAME}"
)

pnpm exec wrangler "${deploy_args[@]}"
