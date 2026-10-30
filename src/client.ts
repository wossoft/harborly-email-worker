import type { Env, MailIngestPayload, ParseStatus } from "./types.ts";
import { MAX_API_BYTES, MAX_RAW_PARSE_BYTES } from "./types.ts";

const MAX_ATTEMPTS = 4;
const TOTAL_BUDGET_MS = 12_000;
const ATTEMPT_TIMEOUT_MS = 4_000;
const FALLBACK_ATTEMPTS = 2;
const FALLBACK_BUDGET_MS = 5_000;
const FALLBACK_TIMEOUT_MS = 3_000;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const SAFE_CODE = /^[a-z0-9_]{1,40}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const encoder = new TextEncoder();

export interface AttemptResult {
  ok: boolean;
  code: string;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return toHex(new Uint8Array(digest));
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function hmacHex(key: CryptoKey, value: string): Promise<string> {
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return toHex(new Uint8Array(signature));
}

function binding(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function safeCode(code: string): string {
  return SAFE_CODE.test(code) ? code : "unclassified";
}

function isTimeout(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("name" in error)) return false;
  const name = error.name;
  return name === "TimeoutError" || name === "AbortError";
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // 响应体可能回显邮件或密钥，失败时也不读取。
  }
}

function ingestUrlError(raw: string): string | null {
  const value = raw.trim();
  if (value.length === 0 || value.length > 2048 || /[\u0000-\u001F\u007F]/.test(value))
    return "invalid_ingest_url";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "invalid_ingest_url";
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hostname.length === 0)
    return "invalid_ingest_url";
  return null;
}

/** 只接受飞书官方自定义机器人 HTTPS 地址，拒绝其他主机、端口、路径和查询串。 */
export function canonicalFeishuWebhook(raw: string): string | null {
  const value = raw.trim();
  if (value.length === 0 || /[\u0000-\u001F\u007F]/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== "open.feishu.cn" || url.port !== "")
    return null;
  if (url.username || url.password || url.search !== "" || url.hash !== "") return null;
  const match = url.pathname.match(/^\/open-apis\/bot\/v2\/hook\/([0-9a-fA-F-]{36})$/);
  const id = match?.[1];
  if (!id || !UUID_RE.test(id)) return null;
  const canonical = `https://open.feishu.cn/open-apis/bot/v2/hook/${id.toLowerCase()}`;
  if (url.href !== canonical) return null;
  return canonical;
}

function encodedSize(payload: MailIngestPayload): number {
  return encoder.encode(JSON.stringify(payload)).byteLength;
}

function reducedStatus(source: MailIngestPayload): ParseStatus {
  return source.parseStatus === "failed" && source.rawSize <= MAX_RAW_PARSE_BYTES
    ? "failed"
    : "headers_only";
}

// 地址字段最多 320 字符，始终放得下；保留它们，否则后端无法按收件地址归属产品而拒收。
function minimalPayload(source: MailIngestPayload): MailIngestPayload {
  return {
    envelopeFrom: source.envelopeFrom,
    envelopeTo: source.envelopeTo,
    messageId: null,
    subject: "",
    textBody: "",
    receivedAt: ISO_TIME.test(source.receivedAt) ? source.receivedAt : new Date().toISOString(),
    rawSize: source.rawSize,
    attachmentsMeta: [],
    parseStatus: reducedStatus(source),
    bodyTruncated: true,
    forwardStatus: source.forwardStatus,
  };
}

function shrinkPayload(payload: MailIngestPayload): MailIngestPayload {
  let current = payload;
  if (encodedSize(current) <= MAX_API_BYTES) return current;

  let text = current.textBody;
  for (
    let guard = 0;
    guard < 20 && encodedSize(current) > MAX_API_BYTES && text.length > 0;
    guard++
  ) {
    const chars = Array.from(text);
    text = chars.slice(0, Math.floor(chars.length / 2)).join("");
    current = { ...current, textBody: text, bodyTruncated: true };
  }

  let attachments = current.attachmentsMeta;
  while (encodedSize(current) > MAX_API_BYTES && attachments.length > 0) {
    attachments = attachments.slice(0, -1);
    current = { ...current, attachmentsMeta: attachments };
  }
  if (encodedSize(current) <= MAX_API_BYTES) return current;

  const parseStatus = reducedStatus(current);
  current = {
    ...current,
    messageId:
      current.messageId === null ? null : Array.from(current.messageId).slice(0, 80).join(""),
    subject: Array.from(current.subject).slice(0, 80).join(""),
    textBody: "",
    attachmentsMeta: [],
    parseStatus,
    bodyTruncated: true,
  };
  if (encodedSize(current) <= MAX_API_BYTES) return current;
  return minimalPayload(current);
}

