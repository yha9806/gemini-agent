import { readFile, readdir } from "node:fs/promises";
import { basename, relative, join, sep } from "node:path";
import { createHash } from "node:crypto";
import { loadTelemetryConfigContext } from "./telemetry-config.mjs";
import { maskCredentialText, normalizeTelemetryEvent } from "./telemetry-schemas.mjs";
import {
  loadTelemetryState,
  telemetryQueueDirs,
} from "./telemetry-queue.mjs";

const QUEUE_STATES = ["pending", "inflight", "sent", "failed", "quarantine"];
const DEFAULT_QUEUE_STATE = Object.freeze({
  dropped_old_count: 0,
  dropped_memory_count: 0,
  queue_bytes: 0,
  sent_success_count: 0,
  sent_failure_count: 0,
  non_retryable_failure_count: 0,
  last_failure_reason: null,
  last_sent_at: null,
});

function zeroCounts() {
  return {
    total: 0,
    pending: 0,
    inflight: 0,
    sent: 0,
    failed: 0,
    quarantine: 0,
    invalid: 0,
  };
}

function zeroUsage() {
  return {
    prompt_tokens: 0,
    response_tokens: 0,
    total_tokens: 0,
    estimated_codex_tokens_saved: 0,
    events_missing_usage: 0,
  };
}

function zeroRawContent() {
  return {
    prompt_events: 0,
    response_events: 0,
    truncated_prompt_events: 0,
    truncated_response_events: 0,
  };
}

function zeroMultimodal() {
  return {
    event_count: 0,
    item_count: 0,
    byte_count: 0,
    unknown_mime_items: 0,
    unknown_byte_size_items: 0,
    unknown_kind_items: 0,
    media_items_with_mime: 0,
    media_items_with_byte_size: 0,
    media_items_with_kind: 0,
  };
}

function zeroAdjustedMultimodal() {
  return {
    ...zeroMultimodal(),
    correction_event_count: 0,
    corrected_original_event_count: 0,
    orphan_correction_event_count: 0,
    superseded_correction_event_count: 0,
    applied_correction_event_count: 0,
  };
}

function zeroCorrections() {
  return {
    event_count: 0,
    corrected_original_event_count: 0,
    media_item_count: 0,
    media_byte_count: 0,
    media_items_with_mime: 0,
    media_items_with_byte_size: 0,
  };
}

function zeroPaletteSplit() {
  return {
    event_count: 0,
    success_count: 0,
    error_count: 0,
    quality_event_count: 0,
    avg_quality_score: null,
    resized_mask_count: 0,
    empty_target_count: 0,
    degenerate_target_count: 0,
    avg_foreground_area_pct: null,
    top_actual_models: [],
  };
}

function zeroStatusCounts() {
  return {
    event_count: 0,
    success_count: 0,
    error_count: 0,
    unknown_count: 0,
  };
}

function safeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function safeFiniteNumber(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function roundOne(value) {
  return Number(value.toFixed(1));
}

function sanitizeDimension(value, fallback = "unknown") {
  const text = `${value ?? ""}`.replace(/[\0-\x1F\x7F]/g, " ").trim();
  const masked = maskCredentialText(text || fallback);
  return masked.length > 120 ? `${masked.slice(0, 117)}...` : masked;
}

function classifyFailureReason(reason) {
  const text = `${reason ?? ""}`.trim().toLowerCase();
  if (!text) return null;
  if (text.startsWith("quarantined:")) return "quarantined";
  if (text.startsWith("receiver_error")) return "receiver_error";
  if (text.startsWith("schedule_not_due")) return "schedule_not_due";
  if (/^http_\d{3}$/.test(text)) return text;
  return "other";
}

function createDimensionMap() {
  return new Map();
}

function updateDimension(map, key, status) {
  const safeKey = sanitizeDimension(key);
  const item = map.get(safeKey) ?? {
    key: safeKey,
    event_count: 0,
    success_count: 0,
    error_count: 0,
    unknown_count: 0,
  };
  item.event_count += 1;
  if (status === "success") item.success_count += 1;
  else if (status === "error") item.error_count += 1;
  else item.unknown_count += 1;
  map.set(safeKey, item);
}

function safeOptionalDimension(value) {
  const raw = `${value ?? ""}`.trim();
  if (!raw || raw.toLowerCase() === "unknown") return null;
  if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(raw)) return null;
  const safe = sanitizeDimension(raw);
  return safe && safe.toLowerCase() !== "unknown" ? safe : null;
}

