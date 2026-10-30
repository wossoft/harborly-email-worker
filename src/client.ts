import type { Env, MailIngestPayload, ParseStatus } from "./types.ts";
import { DEFAULT_INGEST_URL, MAX_API_BYTES, MAX_RAW_PARSE_BYTES } from "./types.ts";

const MAX_ATTEMPTS = 4;
const TOTAL_BUDGET_MS = 12_000;
const ATTEMPT_TIMEOUT_MS = 4_000;
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
  const ingestUrl = binding(env.INGEST_URL).trim() || DEFAULT_INGEST_URL;
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
