import PostalMime, { decodeWords } from "postal-mime";
import type { AttachmentMeta, InboundEmail, ParsedMail } from "./types.ts";
import {
  MAX_ADDRESS_CHARS,
  MAX_ATTACHMENTS,
  MAX_CONTENT_TYPE_CHARS,
  MAX_FILENAME_CHARS,
  MAX_MESSAGE_ID_CHARS,
  MAX_RAW_PARSE_BYTES,
  MAX_SUBJECT_CHARS,
  MAX_TEXT_CHARS,
} from "./types.ts";

const EXACT_ADDRESS =
  /^[a-z0-9._%+\-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/;
const MULTILINE_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const SINGLE_LINE_CONTROL = /[\u0000-\u001F\u007F-\u009F]+/g;

interface MimeAttachment {
  filename?: string | null;
  mimeType?: string;
  content?: ArrayBuffer | Uint8Array | string;
  encoding?: "base64" | "utf8";
}

function hasControl(value: string): boolean {
  return CONTROL.test(value);
}

function stripUnpairedSurrogates(input: string): string {
  let out = "";
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = input.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += input[i] + input[i + 1];
        i += 1;
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) continue;
    out += input[i];
  }
  return out;
}

function normalizeUnicode(input: string): string {
  try {
    return input.normalize("NFC");
  } catch {
    return input;
  }
}

/** 按 UTF-16 单元截断，与后端 string.Length 校验一致；不在代理对中间切断。 */
export function truncateUnits(
  input: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  if (input.length <= maxChars) return { text: input, truncated: false };
  let end = maxChars;
  const code = input.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return { text: input.slice(0, end), truncated: true };
}

/** 去掉控制字符和孤立代理项，再按 UTF-16 单元截断，保证后续 JSON.stringify 得到合法 UTF-8。 */
export function sanitizeLine(
  value: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  const cleaned = normalizeUnicode(stripUnpairedSurrogates(value))
    .replace(SINGLE_LINE_CONTROL, " ")
    .replace(/[ \t\u00a0]+/g, " ")
    .trim();
  return truncateUnits(cleaned, maxChars);
}

function sanitizeMultiline(value: string, maxChars: number): { text: string; truncated: boolean } {
  const cleaned = normalizeUnicode(stripUnpairedSurrogates(value))
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\u2028\u2029]/g, "\n")
    .replace(MULTILINE_CONTROL, "");
  return truncateUnits(cleaned, maxChars);
}

function isIpv4(domain: string): boolean {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(domain);
}

export function isExactAddress(value: string): boolean {
  if (value.length > MAX_ADDRESS_CHARS) return false;
  const at = value.lastIndexOf("@");
  if (at < 1 || at > 64) return false;
  const domain = value.slice(at + 1);
  if (domain.length > 253 || isIpv4(domain)) return false;
  return EXACT_ADDRESS.test(value);
}

function normalizeAddress(value: string): string | null {
  if (hasControl(value)) return null;
  const cleaned = value.trim().toLowerCase();
  const angle = cleaned.match(/<([^<>\s]+)>/);
  let candidate = angle?.[1] ?? cleaned;
  if (candidate.startsWith("mailto:")) candidate = candidate.slice("mailto:".length);
  candidate = candidate.trim();
  if (!isExactAddress(candidate)) return null;
  return candidate;
}

function readHeader(headers: Headers, name: string): string {
  try {
    const value = headers.get(name);
    if (typeof value !== "string" || value.length === 0) return "";
    return value.length > 8192 ? value.slice(0, 8192) : value;
  } catch {
    return "";
  }
}

function decodeHeader(value: string): string {
  if (!value) return "";
  try {
    return decodeWords(value);
  } catch {
    return value;
  }
}

function normalizeMessageId(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const text = sanitizeLine(decodeHeader(value), MAX_MESSAGE_ID_CHARS).text;
  return text.length > 0 ? text : null;
}

function envelopeAddress(value: string): string {
  const normalized = normalizeAddress(value);
  if (normalized) return normalized;
  if (typeof value !== "string") return "";
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "" || trimmed === "<>") return "";
  // 宽松兜底（如 SRS/VERP 地址）仍须满足后端地址规则；否则上报空发件人，避免整封邮件被拒收。
  const candidate = trimmed.match(/^<([^<>]+)>$/)?.[1] ?? trimmed;
  return backendAcceptsAddress(candidate) ? candidate : "";
}

function backendAcceptsAddress(value: string): boolean {
  if (value.length > MAX_ADDRESS_CHARS || /\s/.test(value) || hasControl(value)) return false;
  const parts = value.split("@");
  if (parts.length !== 2 || parts[0].length === 0 || parts[0].includes("*")) return false;
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
    parts[1],
  );
}