function updateOptionalDimension(map, key, status) {
  const safeKey = safeOptionalDimension(key);
  if (!safeKey) return;
  updateDimension(map, safeKey, status);
}

function canonicalCommand(value) {
  const sanitized = sanitizeDimension(value);
  return sanitized.toLowerCase().replaceAll("_", "-");
}

function updateCommandDimension(map, command, status) {
  updateDimension(map, canonicalCommand(command), status);
}

function updateStatusCounts(counts, status) {
  counts.event_count += 1;
  if (status === "success") counts.success_count += 1;
  else if (status === "error") counts.error_count += 1;
  else counts.unknown_count += 1;
}

function topDimension(map, keyName, limit) {
  return [...map.values()]
    .sort((left, right) => right.event_count - left.event_count || left.key.localeCompare(right.key))
    .slice(0, limit)
    .map((item) => ({
      [keyName]: item.key,
      event_count: item.event_count,
      success_count: item.success_count,
      error_count: item.error_count,
      unknown_count: item.unknown_count,
    }));
}

function updateMediaMime(map, mimeType, byteSize, seenInEvent) {
  const key = sanitizeDimension(mimeType, "unknown");
  const item = map.get(key) ?? {
    key,
    event_count: 0,
    item_count: 0,
    byte_count: 0,
  };
  if (!seenInEvent.has(key)) {
    item.event_count += 1;
    seenInEvent.add(key);
  }
  item.item_count += 1;
  item.byte_count += byteSize;
  map.set(key, item);
}

function topMediaMime(map, limit) {
  return [...map.values()]
    .sort((left, right) => (
      right.item_count - left.item_count
      || right.event_count - left.event_count
      || left.key.localeCompare(right.key)
    ))
    .slice(0, limit)
    .map((item) => ({
      mime_type: item.key,
      event_count: item.event_count,
      item_count: item.item_count,
      byte_count: item.byte_count,
    }));
}

function updateMediaKind(map, mediaKind, byteSize, seenInEvent) {
  const key = sanitizeDimension(mediaKind, "unknown");
  const item = map.get(key) ?? {
    key,
    event_count: 0,
    item_count: 0,
    byte_count: 0,
  };
  if (!seenInEvent.has(key)) {
    item.event_count += 1;
    seenInEvent.add(key);
  }
  item.item_count += 1;
  item.byte_count += byteSize;
  map.set(key, item);
}

function topMediaKind(map, limit) {
  return [...map.values()]
    .sort((left, right) => (
      right.item_count - left.item_count
      || right.event_count - left.event_count
      || left.key.localeCompare(right.key)
    ))
    .slice(0, limit)
    .map((item) => ({
      media_kind: item.key,
      event_count: item.event_count,
      item_count: item.item_count,
      byte_count: item.byte_count,
    }));
}

function createMediaAggregate() {
  return {
    ...zeroMultimodal(),
    mediaMimes: createDimensionMap(),
    mediaKinds: createDimensionMap(),
  };
}

function compactMediaItems(items) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => {
    const mimeType = typeof item?.mime_type === "string" && item.mime_type.trim()
      ? item.mime_type
      : "unknown";
    const mediaKind = typeof item?.media_kind === "string" && item.media_kind.trim()
      ? item.media_kind
      : "unknown";
    const hasByteSize = Number.isInteger(item?.byte_size) && item.byte_size >= 0;
    return {
      mimeType,
      mediaKind,
      byteSize: hasByteSize ? item.byte_size : 0,
      hasByteSize,
    };
  });
}

function addCompactMediaItems(aggregate, items) {
  if (items.length === 0) return;
  aggregate.event_count += 1;
  const seenMimes = new Set();
  const seenKinds = new Set();
  for (const item of items) {
    aggregate.item_count += 1;
    aggregate.byte_count += item.byteSize;
    if (item.mimeType === "unknown") aggregate.unknown_mime_items += 1;
    else aggregate.media_items_with_mime += 1;
    if (!item.hasByteSize) aggregate.unknown_byte_size_items += 1;
    else aggregate.media_items_with_byte_size += 1;
    if (item.mediaKind === "unknown") aggregate.unknown_kind_items += 1;
    else aggregate.media_items_with_kind += 1;
    updateMediaMime(aggregate.mediaMimes, item.mimeType, item.byteSize, seenMimes);
    updateMediaKind(aggregate.mediaKinds, item.mediaKind, item.byteSize, seenKinds);
  }
}

