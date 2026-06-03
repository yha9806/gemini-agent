import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { appendTelemetryEvent } from "./telemetry-queue.mjs";
import { loadTelemetryConfigContext } from "./telemetry-config.mjs";
import {
  DEFAULT_TELEMETRY_DEPLOYMENT_ID,
  truncateTelemetryText,
} from "./telemetry-schemas.mjs";

const DEFAULT_COMMAND = "gemini";
const DEFAULT_PROJECT_ID = "gemini-agent";
const DEFAULT_SOURCE = "cli";
const MODEL = "gemini-3.5-flash";
const VALID_SOURCES = new Set(["cli", "mcp", "validate"]);
const VALID_STATUSES = new Set(["success", "error"]);
const BASE64_BYTE_SIZE_LIMIT = 1024 * 1024;
const DEFAULT_CONFIG_CACHE_TTL_MS = 1000;

let pendingCaptures = new Set();
let configCache = new WeakMap();
let defaultConfigCache = new Map();

function configMapFor(loadConfig) {
  if (loadConfig === loadTelemetryConfigContext) return defaultConfigCache;
  let cache = configCache.get(loadConfig);
  if (!cache) {
    cache = new Map();
    configCache.set(loadConfig, cache);
  }
  return cache;
}

function normalizeLoadedTelemetryContext(value, cwd) {
  if (value && typeof value === "object" && "config" in value && "storageCwd" in value) {
    return value;
  }
  return { scope: "local", storageCwd: cwd, config: value ?? null };
}

