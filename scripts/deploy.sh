#!/usr/bin/env bash
# 为一个 Cloudflare 账号部署 Email Worker，对应 Harborly 的一个用户级邮件连接。
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

for name in CONNECTION_ID CONNECTION_SECRET FORWARD_TO; do
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

// 可选：留空时 Worker 使用 https://harborly.dev/api/workspace/mail-ingest。
const ingest = process.env.INGEST_URL ?? "";
if (ingest.length > 0) {
  if (ingest.length > 2048 || /[\u0000-\u001F\u007F]/.test(ingest)) {
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
}

if (!uuid.test((process.env.CONNECTION_ID ?? "").trim())) fail("CONNECTION_ID 必须是 GUID");

if (!isExact((process.env.FORWARD_TO ?? "").trim().toLowerCase())) {
  fail("FORWARD_TO 必须是单个邮箱地址，且该地址要先在 Cloudflare 完成 destination 验证");
}

const secret = process.env.CONNECTION_SECRET ?? "";
if (secret.length === 0 || secret.length > 4096 || /[\r\n]/.test(secret)) fail("CONNECTION_SECRET 无效");

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
一个 Cloudflare 账号部署一份，对应 Harborly 的一个邮件连接；该账号下所有产品共用同一个 FORWARD_TO。
Worker 不持有地址名单。产品归属由 Harborly 按收件地址决定，未登记的地址会被 Harborly 拒收。

本脚本不会声明 addresses，因此不会创建、接管或删除 Email Routing 规则。
请在 Dashboard 为每个域名把 catch-all（或个别精确地址）改成 Send to a Worker，并人工确认目标就是「${worker_name}」。
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

secret_put CONNECTION_SECRET "$CONNECTION_SECRET"

deploy_args=(
  deploy
  --config wrangler.jsonc
  --var "CONNECTION_ID:${CONNECTION_ID}"
  --var "FORWARD_TO:${FORWARD_TO}"
)
if [[ -n "${INGEST_URL:-}" ]]; then
  deploy_args+=(--var "INGEST_URL:${INGEST_URL}")
fi

pnpm exec wrangler "${deploy_args[@]}"