function publicMediaAggregate(aggregate, topLimit) {
  return {
    event_count: aggregate.event_count,
    item_count: aggregate.item_count,
    byte_count: aggregate.byte_count,
    unknown_mime_items: aggregate.unknown_mime_items,
    unknown_byte_size_items: aggregate.unknown_byte_size_items,
    unknown_kind_items: aggregate.unknown_kind_items,
    media_items_with_mime: aggregate.media_items_with_mime,
    media_items_with_byte_size: aggregate.media_items_with_byte_size,
    media_items_with_kind: aggregate.media_items_with_kind,
    top_media_mime: topMediaMime(aggregate.mediaMimes, topLimit),
    top_media_kind: topMediaKind(aggregate.mediaKinds, topLimit),
  };
}

function topCorrectionVersions(map, limit) {
  return [...map.values()]
    .sort((left, right) => (
      right.event_count - left.event_count
      || right.media_item_count - left.media_item_count
      || left.key.localeCompare(right.key)
    ))
    .slice(0, limit)
    .map((item) => ({
      correction_version: item.key,
      event_count: item.event_count,
      corrected_original_event_count: item.correctedOriginalIds.size,
      media_item_count: item.media_item_count,
      media_byte_count: item.media_byte_count,
    }));
}

function successRate(item) {
  return item.event_count > 0 ? item.success_count / item.event_count : 0;
}

function commandLooksLikeArtifactReview(command) {
  return /artifact[_-]?review/i.test(command);
}

function isCorrectionEvent(event) {
  return event.command === "artifact-review-backfill-correction";
}

function isPaletteSplitEvent(event) {
  return event.command === "palette-split" || event.metadata?.workflow === "palette-split";
}

