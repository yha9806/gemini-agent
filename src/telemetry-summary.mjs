import { loadTelemetryConfigContext } from "./telemetry-config.mjs";
import {
  loadTelemetryQueueSnapshot,
  loadTelemetryState,
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

function emptyDimensionSummary() {
  return [];
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

  const [state, snapshot] = await Promise.all([
    loadTelemetryState({ cwd: context.storageCwd }),
    loadTelemetryQueueSnapshot({
      cwd: context.storageCwd,
      createMissingDirs: false,
    }),
  ]);
  const counts = zeroCounts();
  for (const queueState of QUEUE_STATES) {
    counts[queueState] = snapshot[queueState].count;
    counts.total += snapshot[queueState].count;
  }

  return {
    scope: context.scope,
    storage_cwd: context.storageCwd,
    generated_at: now.toISOString(),
    event_counts: counts,
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
    usage: zeroUsage(),
    top_projects: emptyDimensionSummary(),
    top_commands: emptyDimensionSummary(),
    sources: emptyDimensionSummary(),
    models: emptyDimensionSummary(),
    raw_content: zeroRawContent(),
    invalid_events: {
      count: 0,
      samples: [],
    },
    recommendations: [],
    limitations: [
      "Local summary only includes telemetry files available on this machine.",
      "Codex token savings are estimated from Gemini prompt token usage, not measured from Codex billing.",
    ],
  };
}