/** 测量过程可能多次 stringify；返回值是唯一会被签名和发送的 UTF-8 字节。重试复用这同一份字节。 */
export function serializeIngest(payload: MailIngestPayload): Uint8Array {
  try {
    const fitted = shrinkPayload(payload);
    const bytes = encoder.encode(JSON.stringify(fitted));
    if (bytes.byteLength <= MAX_API_BYTES) return bytes;
  } catch {
    // 落到固定的最小 JSON。
  }
  return encoder.encode(JSON.stringify(minimalPayload(payload)));
}

function backoffMs(failedAttempt: number, deadline: number): number {
  const table = [300, 800, 1600];
  const base = table[Math.min(failedAttempt, table.length - 1)] ?? 1600;
  const wait = base + Math.floor(Math.random() * 150);
  const room = deadline - Date.now() - 250;
  if (room <= 0) return 0;
  return Math.min(wait, room);
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

async function signedHeaders(
  connectionId: string,
  key: CryptoKey,
  bodyHash: string,
): Promise<Headers> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomUUID();
  const signature = await hmacHex(key, `${connectionId}\n${timestamp}\n${nonce}\n${bodyHash}`);
  const headers = new Headers();
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("X-Harborly-Connection", connectionId);
  headers.set("X-Harborly-Timestamp", timestamp);
  headers.set("X-Harborly-Nonce", nonce);
  headers.set("X-Harborly-Signature", signature);
  return headers;
}

export async function postIngest(env: Env, body: Uint8Array): Promise<AttemptResult> {
  const ingestUrl = binding(env.INGEST_URL).trim();
  const connectionId = binding(env.CONNECTION_ID).trim();
  const secret = binding(env.CONNECTION_SECRET);
  const urlError = ingestUrlError(ingestUrl);
  if (urlError) return { ok: false, code: urlError };
  if (!UUID_RE.test(connectionId)) return { ok: false, code: "invalid_connection_id" };
  if (secret.length === 0 || secret.length > 4096) return { ok: false, code: "missing_secret" };

  let key: CryptoKey;
  let bodyHash: string;
  try {
    key = await importHmacKey(secret);
    bodyHash = await sha256Hex(body);
  } catch {
    return { ok: false, code: "sign_failed" };
  }

  const deadline = Date.now() + TOTAL_BUDGET_MS;
  let lastCode = "ingest_failed";
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining < 250)
      return {
        ok: false,
        code: lastCode === "ingest_failed" ? "budget_exceeded" : lastCode,
      };
    const timeout = Math.min(ATTEMPT_TIMEOUT_MS, remaining);
    try {
      const response = await fetch(ingestUrl, {
        method: "POST",
        redirect: "manual",
        cache: "no-store",
        headers: await signedHeaders(connectionId, key, bodyHash),
        body,
        signal: AbortSignal.timeout(timeout),
      });
      const status = response.status;
      const redirected =
        (response.type as string) === "opaqueredirect" || (status >= 300 && status < 400);
      await discard(response);
      if (redirected) return { ok: false, code: "redirect_rejected" };
      if (status >= 200 && status < 300) return { ok: true, code: "accepted" };
      if (status === 0) {
        lastCode = "network";
      } else if (!retryableStatus(status)) {
        return { ok: false, code: `http_${status}` };
      } else {
        lastCode = status === 429 ? "http_429" : `http_${status}`;
      }
    } catch (error) {
      lastCode = isTimeout(error) ? "timeout" : "network";
    }
    if (attempt < MAX_ATTEMPTS - 1) await sleep(backoffMs(attempt, deadline));
  }
  return { ok: false, code: safeCode(lastCode) };
}

async function feishuSign(secret: string, timestamp: string): Promise<string> {
  const key = await importHmacKey(`${timestamp}\n${secret}`);
  const signature = await crypto.subtle.sign("HMAC", key, new Uint8Array(0));
  return bytesToBase64(new Uint8Array(signature));
}

