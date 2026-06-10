import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { loadTelemetryConfigContext } from "./telemetry-config.mjs";
import { inferMediaKind, inferMediaMime } from "./media-metadata.mjs";
import { maskCredentialText, normalizeTelemetryEvent } from "./telemetry-schemas.mjs";
import { appendTelemetryEventsIfNew, telemetryQueueDirs } from "./telemetry-queue.mjs";

const QUEUE_STATES = ["pending", "inflight", "sent", "failed", "quarantine"];
const CORRECTION_COMMAND = "artifact-review-backfill-correction";
const VERSION_PATTERN = /^[A-Za-z0-9._-]{1,48}$/;
const VALID_MEDIA_KINDS = new Set(["screenshot", "design", "document", "image", "unknown"]);
const DEFAULT_LIMIT = 100;

function assertPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer.`);
  }
}

function normalizeCorrectionVersion(value) {
  if (typeof value !== "string" || !VERSION_PATTERN.test(value)) {
    throw new Error("correctionVersion must contain 1-48 letters, numbers, dots, underscores, or dashes.");
  }
  return value;
}

function normalizeMimeType(value) {
  if (typeof value !== "string") return null;
  const mimeType = value.split(";")[0].trim().toLowerCase();
  return mimeType || null;
}

function safeMediaKind(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return VALID_MEDIA_KINDS.has(normalized) ? normalized : null;
}

function safeDimension(value, fallback = "unknown") {
  const text = `${value ?? ""}`.replace(/[\0-\x1F\x7F]/g, " ").trim();
  const masked = maskCredentialText(text || fallback);
  return masked.length > 80 ? `${masked.slice(0, 77)}...` : masked;
}

function canonicalCommand(value) {
  return safeDimension(value).toLowerCase().replaceAll("_", "-");
}

function hashText(value) {
  return createHash("sha256").update(value).digest("hex");
}

function correctionEventId(originalEventId, correctionVersion) {
  return `multimodal_kind_correction_${hashText(`${originalEventId}\0${correctionVersion}`).slice(0, 24)}`;
}

function correctionKey(originalEventId, correctionVersion) {
  return `${originalEventId}\0${correctionVersion}`;
}

function eventFileForState(state, path) {
  const name = basename(path);
  if (state === "failed") return name !== "reason.json" && name.endsWith(".json");
  if (state === "quarantine") return name === "event.json";
  return name.endsWith(".json");
}

async function* walkFiles(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isFile()) {
      yield path;
    } else if (entry.isDirectory()) {
      yield* walkFiles(path);
    }
  }
}

async function readEventFile(path) {
  const raw = await readFile(path, "utf8");
  return normalizeTelemetryEvent(JSON.parse(raw));
}

function isCorrectionEvent(event) {
  return event.command === CORRECTION_COMMAND
    && typeof event.metadata?.correction_for_event_id === "string"
    && typeof event.metadata?.correction_version === "string";
}

function originalCorrectionKey(event) {
  if (!isCorrectionEvent(event)) return null;
  return correctionKey(
    event.metadata.correction_for_event_id,
    event.metadata.correction_version,
  );
}

function itemReference(item) {
  return item?.basename ?? item?.name ?? item?.displayName ?? item?.display_name ?? null;
}

function inferMimeForMediaItem(item) {
  return normalizeMimeType(item?.mime_type ?? item?.mimeType)
    ?? inferMediaMime(itemReference(item))
    ?? null;
}

function inferKindForMediaItem(item, { command, index }) {
  const existing = safeMediaKind(item?.media_kind ?? item?.mediaKind);
  if (existing && existing !== "unknown") return existing;
  const normalizedCommand = canonicalCommand(command);
  if (normalizedCommand === "palette-split") {
    return index === 0 ? "image" : "design";
  }
  const mimeType = inferMimeForMediaItem(item);
  const inferred = inferMediaKind({ mimeType, reference: itemReference(item) });
  return VALID_MEDIA_KINDS.has(inferred) ? inferred : "unknown";
}

function mediaItemNeedsRepair(item) {
  const existing = safeMediaKind(item?.media_kind ?? item?.mediaKind);
  return !existing || existing === "unknown";
}

function mediaItemNeedsMetadataRepair(item, context) {
  const existingMimeType = normalizeMimeType(item?.mime_type ?? item?.mimeType);
  const inferredMimeType = inferMimeForMediaItem(item);
  const canImproveMime = !existingMimeType && Boolean(inferredMimeType);
  const existingKind = safeMediaKind(item?.media_kind ?? item?.mediaKind);
  const inferredKind = inferKindForMediaItem(item, context);
  const canImproveKind = (!existingKind || existingKind === "unknown") && inferredKind !== "unknown";
  return canImproveMime || canImproveKind;
}

function repairedMediaItem(item, context) {
  const next = {};
  const mimeType = inferMimeForMediaItem(item);
  if (mimeType) next.mime_type = mimeType;
  const byteSize = item?.byte_size ?? item?.byteSize ?? item?.size;
  if (Number.isInteger(byteSize) && byteSize >= 0) next.byte_size = byteSize;
  if (typeof item?.basename === "string" && item.basename.trim()) next.basename = item.basename;
  if (typeof item?.sha256 === "string" && item.sha256.trim()) next.sha256 = item.sha256;
  next.media_kind = inferKindForMediaItem(item, context);
  return next;
}

function mediaKindCounts(items) {
  const counts = new Map();
  for (const item of items) {
    const kind = item.media_kind ?? "unknown";
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return counts;
}

function topMediaKind(counts) {
  return [...counts.entries()]
    .map(([mediaKind, itemCount]) => ({ media_kind: mediaKind, item_count: itemCount }))
    .sort((left, right) => right.item_count - left.item_count || left.media_kind.localeCompare(right.media_kind));
}

function mediaMimeCounts(items) {
  const counts = new Map();
  for (const item of items) {
    const mimeType = item.mime_type ?? "unknown";
    counts.set(mimeType, (counts.get(mimeType) ?? 0) + 1);
  }
  return counts;
}

function topMediaMime(counts) {
  return [...counts.entries()]
    .map(([mimeType, itemCount]) => ({ mime_type: mimeType, item_count: itemCount }))
    .sort((left, right) => right.item_count - left.item_count || left.mime_type.localeCompare(right.mime_type));
}

function missingByteSizeCount(items) {
  return items.filter((item) => !Number.isInteger(item.byte_size) || item.byte_size < 0).length;
}

function buildCorrectionEvent(event, { correctionVersion, now, correctionReason = "media_kind_inference" }) {
  const originalItems = Array.isArray(event.payload?.multimodal) ? event.payload.multimodal : [];
  const repairedItems = originalItems.map((item, index) => repairedMediaItem(item, {
    command: event.command,
    index,
  }));
  const correctionText = correctionReason === "media_metadata_inference"
    ? "Multimodal media metadata correction."
    : "Multimodal media kind correction.";
  return normalizeTelemetryEvent({
    schema_version: 1,
    event_id: correctionEventId(event.event_id, correctionVersion),
    trace_id: `trace_${hashText(`${event.event_id}\0${correctionVersion}`).slice(0, 24)}`,
    deployment_id: event.deployment_id,
    project_id: event.project_id,
    source: "cli",
    command: CORRECTION_COMMAND,
    model: "gemini-3.5-flash",
    prompt: correctionText,
    response: correctionText,
    status: "success",
    error_type: null,
    latency_ms: 0,
    created_at: now.toISOString(),
    payload: {
      prompt_truncated: false,
      response_truncated: false,
      multimodal: repairedItems,
    },
    context: event.context,
    outcome: {
      task_outcome: "unknown",
      user_acceptance: "not_applicable",
      accepted_files: [],
      modified_after_review: false,
      followup_required: false,
    },
    economics: {
      codex_tokens_saved_estimate: 0,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      latency_bucket: "lt_1s",
      cost_bucket: "free",
    },
    metadata: {
      correction_for_event_id: event.event_id,
      correction_version: correctionVersion,
      correction_reason: correctionReason,
      corrected_command: canonicalCommand(event.command),
    },
  });
}

function needsCorrection(event, { mode = "kind" } = {}) {
  if (event.command === CORRECTION_COMMAND) return false;
  const items = Array.isArray(event.payload?.multimodal) ? event.payload.multimodal : [];
  if (items.length === 0) return false;
  if (mode === "metadata") {
    return items.some((item, index) => mediaItemNeedsMetadataRepair(item, {
      command: event.command,
      index,
    }));
  }
  return items.some(mediaItemNeedsRepair);
}

async function visitTelemetryEvents(storageCwd, visitor) {
  const dirs = telemetryQueueDirs(storageCwd);
  let scannedEvents = 0;
  let invalidFiles = 0;

  for (const state of QUEUE_STATES) {
    for await (const path of walkFiles(dirs[state])) {
      if (!eventFileForState(state, path)) continue;
      try {
        const event = await readEventFile(path);
        scannedEvents += 1;
        await visitor(event);
      } catch {
        invalidFiles += 1;
      }
    }
  }

  return { scannedEvents, invalidFiles };
}

async function loadRepairContext(storageCwd, correctionVersion, limit, { mode = "kind" } = {}) {
  const existingCorrections = new Set();
  const candidates = [];
  const scan = await visitTelemetryEvents(storageCwd, async (event) => {
    const key = originalCorrectionKey(event);
    if (key) existingCorrections.add(key);
    if (needsCorrection(event, { mode })) candidates.push(event);
  });
  const originals = [];
  let skippedExistingCount = 0;
  let limitedCount = 0;

  for (const event of candidates) {
    if (existingCorrections.has(correctionKey(event.event_id, correctionVersion))) {
      skippedExistingCount += 1;
      continue;
    }
    if (originals.length >= limit) {
      limitedCount += 1;
      continue;
    }
    originals.push(event);
  }

  return {
    scannedEvents: scan.scannedEvents,
    invalidFiles: scan.invalidFiles,
    originals,
    skippedExistingCount,
    limitedCount,
  };
}

async function resolveRepairStorage({ cwd, home, scope }) {
  const context = await loadTelemetryConfigContext({ cwd, home, scope });
  if (context.config?.enabled) {
    return {
      scope: context.scope,
      storageCwd: context.storageCwd,
      config: context.config,
    };
  }
  if (scope === "global") throw new Error("Telemetry is not enabled.");
  return {
    scope: context.scope,
    storageCwd: context.storageCwd,
    config: null,
  };
}

export async function runTelemetryMultimodalRepairKind({
  cwd = process.cwd(),
  home,
  scope = "auto",
  correctionVersion,
  dryRun = true,
  limit = DEFAULT_LIMIT,
  now = new Date(),
} = {}) {
  const version = normalizeCorrectionVersion(correctionVersion);
  assertPositiveInteger(limit, "limit");

  const context = await resolveRepairStorage({ cwd, home, scope });
  const repairContext = await loadRepairContext(context.storageCwd, version, limit, { mode: "kind" });
  const selectedOriginals = repairContext.originals;
  const corrections = selectedOriginals.map((event) => buildCorrectionEvent(event, {
    correctionVersion: version,
    now,
    correctionReason: "media_kind_inference",
  }));
  const repairedItems = corrections.flatMap((event) => event.payload.multimodal);
  const kindCounts = mediaKindCounts(repairedItems);

  let queuedCount = 0;
  let skippedDuplicateCount = 0;
  if (!dryRun && corrections.length > 0) {
    const result = await appendTelemetryEventsIfNew({
      cwd: context.storageCwd,
      events: corrections,
      maxQueueBytes: context.config?.max_queue_bytes,
    });
    queuedCount = result.queued.length;
    skippedDuplicateCount = result.skipped.length;
  }

  return {
    ok: true,
    scope: context.scope,
    storage_cwd: context.storageCwd,
    dry_run: dryRun,
    correction_version: version,
    scanned_events: repairContext.scannedEvents,
    invalid_file_count: repairContext.invalidFiles,
    repairable_events: selectedOriginals.length,
    repairable_media_items: repairedItems.length,
    skipped_existing_count: repairContext.skippedExistingCount + skippedDuplicateCount,
    limited_count: repairContext.limitedCount,
    queued_count: queuedCount,
    preview: {
      top_inferred_media_kind: topMediaKind(kindCounts),
    },
    limitations: [
      "This command creates correction events and does not rewrite existing telemetry files.",
      "Output is aggregate-only and does not reveal raw prompt, response, event ids, paths, or media file names.",
      "Historical inference is best-effort; low-confidence media kinds remain unknown.",
    ],
  };
}

export async function runTelemetryMultimodalRepairMetadata({
  cwd = process.cwd(),
  home,
  scope = "auto",
  correctionVersion,
  dryRun = true,
  limit = DEFAULT_LIMIT,
  now = new Date(),
} = {}) {
  const version = normalizeCorrectionVersion(correctionVersion);
  assertPositiveInteger(limit, "limit");

  const context = await resolveRepairStorage({ cwd, home, scope });
  const repairContext = await loadRepairContext(context.storageCwd, version, limit, { mode: "metadata" });
  const selectedOriginals = repairContext.originals;
  const corrections = selectedOriginals.map((event) => buildCorrectionEvent(event, {
    correctionVersion: version,
    now,
    correctionReason: "media_metadata_inference",
  }));
  const repairedItems = corrections.flatMap((event) => event.payload.multimodal);
  const kindCounts = mediaKindCounts(repairedItems);
  const mimeCounts = mediaMimeCounts(repairedItems);

  let queuedCount = 0;
  let skippedDuplicateCount = 0;
  if (!dryRun && corrections.length > 0) {
    const result = await appendTelemetryEventsIfNew({
      cwd: context.storageCwd,
      events: corrections,
      maxQueueBytes: context.config?.max_queue_bytes,
    });
    queuedCount = result.queued.length;
    skippedDuplicateCount = result.skipped.length;
  }

  return {
    ok: true,
    scope: context.scope,
    storage_cwd: context.storageCwd,
    dry_run: dryRun,
    correction_version: version,
    scanned_events: repairContext.scannedEvents,
    invalid_file_count: repairContext.invalidFiles,
    repairable_events: selectedOriginals.length,
    repairable_media_items: repairedItems.length,
    skipped_existing_count: repairContext.skippedExistingCount + skippedDuplicateCount,
    limited_count: repairContext.limitedCount,
    queued_count: queuedCount,
    preview: {
      top_inferred_media_mime: topMediaMime(mimeCounts),
      top_inferred_media_kind: topMediaKind(kindCounts),
      missing_byte_size_items: missingByteSizeCount(repairedItems),
    },
    limitations: [
      "This command creates correction events and does not rewrite existing telemetry files.",
      "MIME and media kind are inferred only from existing safe metadata such as synthetic basenames and MIME fields.",
      "Missing byte sizes are not fabricated; byte_size is preserved only when the original telemetry item already had it.",
      "Output is aggregate-only and does not reveal raw prompt, response, event ids, paths, or media file names.",
    ],
  };
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatKindRows(rows) {
  if (rows.length === 0) return "None";
  return rows.map((item, index) => (
    `${index + 1}. ${item.media_kind}: ${formatNumber(item.item_count)} media items`
  )).join("\n");
}

function formatMimeRows(rows) {
  if (rows.length === 0) return "None";
  return rows.map((item, index) => (
    `${index + 1}. ${item.mime_type}: ${formatNumber(item.item_count)} media items`
  )).join("\n");
}

export function formatTelemetryMultimodalRepairText(report) {
  return [
    "Telemetry Multimodal Repair",
    "",
    `Scope: ${report.scope}`,
    `Storage: ${report.storage_cwd}`,
    `Mode: ${report.dry_run ? "dry-run" : "write"}`,
    `Correction version: ${report.correction_version}`,
    `Scanned events: ${formatNumber(report.scanned_events)}`,
    `Repairable events: ${formatNumber(report.repairable_events)}`,
    `Repairable media items: ${formatNumber(report.repairable_media_items)}`,
    `Queued corrections: ${formatNumber(report.queued_count)}`,
    `Skipped existing corrections: ${formatNumber(report.skipped_existing_count)}`,
    `Limited events: ${formatNumber(report.limited_count)}`,
    "",
    "Inferred media kind preview:",
    formatKindRows(report.preview.top_inferred_media_kind),
    "",
    "Limitations:",
    ...report.limitations.map((item) => `- ${item}`),
    "",
  ].join("\n");
}

export function formatTelemetryMultimodalRepairMetadataText(report) {
  return [
    "Telemetry Multimodal Metadata Repair",
    "",
    `Scope: ${report.scope}`,
    `Storage: ${report.storage_cwd}`,
    `Mode: ${report.dry_run ? "dry-run" : "write"}`,
    `Correction version: ${report.correction_version}`,
    `Scanned events: ${formatNumber(report.scanned_events)}`,
    `Repairable events: ${formatNumber(report.repairable_events)}`,
    `Repairable media items: ${formatNumber(report.repairable_media_items)}`,
    `Queued corrections: ${formatNumber(report.queued_count)}`,
    `Skipped existing corrections: ${formatNumber(report.skipped_existing_count)}`,
    `Limited events: ${formatNumber(report.limited_count)}`,
    `Missing byte-size items after repair: ${formatNumber(report.preview.missing_byte_size_items)}`,
    "",
    "Inferred MIME preview:",
    formatMimeRows(report.preview.top_inferred_media_mime),
    "",
    "Inferred media kind preview:",
    formatKindRows(report.preview.top_inferred_media_kind),
    "",
    "Limitations:",
    ...report.limitations.map((item) => `- ${item}`),
    "",
  ].join("\n");
}
