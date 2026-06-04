import { readFile, readdir } from "node:fs/promises";
import { basename, relative, join, sep } from "node:path";
import { loadTelemetryConfigContext } from "./telemetry-config.mjs";
import { maskCredentialText, normalizeTelemetryEvent } from "./telemetry-schemas.mjs";
import {
  loadTelemetryState,
  telemetryQueueDirs,
} from "./telemetry-queue.mjs";

const QUEUE_STATES = ["pending", "inflight", "sent", "failed", "quarantine"];

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

function safeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function sanitizeDimension(value, fallback = "unknown") {
  const text = `${value ?? ""}`.replace(/[\0-\x1F\x7F]/g, " ").trim();
  const masked = maskCredentialText(text || fallback);
  return masked.length > 120 ? `${masked.slice(0, 117)}...` : masked;
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

function createAccumulator(invalidSampleLimit) {
  return {
    invalidSampleLimit,
    counts: zeroCounts(),
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
    accumulator.invalidSamples.push(relativeSamplePath(root, path));
  }
}

function addEvent(accumulator, state, event) {
  accumulator.counts[state] += 1;
  accumulator.counts.total += 1;
  const status = event.status === "success" || event.status === "error" ? event.status : "unknown";
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

  const state = await loadTelemetryState({ cwd: context.storageCwd });

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

  return {
    scope: context.scope,
    storage_cwd: context.storageCwd,
    generated_at: now.toISOString(),
    event_counts: accumulator.counts,
    queue: {
      queue_bytes: state.queue_bytes,
      dropped_old_count: state.dropped_old_count,
      dropped_memory_count: state.dropped_memory_count,
      sent_success_count: state.sent_success_count,
      sent_failure_count: state.sent_failure_count,
      non_retryable_failure_count: state.non_retryable_failure_count,
      last_failure_reason: state.last_failure_reason,
      last_sent_at: state.last_sent_at,
    },
    usage: accumulator.usage,
    top_projects: topDimension(accumulator.projects, "project_id", topLimit),
    top_commands: topDimension(accumulator.commands, "command", topLimit),
    sources: topDimension(accumulator.sources, "source", topLimit),
    models: topDimension(accumulator.models, "model", topLimit),
    raw_content: accumulator.rawContent,
    invalid_events: {
      count: accumulator.counts.invalid,
      samples: accumulator.invalidSamples,
    },
    recommendations: [],
    limitations: [
      "Local summary only includes telemetry files available on this machine.",
      "Codex token savings are estimated from Gemini prompt token usage, not measured from Codex billing.",
    ],
  };
}
