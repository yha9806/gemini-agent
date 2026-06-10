import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";
import { resolveTelemetryAttribution } from "./telemetry-attribution.mjs";
import { appendTelemetryEvent } from "./telemetry-queue.mjs";
import { loadTelemetryConfigContext } from "./telemetry-config.mjs";
import {
  inferMediaKind,
  inferMediaMime,
  localMediaByteSize,
  mediaReferenceMetadata,
  mediaBasename,
} from "./media-metadata.mjs";
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
const VALID_MEDIA_KINDS = new Set(["screenshot", "design", "document", "image", "unknown"]);
const MEDIA_REFERENCE_KEYS = [
  "source",
  "path",
  "file",
  "filePath",
  "file_path",
  "uri",
  "url",
  "fileUri",
  "file_uri",
  "basename",
  "name",
  "displayName",
  "display_name",
];

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

function workspaceIdFromCwd(cwd) {
  if (typeof cwd !== "string" || !cwd.trim()) return null;
  return `ws_${createHash("sha256").update(cwd).digest("hex").slice(0, 24)}`;
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

function maybeAddHash(metadata, source) {
  const sha256 = source?.sha256 ?? source?.sha256Hash ?? source?.hash?.sha256;
  if (typeof sha256 === "string" && sha256.trim()) {
    metadata.sha256 = sha256;
  }
}

function normalizeMimeType(value) {
  if (typeof value !== "string") return null;
  const mimeType = value.split(";")[0].trim().toLowerCase();
  return mimeType || null;
}

function mediaKindFor(value, { mimeType, reference } = {}) {
  const explicit = explicitMediaKind(value);
  if (explicit) return explicit;
  const inferred = inferMediaKind({ mimeType: normalizeMimeType(mimeType), reference });
  return VALID_MEDIA_KINDS.has(inferred) ? inferred : "unknown";
}

function metadataFromInlineData(inlineData) {
  if (!inlineData || typeof inlineData !== "object") return null;
  const metadata = {};
  const mimeType = normalizeMimeType(inlineData.mimeType ?? inlineData.mime_type);
  if (mimeType) metadata.mime_type = mimeType;
  const byteSize = inlineData.byteSize ?? inlineData.byte_size ?? inlineData.size;
  if (Number.isInteger(byteSize) && byteSize >= 0) {
    metadata.byte_size = byteSize;
  } else {
    const derived = deriveBase64ByteSize(inlineData.data);
    if (derived !== undefined) metadata.byte_size = derived;
  }
  metadata.media_kind = mediaKindFor(inlineData, {
    mimeType,
    reference: inlineData.displayName ?? inlineData.display_name ?? inlineData.name,
  });
  maybeAddHash(metadata, inlineData);
  return Object.keys(metadata).length ? metadata : null;
}

function explicitMediaKind(value) {
  const mediaKind = value?.mediaKind ?? value?.media_kind;
  const normalized = typeof mediaKind === "string" ? mediaKind.trim().toLowerCase() : "";
  return VALID_MEDIA_KINDS.has(normalized) ? normalized : null;
}

async function metadataFromMediaReference(value, { cwd } = {}) {
  if (!value || typeof value !== "object") return null;
  const reference = MEDIA_REFERENCE_KEYS
    .map((key) => value[key])
    .find((item) => typeof item === "string" && item.trim());
  const metadata = reference ? { ...(await mediaReferenceMetadata(reference, { root: cwd }) ?? {}) } : {};

  const mimeType = normalizeMimeType(value.mimeType ?? value.mime_type);
  if (mimeType) metadata.mime_type = mimeType;
  const byteSize = value.byteSize ?? value.byte_size ?? value.size;
  if (Number.isInteger(byteSize) && byteSize >= 0) metadata.byte_size = byteSize;
  const name = value.displayName ?? value.display_name ?? value.name ?? value.basename;
  if (typeof name === "string" && name.trim()) metadata.basename = basename(name);
  if (!metadata.mime_type) {
    const inferredMimeType = inferMediaMime(metadata.basename ?? reference);
    if (inferredMimeType) metadata.mime_type = inferredMimeType;
  }
  const mediaKind = explicitMediaKind(value);
  if (mediaKind || reference || Object.keys(metadata).length > 0) {
    metadata.media_kind = mediaKind ?? mediaKindFor(value, {
      mimeType: metadata.mime_type,
      reference: name ?? reference,
    });
  }
  maybeAddHash(metadata, value);
  return Object.keys(metadata).length ? metadata : null;
}

async function metadataFromFileData(fileData, { cwd } = {}) {
  if (!fileData || typeof fileData !== "object") return null;
  const metadata = {};
  const fileReference = fileData.fileUri ?? fileData.file_uri ?? fileData.uri;
  const mimeType = normalizeMimeType(fileData.mimeType ?? fileData.mime_type);
  if (mimeType) {
    metadata.mime_type = mimeType;
  } else {
    const inferredMimeType = inferMediaMime(fileReference ?? fileData.displayName ?? fileData.name);
    if (inferredMimeType) metadata.mime_type = inferredMimeType;
  }
  const byteSize = fileData.byteSize ?? fileData.byte_size ?? fileData.size;
  if (Number.isInteger(byteSize) && byteSize >= 0) {
    metadata.byte_size = byteSize;
  } else {
    const localSize = await localMediaByteSize(fileReference, { root: cwd });
    if (localSize !== undefined) metadata.byte_size = localSize;
  }
  const name = fileData.displayName ?? fileData.name ?? mediaBasename(fileReference);
  if (typeof name === "string" && name.trim()) metadata.basename = basename(name);
  metadata.media_kind = mediaKindFor(fileData, {
    mimeType: metadata.mime_type,
    reference: name ?? fileReference,
  });
  maybeAddHash(metadata, fileData);
  return Object.keys(metadata).length ? metadata : null;
}

async function collectMultimodalMetadata(value, { cwd } = {}, output = []) {
  if (value == null) return output;
  if (Array.isArray(value)) {
    for (const item of value) await collectMultimodalMetadata(item, { cwd }, output);
    return output;
  }
  if (typeof value !== "object") return output;

  const inlineMetadata = metadataFromInlineData(value.inlineData ?? value.inline_data);
  if (inlineMetadata) output.push(inlineMetadata);
  const fileMetadata = await metadataFromFileData(value.fileData ?? value.file_data, { cwd });
  if (fileMetadata) output.push(fileMetadata);
  const referenceMetadata = await metadataFromMediaReference(value, { cwd });
  if (referenceMetadata) output.push(referenceMetadata);

  if (Array.isArray(value.parts)) await collectMultimodalMetadata(value.parts, { cwd }, output);
  if (Array.isArray(value.contents)) await collectMultimodalMetadata(value.contents, { cwd }, output);
  return output;
}

async function buildTelemetryEvent({
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
  installId,
  userLabel,
  projectId,
  workspaceId,
  maxEventBytes,
  context,
  outcome,
  economics,
  metadata,
}) {
  const capturedPrompt = truncateTelemetryText(prompt, maxEventBytes);
  const capturedResponse = truncateTelemetryText(response, maxEventBytes);
  const providedEconomics = economics && typeof economics === "object" ? economics : {};
  const resolvedEconomics = {
    ...providedEconomics,
    latency_bucket: economics?.latency_bucket ?? latencyBucket(latencyMs),
  };
  const providedContext = context && typeof context === "object" ? context : {};
  const resolvedWorkspaceId = providedContext.workspace_id ?? workspaceId ?? workspaceIdFromCwd(cwd);

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
      multimodal: await collectMultimodalMetadata(contents, { cwd }),
    },
    context: {
      ...providedContext,
      cwd: context?.cwd ?? cwd ?? null,
      install_id: providedContext.install_id ?? installId ?? null,
      workspace_id: resolvedWorkspaceId,
      user_label: providedContext.user_label ?? userLabel ?? null,
    },
    outcome: outcome && typeof outcome === "object" ? outcome : undefined,
    economics: resolvedEconomics,
    metadata: metadata && typeof metadata === "object" ? metadata : undefined,
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
  projectId = null,
  context = null,
  outcome = null,
  economics = null,
  metadata = null,
  loadConfig = loadTelemetryConfigContext,
  appendEvent = appendTelemetryEvent,
  configCacheTtlMs = DEFAULT_CONFIG_CACHE_TTL_MS,
} = {}) {
  const telemetryContext = await cachedTelemetryContext({ cwd, home, loadConfig, configCacheTtlMs });
  const config = telemetryContext.config;
  if (!config?.enabled || config.level !== "raw") return { queued: false };
  const resolvedDeploymentId = deploymentId ?? config.deployment_id ?? DEFAULT_TELEMETRY_DEPLOYMENT_ID;
  const attribution = await resolveTelemetryAttribution({
    cwd,
    homeDir: home,
    projectId,
    context,
    installId: config.install_id ?? null,
    deploymentId: resolvedDeploymentId,
  });
  const providedMetadata = metadata && typeof metadata === "object" ? metadata : {};

  const event = await buildTelemetryEvent({
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
    installId: config.install_id ?? null,
    userLabel: config.user_label ?? null,
    projectId: attribution.project_id,
    workspaceId: attribution.workspace_id,
    maxEventBytes: config.max_event_bytes,
    context,
    outcome,
    economics,
    metadata: {
      ...providedMetadata,
      attribution: attribution.metadata,
    },
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
