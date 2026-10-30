import { postFallback, postIngest, serializeIngest } from "./client.ts";
import { isExactAddress, parseInbound } from "./parser.ts";
import type { Env, ForwardStatus, InboundEmail } from "./types.ts";

const SAFE_TOKEN = /^[a-z0-9_]{1,40}$/;

function binding(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function safeRawSize(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER);
}

function safeLog(entry: {
  event: string;
  code?: string;
  rawSize?: number;
  bytes?: number;
  durationMs?: number;
  forwardStatus?: ForwardStatus;
}): void {
  const record: Record<string, string | number> = {
    event: SAFE_TOKEN.test(entry.event) ? entry.event : "unclassified",
  };
  if (entry.code !== undefined)
    record.code = SAFE_TOKEN.test(entry.code) ? entry.code : "unclassified";
  if (entry.forwardStatus === "succeeded" || entry.forwardStatus === "failed") {
    record.forwardStatus = entry.forwardStatus;
  }
  const numeric: Array<"rawSize" | "bytes" | "durationMs"> = ["rawSize", "bytes", "durationMs"];
  for (const key of numeric) {
    const value = entry[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0)
      record[key] = Math.floor(value);
  }
  console.log(JSON.stringify(record));
}

async function deliverReport(
  message: InboundEmail,
  env: Env,
  receivedAt: string,
  rawSize: number,
  forwardStatus: ForwardStatus,
): Promise<void> {
  const started = Date.now();
  let failureCode = "internal";
  try {
    const parsed = await parseInbound(message);
    const bytes = serializeIngest({
      envelopeFrom: parsed.envelopeFrom,
      envelopeTo: parsed.envelopeTo,
      messageId: parsed.messageId,
      subject: parsed.subject,
      textBody: parsed.textBody,
      receivedAt,
      rawSize,
      attachmentsMeta: parsed.attachmentsMeta,
      parseStatus: parsed.parseStatus,
      bodyTruncated: parsed.bodyTruncated,
      forwardStatus,
    });
    const result = await postIngest(env, bytes);
    safeLog({
      event: result.ok ? "ingest_ok" : "ingest_failed",
      code: result.code,
      rawSize,
      bytes: bytes.byteLength,
      durationMs: Date.now() - started,
      forwardStatus,
    });
    if (result.ok) return;
    failureCode = result.code;
  } catch {
    safeLog({
      event: "ingest_failed",
      code: "internal",
      rawSize,
      durationMs: Date.now() - started,
      forwardStatus,
    });
  }

  try {
    const fallback = await postFallback(env, receivedAt, failureCode);
    if (fallback.code === "not_configured") return;
    safeLog({
      event: fallback.ok ? "fallback_ok" : "fallback_failed",
      code: fallback.code,
      rawSize,
      durationMs: Date.now() - started,
    });
  } catch {
    safeLog({ event: "fallback_failed", code: "internal", rawSize });
  }
}

async function handleEmail(message: InboundEmail, env: Env, ctx: ExecutionContext): Promise<void> {
  const receivedAt = new Date().toISOString();
  const rawSize = safeRawSize(message.rawSize);
  const started = Date.now();
  let forwardStatus: ForwardStatus = "failed";

  // 不在 Worker 里判断产品归属：每封来信都先转发，再独立上报。
  // 收件地址属于哪个产品由 Harborly 按登记地址决定，未登记地址由服务端拒收。
  try {
    const forwardTo = binding(env.FORWARD_TO).trim();
    if (!isExactAddress(forwardTo.toLowerCase())) {
      safeLog({
        event: "forward_failed",
        code: "invalid_forward_target",
        rawSize,
        durationMs: Date.now() - started,
        forwardStatus: "failed",
      });
    } else {
      try {
        await message.forward(forwardTo);
        forwardStatus = "succeeded";
        safeLog({
          event: "forward_ok",
          rawSize,
          durationMs: Date.now() - started,
          forwardStatus: "succeeded",
        });
      } catch {
        forwardStatus = "failed";
        safeLog({
          event: "forward_failed",
          code: "forward_error",
          rawSize,
          durationMs: Date.now() - started,
          forwardStatus: "failed",
        });
      }
    }
  } finally {
    const report = deliverReport(message, env, receivedAt, rawSize, forwardStatus);
    try {
      ctx.waitUntil(report);
    } catch {
      safeLog({ event: "ingest_failed", code: "waituntil", rawSize, forwardStatus });
    }
  }
}

export default {
  async email(message: InboundEmail, env: Env, ctx: ExecutionContext): Promise<void> {
    try {
      await handleEmail(message, env, ctx);
    } catch {
      let rawSize = 0;
      try {
        rawSize = safeRawSize(message.rawSize);
      } catch {
        rawSize = 0;
      }
      safeLog({ event: "handler_failed", code: "internal", rawSize });
    }
  },
};
