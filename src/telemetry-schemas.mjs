import { z } from "zod";

export const TELEMETRY_SCHEMA_VERSION = 1;
export const DEFAULT_MAX_EVENT_BYTES = 1024 * 1024;
export const DEFAULT_MAX_QUEUE_BYTES = 50 * 1024 * 1024;

const IsoString = z.string().datetime({ offset: true });

export const TelemetryConfigZodSchema = z.strictObject({
  enabled: z.boolean(),
  level: z.literal("raw"),
  endpoint: z.string().url(),
  token_env: z.string().min(1),
  schedule: z.string().default("daily@09:00"),
  max_event_bytes: z.number().int().positive().default(DEFAULT_MAX_EVENT_BYTES),
  max_queue_bytes: z.number().int().positive().default(DEFAULT_MAX_QUEUE_BYTES),
  created_at: IsoString,
  updated_at: IsoString,
});

const TelemetryMultimodalItemZodSchema = z.strictObject({
  mime_type: z.string().optional(),
  byte_size: z.number().int().nonnegative().optional(),
  basename: z.string().optional(),
  sha256: z.string().optional(),
});

const TelemetryPayloadZodSchema = z.strictObject({
  prompt_truncated: z.boolean().default(false),
  response_truncated: z.boolean().default(false),
  multimodal: z.array(TelemetryMultimodalItemZodSchema).default([]),
});

export const TelemetryEventZodSchema = z.strictObject({
  schema_version: z.literal(TELEMETRY_SCHEMA_VERSION),
  event_id: z.string().min(1),
  trace_id: z.string().min(1),
  deployment_id: z.string().min(1),
  project_id: z.string().min(1),
  source: z.enum(["cli", "mcp", "validate"]),
  command: z.string().min(1),
  model: z.literal("gemini-3.5-flash"),
  prompt: z.string(),
  response: z.string(),
  status: z.enum(["success", "error"]),
  error_type: z.string().nullable().default(null),
  latency_ms: z.number().int().nonnegative(),
  created_at: IsoString,
  payload: TelemetryPayloadZodSchema.default({ prompt_truncated: false, response_truncated: false, multimodal: [] }),
});

export const TelemetryBatchZodSchema = z.strictObject({
  schema_version: z.literal(TELEMETRY_SCHEMA_VERSION),
  batch_id: z.string().min(1),
  deployment_id: z.string().min(1),
  scheduled_for: IsoString,
  sent_at: IsoString,
  events: z.array(TelemetryEventZodSchema).min(1),
});

const TelemetryReceiverLatestEventZodSchema = z.strictObject({
  received_at: IsoString,
  batch_id: z.string().min(1),
  command: z.string().min(1),
  model: z.literal("gemini-3.5-flash"),
  status: z.enum(["success", "error"]),
});

const TelemetryStatusCountsZodSchema = z.strictObject({
  success: z.number().int().nonnegative(),
  error: z.number().int().nonnegative(),
});

export const TelemetryReceiverAckZodSchema = z.strictObject({
  ok: z.literal(true),
  batch_id: z.string().min(1),
  received_count: z.number().int().nonnegative(),
  received_at: IsoString,
});

export const TelemetryReceiverMetricsZodSchema = z.strictObject({
  ok: z.literal(true),
  received_events: z.number().int().nonnegative(),
  received_batches: z.number().int().nonnegative(),
  last_received_at: IsoString.nullable().default(null),
  last_batch_id: z.string().min(1).nullable().default(null),
  latest_event: TelemetryReceiverLatestEventZodSchema.nullable().default(null),
  status_counts: TelemetryStatusCountsZodSchema,
  clock_skew_warnings: z.number().int().nonnegative(),
});

const MASK_PATTERNS = [
  {
    name: "authorization-header",
    pattern: /Authorization:\s*(?:Bearer|Basic)\s+[^\r\n]+/gi,
    replacement: "Authorization: [MASKED]",
  },
  {
    name: "standalone-bearer-token",
    pattern: /(\bBearer\s+)[A-Za-z0-9._~-]{6,}={0,2}/gi,
    replacement: "$1[MASKED]",
  },
  {
    name: "env-secret-assignment",
    pattern: /([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD))=([^\s"'`]+)/g,
    replacement: "$1=[MASKED]",
  },
  {
    name: "json-secret-field",
    pattern: /"((?:api_?key|token|secret|password))"\s*:\s*"[^"]*"/gi,
    replacement: "\"$1\":\"[MASKED]\"",
  },
  {
    name: "gemini-api-key",
    pattern: /AIzaSy[A-Za-z0-9_-]{20,}/g,
    replacement: "[MASKED]",
  },
];

export function credentialMaskPatterns() {
  return MASK_PATTERNS.map(({ name, pattern }) => ({ name, pattern: pattern.source }));
}

export function maskCredentialText(value) {
  let text = `${value ?? ""}`;
  for (const { pattern, replacement } of MASK_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

export function truncateTelemetryText(value, maxBytes = DEFAULT_MAX_EVENT_BYTES) {
  if (!Number.isInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("maxBytes must be a nonnegative integer.");
  }
  const text = `${value ?? ""}`;
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return { text: buffer.subarray(0, end).toString("utf8"), truncated: true };
}

export function normalizeTelemetryConfig(value) {
  return TelemetryConfigZodSchema.parse(value);
}

export function normalizeTelemetryEvent(value) {
  const parsed = TelemetryEventZodSchema.parse(value);
  return {
    ...parsed,
    prompt: maskCredentialText(parsed.prompt),
    response: maskCredentialText(parsed.response),
  };
}

export function normalizeTelemetryBatch(value) {
  const parsed = TelemetryBatchZodSchema.parse(value);
  return {
    ...parsed,
    events: parsed.events.map((event) => normalizeTelemetryEvent(event)),
  };
}

export function normalizeTelemetryReceiverAck(value) {
  return TelemetryReceiverAckZodSchema.parse(value);
}

export function normalizeTelemetryReceiverMetrics(value) {
  return TelemetryReceiverMetricsZodSchema.parse(value);
}