function safeRawSize(value: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER);
}

function contentByteSize(
  content: MimeAttachment["content"],
  encoding: MimeAttachment["encoding"],
): number {
  if (content == null) return 0;
  if (typeof content === "string") {
    if (encoding === "base64") {
      const cleaned = content.replace(/[\s]/g, "");
      if (cleaned.length === 0) return 0;
      const padding = cleaned.endsWith("==") ? 2 : cleaned.endsWith("=") ? 1 : 0;
      return Math.max(0, Math.floor((cleaned.length * 3) / 4) - padding);
    }
    return new TextEncoder().encode(content).byteLength;
  }
  return content.byteLength;
}

function attachmentMeta(item: MimeAttachment): AttachmentMeta {
  const fileName = sanitizeLine(item.filename ?? "", MAX_FILENAME_CHARS).text;
  const contentType =
    sanitizeLine(item.mimeType ?? "", MAX_CONTENT_TYPE_CHARS).text || "application/octet-stream";
  const size = contentByteSize(item.content, item.encoding);
  return {
    fileName,
    contentType,
    size:
      Number.isFinite(size) && size > 0 ? Math.min(Math.floor(size), Number.MAX_SAFE_INTEGER) : 0,
  };
}

function headerOnly(message: InboundEmail): ParsedMail {
  const subject = sanitizeLine(
    decodeHeader(readHeader(message.headers, "subject")),
    MAX_SUBJECT_CHARS,
  ).text;
  return {
    envelopeFrom: envelopeAddress(message.from),
    envelopeTo: envelopeAddress(message.to),
    messageId: normalizeMessageId(readHeader(message.headers, "message-id")),
    subject,
    textBody: "",
    attachmentsMeta: [],
    parseStatus: "headers_only",
    bodyTruncated: true,
  };
}

function failedParse(message: InboundEmail): ParsedMail {
  const subject = sanitizeLine(
    decodeHeader(readHeader(message.headers, "subject")),
    MAX_SUBJECT_CHARS,
  ).text;
  return {
    envelopeFrom: envelopeAddress(message.from),
    envelopeTo: envelopeAddress(message.to),
    messageId: normalizeMessageId(readHeader(message.headers, "message-id")),
    subject,
    textBody: "",
    attachmentsMeta: [],
    parseStatus: "failed",
    bodyTruncated: false,
  };
}

/** 读取超过上限就中断，避免 rawSize 不真实时把更大的 MIME 读进内存。 */
function limitStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  let seen = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        seen += value.byteLength;
        if (seen > maxBytes) {
          await reader.cancel();
          controller.error(new Error("parse_limit"));
          return;
        }
        controller.enqueue(value);
      } catch (cause) {
        controller.error(
          cause instanceof Error ? new Error("parse_limit") : new Error("parse_limit"),
        );
      }
    },
    cancel() {
      return reader.cancel();
    },
  });
}

export async function parseInbound(message: InboundEmail): Promise<ParsedMail> {
  const rawSize = safeRawSize(message.rawSize);
  if (rawSize === null || rawSize > MAX_RAW_PARSE_BYTES) {
    try {
      return headerOnly(message);
    } catch {
      // 后端要求超过解析上限的邮件必须标记 headers_only。
      return { ...failedParse(message), parseStatus: "headers_only" };
    }
  }

  try {
    const email = await new PostalMime({ attachmentEncoding: "arraybuffer" }).parse(
      limitStream(message.raw, MAX_RAW_PARSE_BYTES),
    );
    const text = sanitizeMultiline(email.text ?? "", MAX_TEXT_CHARS);
    const subject = sanitizeLine(
      email.subject ?? decodeHeader(readHeader(message.headers, "subject")),
      MAX_SUBJECT_CHARS,
    );
    const attachments = Array.isArray(email.attachments) ? email.attachments : [];
    const metas: AttachmentMeta[] = [];
    const count = Math.min(attachments.length, MAX_ATTACHMENTS);
    for (let i = 0; i < count; i++) {
      const item = attachments[i];
      if (!item) continue;
      metas.push(attachmentMeta(item));
    }
    return {
      envelopeFrom: envelopeAddress(message.from),
      envelopeTo: envelopeAddress(message.to),
      messageId: normalizeMessageId(email.messageId ?? readHeader(message.headers, "message-id")),
      subject: subject.text,
      textBody: text.text,
      attachmentsMeta: metas,
      parseStatus: "parsed",
      bodyTruncated: text.truncated,
    };
  } catch {
    try {
      return failedParse(message);
    } catch {
      return {
        envelopeFrom: "",
        envelopeTo: "",
        messageId: null,
        subject: "",
        textBody: "",
        attachmentsMeta: [],
        parseStatus: "failed",
        bodyTruncated: false,
      };
    }
  }
}
