import { readFile, readdir } from "node:fs/promises";
import { basename, relative, join, sep } from "node:path";
import { createHash } from "node:crypto";
import { normalizeTelemetryCommandAlias } from "./telemetry-command-normalization.mjs";
import { loadTelemetryConfigContext } from "./telemetry-config.mjs";
import { isValidationTelemetryEvent, safeTelemetryPurpose } from "./telemetry-purpose.mjs";
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

function zeroTelemetryPurpose() {
  return {
    event_count: 0,
    production_event_count: 0,
    validation_event_count: 0,
    product_adjusted_event_count: 0,
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

function zeroBackfill() {
  return {
    media_manifest_sources: [],
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

const DESIGN_SCORE_FIELDS = [
  ["overall_score", "avg_overall_score"],
  ["visual_hierarchy_score", "avg_visual_hierarchy_score"],
  ["clarity_score", "avg_clarity_score"],
  ["accessibility_score", "avg_accessibility_score"],
  ["consistency_score", "avg_consistency_score"],
  ["implementation_readiness_score", "avg_implementation_readiness_score"],
];

function zeroArtifactReviewQuality() {
  return {
    event_count: 0,
    success_count: 0,
    error_count: 0,
    scorecard_event_count: 0,
    scorecard_field_coverage: [],
    avg_overall_score: null,
    avg_visual_hierarchy_score: null,
    avg_clarity_score: null,
    avg_accessibility_score: null,
    avg_consistency_score: null,
    avg_implementation_readiness_score: null,
    top_commands: [],
  };
}

function zeroArtifactReviewDepths() {
  return {
    event_count: 0,
    known_depth_event_count: 0,
    top_depths: [],
    top_budget_cohorts: [],
  };
}

function createDesignScoreSums() {
  return Object.fromEntries(DESIGN_SCORE_FIELDS.map(([key]) => [key, { sum: 0, count: 0 }]));
}

function zeroContextLoop() {
  return {
    gate_event_count: 0,
    context_pack_reused_event_count: 0,
    auto_context_pack_event_count: 0,
    explicit_context_pack_event_count: 0,
    no_context_pack_event_count: 0,
    unknown_context_pack_mode_event_count: 0,
    has_fresh_input_count: 0,
    context_pack_preflight_warning_count: 0,
    smart_diff_event_count: 0,
    smart_diff_context_pack_bootstrapped_count: 0,
  };
}

function zeroLatency() {
  return {
    event_count: 0,
    p50_ms: null,
    p95_ms: null,
    p99_ms: null,
    max_ms: null,
    top_commands: [],
  };
}

function zeroLatencyStages() {
  return {
    stage_count: 0,
    top_stages: [],
  };
}

function zeroStructuredResponse() {
  return {
    event_count: 0,
    missing_json_envelope_count: 0,
    avg_response_text_bytes: null,
    max_response_text_bytes: null,
    top_finish_reasons: [],
    top_commands: [],
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

function nullableRatio(numerator, denominator, digits = 4) {
  if (denominator <= 0) return null;
  return Number((numerator / denominator).toFixed(digits));
}

function sanitizeDimension(value, fallback = "unknown") {
  const text = `${value ?? ""}`.replace(/[\0-\x1F\x7F]/g, " ").trim();
  const masked = maskLocalPaths(maskCredentialText(text || fallback));
  return masked.length > 120 ? `${masked.slice(0, 117)}...` : masked;
}

const LOCAL_PATH_PATTERN = /\bfile:\/\/\/(?:Users|home|tmp|var|private|Volumes)\/[^\s"',)]+|\/(?:Users|home|tmp|var|private|Volumes)\/[^\s"',)]+/g;

function maskLocalPaths(value) {
  return value.replace(LOCAL_PATH_PATTERN, "[PATH]");
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
  return normalizeTelemetryCommandAlias(sanitized.toLowerCase().replaceAll("_", "-"));
}

const SAFE_MULTIMODAL_COMMANDS = new Set([
  "artifact-review",
  "artifact-review-backfill",
  "palette-split",
]);

const BACKFILL_MANIFEST_SOURCES = new Set([
  "artifact_media_manifest",
  "artifact_sources",
  "none",
]);
const CONTEXT_PACK_MODES = new Set(["auto", "explicit", "none"]);
const FRESH_INPUT_MODES = new Set(["none", "stdin", "file", "diff", "smart-diff", "text", "mixed"]);
const ARTIFACT_REVIEW_DEPTHS = new Set(["quick", "standard"]);

function safeMultimodalCommand(value) {
  const command = canonicalCommand(value);
  return SAFE_MULTIMODAL_COMMANDS.has(command) ? command : "other";
}

function isBackfillCommand(value) {
  const command = canonicalCommand(value);
  return command === "artifact-review-backfill" || command === "artifact-review-backfill-correction";
}

function safeBackfillManifestSource(value) {
  const source = typeof value === "string" ? value.trim() : "";
  return BACKFILL_MANIFEST_SOURCES.has(source) ? source : "unknown";
}

function safeContextPackMode(value) {
  const mode = typeof value === "string" ? value.trim().toLowerCase() : "";
  return CONTEXT_PACK_MODES.has(mode) ? mode : "unknown";
}

function safeFreshInputMode(value) {
  const mode = typeof value === "string" ? value.trim().toLowerCase() : "";
  return FRESH_INPUT_MODES.has(mode) ? mode : "unknown";
}

function safeArtifactReviewDepth(value) {
  const depth = typeof value === "string" ? value.trim().toLowerCase() : "";
  return ARTIFACT_REVIEW_DEPTHS.has(depth) ? depth : "unknown";
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

function updateBackfillManifestSource(map, source, status, mediaItemCount) {
  const safeSource = safeBackfillManifestSource(source);
  const item = map.get(safeSource) ?? {
    key: safeSource,
    event_count: 0,
    media_item_count: 0,
    success_count: 0,
    error_count: 0,
    unknown_count: 0,
  };
  item.event_count += 1;
  item.media_item_count += mediaItemCount;
  if (status === "success") item.success_count += 1;
  else if (status === "error") item.error_count += 1;
  else item.unknown_count += 1;
  map.set(safeSource, item);
}

function topBackfillManifestSources(map, limit) {
  return [...map.values()]
    .sort((left, right) => (
      right.event_count - left.event_count
      || right.media_item_count - left.media_item_count
      || left.key.localeCompare(right.key)
    ))
    .slice(0, limit)
    .map((item) => ({
      media_manifest_source: item.key,
      event_count: item.event_count,
      media_item_count: item.media_item_count,
      success_count: item.success_count,
      error_count: item.error_count,
      unknown_count: item.unknown_count,
    }));
}

function updateSimpleCount(map, key) {
  const count = map.get(key) ?? 0;
  map.set(key, count + 1);
}

function topSimpleCounts(map, keyName, limit) {
  return [...map.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([key, count]) => ({
      [keyName]: key,
      event_count: count,
    }));
}

function safeStructuredResponseFinishReason(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9_.-]{1,64}$/.test(text) ? text : "unknown";
}

function createStructuredResponseAggregate() {
  return {
    event_count: 0,
    missing_json_envelope_count: 0,
    response_text_bytes_sum: 0,
    max_response_text_bytes: null,
    finishReasons: new Map(),
    commands: new Map(),
  };
}

function addStructuredResponseCommand(map, command, responseTextBytes, hasJsonEnvelope) {
  const key = canonicalCommand(command);
  const item = map.get(key) ?? {
    key,
    event_count: 0,
    missing_json_envelope_count: 0,
    response_text_bytes_sum: 0,
    max_response_text_bytes: null,
  };
  item.event_count += 1;
  if (!hasJsonEnvelope) item.missing_json_envelope_count += 1;
  item.response_text_bytes_sum += responseTextBytes;
  item.max_response_text_bytes = Math.max(item.max_response_text_bytes ?? 0, responseTextBytes);
  map.set(key, item);
}

function addStructuredResponse(aggregate, command, metadata) {
  const diagnostic = metadata?.structured_response;
  if (!diagnostic || typeof diagnostic !== "object" || Array.isArray(diagnostic)) return;
  const responseTextBytes = safeInteger(diagnostic.response_text_bytes);
  const hasJsonEnvelope = diagnostic.response_has_json_object_envelope === true;
  const finishReason = safeStructuredResponseFinishReason(diagnostic.gemini_finish_reason);
  aggregate.event_count += 1;
  if (!hasJsonEnvelope) aggregate.missing_json_envelope_count += 1;
  aggregate.response_text_bytes_sum += responseTextBytes;
  aggregate.max_response_text_bytes = Math.max(aggregate.max_response_text_bytes ?? 0, responseTextBytes);
  updateSimpleCount(aggregate.finishReasons, finishReason);
  addStructuredResponseCommand(aggregate.commands, command, responseTextBytes, hasJsonEnvelope);
}

function topStructuredResponseCommands(map, limit) {
  return [...map.values()]
    .sort((left, right) => (
      right.event_count - left.event_count
      || right.missing_json_envelope_count - left.missing_json_envelope_count
      || left.key.localeCompare(right.key)
    ))
    .slice(0, limit)
    .map((item) => ({
      command: item.key,
      event_count: item.event_count,
      missing_json_envelope_count: item.missing_json_envelope_count,
      avg_response_text_bytes: roundOne(item.response_text_bytes_sum / item.event_count),
      max_response_text_bytes: item.max_response_text_bytes,
    }));
}

function buildStructuredResponseSummary(aggregate, topLimit) {
  if (aggregate.event_count === 0) return zeroStructuredResponse();
  return {
    event_count: aggregate.event_count,
    missing_json_envelope_count: aggregate.missing_json_envelope_count,
    avg_response_text_bytes: roundOne(aggregate.response_text_bytes_sum / aggregate.event_count),
    max_response_text_bytes: aggregate.max_response_text_bytes,
    top_finish_reasons: topSimpleCounts(aggregate.finishReasons, "gemini_finish_reason", topLimit),
    top_commands: topStructuredResponseCommands(aggregate.commands, topLimit),
  };
}

function createLatencyAggregate() {
  return {
    values: [],
    commands: new Map(),
  };
}

function nearestRank(values, percentile) {
  if (values.length === 0) return null;
  const index = Math.min(
    values.length - 1,
    Math.max(0, Math.ceil(values.length * percentile) - 1),
  );
  return values[index];
}

function publicLatency(values) {
  if (values.length === 0) {
    return {
      event_count: 0,
      p50_ms: null,
      p95_ms: null,
      p99_ms: null,
      max_ms: null,
    };
  }
  const sorted = [...values].sort((left, right) => left - right);
  return {
    event_count: sorted.length,
    p50_ms: nearestRank(sorted, 0.5),
    p95_ms: nearestRank(sorted, 0.95),
    p99_ms: nearestRank(sorted, 0.99),
    max_ms: sorted.at(-1),
  };
}

function addLatency(aggregate, command, latencyMs) {
  if (!Number.isInteger(latencyMs) || latencyMs < 0) return;
  aggregate.values.push(latencyMs);
  const key = canonicalCommand(command);
  const item = aggregate.commands.get(key) ?? { key, values: [] };
  item.values.push(latencyMs);
  aggregate.commands.set(key, item);
}

function topLatencyCommands(map, limit) {
  return [...map.values()]
    .map((item) => ({
      command: item.key,
      ...publicLatency(item.values),
    }))
    .sort((left, right) => (
      right.p95_ms - left.p95_ms
      || right.event_count - left.event_count
      || left.command.localeCompare(right.command)
    ))
    .slice(0, limit);
}

function buildLatencySummary(aggregate, topLimit) {
  if (aggregate.values.length === 0) return zeroLatency();
  return {
    ...publicLatency(aggregate.values),
    top_commands: topLatencyCommands(aggregate.commands, topLimit),
  };
}

const SAFE_LATENCY_STAGE_NAME = /^[a-z][a-z0-9_]{0,63}$/;

function publicStageLatency(values) {
  const latency = publicLatency(values);
  return {
    event_count: latency.event_count,
    p50_ms: latency.p50_ms,
    p95_ms: latency.p95_ms,
    max_ms: latency.max_ms,
  };
}

function createLatencyStagesAggregate() {
  return {
    stageCount: 0,
    stages: new Map(),
  };
}

function safeLatencyStageValue(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeLatencyStageName(value) {
  return typeof value === "string" && SAFE_LATENCY_STAGE_NAME.test(value) ? value : null;
}

function addLatencyStage(aggregate, stage, command, latencyMs) {
  const item = aggregate.stages.get(stage) ?? createLatencyAggregate();
  item.values.push(latencyMs);
  const commandKey = canonicalCommand(command);
  const commandItem = item.commands.get(commandKey) ?? { key: commandKey, values: [] };
  commandItem.values.push(latencyMs);
  item.commands.set(commandKey, commandItem);
  aggregate.stages.set(stage, item);
  aggregate.stageCount += 1;
}

function addLatencyStages(aggregate, command, metadata) {
  const stages = metadata?.latency_stages_ms;
  if (!stages || typeof stages !== "object" || Array.isArray(stages)) return;
  for (const [rawStage, rawLatencyMs] of Object.entries(stages)) {
    const stage = safeLatencyStageName(rawStage);
    const latencyMs = safeLatencyStageValue(rawLatencyMs);
    if (!stage || latencyMs === null) continue;
    addLatencyStage(aggregate, stage, command, latencyMs);
  }
}

function topLatencyStageCommands(map, limit) {
  return [...map.values()]
    .map((item) => ({
      command: item.key,
      ...publicStageLatency(item.values),
    }))
    .sort((left, right) => (
      right.p95_ms - left.p95_ms
      || right.event_count - left.event_count
      || left.command.localeCompare(right.command)
    ))
    .slice(0, limit);
}

function buildLatencyStagesSummary(aggregate, topLimit) {
  if (aggregate.stageCount === 0) return zeroLatencyStages();
  const topStages = [...aggregate.stages.entries()]
    .map(([stage, item]) => ({
      stage,
      ...publicStageLatency(item.values),
      top_commands: topLatencyStageCommands(item.commands, topLimit),
    }))
    .sort((left, right) => (
      right.p95_ms - left.p95_ms
      || right.event_count - left.event_count
      || left.stage.localeCompare(right.stage)
    ))
    .slice(0, topLimit);
  return {
    stage_count: aggregate.stageCount,
    top_stages: topStages,
  };
}

function updateContextLoopCommand(
  map,
  command,
  contextPackMode,
  hasFreshInput,
  contextPackPreflightWarning,
  smartDiff,
  smartDiffContextPackBootstrapped,
) {
  const key = canonicalCommand(command);
  const item = map.get(key) ?? {
    key,
    ...zeroContextLoop(),
  };
  item.gate_event_count += 1;
  if (contextPackMode === "auto" || contextPackMode === "explicit") {
    item.context_pack_reused_event_count += 1;
  }
  if (contextPackMode === "auto") item.auto_context_pack_event_count += 1;
  else if (contextPackMode === "explicit") item.explicit_context_pack_event_count += 1;
  else if (contextPackMode === "none") item.no_context_pack_event_count += 1;
  else item.unknown_context_pack_mode_event_count += 1;
  if (hasFreshInput) item.has_fresh_input_count += 1;
  if (contextPackPreflightWarning) item.context_pack_preflight_warning_count += 1;
  if (smartDiff) item.smart_diff_event_count += 1;
  if (smartDiffContextPackBootstrapped) item.smart_diff_context_pack_bootstrapped_count += 1;
  map.set(key, item);
}

function topContextLoopCommands(map, limit) {
  return [...map.values()]
    .sort((left, right) => (
      right.gate_event_count - left.gate_event_count
      || right.context_pack_reused_event_count - left.context_pack_reused_event_count
      || left.key.localeCompare(right.key)
    ))
    .slice(0, limit)
    .map((item) => ({
      command: item.key,
      event_count: item.gate_event_count,
      context_pack_reused_event_count: item.context_pack_reused_event_count,
      auto_context_pack_event_count: item.auto_context_pack_event_count,
      explicit_context_pack_event_count: item.explicit_context_pack_event_count,
      no_context_pack_event_count: item.no_context_pack_event_count,
      unknown_context_pack_mode_event_count: item.unknown_context_pack_mode_event_count,
      has_fresh_input_count: item.has_fresh_input_count,
      context_pack_preflight_warning_count: item.context_pack_preflight_warning_count,
      smart_diff_event_count: item.smart_diff_event_count,
      smart_diff_context_pack_bootstrapped_count: item.smart_diff_context_pack_bootstrapped_count,
      smart_diff_context_pack_bootstrap_rate: nullableRatio(
        item.smart_diff_context_pack_bootstrapped_count,
        item.smart_diff_event_count,
      ),
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

function updateMediaCommand(map, command, items) {
  if (items.length === 0) return;
  const key = safeMultimodalCommand(command);
  const item = map.get(key) ?? {
    key,
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
  item.event_count += 1;
  for (const media of items) {
    item.item_count += 1;
    item.byte_count += media.byteSize;
    if (media.mimeType === "unknown") item.unknown_mime_items += 1;
    else item.media_items_with_mime += 1;
    if (!media.hasByteSize) item.unknown_byte_size_items += 1;
    else item.media_items_with_byte_size += 1;
    if (media.mediaKind === "unknown") item.unknown_kind_items += 1;
    else item.media_items_with_kind += 1;
  }
  map.set(key, item);
}

function topMediaCommands(map, limit) {
  return [...map.values()]
    .sort((left, right) => (
      right.item_count - left.item_count
      || right.event_count - left.event_count
      || left.key.localeCompare(right.key)
    ))
    .slice(0, limit)
    .map((item) => ({
      command: item.key,
      event_count: item.event_count,
      item_count: item.item_count,
      byte_count: item.byte_count,
      unknown_mime_items: item.unknown_mime_items,
      unknown_byte_size_items: item.unknown_byte_size_items,
      unknown_kind_items: item.unknown_kind_items,
      media_items_with_mime: item.media_items_with_mime,
      media_items_with_byte_size: item.media_items_with_byte_size,
      media_items_with_kind: item.media_items_with_kind,
    }));
}

function createMediaAggregate() {
  return {
    ...zeroMultimodal(),
    mediaMimes: createDimensionMap(),
    mediaKinds: createDimensionMap(),
    mediaCommands: createDimensionMap(),
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

function addCompactMediaItems(aggregate, items, command = null) {
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
  if (command !== null) updateMediaCommand(aggregate.mediaCommands, command, items);
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
    top_commands: topMediaCommands(aggregate.mediaCommands, topLimit),
  };
}

function mergeCorrectedMediaItems(originalItems, correctionItems) {
  if (correctionItems.length === 0) return originalItems;
  // Backfilled correction manifests preserve source order; merge by index so
  // partial corrections can fill only the fields they know without dropping
  // original media entries that had no corrected counterpart.
  const merged = correctionItems.map((correction, index) => {
    const original = originalItems[index];
    const hasByteSize = correction.hasByteSize || Boolean(original?.hasByteSize);
    return {
      mimeType: correction.mimeType !== "unknown"
        ? correction.mimeType
        : original?.mimeType ?? "unknown",
      mediaKind: correction.mediaKind !== "unknown"
        ? correction.mediaKind
        : original?.mediaKind ?? "unknown",
      byteSize: correction.hasByteSize
        ? correction.byteSize
        : original?.byteSize ?? 0,
      hasByteSize,
    };
  });
  if (originalItems.length > correctionItems.length) {
    merged.push(...originalItems.slice(correctionItems.length));
  }
  return merged;
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

function mediaKindCoverage(multimodal) {
  return multimodal.item_count > 0 ? multimodal.media_items_with_kind / multimodal.item_count : 0;
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

function artifactReviewQualityCommand(value) {
  const command = canonicalCommand(value);
  return command === "artifact-review" || command === "artifact-review-backfill" ? command : null;
}

function buildRecommendations({
  commands,
  counts,
  statusCounts,
  queue,
  usage,
  multimodal,
  multimodalAdjusted,
}) {
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
  const rawKindCoverage = mediaKindCoverage(multimodal);
  const adjustedKindCoverage = mediaKindCoverage(multimodalAdjusted ?? zeroAdjustedMultimodal());
  const recommendationItemCount = Math.max(
    multimodal.item_count,
    multimodalAdjusted?.item_count ?? 0,
  );
  if (recommendationItemCount >= 5 && rawKindCoverage < 0.5 && adjustedKindCoverage < 0.5) {
    recommendations.push({
      kind: "instrumentation",
      message: "Most multimodal metadata is missing media kind; classify screenshots, designs, documents, and images before making quality claims.",
    });
  } else if (
    recommendationItemCount >= 5
    && rawKindCoverage < 0.5
    && adjustedKindCoverage >= 0.5
    && adjustedKindCoverage - rawKindCoverage >= 0.25
  ) {
    recommendations.push({
      kind: "instrumentation",
      message: "Correction-aware multimodal coverage is materially better; keep correction-aware reporting and prioritize backfill operationalization.",
    });
  }
  return recommendations;
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatPercent(value) {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function formatTopRows(items, keyName) {
  if (items.length === 0) return "None";
  return items.map((item, index) => (
    `${index + 1}. ${item[keyName]}: ${item.event_count} events, ${item.success_count} success, ${item.error_count} error`
  )).join("\n");
}

function formatSimpleRows(items, keyName) {
  if (items.length === 0) return "None";
  return items.map((item, index) => (
    `${index + 1}. ${item[keyName]}: ${formatNumber(item.event_count)} events`
  )).join("\n");
}

function formatMediaCommandRows(items) {
  if (items.length === 0) return "None";
  return items.map((item, index) => (
    `${index + 1}. ${item.command}: ${formatNumber(item.event_count)} events, ${formatNumber(item.item_count)} media items, ${formatNumber(item.byte_count)} bytes`
  )).join("\n");
}

function formatLatencyCommandRows(items) {
  if (items.length === 0) return "None";
  return items.map((item, index) => (
    `${index + 1}. ${item.command}: ${formatNumber(item.event_count)} events, p50 ${formatNumber(item.p50_ms)} ms, p95 ${formatNumber(item.p95_ms)} ms, p99 ${formatNumber(item.p99_ms)} ms, max ${formatNumber(item.max_ms)} ms`
  )).join("\n");
}

function formatLatencyStageRows(items) {
  if (items.length === 0) return "None";
  return items.map((item, index) => (
    `${index + 1}. ${item.stage}: ${formatNumber(item.event_count)} events, p50 ${formatNumber(item.p50_ms)} ms, p95 ${formatNumber(item.p95_ms)} ms, max ${formatNumber(item.max_ms)} ms`
  )).join("\n");
}

function formatArtifactReviewDepthRows(items) {
  if (items.length === 0) return "None";
  return items.map((item, index) => (
    `${index + 1}. ${item.review_depth}: ${formatNumber(item.event_count)} events, ${formatNumber(item.success_count)} success, ${formatNumber(item.error_count)} error, p95 ${item.p95_latency_ms == null ? "n/a" : `${formatNumber(item.p95_latency_ms)} ms`}, total tokens ${formatNumber(item.total_tokens)}`
  )).join("\n");
}

function formatArtifactReviewBudgetCohortRows(items) {
  if (items.length === 0) return "None";
  return items.map((item, index) => (
    `${index + 1}. ${item.review_depth} / ${item.budget_cohort}: ${formatNumber(item.event_count)} events, ${formatNumber(item.success_count)} success, ${formatNumber(item.error_count)} error, p95 ${item.p95_latency_ms == null ? "n/a" : `${formatNumber(item.p95_latency_ms)} ms`}`
  )).join("\n");
}

function formatScorecardFieldCoverageRows(items) {
  if (items.length === 0) return "None";
  return items.map((item, index) => (
    `${index + 1}. ${item.field}: ${formatNumber(item.scored_event_count)} of ${formatNumber(item.event_count)} events (${formatPercent(item.coverage_rate)})`
  )).join("\n");
}

function formatBackfillManifestSourceRows(items) {
  if (items.length === 0) return "None";
  return items.map((item, index) => (
    `${index + 1}. ${item.media_manifest_source}: ${formatNumber(item.event_count)} events, ${formatNumber(item.media_item_count)} media items`
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
    backfillManifestSources: createDimensionMap(),
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
    artifactReviewQuality: {
      event_count: 0,
      success_count: 0,
      error_count: 0,
      scorecard_event_count: 0,
      scores: createDesignScoreSums(),
    },
    artifactReviewQualityCommands: new Map(),
    artifactReviewDepths: new Map(),
    artifactReviewBudgetCohorts: new Map(),
    contextLoop: zeroContextLoop(),
    contextPackModes: new Map(),
    freshInputModes: new Map(),
    contextLoopCommands: new Map(),
    latency: createLatencyAggregate(),
    latencyStages: createLatencyStagesAggregate(),
    structuredResponse: createStructuredResponseAggregate(),
    telemetryPurpose: zeroTelemetryPurpose(),
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
  const purpose = safeTelemetryPurpose(event?.metadata?.telemetry_purpose);
  const validation = isValidationTelemetryEvent(event);
  accumulator.telemetryPurpose.event_count += 1;
  if (purpose === "validation") {
    accumulator.telemetryPurpose.validation_event_count += 1;
  } else {
    accumulator.telemetryPurpose.production_event_count += 1;
    accumulator.telemetryPurpose.product_adjusted_event_count += 1;
  }
  updateStatusCounts(accumulator.statusCounts, status);
  updateDimension(accumulator.projects, event.project_id, status);
  updateOptionalDimension(accumulator.workspaces, event.context?.workspace_id, status);
  updateOptionalDimension(accumulator.userLabels, event.context?.user_label, status);
  updateCommandDimension(accumulator.commands, event.command, status);
  updateDimension(accumulator.sources, event.source, status);
  updateDimension(accumulator.models, event.model, status);
  if (!validation && isPaletteSplitEvent(event)) addPaletteSplitEvent(accumulator, event, status);
  if (!validation) {
    addArtifactReviewQualityEvent(accumulator, event, status);
    addArtifactReviewDepthEvent(accumulator, event, status);
  }
  addContextLoopEvent(accumulator, event);
  addLatency(accumulator.latency, event.command, event.latency_ms);
  addLatencyStages(accumulator.latencyStages, event.command, event.metadata);
  addStructuredResponse(accumulator.structuredResponse, event.command, event.metadata);

  if (event.prompt) accumulator.rawContent.prompt_events += 1;
  if (event.response) accumulator.rawContent.response_events += 1;
  if (event.payload?.prompt_truncated) accumulator.rawContent.truncated_prompt_events += 1;
  if (event.payload?.response_truncated) accumulator.rawContent.truncated_response_events += 1;

  const multimodalItems = Array.isArray(event.payload?.multimodal)
    ? event.payload.multimodal
    : [];
  if (!validation && isBackfillCommand(event.command)) {
    updateBackfillManifestSource(
      accumulator.backfillManifestSources,
      event.metadata?.media_manifest_source,
      status,
      multimodalItems.length,
    );
  }
  const compactItems = compactMediaItems(multimodalItems);
  if (validation) {
    return;
  }
  if (isCorrectionEvent(event)) {
    addCorrectionEvent(accumulator, event, multimodalItems);
    addAdjustedCorrectionCandidate(accumulator, event, compactItems);
  } else {
    if (typeof event.event_id === "string" && event.event_id.trim()) {
      accumulator.existingEventIds.add(event.event_id);
      accumulator.adjustedOriginals.set(event.event_id, {
        command: event.command,
        mediaItems: compactItems,
      });
    }
    addCompactMediaItems(accumulator.rawMedia, compactItems, event.command);
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

function safeDesignScore(value) {
  return Number.isInteger(value) && value >= 0 && value <= 100 ? value : null;
}

function designScorecardFromMetadata(metadata) {
  const scorecard = metadata?.design_scorecard;
  if (!scorecard || typeof scorecard !== "object" || Array.isArray(scorecard)) return null;
  const scores = {};
  let hasScore = false;
  for (const [key] of DESIGN_SCORE_FIELDS) {
    const score = safeDesignScore(scorecard[key]);
    scores[key] = score;
    if (score !== null) hasScore = true;
  }
  return hasScore ? scores : null;
}

function addDesignScores(target, scores) {
  if (!scores) return;
  for (const [key] of DESIGN_SCORE_FIELDS) {
    const score = scores[key];
    if (score === null) continue;
    target[key].sum += score;
    target[key].count += 1;
  }
}

function updateArtifactReviewQualityCommand(map, command, status, scores) {
  const item = map.get(command) ?? {
    key: command,
    event_count: 0,
    success_count: 0,
    error_count: 0,
    unknown_count: 0,
    scorecard_event_count: 0,
    scores: createDesignScoreSums(),
  };
  item.event_count += 1;
  if (status === "success") item.success_count += 1;
  else if (status === "error") item.error_count += 1;
  else item.unknown_count += 1;
  if (scores) {
    item.scorecard_event_count += 1;
    addDesignScores(item.scores, scores);
  }
  map.set(command, item);
}

const MAX_SAFE_ARTIFACT_REVIEW_OUTPUT_TOKENS = 100_000;

function safeMaxOutputTokens(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_SAFE_ARTIFACT_REVIEW_OUTPUT_TOKENS
    ? value
    : null;
}

function createArtifactReviewDepthItem(depth) {
  return {
    key: depth,
    event_count: 0,
    success_count: 0,
    error_count: 0,
    unknown_count: 0,
    scorecard_event_count: 0,
    scores: createDesignScoreSums(),
    latencyValues: [],
    usage: zeroUsage(),
    maxOutputTokenSum: 0,
    maxOutputTokenCount: 0,
  };
}

function createArtifactReviewBudgetCohortItem(depth, budgetCohort, maxOutputTokens) {
  return {
    key: `${depth}\0${budgetCohort}`,
    depth,
    budgetCohort,
    maxOutputTokens,
    event_count: 0,
    success_count: 0,
    error_count: 0,
    unknown_count: 0,
    scorecard_event_count: 0,
    scores: createDesignScoreSums(),
    latencyValues: [],
    usage: zeroUsage(),
  };
}

function artifactReviewBudgetCohort(depth, maxOutputTokens) {
  if (maxOutputTokens !== null) {
    return {
      budgetCohort: `${maxOutputTokens}`,
      publicMaxOutputTokens: maxOutputTokens,
    };
  }
  return {
    budgetCohort: depth === "standard" ? "unbounded" : "unknown",
    publicMaxOutputTokens: null,
  };
}

function addUsageToAggregate(usage, economics) {
  const inputTokens = economics?.input_tokens;
  const outputTokens = economics?.output_tokens;
  const totalTokens = economics?.total_tokens;
  if (inputTokens == null && outputTokens == null && totalTokens == null) {
    usage.events_missing_usage += 1;
    return;
  }
  usage.prompt_tokens += safeInteger(inputTokens);
  usage.response_tokens += safeInteger(outputTokens);
  usage.total_tokens += safeInteger(totalTokens);
}

function addArtifactReviewDepthEvent(accumulator, event, status) {
  const command = artifactReviewQualityCommand(event.command);
  if (!command) return;
  const depth = safeArtifactReviewDepth(event.metadata?.artifact_review_depth);
  const maxOutputTokens = safeMaxOutputTokens(event.metadata?.artifact_review_max_output_tokens);
  const item = accumulator.artifactReviewDepths.get(depth) ?? createArtifactReviewDepthItem(depth);
  item.event_count += 1;
  if (status === "success") item.success_count += 1;
  else if (status === "error") item.error_count += 1;
  else item.unknown_count += 1;

  const scores = designScorecardFromMetadata(event.metadata);
  if (scores) {
    item.scorecard_event_count += 1;
    addDesignScores(item.scores, scores);
  }
  if (Number.isInteger(event.latency_ms) && event.latency_ms >= 0) {
    item.latencyValues.push(event.latency_ms);
  }
  addUsageToAggregate(item.usage, event.economics);

  if (maxOutputTokens !== null) {
    item.maxOutputTokenSum += maxOutputTokens;
    item.maxOutputTokenCount += 1;
  }
  accumulator.artifactReviewDepths.set(depth, item);

  const cohort = artifactReviewBudgetCohort(depth, maxOutputTokens);
  const cohortKey = `${depth}\0${cohort.budgetCohort}`;
  const cohortItem = accumulator.artifactReviewBudgetCohorts.get(cohortKey)
    ?? createArtifactReviewBudgetCohortItem(depth, cohort.budgetCohort, cohort.publicMaxOutputTokens);
  cohortItem.event_count += 1;
  if (status === "success") cohortItem.success_count += 1;
  else if (status === "error") cohortItem.error_count += 1;
  else cohortItem.unknown_count += 1;
  if (scores) {
    cohortItem.scorecard_event_count += 1;
    addDesignScores(cohortItem.scores, scores);
  }
  if (Number.isInteger(event.latency_ms) && event.latency_ms >= 0) {
    cohortItem.latencyValues.push(event.latency_ms);
  }
  addUsageToAggregate(cohortItem.usage, event.economics);
  accumulator.artifactReviewBudgetCohorts.set(cohortKey, cohortItem);
}

function addArtifactReviewQualityEvent(accumulator, event, status) {
  const command = artifactReviewQualityCommand(event.command);
  if (!command) return;
  accumulator.artifactReviewQuality.event_count += 1;
  if (status === "success") accumulator.artifactReviewQuality.success_count += 1;
  else if (status === "error") accumulator.artifactReviewQuality.error_count += 1;

  const scores = designScorecardFromMetadata(event.metadata);
  if (scores) {
    accumulator.artifactReviewQuality.scorecard_event_count += 1;
    addDesignScores(accumulator.artifactReviewQuality.scores, scores);
  }
  updateArtifactReviewQualityCommand(
    accumulator.artifactReviewQualityCommands,
    command,
    status,
    scores,
  );
}

function addContextLoopEvent(accumulator, event) {
  if (!event.metadata?.gate) return;
  const contextPackMode = safeContextPackMode(event.metadata?.context_pack_mode);
  const freshInputMode = safeFreshInputMode(event.metadata?.fresh_input_mode);
  const hasFreshInput = event.metadata?.has_fresh_input === true
    || !["none", "unknown"].includes(freshInputMode);
  const contextPackPreflightWarning = event.metadata?.context_pack_preflight_warning === true;
  const smartDiff = freshInputMode === "smart-diff" || event.metadata?.smart_diff_shortcut === true;
  const smartDiffContextPackBootstrapped = smartDiff
    && event.metadata?.smart_diff_context_pack_bootstrapped === true;

  accumulator.contextLoop.gate_event_count += 1;
  if (contextPackMode === "auto" || contextPackMode === "explicit") {
    accumulator.contextLoop.context_pack_reused_event_count += 1;
  }
  if (contextPackMode === "auto") accumulator.contextLoop.auto_context_pack_event_count += 1;
  else if (contextPackMode === "explicit") accumulator.contextLoop.explicit_context_pack_event_count += 1;
  else if (contextPackMode === "none") accumulator.contextLoop.no_context_pack_event_count += 1;
  else accumulator.contextLoop.unknown_context_pack_mode_event_count += 1;
  if (hasFreshInput) accumulator.contextLoop.has_fresh_input_count += 1;
  if (contextPackPreflightWarning) accumulator.contextLoop.context_pack_preflight_warning_count += 1;
  if (smartDiff) accumulator.contextLoop.smart_diff_event_count += 1;
  if (smartDiffContextPackBootstrapped) {
    accumulator.contextLoop.smart_diff_context_pack_bootstrapped_count += 1;
  }

  updateSimpleCount(accumulator.contextPackModes, contextPackMode);
  updateSimpleCount(accumulator.freshInputModes, freshInputMode);
  updateContextLoopCommand(
    accumulator.contextLoopCommands,
    event.command,
    contextPackMode,
    hasFreshInput,
    contextPackPreflightWarning,
    smartDiff,
    smartDiffContextPackBootstrapped,
  );
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

const MEDIA_CORRECTION_VERSION_PATTERN = /^media-v(\d+)$/;

function semanticCorrectionNumber(version) {
  const match = MEDIA_CORRECTION_VERSION_PATTERN.exec(version);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function validTimestampMs(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY;
}

function compareCorrectionCandidates(left, right) {
  const leftSemantic = semanticCorrectionNumber(left.version);
  const rightSemantic = semanticCorrectionNumber(right.version);
  if (leftSemantic !== null && rightSemantic !== null && leftSemantic !== rightSemantic) {
    return leftSemantic - rightSemantic;
  }
  if ((leftSemantic === null || rightSemantic === null) && left.version !== right.version) {
    return left.version.localeCompare(right.version);
  }
  const leftTime = validTimestampMs(left.createdAt);
  const rightTime = validTimestampMs(right.createdAt);
  if (leftTime !== rightTime) return leftTime - rightTime;
  return left.sequence - right.sequence;
}

function bestCorrectionCandidate(candidates) {
  return candidates.reduce((best, candidate) => (
    compareCorrectionCandidates(best, candidate) >= 0 ? best : candidate
  ));
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

    const applied = bestCorrectionCandidate(candidates);
    const original = accumulator.adjustedOriginals.get(target) ?? { command: null, mediaItems: [] };
    const originalItems = original.mediaItems;
    const adjustedMediaItems = mergeCorrectedMediaItems(originalItems, applied.mediaItems);
    appliedOriginals.add(target);
    appliedCorrectionEventCount += 1;
    supersededCorrectionEventCount += Math.max(0, candidates.length - 1);
    addCompactMediaItems(aggregate, adjustedMediaItems, original.command);

    const item = appliedVersions.get(applied.version) ?? {
      key: applied.version,
      event_count: 0,
      media_item_count: 0,
      media_byte_count: 0,
      correctedOriginalIds: new Set(),
    };
    item.event_count += 1;
    item.media_item_count += adjustedMediaItems.length;
    item.media_byte_count += adjustedMediaItems.reduce(
      (total, media) => total + media.byteSize,
      0,
    );
    item.correctedOriginalIds.add(target);
    appliedVersions.set(applied.version, item);
  }

  for (const [eventId, original] of accumulator.adjustedOriginals.entries()) {
    if (!appliedOriginals.has(eventId)) {
      addCompactMediaItems(aggregate, original.mediaItems, original.command);
    }
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

function averageDesignScore(scores, key) {
  const item = scores[key];
  return item.count > 0 ? roundOne(item.sum / item.count) : null;
}

function artifactReviewQualityCommandRows(map, topLimit) {
  return [...map.values()]
    .sort((left, right) => (
      right.event_count - left.event_count
      || right.scorecard_event_count - left.scorecard_event_count
      || left.key.localeCompare(right.key)
    ))
    .slice(0, topLimit)
    .map((item) => ({
      command: item.key,
      event_count: item.event_count,
      success_count: item.success_count,
      error_count: item.error_count,
      unknown_count: item.unknown_count,
      scorecard_event_count: item.scorecard_event_count,
      avg_overall_score: averageDesignScore(item.scores, "overall_score"),
    }));
}

function scorecardFieldCoverageRows(scores, eventCount) {
  if (eventCount <= 0) return [];
  return DESIGN_SCORE_FIELDS.map(([key]) => ({
    field: key,
    scored_event_count: scores[key].count,
    event_count: eventCount,
    coverage_rate: nullableRatio(scores[key].count, eventCount, 4),
  }));
}

function buildArtifactReviewQualitySummary(accumulator, topLimit) {
  if (accumulator.artifactReviewQuality.event_count === 0) return zeroArtifactReviewQuality();
  return {
    event_count: accumulator.artifactReviewQuality.event_count,
    success_count: accumulator.artifactReviewQuality.success_count,
    error_count: accumulator.artifactReviewQuality.error_count,
    scorecard_event_count: accumulator.artifactReviewQuality.scorecard_event_count,
    scorecard_field_coverage: scorecardFieldCoverageRows(
      accumulator.artifactReviewQuality.scores,
      accumulator.artifactReviewQuality.event_count,
    ),
    ...Object.fromEntries(DESIGN_SCORE_FIELDS.map(([key, avgKey]) => [
      avgKey,
      averageDesignScore(accumulator.artifactReviewQuality.scores, key),
    ])),
    top_commands: artifactReviewQualityCommandRows(accumulator.artifactReviewQualityCommands, topLimit),
  };
}

function artifactReviewDepthRows(map, topLimit) {
  return [...map.values()]
    .sort((left, right) => (
      right.event_count - left.event_count
      || left.key.localeCompare(right.key)
    ))
    .slice(0, topLimit)
    .map((item) => {
      const latency = publicLatency(item.latencyValues);
      return {
        review_depth: item.key,
        event_count: item.event_count,
        success_count: item.success_count,
        error_count: item.error_count,
        unknown_count: item.unknown_count,
        scorecard_event_count: item.scorecard_event_count,
        avg_overall_score: averageDesignScore(item.scores, "overall_score"),
        avg_implementation_readiness_score: averageDesignScore(item.scores, "implementation_readiness_score"),
        p50_latency_ms: latency.p50_ms,
        p95_latency_ms: latency.p95_ms,
        max_latency_ms: latency.max_ms,
        prompt_tokens: item.usage.prompt_tokens,
        response_tokens: item.usage.response_tokens,
        total_tokens: item.usage.total_tokens,
        events_missing_usage: item.usage.events_missing_usage,
        avg_max_output_tokens: item.maxOutputTokenCount > 0
          ? roundOne(item.maxOutputTokenSum / item.maxOutputTokenCount)
          : null,
      };
    });
}

const ARTIFACT_REVIEW_DEPTH_ORDER = new Map([
  ["quick", 0],
  ["standard", 1],
  ["unknown", 2],
]);

function artifactReviewDepthRank(depth) {
  return ARTIFACT_REVIEW_DEPTH_ORDER.get(depth) ?? 3;
}

function artifactReviewBudgetRank(item) {
  if (item.maxOutputTokens !== null) return 0;
  if (item.budgetCohort === "unbounded") return 1;
  return 2;
}

function compareArtifactReviewBudgetCohorts(left, right) {
  return (
    right.event_count - left.event_count
    || artifactReviewDepthRank(left.depth) - artifactReviewDepthRank(right.depth)
    || artifactReviewBudgetRank(left) - artifactReviewBudgetRank(right)
    || (right.maxOutputTokens ?? -1) - (left.maxOutputTokens ?? -1)
    || left.budgetCohort.localeCompare(right.budgetCohort)
  );
}

function artifactReviewBudgetCohortRows(map, topLimit) {
  return [...map.values()]
    .sort(compareArtifactReviewBudgetCohorts)
    .slice(0, topLimit)
    .map((item) => {
      const latency = publicLatency(item.latencyValues);
      return {
        review_depth: item.depth,
        budget_cohort: item.budgetCohort,
        max_output_tokens: item.maxOutputTokens,
        event_count: item.event_count,
        success_count: item.success_count,
        error_count: item.error_count,
        unknown_count: item.unknown_count,
        scorecard_event_count: item.scorecard_event_count,
        avg_overall_score: averageDesignScore(item.scores, "overall_score"),
        avg_implementation_readiness_score: averageDesignScore(item.scores, "implementation_readiness_score"),
        p50_latency_ms: latency.p50_ms,
        p95_latency_ms: latency.p95_ms,
        max_latency_ms: latency.max_ms,
        prompt_tokens: item.usage.prompt_tokens,
        response_tokens: item.usage.response_tokens,
        total_tokens: item.usage.total_tokens,
        events_missing_usage: item.usage.events_missing_usage,
      };
    });
}

function buildArtifactReviewDepthSummary(accumulator, topLimit) {
  if (accumulator.artifactReviewDepths.size === 0) return zeroArtifactReviewDepths();
  const rows = [...accumulator.artifactReviewDepths.values()];
  return {
    event_count: rows.reduce((total, item) => total + item.event_count, 0),
    known_depth_event_count: rows
      .filter((item) => item.key !== "unknown")
      .reduce((total, item) => total + item.event_count, 0),
    top_depths: artifactReviewDepthRows(accumulator.artifactReviewDepths, topLimit),
    top_budget_cohorts: artifactReviewBudgetCohortRows(accumulator.artifactReviewBudgetCohorts, topLimit),
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
  const backfill = {
    ...zeroBackfill(),
    media_manifest_sources: topBackfillManifestSources(accumulator.backfillManifestSources, topLimit),
  };
  const paletteSplit = buildPaletteSplitSummary(accumulator, topLimit);
  const artifactReviewQuality = buildArtifactReviewQualitySummary(accumulator, topLimit);
  const artifactReviewDepths = buildArtifactReviewDepthSummary(accumulator, topLimit);
  const latency = buildLatencySummary(accumulator.latency, topLimit);
  const latencyStages = buildLatencyStagesSummary(accumulator.latencyStages, topLimit);
  const structuredResponse = buildStructuredResponseSummary(accumulator.structuredResponse, topLimit);
  const contextLoop = {
    ...accumulator.contextLoop,
    smart_diff_context_pack_bootstrap_rate: nullableRatio(
      accumulator.contextLoop.smart_diff_context_pack_bootstrapped_count,
      accumulator.contextLoop.smart_diff_event_count,
    ),
    top_context_pack_modes: topSimpleCounts(accumulator.contextPackModes, "context_pack_mode", topLimit),
    top_fresh_input_modes: topSimpleCounts(accumulator.freshInputModes, "fresh_input_mode", topLimit),
    top_gate_commands: topContextLoopCommands(accumulator.contextLoopCommands, topLimit),
  };
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
    telemetry_purpose: accumulator.telemetryPurpose,
    status_counts: accumulator.statusCounts,
    queue,
    usage: accumulator.usage,
    multimodal,
    multimodal_adjusted: multimodalAdjusted,
    corrections,
    backfill,
    palette_split: paletteSplit,
    artifact_review_quality: artifactReviewQuality,
    artifact_review_depths: artifactReviewDepths,
    latency,
    latency_stages: latencyStages,
    structured_response: structuredResponse,
    context_loop: contextLoop,
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
      multimodalAdjusted,
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
    "Telemetry purpose:",
    `- Product-adjusted events: ${formatNumber(summary.telemetry_purpose?.product_adjusted_event_count ?? summary.event_counts.total)} of ${formatNumber(summary.telemetry_purpose?.event_count ?? summary.event_counts.total)}`,
    `- Validation events excluded from product metrics: ${formatNumber(summary.telemetry_purpose?.validation_event_count ?? 0)}`,
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
    "Latency:",
    `- Events: ${formatNumber(summary.latency?.event_count ?? 0)}`,
    `- p50: ${summary.latency?.p50_ms == null ? "n/a" : `${formatNumber(summary.latency.p50_ms)} ms`}`,
    `- p95: ${summary.latency?.p95_ms == null ? "n/a" : `${formatNumber(summary.latency.p95_ms)} ms`}`,
    `- p99: ${summary.latency?.p99_ms == null ? "n/a" : `${formatNumber(summary.latency.p99_ms)} ms`}`,
    `- Max: ${summary.latency?.max_ms == null ? "n/a" : `${formatNumber(summary.latency.max_ms)} ms`}`,
    "Top latency commands:",
    formatLatencyCommandRows(summary.latency?.top_commands ?? []),
    "",
    "Latency stages:",
    `- Stage samples: ${formatNumber(summary.latency_stages?.stage_count ?? 0)}`,
    "Top latency stages:",
    formatLatencyStageRows(summary.latency_stages?.top_stages ?? []),
    "",
    "Structured responses:",
    `- Events: ${formatNumber(summary.structured_response?.event_count ?? 0)}`,
    `- Missing JSON envelope: ${formatNumber(summary.structured_response?.missing_json_envelope_count ?? 0)}`,
    `- Average response bytes: ${summary.structured_response?.avg_response_text_bytes == null ? "n/a" : formatNumber(summary.structured_response.avg_response_text_bytes)}`,
    `- Max response bytes: ${summary.structured_response?.max_response_text_bytes == null ? "n/a" : formatNumber(summary.structured_response.max_response_text_bytes)}`,
    "Top structured response finish reasons:",
    formatSimpleRows(summary.structured_response?.top_finish_reasons ?? [], "gemini_finish_reason"),
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
    "Top multimodal commands:",
    formatMediaCommandRows(summary.multimodal?.top_commands ?? []),
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
    "Top adjusted multimodal commands:",
    formatMediaCommandRows(summary.multimodal_adjusted?.top_commands ?? []),
    "",
    "Corrections:",
    `- Correction events: ${formatNumber(summary.corrections?.event_count ?? 0)}`,
    `- Corrected original events: ${formatNumber(summary.corrections?.corrected_original_event_count ?? 0)}`,
    `- Correction media items: ${formatNumber(summary.corrections?.media_item_count ?? 0)}`,
    "Backfill media manifest sources:",
    formatBackfillManifestSourceRows(summary.backfill?.media_manifest_sources ?? []),
    "",
    "Palette split:",
    `- Events: ${formatNumber(summary.palette_split?.event_count ?? 0)}`,
    `- Quality events: ${formatNumber(summary.palette_split?.quality_event_count ?? 0)}`,
    `- Average quality score: ${summary.palette_split?.avg_quality_score ?? "n/a"}`,
    `- Resized masks: ${formatNumber(summary.palette_split?.resized_mask_count ?? 0)}`,
    "",
    "Artifact review quality:",
    `- Events: ${formatNumber(summary.artifact_review_quality?.event_count ?? 0)}`,
    `- Scorecard events: ${formatNumber(summary.artifact_review_quality?.scorecard_event_count ?? 0)}`,
    `- Average overall score: ${summary.artifact_review_quality?.avg_overall_score ?? "n/a"}`,
    `- Average implementation readiness score: ${summary.artifact_review_quality?.avg_implementation_readiness_score ?? "n/a"}`,
    "Scorecard field coverage:",
    formatScorecardFieldCoverageRows(summary.artifact_review_quality?.scorecard_field_coverage ?? []),
    "",
    "Artifact review depths:",
    `- Events: ${formatNumber(summary.artifact_review_depths?.event_count ?? 0)}`,
    `- Known depth events: ${formatNumber(summary.artifact_review_depths?.known_depth_event_count ?? 0)}`,
    "Top review depths:",
    formatArtifactReviewDepthRows(summary.artifact_review_depths?.top_depths ?? []),
    "Artifact review budget cohorts:",
    formatArtifactReviewBudgetCohortRows(summary.artifact_review_depths?.top_budget_cohorts ?? []),
    "",
    "Context loop:",
    `- Gate events: ${formatNumber(summary.context_loop?.gate_event_count ?? 0)}`,
    `- Context-pack reused events: ${formatNumber(summary.context_loop?.context_pack_reused_event_count ?? 0)}`,
    `- Auto context-pack events: ${formatNumber(summary.context_loop?.auto_context_pack_event_count ?? 0)}`,
    `- Explicit context-pack events: ${formatNumber(summary.context_loop?.explicit_context_pack_event_count ?? 0)}`,
    `- No context-pack events: ${formatNumber(summary.context_loop?.no_context_pack_event_count ?? 0)}`,
    `- Unknown context-pack mode events: ${formatNumber(summary.context_loop?.unknown_context_pack_mode_event_count ?? 0)}`,
    `- Fresh input events: ${formatNumber(summary.context_loop?.has_fresh_input_count ?? 0)}`,
    `- Context-pack preflight warnings: ${formatNumber(summary.context_loop?.context_pack_preflight_warning_count ?? 0)}`,
    `- Smart-diff events: ${formatNumber(summary.context_loop?.smart_diff_event_count ?? 0)}`,
    `- Smart-diff auto-bootstrap events: ${formatNumber(summary.context_loop?.smart_diff_context_pack_bootstrapped_count ?? 0)}`,
    `- Smart-diff auto-bootstrap rate: ${formatPercent(summary.context_loop?.smart_diff_context_pack_bootstrap_rate ?? null)}`,
    "",
    "Recommendations:",
    recommendations,
    "",
  ].join("\n");
}
