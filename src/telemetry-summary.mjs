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

function successRate(item) {
  return item.event_count > 0 ? item.success_count / item.event_count : 0;
}

function buildRecommendations({ commands, counts, statusCounts, queue, usage }) {
  const recommendations = [];
  const artifactReview = commands.find((item) => item.command === "artifact-review");
  if (artifactReview?.success_count >= 5 && successRate(artifactReview) >= 0.8) {
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
  if (counts.total > 0 && usage.events_missing_usage / counts.total > 0.5) {
    recommendations.push({
      kind: "instrumentation",
      message: "Most events are missing usage metadata; validate Gemini client capture before drawing token-savings conclusions.",
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
    projects: createDimensionMap(),
    commands: createDimensionMap(),
    sources: createDimensionMap(),
    models: createDimensionMap(),
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
  updateDimension(accumulator.commands, event.command, status);
  updateDimension(accumulator.sources, event.source, status);
  updateDimension(accumulator.models, event.model, status);

  if (event.prompt) accumulator.rawContent.prompt_events += 1;
  if (event.response) accumulator.rawContent.response_events += 1;
  if (event.payload?.prompt_truncated) accumulator.rawContent.truncated_prompt_events += 1;
  if (event.payload?.response_truncated) accumulator.rawContent.truncated_response_events += 1;

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
  const topCommands = topDimension(accumulator.commands, "command", topLimit);
  const allCommands = topDimension(accumulator.commands, "command", accumulator.commands.size);
  const sources = topDimension(accumulator.sources, "source", topLimit);
  const models = topDimension(accumulator.models, "model", topLimit);
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
    top_projects: topProjects,
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
    "Recommendations:",
    recommendations,
    "",
  ].join("\n");
}
