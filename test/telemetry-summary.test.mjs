import assert from "node:assert/strict";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { saveTelemetryConfig } from "../src/telemetry-config.mjs";
import {
  appendTelemetryEvent,
  claimTelemetryBatch,
  completeTelemetryBatch,
  failTelemetryBatch,
  quarantineTelemetryEvent,
} from "../src/telemetry-queue.mjs";
import { runTelemetrySummary } from "../src/telemetry-summary.mjs";

const TOKEN_ENV = "GEMINI_AGENT_TELEMETRY_TOKEN";

async function temporaryWorkspace() {
  return mkdtemp(join(tmpdir(), "gemini-agent-telemetry-summary-"));
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function telemetryEvent(index, overrides = {}) {
  const suffix = `${index}`.padStart(6, "0");
  return {
    schema_version: 1,
    event_id: `evt_${suffix}`,
    trace_id: `trace_${suffix}`,
    deployment_id: "dep_test",
    project_id: "gemini-agent",
    source: "cli",
    command: "ask",
    model: "gemini-3.5-flash",
    prompt: `prompt ${suffix}`,
    response: `response ${suffix}`,
    status: "success",
    error_type: null,
    latency_ms: index,
    created_at: "2026-06-04T09:00:00.000Z",
    payload: { prompt_truncated: false, response_truncated: false, multimodal: [] },
    context: {
      cwd: null,
      session_id: null,
      run_id: null,
      task_id: null,
      parent_codex_session: null,
    },
    outcome: {
      task_outcome: "unknown",
      user_acceptance: "unknown",
      accepted_files: [],
      modified_after_review: null,
      followup_required: null,
    },
    economics: {
      codex_tokens_saved_estimate: null,
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      latency_bucket: null,
      cost_bucket: null,
    },
    ...overrides,
  };
}

test("runTelemetrySummary rejects when telemetry is not enabled", async () => {
  const cwd = await temporaryWorkspace();

  await assert.rejects(
    runTelemetrySummary({ cwd, scope: "local" }),
    /Telemetry is not enabled/,
  );
});

test("runTelemetrySummary returns a zero summary for an enabled empty queue without creating queue dirs", async () => {
  const cwd = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });

  const result = await runTelemetrySummary({
    cwd,
    scope: "local",
    now: new Date("2026-06-04T10:00:00.000Z"),
  });

  assert.equal(result.scope, "local");
  assert.equal(result.storage_cwd, cwd);
  assert.equal(result.generated_at, "2026-06-04T10:00:00.000Z");
  assert.deepEqual(result.event_counts, {
    total: 0,
    pending: 0,
    inflight: 0,
    sent: 0,
    failed: 0,
    quarantine: 0,
    invalid: 0,
  });
  assert.equal(result.usage.total_tokens, 0);
  assert.equal(result.raw_content.prompt_events, 0);
  assert.deepEqual(result.top_projects, []);
  assert.deepEqual(result.top_commands, []);
  assert.equal(await pathExists(join(cwd, ".gemini-agent/telemetry/queue")), false);
});

test("runTelemetrySummary aggregates pending sent failed quarantine dimensions and usage", async () => {
  const cwd = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });

  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(1, {
      project_id: "vulca-platform",
      command: "artifact-review",
      economics: {
        input_tokens: 100,
        output_tokens: 25,
        total_tokens: 125,
      },
    }),
  });
  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(2, {
      project_id: "gemini-agent",
      command: "context-pack",
      payload: { prompt_truncated: true, response_truncated: false, multimodal: [] },
      economics: {
        input_tokens: 50,
        output_tokens: 15,
        total_tokens: 65,
      },
    }),
  });
  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(3, {
      project_id: "vulca-platform",
      command: "artifact-review",
      status: "error",
      error_type: "APIError",
      economics: {
        input_tokens: 10,
        output_tokens: 0,
        total_tokens: 10,
      },
    }),
  });
  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(4, {
      project_id: "emoart-challenge",
      command: "artifact-review",
      source: "mcp",
    }),
  });

  const sentBatch = await claimTelemetryBatch({
    cwd,
    batchSize: 1,
    now: new Date("2026-06-04T09:01:00.000Z"),
  });
  await completeTelemetryBatch({
    cwd,
    batchId: sentBatch.batchId,
    now: new Date("2026-06-04T09:02:00.000Z"),
  });
  const failedBatch = await claimTelemetryBatch({
    cwd,
    batchSize: 1,
    now: new Date("2026-06-04T09:03:00.000Z"),
  });
  await failTelemetryBatch({
    cwd,
    batchId: failedBatch.batchId,
    reason: "receiver_error",
    retryable: false,
    now: new Date("2026-06-04T09:04:00.000Z"),
  });
  await quarantineTelemetryEvent({
    cwd,
    eventId: "evt_000003",
    reason: "manual review",
    now: new Date("2026-06-04T09:05:00.000Z"),
  });

  const result = await runTelemetrySummary({
    cwd,
    scope: "local",
    now: new Date("2026-06-04T10:00:00.000Z"),
  });

  assert.deepEqual(result.event_counts, {
    total: 4,
    pending: 1,
    inflight: 0,
    sent: 1,
    failed: 1,
    quarantine: 1,
    invalid: 0,
  });
  assert.deepEqual(result.usage, {
    prompt_tokens: 160,
    response_tokens: 40,
    total_tokens: 200,
    estimated_codex_tokens_saved: 160,
    events_missing_usage: 1,
  });
  assert.deepEqual(result.raw_content, {
    prompt_events: 4,
    response_events: 4,
    truncated_prompt_events: 1,
    truncated_response_events: 0,
  });
  assert.equal(result.top_projects[0].project_id, "vulca-platform");
  assert.equal(result.top_projects[0].event_count, 2);
  assert.equal(result.top_commands[0].command, "artifact-review");
  assert.equal(result.top_commands[0].event_count, 3);
  assert.deepEqual(result.models, [{
    model: "gemini-3.5-flash",
    event_count: 4,
    success_count: 3,
    error_count: 1,
    unknown_count: 0,
  }]);
});