/** 只含连接标签、接收时间和失败码；不含主题、正文、发件人或收件地址。 */
function fallbackText(connectionLabel: string, receivedAt: string, code: string): string {
  const label =
    connectionLabel.trim().length > 0 ? connectionLabel.trim().slice(0, 80) : "未命名连接";
  const when = ISO_TIME.test(receivedAt) ? receivedAt : new Date().toISOString();
  return `Harborly 邮件上报失败\n连接: ${label}\n接收时间: ${when}\n失败码: ${safeCode(code)}`;
}

async function readLimited(response: Response, maxBytes: number): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function feishuAccepted(body: string): { ok: boolean; code: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, code: "feishu_rejected" };
  }
  if (typeof parsed !== "object" || parsed === null) return { ok: false, code: "feishu_rejected" };
  const record = parsed as Record<string, unknown>;
  const hasCode = "code" in record;
  const statusValue =
    "StatusCode" in record
      ? record.StatusCode
      : "status_code" in record
        ? record.status_code
        : undefined;
  const hasStatus = statusValue !== undefined;
  if (!hasCode && !hasStatus) return { ok: false, code: "feishu_rejected" };
  if (hasCode && record.code !== 0) {
    const numeric =
      typeof record.code === "number" && Number.isSafeInteger(record.code) ? record.code : null;
    return {
      ok: false,
      code:
        numeric !== null && numeric >= 0 && numeric <= 999999
          ? `feishu_${numeric}`
          : "feishu_rejected",
    };
  }
  if (hasStatus && statusValue !== 0) return { ok: false, code: "feishu_rejected" };
  return { ok: true, code: "accepted" };
}

export async function postFallback(
  env: Env,
  receivedAt: string,
  failureCode: string,
): Promise<AttemptResult> {
  const rawWebhook = binding(env.FALLBACK_WEBHOOK).trim();
  if (rawWebhook.length === 0) return { ok: true, code: "not_configured" };
  const webhook = canonicalFeishuWebhook(rawWebhook);
  if (!webhook) return { ok: false, code: "invalid_webhook" };

  const secret = binding(env.FALLBACK_SIGN_SECRET);
  const connectionLabel = binding(env.CONNECTION_LABEL)
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .trim()
    .slice(0, 80);
  const text = fallbackText(connectionLabel, receivedAt, failureCode);
  const deadline = Date.now() + FALLBACK_BUDGET_MS;
  let lastCode = "fallback_failed";

  for (let attempt = 0; attempt < FALLBACK_ATTEMPTS; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining < 250)
      return {
        ok: false,
        code: lastCode === "fallback_failed" ? "budget_exceeded" : lastCode,
      };
    const payload: Record<string, unknown> = {
      msg_type: "text",
      content: { text },
    };
    if (secret.length > 0) {
      if (secret.length > 4096) return { ok: false, code: "invalid_sign_secret" };
      try {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        payload.timestamp = timestamp;
        payload.sign = await feishuSign(secret, timestamp);
      } catch {
        return { ok: false, code: "sign_failed" };
      }
    }
    try {
      const response = await fetch(webhook, {
        method: "POST",
        redirect: "manual",
        cache: "no-store",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(Math.min(FALLBACK_TIMEOUT_MS, remaining)),
      });
      const status = response.status;
      const redirected =
        (response.type as string) === "opaqueredirect" || (status >= 300 && status < 400);
      if (redirected) {
        await discard(response);
        return { ok: false, code: "redirect_rejected" };
      }
      if (status === 0) {
        await discard(response);
        lastCode = "network";
      } else if (status < 200 || status >= 300) {
        await discard(response);
        if (!retryableStatus(status)) return { ok: false, code: `http_${status}` };
        lastCode = status === 429 ? "http_429" : `http_${status}`;
      } else {
        const raw = await readLimited(response, 4096);
        if (raw === null) return { ok: false, code: "feishu_rejected" };
        const accepted = feishuAccepted(raw);
        if (!accepted.ok) return accepted;
        return { ok: true, code: "accepted" };
      }
    } catch (error) {
      lastCode = isTimeout(error) ? "timeout" : "network";
    }
    if (attempt < FALLBACK_ATTEMPTS - 1) await sleep(backoffMs(attempt, deadline));
  }
  return { ok: false, code: safeCode(lastCode) };
}
