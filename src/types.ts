export const DEFAULT_INGEST_URL = "https://harborly.dev/api/workspace/mail-ingest";

/** 原始 MIME 超过该大小时不读取 raw，只上报头部。 */
export const MAX_RAW_PARSE_BYTES = 2 * 1024 * 1024;

export const MAX_TEXT_CHARS = 32768;
export const MAX_SUBJECT_CHARS = 512;
export const MAX_ATTACHMENTS = 50;
export const MAX_FILENAME_CHARS = 255;
export const MAX_CONTENT_TYPE_CHARS = 255;
export const MAX_MESSAGE_ID_CHARS = 512;
export const MAX_ADDRESS_CHARS = 320;

/** JSON 正文上限留出请求头空间，使整个上报请求低于 256 KiB。 */
export const MAX_API_BYTES = 256 * 1024 - 4096;

export type ParseStatus = "parsed" | "headers_only" | "failed";
export type ForwardStatus = "succeeded" | "failed";

export interface AttachmentMeta {
  fileName: string;
  contentType: string;
  size: number;
}

/** Worker -> Harborly 的冻结 JSON。字段顺序即签名字节的对象键顺序。 */
export interface MailIngestPayload {
  envelopeFrom: string;
  envelopeTo: string;
  messageId: string | null;
  subject: string;
  textBody: string;
  receivedAt: string;
  rawSize: number;
  attachmentsMeta: AttachmentMeta[];
  parseStatus: ParseStatus;
  bodyTruncated: boolean;
  forwardStatus: ForwardStatus;
}

/** 每个 Cloudflare 账号一份部署，对应 Harborly 的一个用户级邮件连接。 */
export interface Env {
  /** 留空时使用 DEFAULT_INGEST_URL；自托管 Harborly 时再覆盖。 */
  INGEST_URL?: string;
  CONNECTION_ID: string;
  CONNECTION_SECRET: string;
  FORWARD_TO: string;
}

/** 只依赖 Email Routing 实际用到的字段，避免把邮件正文当成请求目标。 */
export interface InboundEmail {
  readonly from: string;
  readonly to: string;
  readonly headers: Headers;
  readonly raw: ReadableStream<Uint8Array>;
  readonly rawSize: number;
  forward(rcptTo: string, headers?: Headers): Promise<unknown>;
}

export interface ParsedMail {
  envelopeFrom: string;
  envelopeTo: string;
  messageId: string | null;
  subject: string;
  textBody: string;
  attachmentsMeta: AttachmentMeta[];
  parseStatus: ParseStatus;
  bodyTruncated: boolean;
}
