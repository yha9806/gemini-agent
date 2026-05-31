import { z } from "zod";

export const TELEMETRY_SCHEMA_VERSION = 1;
export const RAW_TELEMETRY_SCHEMA_VERSION = "raw-v1";
export const DEFAULT_MAX_EVENT_BYTES = 1024 * 1024;
export const DEFAULT_MAX_QUEUE_BYTES = 50 * 1024 * 1024;
export const CREDENTIAL_MASK_VERSION = 1;
export const DEFAULT_TELEMETRY_DEPLOYMENT_ID = "local";

const IsoString = z.string()
  .datetime({ offset: true })
  .regex(/Z$/, "Expected UTC ISO timestamp ending in Z.");

const DeploymentId = z.string()
  .min(1)
  .regex(/^[A-Za-z0-9._-]+$/, "Expected deployment id with letters, numbers, dot, underscore, or dash.");

export const TelemetryConfigZodSchema = z.strictObject({
  enabled: z.boolean(),
  level: z.literal("raw"),
  endpoint: z.string().url(),
  token_env: z.string().min(1),
  deployment_id: DeploymentId.default(DEFAULT_TELEMETRY_DEPLOYMENT_ID),
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
  multimodal: z.array(TelemetryMultimodalItemZodSchema).default(() => []),
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
  payload: TelemetryPayloadZodSchema.default(() => ({
    prompt_truncated: false,
    response_truncated: false,
    multimodal: [],
  })),
});

export const TelemetryBatchZodSchema = z.strictObject({
  schema_version: z.literal(TELEMETRY_SCHEMA_VERSION),
  batch_id: z.string().min(1),
  deployment_id: z.string().min(1),
  scheduled_for: IsoString,
  sent_at: IsoString,
  events: z.array(TelemetryEventZodSchema).min(1),
});

export const RawTelemetryUsageZodSchema = z.strictObject({
  input_tokens: z.number().int().nonnegative().nullable().default(null),
  output_tokens: z.number().int().nonnegative().nullable().default(null),
  total_tokens: z.number().int().nonnegative().nullable().default(null),
});

export const RawTelemetryEventZodSchema = z.strictObject({
  event_id: z.string().min(1),
  source_host_app: z.enum(["codex", "cli", "mcp", "other"]),
  trigger_source: z.enum(["manual", "scheduled", "mcp", "global_policy"]),
  model_provider: z.string().min(1),
  model: z.string().min(1),
  command: z.string().min(1),
  started_at: IsoString,
  ended_at: IsoString,
  latency_ms: z.number().int().nonnegative(),
  status: z.enum(["success", "error"]),
  usage: RawTelemetryUsageZodSchema.nullable().default(null),
  request_raw: z.unknown().default(null),
  prompt_raw: z.string().default(""),
  response_raw: z.string().default(""),
  response_candidates_raw: z.array(z.unknown()).default(() => []),
  tool_calls_raw: z.array(z.unknown()).default(() => []),
  media_manifest: z.array(z.unknown()).default(() => []),
  error: z.unknown().nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).default(() => ({})),
});

export const RawTelemetryBatchZodSchema = z.strictObject({
  schema_version: z.literal(RAW_TELEMETRY_SCHEMA_VERSION),
  batch_id: z.string().min(1),
  deployment_id: z.string().min(1),
  agent_version: z.string().min(1),
  generated_at: IsoString,
  checksum: z.string().min(1),
  events: z.array(RawTelemetryEventZodSchema).min(1),
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
  received_count: z.number().int().positive(),
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
  clock_skew_warnings: z.number().int().nonnegative().default(0),
});

const MASK_PATTERNS = [
  {
    name: "authorization-header",
    pattern: /Authorization:[^\S\r\n]*[^\r\n]+/gi,
    replacement: "Authorization: [MASKED]",
  },
  {
    name: "api-key-header",
    pattern: /(X-API-Key:[^\S\r\n]*)[^\r\n]+/gi,
    replacement: "$1[MASKED]",
  },
  {
    name: "standalone-bearer-token",
    pattern: /(\bBearer[^\S\r\n]+)[^\s"'`]{6,}/gi,
    replacement: "$1[MASKED]",
  },
  {
    name: "env-secret-assignment",
    pattern: /([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD))([^\S\r\n]*=[^\S\r\n]*)(?:(["'])([^\r\n]*?)\3|([^\s"'`]+))/g,
    replacement: (match, name, separator, quote) => (
      quote ? `${name}${separator}${quote}[MASKED]${quote}` : `${name}${separator}[MASKED]`
    ),
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
  return MASK_PATTERNS.map(({ name, pattern }) => ({
    masking_version: CREDENTIAL_MASK_VERSION,
    name,
    pattern: pattern.source,
    flags: pattern.flags,
  }));
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
  if (value?.schema_version === RAW_TELEMETRY_SCHEMA_VERSION) {
    const rawBatch = normalizeRawTelemetryBatch(value);
    return {
      schema_version: TELEMETRY_SCHEMA_VERSION,
      batch_id: rawBatch.batch_id,
      deployment_id: rawBatch.deployment_id,
      scheduled_for: rawBatch.generated_at,
      sent_at: rawBatch.generated_at,
      events: rawBatch.events.map((event) => normalizeTelemetryEvent({
        schema_version: TELEMETRY_SCHEMA_VERSION,
        event_id: event.event_id,
        trace_id: `${event.metadata.trace_id ?? event.event_id}`,
        deployment_id: rawBatch.deployment_id,
        project_id: `${event.metadata.project_id ?? "gemini-agent"}`,
        source: event.trigger_source === "mcp" ? "mcp" : "cli",
        command: event.command,
        model: event.model,
        prompt: event.prompt_raw,
        response: event.response_raw,
        status: event.status,
        error_type: event.error && typeof event.error === "object" && "type" in event.error
          ? `${event.error.type}`
          : null,
        latency_ms: event.latency_ms,
        created_at: event.started_at,
        payload: {
          prompt_truncated: Boolean(event.metadata.prompt_truncated),
          response_truncated: Boolean(event.metadata.response_truncated),
          multimodal: event.media_manifest,
        },
      })),
    };
  }
  const parsed = TelemetryBatchZodSchema.parse(value);
  return {
    ...parsed,
    events: parsed.events.map((event) => normalizeTelemetryEvent(event)),
  };
}

export function normalizeRawTelemetryBatch(value) {
  const parsed = RawTelemetryBatchZodSchema.parse(value);
  return {
    ...parsed,
    events: parsed.events.map((event) => ({
      ...event,
      prompt_raw: maskCredentialText(event.prompt_raw),
      response_raw: maskCredentialText(event.response_raw),
    })),
  };
}

export function normalizeTelemetryReceiverAck(value) {
  return TelemetryReceiverAckZodSchema.parse(value);
}

export function normalizeTelemetryReceiverMetrics(value) {
  return TelemetryReceiverMetricsZodSchema.parse(value);
}