function buildRecommendations({ commands, counts, statusCounts, queue, usage, multimodal }) {
  const recommendations = [];
  const artifactReview = commands
    .filter((item) => commandLooksLikeArtifactReview(item.command))
    .reduce((total, item) => ({
      event_count: total.event_count + item.event_count,
      success_count: total.success_count + item.success_count,
      error_count: total.error_count + item.error_count,
      unknown_count: total.unknown_count + item.unknown_count,
    }), zeroStatusCounts());
  if (artifactReview.success_count >= 5 && successRate(artifactReview) >= 0.8) {
    recommendations.push({
      kind: "workflow",
      message: "artifact-review has enough successful use to keep prioritizing multimodal/design workflows.",
    });
  }
  const contextPack = commands.find((item) => item.command === "context-pack");
  if (contextPack?.success_count >= 5 && successRate(contextPack) >= 0.8) {
    recommendations.push({
      kind: "workflow",
      message: "context-pack has enough successful use to keep prioritizing large-context compression.",
    });
  }
  if (statusCounts.event_count > 0 && statusCounts.error_count / statusCounts.event_count > 0.2) {
    recommendations.push({
      kind: "reliability",
      message: "Error rate is above 20%; diagnose reliability before expanding automation.",
    });
  }
  if (counts.pending >= 50 && queue.last_failure_reason === "receiver_error") {
    recommendations.push({
      kind: "delivery",
      message: "Pending queue is high with receiver_error; keep bounded flushes and inspect the endpoint.",
    });
  }
  if (queue.last_failure_reason === "http_403") {
    recommendations.push({
      kind: "delivery",
      message: "Last telemetry failure was http_403; verify token and endpoint, then retry with small bounded flushes.",
    });
  }
  if (counts.total > 0 && usage.events_missing_usage / counts.total > 0.5) {
    recommendations.push({
      kind: "instrumentation",
      message: "Most events are missing usage metadata; validate Gemini client capture before drawing token-savings conclusions.",
    });
  }
  if (multimodal.item_count > 0 && multimodal.unknown_mime_items / multimodal.item_count > 0.1) {
    recommendations.push({
      kind: "instrumentation",
      message: "Some multimodal metadata has unknown MIME types; improve artifact capture so design analytics can segment images, PDFs, and screenshots.",
    });
  }
  if (multimodal.item_count > 0 && multimodal.unknown_byte_size_items / multimodal.item_count > 0.25) {
    recommendations.push({
      kind: "instrumentation",
      message: "Some multimodal metadata is missing byte sizes; improve media capture so cost and storage analytics can measure payload volume.",
    });
  }
  if (multimodal.item_count >= 5 && multimodal.unknown_kind_items / multimodal.item_count > 0.5) {
    recommendations.push({
      kind: "instrumentation",
      message: "Most multimodal metadata is missing media kind; classify screenshots, designs, documents, and images before making quality claims.",
    });
  }
  return recommendations;
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatTopRows(items, keyName) {
  if (items.length === 0) return "None";
  return items.map((item, index) => (
    `${index + 1}. ${item[keyName]}: ${item.event_count} events, ${item.success_count} success, ${item.error_count} error`
  )).join("\n");
}

function summaryStatusCounts(summary) {
  if (summary.status_counts) return summary.status_counts;
  return summary.top_commands.reduce((counts, item) => ({
    event_count: counts.event_count + item.event_count,
    success_count: counts.success_count + item.success_count,
    error_count: counts.error_count + item.error_count,
    unknown_count: counts.unknown_count + item.unknown_count,
  }), zeroStatusCounts());
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

function eventFileForState(state, path) {
  const name = basename(path);
  if (state === "failed") return name !== "reason.json" && name.endsWith(".json");
  if (state === "quarantine") return name === "event.json";
  return name.endsWith(".json");
}

async function readEventFile(path) {
  const raw = await readFile(path, "utf8");
  return normalizeTelemetryEvent(JSON.parse(raw));
}

function isMissingFileError(error) {
  return error?.code === "ENOENT";
}

function relativeSamplePath(root, path) {
  const sample = relative(root, path);
  return sep === "\\" ? sample.replaceAll("\\", "/") : sample;
}

function safeInvalidSamplePath(root, path) {
  const sample = relativeSamplePath(root, path);
  const digest = createHash("sha256").update(sample).digest("hex").slice(0, 12);
  const segments = sample.split("/");
  const queueIndex = segments.indexOf("queue");
  const state = queueIndex >= 0 ? segments[queueIndex + 1] : null;
  return QUEUE_STATES.includes(state)
    ? `queue/${state}/invalid-${digest}.json`
    : `invalid-${digest}.json`;
}

function createAccumulator(invalidSampleLimit) {
  return {
    invalidSampleLimit,
    counts: zeroCounts(),
    statusCounts: zeroStatusCounts(),
    usage: zeroUsage(),
    rawContent: zeroRawContent(),
    rawMedia: createMediaAggregate(),
    corrections: zeroCorrections(),
    projects: createDimensionMap(),
    workspaces: createDimensionMap(),
    userLabels: createDimensionMap(),
    commands: createDimensionMap(),
    sources: createDimensionMap(),
    models: createDimensionMap(),
    correctionVersions: createDimensionMap(),
    correctedOriginalIds: new Set(),
    existingEventIds: new Set(),
    adjustedOriginals: new Map(),
    adjustedCorrections: new Map(),
    adjustedMalformedCorrectionCount: 0,
    adjustedCorrectionSequence: 0,
    paletteSplit: {
      event_count: 0,
      success_count: 0,
      error_count: 0,
      quality_event_count: 0,
      quality_score_sum: 0,
      quality_score_count: 0,
      resized_mask_count: 0,
      empty_target_count: 0,
      degenerate_target_count: 0,
      foreground_area_pct_sum: 0,
      foreground_area_pct_count: 0,
    },
    paletteSplitModels: createDimensionMap(),
    invalidSamples: [],
  };
}

function addInvalid(accumulator, path, root) {
  accumulator.counts.invalid += 1;
  accumulator.counts.total += 1;
  if (accumulator.invalidSamples.length < accumulator.invalidSampleLimit) {
    accumulator.invalidSamples.push(safeInvalidSamplePath(root, path));
  }
}

function addEvent(accumulator, state, event) {
  accumulator.counts[state] += 1;
  accumulator.counts.total += 1;
  const status = event.status === "success" || event.status === "error" ? event.status : "unknown";
  updateStatusCounts(accumulator.statusCounts, status);
  updateDimension(accumulator.projects, event.project_id, status);
  updateOptionalDimension(accumulator.workspaces, event.context?.workspace_id, status);
  updateOptionalDimension(accumulator.userLabels, event.context?.user_label, status);
  updateCommandDimension(accumulator.commands, event.command, status);
  updateDimension(accumulator.sources, event.source, status);
  updateDimension(accumulator.models, event.model, status);
  if (isPaletteSplitEvent(event)) addPaletteSplitEvent(accumulator, event, status);

  if (event.prompt) accumulator.rawContent.prompt_events += 1;
  if (event.response) accumulator.rawContent.response_events += 1;
  if (event.payload?.prompt_truncated) accumulator.rawContent.truncated_prompt_events += 1;
  if (event.payload?.response_truncated) accumulator.rawContent.truncated_response_events += 1;

  const multimodalItems = Array.isArray(event.payload?.multimodal)
    ? event.payload.multimodal
    : [];
  const compactItems = compactMediaItems(multimodalItems);
  if (isCorrectionEvent(event)) {
    addCorrectionEvent(accumulator, event, multimodalItems);
    addAdjustedCorrectionCandidate(accumulator, event, compactItems);
  } else {
    if (typeof event.event_id === "string" && event.event_id.trim()) {
      accumulator.existingEventIds.add(event.event_id);
      accumulator.adjustedOriginals.set(event.event_id, compactItems);
    }
    addCompactMediaItems(accumulator.rawMedia, compactItems);
  }

  const inputTokens = event.economics?.input_tokens;
  const outputTokens = event.economics?.output_tokens;
  const totalTokens = event.economics?.total_tokens;
  if (inputTokens == null && outputTokens == null && totalTokens == null) {
    accumulator.usage.events_missing_usage += 1;
    return;
  }
  accumulator.usage.prompt_tokens += safeInteger(inputTokens);
  accumulator.usage.response_tokens += safeInteger(outputTokens);
  accumulator.usage.total_tokens += safeInteger(totalTokens);
  accumulator.usage.estimated_codex_tokens_saved += safeInteger(inputTokens);
}

function addPaletteSplitEvent(accumulator, event, status) {
  accumulator.paletteSplit.event_count += 1;
  if (status === "success") accumulator.paletteSplit.success_count += 1;
  else if (status === "error") accumulator.paletteSplit.error_count += 1;

  updateDimension(accumulator.paletteSplitModels, event.metadata?.actual_model, status);

  const quality = event.metadata?.quality;
  if (!quality || typeof quality !== "object" || Array.isArray(quality)) return;
  accumulator.paletteSplit.quality_event_count += 1;
  if (quality.mask_resized === true) accumulator.paletteSplit.resized_mask_count += 1;
  accumulator.paletteSplit.empty_target_count += safeInteger(quality.empty_target_count);
  accumulator.paletteSplit.degenerate_target_count += safeInteger(quality.degenerate_target_count);

  const qualityScore = safeFiniteNumber(quality.quality_score);
  if (qualityScore !== null) {
    accumulator.paletteSplit.quality_score_sum += qualityScore;
    accumulator.paletteSplit.quality_score_count += 1;
  }
  const foregroundAreaPct = safeFiniteNumber(quality.foreground_area_pct);
  if (foregroundAreaPct !== null) {
    accumulator.paletteSplit.foreground_area_pct_sum += foregroundAreaPct;
    accumulator.paletteSplit.foreground_area_pct_count += 1;
  }
}

function addCorrectionEvent(accumulator, event, multimodalItems) {
  accumulator.corrections.event_count += 1;
  const originalEventId = typeof event.metadata?.correction_for_event_id === "string"
    && event.metadata.correction_for_event_id.trim()
    ? event.metadata.correction_for_event_id
    : null;
  if (originalEventId) accumulator.correctedOriginalIds.add(originalEventId);

  const version = sanitizeDimension(event.metadata?.correction_version, "unknown");
  const versionItem = accumulator.correctionVersions.get(version) ?? {
    key: version,
    event_count: 0,
    media_item_count: 0,
    media_byte_count: 0,
    correctedOriginalIds: new Set(),
  };
  versionItem.event_count += 1;
  if (originalEventId) versionItem.correctedOriginalIds.add(originalEventId);

  for (const item of multimodalItems) {
    const byteSize = safeInteger(item?.byte_size);
    accumulator.corrections.media_item_count += 1;
    accumulator.corrections.media_byte_count += byteSize;
    versionItem.media_item_count += 1;
    versionItem.media_byte_count += byteSize;
    if (typeof item?.mime_type === "string" && item.mime_type.trim()) {
      accumulator.corrections.media_items_with_mime += 1;
    }
    if (Number.isInteger(item?.byte_size) && item.byte_size >= 0) {
      accumulator.corrections.media_items_with_byte_size += 1;
    }
  }

  accumulator.correctionVersions.set(version, versionItem);
}

function safeCorrectionTarget(event) {
  const target = event.metadata?.correction_for_event_id;
  return typeof target === "string" && target.trim() ? target : null;
}

function safeCorrectionVersion(event) {
  const version = sanitizeDimension(event.metadata?.correction_version, "unknown");
  return version && version !== "unknown" ? version : null;
}

function addAdjustedCorrectionCandidate(accumulator, event, mediaItems) {
  accumulator.adjustedCorrectionSequence += 1;
  const target = safeCorrectionTarget(event);
  const version = safeCorrectionVersion(event);
  if (!target || !version) {
    accumulator.adjustedMalformedCorrectionCount += 1;
    return;
  }
  const candidates = accumulator.adjustedCorrections.get(target) ?? [];
  candidates.push({
    target,
    version,
    createdAt: event.created_at,
    sequence: accumulator.adjustedCorrectionSequence,
    mediaItems,
  });
  accumulator.adjustedCorrections.set(target, candidates);
}

function buildAdjustedMultimodal(accumulator, topLimit) {
  const aggregate = createMediaAggregate();
  const appliedVersions = createDimensionMap();
  const appliedOriginals = new Set();
  let correctionEventCount = accumulator.adjustedMalformedCorrectionCount;
  let orphanCorrectionEventCount = accumulator.adjustedMalformedCorrectionCount;
  let supersededCorrectionEventCount = 0;
  let appliedCorrectionEventCount = 0;

  for (const [target, candidates] of accumulator.adjustedCorrections.entries()) {
    correctionEventCount += candidates.length;
    const originalExists = accumulator.existingEventIds.has(target);
    if (!originalExists) {
      orphanCorrectionEventCount += candidates.length;
      continue;
    }

    const applied = candidates[candidates.length - 1];
    appliedOriginals.add(target);
    appliedCorrectionEventCount += 1;
    supersededCorrectionEventCount += Math.max(0, candidates.length - 1);
    addCompactMediaItems(aggregate, applied.mediaItems);

    const item = appliedVersions.get(applied.version) ?? {
      key: applied.version,
      event_count: 0,
      media_item_count: 0,
      media_byte_count: 0,
      correctedOriginalIds: new Set(),
    };
    item.event_count += 1;
    item.media_item_count += applied.mediaItems.length;
    item.media_byte_count += applied.mediaItems.reduce(
      (total, media) => total + media.byteSize,
      0,
    );
    item.correctedOriginalIds.add(target);
    appliedVersions.set(applied.version, item);
  }

  for (const [eventId, originalItems] of accumulator.adjustedOriginals.entries()) {
    if (!appliedOriginals.has(eventId)) addCompactMediaItems(aggregate, originalItems);
  }

  return {
    ...publicMediaAggregate(aggregate, topLimit),
    correction_event_count: correctionEventCount,
    corrected_original_event_count: appliedOriginals.size,
    orphan_correction_event_count: orphanCorrectionEventCount,
    superseded_correction_event_count: supersededCorrectionEventCount,
    applied_correction_event_count: appliedCorrectionEventCount,
    top_correction_versions: topCorrectionVersions(appliedVersions, topLimit),
  };
}

function buildPaletteSplitSummary(accumulator, topLimit) {
  if (accumulator.paletteSplit.event_count === 0) return zeroPaletteSplit();
  const qualityCount = accumulator.paletteSplit.quality_score_count;
  const foregroundCount = accumulator.paletteSplit.foreground_area_pct_count;
  return {
    event_count: accumulator.paletteSplit.event_count,
    success_count: accumulator.paletteSplit.success_count,
    error_count: accumulator.paletteSplit.error_count,
    quality_event_count: accumulator.paletteSplit.quality_event_count,
    avg_quality_score: qualityCount > 0
      ? roundOne(accumulator.paletteSplit.quality_score_sum / qualityCount)
      : null,
    resized_mask_count: accumulator.paletteSplit.resized_mask_count,
    empty_target_count: accumulator.paletteSplit.empty_target_count,
    degenerate_target_count: accumulator.paletteSplit.degenerate_target_count,
    avg_foreground_area_pct: foregroundCount > 0
      ? roundOne(accumulator.paletteSplit.foreground_area_pct_sum / foregroundCount)
      : null,
    top_actual_models: topDimension(accumulator.paletteSplitModels, "actual_model", topLimit),
  };
}

export async function runTelemetrySummary({
  cwd = process.cwd(),
  home,
  scope = "auto",
  now = new Date(),
  topLimit = 10,
  invalidSampleLimit = 20,
} = {}) {
  if (!Number.isInteger(topLimit) || topLimit <= 0) {
    throw new RangeError("topLimit must be a positive integer.");
  }
  if (!Number.isInteger(invalidSampleLimit) || invalidSampleLimit < 0) {
    throw new RangeError("invalidSampleLimit must be a nonnegative integer.");
  }

  const context = await loadTelemetryConfigContext({ cwd, home, scope });
  if (!context.config?.enabled) throw new Error("Telemetry is not enabled.");

  let state = DEFAULT_QUEUE_STATE;
  let stateReadError = false;
  try {
    state = await loadTelemetryState({ cwd: context.storageCwd });
  } catch {
    stateReadError = true;
  }

  const dirs = telemetryQueueDirs(context.storageCwd);
  const accumulator = createAccumulator(invalidSampleLimit);
  for (const queueState of QUEUE_STATES) {
    for await (const path of walkFiles(dirs[queueState])) {
      if (!eventFileForState(queueState, path)) continue;
      try {
        addEvent(accumulator, queueState, await readEventFile(path));
      } catch (error) {
        if (isMissingFileError(error)) continue;
        addInvalid(accumulator, path, dirs.root);
      }
    }
  }

  const topProjects = topDimension(accumulator.projects, "project_id", topLimit);
  const topWorkspaces = topDimension(accumulator.workspaces, "workspace_id", topLimit);
  const topUserLabels = topDimension(accumulator.userLabels, "user_label", topLimit);
  const topCommands = topDimension(accumulator.commands, "command", topLimit);
  const allCommands = topDimension(accumulator.commands, "command", accumulator.commands.size);
  const sources = topDimension(accumulator.sources, "source", topLimit);
  const models = topDimension(accumulator.models, "model", topLimit);
  const multimodal = publicMediaAggregate(accumulator.rawMedia, topLimit);
  const multimodalAdjusted = buildAdjustedMultimodal(accumulator, topLimit);
  const corrections = {
    ...accumulator.corrections,
    corrected_original_event_count: accumulator.correctedOriginalIds.size,
    top_versions: topCorrectionVersions(accumulator.correctionVersions, topLimit),
  };
  const paletteSplit = buildPaletteSplitSummary(accumulator, topLimit);
  const queue = {
    queue_bytes: state.queue_bytes,
    dropped_old_count: state.dropped_old_count,
    dropped_memory_count: state.dropped_memory_count,
    sent_success_count: state.sent_success_count,
    sent_failure_count: state.sent_failure_count,
    non_retryable_failure_count: state.non_retryable_failure_count,
    last_failure_reason: classifyFailureReason(state.last_failure_reason),
    last_sent_at: state.last_sent_at,
    state_read_error: stateReadError,
  };

  return {
    scope: context.scope,
    storage_cwd: context.storageCwd,
    generated_at: now.toISOString(),
    event_counts: accumulator.counts,
    status_counts: accumulator.statusCounts,
    queue,
    usage: accumulator.usage,
    multimodal,
    multimodal_adjusted: multimodalAdjusted,
    corrections,
    palette_split: paletteSplit,
    top_projects: topProjects,
    top_workspaces: topWorkspaces,
    top_user_labels: topUserLabels,
    top_commands: topCommands,
    sources,
    models,
    raw_content: accumulator.rawContent,
    invalid_events: {
      count: accumulator.counts.invalid,
      samples: accumulator.invalidSamples,
    },
    recommendations: buildRecommendations({
      commands: allCommands,
      counts: accumulator.counts,
      statusCounts: accumulator.statusCounts,
      queue,
      usage: accumulator.usage,
      multimodal,
    }),
    limitations: [
      "Local summary only includes telemetry files available on this machine.",
      "Codex token savings are estimated from Gemini prompt token usage, not measured from Codex billing.",
      ...(stateReadError ? ["Queue state metadata could not be read; queue counters may be incomplete."] : []),
    ],
  };
}

export function formatTelemetrySummaryText(summary) {
  const statusCounts = summaryStatusCounts(summary);
  const successCount = statusCounts.success_count;
  const errorCount = statusCounts.error_count;
  const knownOutcomes = successCount + errorCount;
  const successRateText = knownOutcomes === 0 ? "n/a" : `${((successCount / knownOutcomes) * 100).toFixed(1)}%`;
  const recommendations = summary.recommendations.length
    ? summary.recommendations.map((item) => `- ${item.message}`).join("\n")
    : "- No recommendations yet; collect more events.";

  return [
    "Telemetry Summary",
    "",
    `Scope: ${summary.scope}`,
    `Storage: ${summary.storage_cwd}`,
    `Events: ${summary.event_counts.total} total, ${summary.event_counts.sent} sent, ${summary.event_counts.pending} pending, ${summary.event_counts.failed} failed, ${summary.event_counts.quarantine} quarantined, ${summary.event_counts.invalid} invalid`,
    "",
    "Top projects:",
    formatTopRows(summary.top_projects, "project_id"),
    "",
    "Top workspaces:",
    formatTopRows(summary.top_workspaces ?? [], "workspace_id"),
    "",
    "Top user labels:",
    formatTopRows(summary.top_user_labels ?? [], "user_label"),
    "",
    "Top commands:",
    formatTopRows(summary.top_commands, "command"),
    "",
    "Reliability:",
    `- Success rate: ${successRateText}`,
    `- Last failure: ${summary.queue.last_failure_reason ?? "none"}`,
    "",
    "Usage:",
    `- Prompt tokens: ${formatNumber(summary.usage.prompt_tokens)}`,
    `- Response tokens: ${formatNumber(summary.usage.response_tokens)}`,
    `- Estimated Codex tokens saved: ${formatNumber(summary.usage.estimated_codex_tokens_saved)}`,
    "",
    "Multimodal:",
    `- Events: ${formatNumber(summary.multimodal?.event_count ?? 0)}`,
    `- Media items: ${formatNumber(summary.multimodal?.item_count ?? 0)}`,
    `- Media bytes: ${formatNumber(summary.multimodal?.byte_count ?? 0)}`,
    `- Unknown MIME items: ${formatNumber(summary.multimodal?.unknown_mime_items ?? 0)}`,
    `- Unknown byte-size items: ${formatNumber(summary.multimodal?.unknown_byte_size_items ?? 0)}`,
    `- Unknown media-kind items: ${formatNumber(summary.multimodal?.unknown_kind_items ?? 0)}`,
    "",
    "Adjusted multimodal:",
    `- Events: ${formatNumber(summary.multimodal_adjusted?.event_count ?? 0)}`,
    `- Media items: ${formatNumber(summary.multimodal_adjusted?.item_count ?? 0)}`,
    `- Media bytes: ${formatNumber(summary.multimodal_adjusted?.byte_count ?? 0)}`,
    `- Unknown MIME items: ${formatNumber(summary.multimodal_adjusted?.unknown_mime_items ?? 0)}`,
    `- Unknown byte-size items: ${formatNumber(summary.multimodal_adjusted?.unknown_byte_size_items ?? 0)}`,
    `- Unknown media-kind items: ${formatNumber(summary.multimodal_adjusted?.unknown_kind_items ?? 0)}`,
    `- Applied correction events: ${formatNumber(summary.multimodal_adjusted?.applied_correction_event_count ?? 0)}`,
    `- Orphan correction events: ${formatNumber(summary.multimodal_adjusted?.orphan_correction_event_count ?? 0)}`,
    "",
    "Corrections:",
    `- Correction events: ${formatNumber(summary.corrections?.event_count ?? 0)}`,
    `- Corrected original events: ${formatNumber(summary.corrections?.corrected_original_event_count ?? 0)}`,
    `- Correction media items: ${formatNumber(summary.corrections?.media_item_count ?? 0)}`,
    "",
    "Palette split:",
    `- Events: ${formatNumber(summary.palette_split?.event_count ?? 0)}`,
    `- Quality events: ${formatNumber(summary.palette_split?.quality_event_count ?? 0)}`,
    `- Average quality score: ${summary.palette_split?.avg_quality_score ?? "n/a"}`,
    `- Resized masks: ${formatNumber(summary.palette_split?.resized_mask_count ?? 0)}`,
    "",
    "Recommendations:",
    recommendations,
    "",
  ].join("\n");
}