function cachedTelemetryContext({
  cwd,
  home,
  loadConfig,
  configCacheTtlMs = DEFAULT_CONFIG_CACHE_TTL_MS,
}) {
  const cache = configMapFor(loadConfig);
  const now = Date.now();
  const ttlMs = nonnegativeInteger(configCacheTtlMs);
  const cacheKey = `${cwd}\0${home ?? ""}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.promise;
  }
  const promise = Promise.resolve()
    .then(() => loadConfig({ cwd, home }))
    .catch(() => null)
    .then((loaded) => {
      const context = normalizeLoadedTelemetryContext(loaded, cwd);
      const config = context.config;
      const expiresAt = config?.enabled && config.level === "raw" ? now : now + ttlMs;
      cache.set(cacheKey, { promise: Promise.resolve(context), expiresAt });
      return context;
    });
  cache.set(cacheKey, { promise, expiresAt: now + ttlMs });
  return promise;
}

function utcTimestamp(now) {
  const date = now instanceof Date ? now : new Date(now);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function makeId(prefix) {
  return `${prefix}_${Date.now()}_${randomUUID()}`;
}

function nonnegativeInteger(value) {
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

function latencyBucket(latencyMs) {
  const ms = nonnegativeInteger(latencyMs);
  if (ms < 1000) return "lt_1s";
  if (ms < 5000) return "1_5s";
  if (ms < 15000) return "5_15s";
  if (ms < 60000) return "15_60s";
  return "gte_60s";
}

function deriveBase64ByteSize(value) {
  if (typeof value !== "string" || value.length > BASE64_BYTE_SIZE_LIMIT) return undefined;
  const compact = value.replace(/\s/g, "");
  if (!compact || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    return undefined;
  }
  const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
  return Math.max(0, (compact.length / 4) * 3 - padding);
}

function fileBasename(value) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = new URL(value);
    const name = basename(decodeURIComponent(url.pathname));
    return name || undefined;
  } catch {
    const name = basename(value);
    return name || undefined;
  }
}

function maybeAddHash(metadata, source) {
  const sha256 = source?.sha256 ?? source?.sha256Hash ?? source?.hash?.sha256;
  if (typeof sha256 === "string" && sha256.trim()) {
    metadata.sha256 = sha256;
  }
}

function metadataFromInlineData(inlineData) {
  if (!inlineData || typeof inlineData !== "object") return null;
  const metadata = {};
  const mimeType = inlineData.mimeType ?? inlineData.mime_type;
  if (typeof mimeType === "string" && mimeType.trim()) metadata.mime_type = mimeType;
  const byteSize = inlineData.byteSize ?? inlineData.byte_size ?? inlineData.size;
  if (Number.isInteger(byteSize) && byteSize >= 0) {
    metadata.byte_size = byteSize;
  } else {
    const derived = deriveBase64ByteSize(inlineData.data);
    if (derived !== undefined) metadata.byte_size = derived;
  }
  maybeAddHash(metadata, inlineData);
  return Object.keys(metadata).length ? metadata : null;
}

function metadataFromFileData(fileData) {
  if (!fileData || typeof fileData !== "object") return null;
  const metadata = {};
  const mimeType = fileData.mimeType ?? fileData.mime_type;
  if (typeof mimeType === "string" && mimeType.trim()) metadata.mime_type = mimeType;
  const byteSize = fileData.byteSize ?? fileData.byte_size ?? fileData.size;
  if (Number.isInteger(byteSize) && byteSize >= 0) metadata.byte_size = byteSize;
  const name = fileData.displayName ?? fileData.name ?? fileBasename(fileData.fileUri ?? fileData.file_uri ?? fileData.uri);
  if (typeof name === "string" && name.trim()) metadata.basename = basename(name);
  maybeAddHash(metadata, fileData);
  return Object.keys(metadata).length ? metadata : null;
}

function collectMultimodalMetadata(value, output = []) {
  if (value == null) return output;
  if (Array.isArray(value)) {
    for (const item of value) collectMultimodalMetadata(item, output);
    return output;
  }
  if (typeof value !== "object") return output;

  const inlineMetadata = metadataFromInlineData(value.inlineData ?? value.inline_data);
  if (inlineMetadata) output.push(inlineMetadata);
  const fileMetadata = metadataFromFileData(value.fileData ?? value.file_data);
  if (fileMetadata) output.push(fileMetadata);

  if (Array.isArray(value.parts)) collectMultimodalMetadata(value.parts, output);
  if (Array.isArray(value.contents)) collectMultimodalMetadata(value.contents, output);
  return output;
}

function buildTelemetryEvent({
  cwd,
  command,
  source,
  prompt,
  response,
  status,
  errorType,
  latencyMs,
  now,
  contents,
  deploymentId,
  projectId,
  maxEventBytes,
  context,
  outcome,
  economics,
}) {
  const capturedPrompt = truncateTelemetryText(prompt, maxEventBytes);
  const capturedResponse = truncateTelemetryText(response, maxEventBytes);
  const providedEconomics = economics && typeof economics === "object" ? economics : {};
  const resolvedEconomics = {
    ...providedEconomics,
    latency_bucket: economics?.latency_bucket ?? latencyBucket(latencyMs),
  };
  const providedContext = context && typeof context === "object" ? context : {};

  return {
    schema_version: 1,
    event_id: makeId("evt"),
    trace_id: makeId("trace"),
    deployment_id: deploymentId || DEFAULT_TELEMETRY_DEPLOYMENT_ID,
    project_id: projectId || DEFAULT_PROJECT_ID,
    source: VALID_SOURCES.has(source) ? source : DEFAULT_SOURCE,
    command: command || DEFAULT_COMMAND,
    model: MODEL,
    prompt: capturedPrompt.text,
    response: capturedResponse.text,
    status: VALID_STATUSES.has(status) ? status : "error",
    error_type: status === "error" ? `${errorType || "Error"}` : null,
    latency_ms: nonnegativeInteger(latencyMs),
    created_at: utcTimestamp(now),
    payload: {
      prompt_truncated: capturedPrompt.truncated,
      response_truncated: capturedResponse.truncated,
      multimodal: collectMultimodalMetadata(contents),
    },
    context: {
      ...providedContext,
      cwd: context?.cwd ?? cwd ?? null,
    },
    outcome: outcome && typeof outcome === "object" ? outcome : undefined,
    economics: resolvedEconomics,
  };
}

async function captureGeminiTelemetryTask({
  cwd = process.cwd(),
  home,
  command = DEFAULT_COMMAND,
  source = DEFAULT_SOURCE,
  prompt = "",
  response = "",
  status = "success",
  errorType = null,
  latencyMs = 0,
  now = new Date(),
  contents = null,
  deploymentId = null,
  projectId = DEFAULT_PROJECT_ID,
  context = null,
  outcome = null,
  economics = null,
  loadConfig = loadTelemetryConfigContext,
  appendEvent = appendTelemetryEvent,
  configCacheTtlMs = DEFAULT_CONFIG_CACHE_TTL_MS,
} = {}) {
  const telemetryContext = await cachedTelemetryContext({ cwd, home, loadConfig, configCacheTtlMs });
  const config = telemetryContext.config;
  if (!config?.enabled || config.level !== "raw") return { queued: false };
  const resolvedDeploymentId = deploymentId ?? config.deployment_id ?? DEFAULT_TELEMETRY_DEPLOYMENT_ID;

  const event = buildTelemetryEvent({
    cwd,
    command,
    source,
    prompt,
    response,
    status,
    errorType,
    latencyMs,
    now,
    contents,
    deploymentId: resolvedDeploymentId,
    projectId,
    maxEventBytes: config.max_event_bytes,
    context,
    outcome,
    economics,
  });
  await appendEvent({ cwd: telemetryContext.storageCwd, event, maxQueueBytes: config.max_queue_bytes });
  return { queued: true, event_id: event.event_id };
}

export function captureGeminiTelemetry(options = {}) {
  const capture = captureGeminiTelemetryTask(options).catch(() => ({ queued: false }));
  pendingCaptures.add(capture);
  capture.finally(() => pendingCaptures.delete(capture)).catch(() => {});
  return capture;
}

export async function drainTelemetryCapture({ timeoutMs = 2000 } = {}) {
  const captures = [...pendingCaptures];
  if (captures.length === 0) return { drained: true };
  let timeoutId;
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve("timeout"), Math.max(0, timeoutMs));
  });
  const result = await Promise.race([
    Promise.allSettled(captures).then(() => "drained"),
    timeout,
  ]);
  clearTimeout(timeoutId);
  return { drained: result === "drained" };
}

export function resetTelemetryCaptureForTests() {
  pendingCaptures = new Set();
  configCache = new WeakMap();
  defaultConfigCache = new Map();
}
