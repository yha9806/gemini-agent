import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
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
  telemetryQueueDirs,
} from "../src/telemetry-queue.mjs";
import {
  formatTelemetrySummaryText,
  runTelemetrySummary,
} from "../src/telemetry-summary.mjs";

const TOKEN_ENV = "GEMINI_AGENT_TELEMETRY_TOKEN";
const require = createRequire(import.meta.url);

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

test("runTelemetrySummary aggregates multimodal metadata without exposing media file names", async () => {
  const cwd = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });

  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(31, {
      command: "gemini_artifact_review",
      payload: {
        prompt_truncated: false,
        response_truncated: false,
        multimodal: [
          { mime_type: "image/png", byte_size: 1024, basename: "secret-customer-screen.png" },
          { mime_type: "image/png", byte_size: 2048 },
        ],
      },
    }),
  });
  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(32, {
      command: "artifact-review-backfill",
      payload: {
        prompt_truncated: false,
        response_truncated: false,
        multimodal: [
          { mime_type: "image/jpeg", byte_size: 512 },
          { byte_size: 128, basename: "private-artifact.jpg" },
          { mime_type: "application/pdf" },
        ],
      },
    }),
  });
  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(33, {
      command: "ask",
      payload: { prompt_truncated: false, response_truncated: false, multimodal: [] },
    }),
  });

  const summary = await runTelemetrySummary({ cwd, scope: "local" });
  const text = formatTelemetrySummaryText(summary);

  assert.deepEqual(summary.multimodal, {
    event_count: 2,
    item_count: 5,
    byte_count: 3712,
    unknown_mime_items: 1,
    unknown_byte_size_items: 1,
    top_media_mime: [
      { mime_type: "image/png", event_count: 1, item_count: 2, byte_count: 3072 },
      { mime_type: "application/pdf", event_count: 1, item_count: 1, byte_count: 0 },
      { mime_type: "image/jpeg", event_count: 1, item_count: 1, byte_count: 512 },
      { mime_type: "unknown", event_count: 1, item_count: 1, byte_count: 128 },
    ],
  });
  assert.match(text, /Multimodal:/);
  assert.match(summary.recommendations.map((item) => item.message).join("\n"), /multimodal metadata has unknown MIME types/);
  assert.doesNotMatch(JSON.stringify(summary), /secret-customer-screen/);
  assert.doesNotMatch(text, /private-artifact/);
});

test("runTelemetrySummary reports correction overlays without polluting original multimodal totals", async () => {
  const cwd = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });

  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(34, {
      event_id: "artifact_original_unknown",
      command: "artifact-review-backfill",
      payload: {
        prompt_truncated: false,
        response_truncated: false,
        multimodal: [{ basename: "private-source.png" }],
      },
    }),
  });
  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(35, {
      event_id: "artifact_correction_alpha",
      command: "artifact-review-backfill-correction",
      payload: {
        prompt_truncated: false,
        response_truncated: false,
        multimodal: [
          { mime_type: "image/png", byte_size: 100, basename: "private-source.png" },
          { mime_type: "image/jpeg" },
        ],
      },
      metadata: {
        correction_for_event_id: "artifact_original_unknown",
        correction_version: "media-v1",
      },
    }),
  });
  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(36, {
      event_id: "artifact_correction_beta",
      command: "artifact-review-backfill-correction",
      payload: {
        prompt_truncated: false,
        response_truncated: false,
        multimodal: [
          { mime_type: "image/png", byte_size: 200 },
        ],
      },
      metadata: {
        correction_for_event_id: "artifact_original_unknown",
        correction_version: "media-v1",
      },
    }),
  });

  const summary = await runTelemetrySummary({ cwd, scope: "local" });
  const text = formatTelemetrySummaryText(summary);

  assert.deepEqual(summary.multimodal, {
    event_count: 1,
    item_count: 1,
    byte_count: 0,
    unknown_mime_items: 1,
    unknown_byte_size_items: 1,
    top_media_mime: [
      { mime_type: "unknown", event_count: 1, item_count: 1, byte_count: 0 },
    ],
  });
  assert.deepEqual(summary.corrections, {
    event_count: 2,
    corrected_original_event_count: 1,
    media_item_count: 3,
    media_byte_count: 300,
    media_items_with_mime: 3,
    media_items_with_byte_size: 2,
    top_versions: [
      {
        correction_version: "media-v1",
        event_count: 2,
        corrected_original_event_count: 1,
        media_item_count: 3,
        media_byte_count: 300,
      },
    ],
  });
  assert.match(text, /Corrections:/);
  assert.match(text, /Correction events: 2/);
  assert.doesNotMatch(JSON.stringify(summary), /private-source/);
});

test("runTelemetrySummary reports invalid events with bounded POSIX samples", async () => {
  const cwd = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });

  await appendTelemetryEvent({ cwd, event: telemetryEvent(1) });
  const dirs = telemetryQueueDirs(cwd);
  await writeFile(join(dirs.pending, "bad-a.json"), "{");
  await writeFile(join(dirs.pending, "bad-b.json"), "{}");

  const result = await runTelemetrySummary({
    cwd,
    scope: "local",
    now: new Date("2026-06-04T10:00:00.000Z"),
    invalidSampleLimit: 1,
  });

  assert.deepEqual(result.event_counts, {
    total: 3,
    pending: 1,
    inflight: 0,
    sent: 0,
    failed: 0,
    quarantine: 0,
    invalid: 2,
  });
  assert.equal(result.invalid_events.count, 2);
  assert.equal(result.invalid_events.samples.length, 1);
  assert.match(result.invalid_events.samples[0], /^queue\/pending\/invalid-[a-f0-9]{12}\.json$/);
  assert.doesNotMatch(result.invalid_events.samples[0], /bad-a/);
});

test("runTelemetrySummary skips queue files removed before read", async () => {
  const cwd = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });

  await appendTelemetryEvent({ cwd, event: telemetryEvent(1) });
  const dirs = telemetryQueueDirs(cwd);
  const vanishingPath = join(dirs.pending, "vanishing.json");
  await writeFile(vanishingPath, `${JSON.stringify(telemetryEvent(2))}\n`);

  const fsPromises = require("node:fs/promises");
  const originalReadFile = fsPromises.readFile;
  fsPromises.readFile = async function readFileWithSyntheticRace(path, ...args) {
    if (path === vanishingPath) {
      const error = new Error(`ENOENT: no such file or directory, open '${path}'`);
      error.code = "ENOENT";
      throw error;
    }
    return originalReadFile.call(this, path, ...args);
  };
  syncBuiltinESMExports();

  let result;
  try {
    result = await runTelemetrySummary({
      cwd,
      scope: "local",
      now: new Date("2026-06-04T10:00:00.000Z"),
    });
  } finally {
    fsPromises.readFile = originalReadFile;
    syncBuiltinESMExports();
  }

  assert.deepEqual(result.event_counts, {
    total: 1,
    pending: 1,
    inflight: 0,
    sent: 0,
    failed: 0,
    quarantine: 0,
    invalid: 0,
  });
  assert.deepEqual(result.invalid_events, {
    count: 0,
    samples: [],
  });
});

test("runTelemetrySummary sanitizes metadata dimensions and never exposes raw prompt or response", async () => {
  const cwd = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });
  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(10, {
      project_id: "vulca\nAuthorization: Bearer secret-token",
      command: "artifact-review",
      prompt: "raw prompt with customer secret",
      response: "raw response with customer secret",
    }),
  });

  const summary = await runTelemetrySummary({ cwd, scope: "local" });
  const json = JSON.stringify(summary);
  const text = formatTelemetrySummaryText(summary);

  assert.doesNotMatch(json, /secret-token/);
  assert.doesNotMatch(json, /raw prompt with customer secret/);
  assert.doesNotMatch(json, /raw response with customer secret/);
  assert.doesNotMatch(text, /secret-token/);
  assert.doesNotMatch(text, /raw prompt with customer secret/);
  assert.doesNotMatch(text, /raw response with customer secret/);
  assert.match(text, /Telemetry Summary/);
});

test("runTelemetrySummary sanitizes queue failure metadata before JSON and text output", async () => {
  const cwd = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });
  await appendTelemetryEvent({ cwd, event: telemetryEvent(11) });
  const batch = await claimTelemetryBatch({
    cwd,
    batchSize: 1,
    now: new Date("2026-06-04T09:01:00.000Z"),
  });
  await failTelemetryBatch({
    cwd,
    batchId: batch.batchId,
    reason: "receiver_error\nAuthorization: Bearer secret-token",
    retryable: true,
  });

  const summary = await runTelemetrySummary({ cwd, scope: "local" });
  const json = JSON.stringify(summary);
  const text = formatTelemetrySummaryText(summary);

  assert.doesNotMatch(json, /secret-token/);
  assert.doesNotMatch(text, /secret-token/);
  assert.equal(summary.queue.last_failure_reason, "receiver_error");
});

test("runTelemetrySummary classifies quarantine reasons without exposing reason text", async () => {
  const cwd = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });
  await appendTelemetryEvent({ cwd, event: telemetryEvent(12) });
  await quarantineTelemetryEvent({
    cwd,
    eventId: "evt_000012",
    reason: "manual review for customer@example.com",
    now: new Date("2026-06-04T09:05:00.000Z"),
  });

  const summary = await runTelemetrySummary({ cwd, scope: "local" });
  const json = JSON.stringify(summary);
  const text = formatTelemetrySummaryText(summary);

  assert.equal(summary.queue.last_failure_reason, "quarantined");
  assert.doesNotMatch(json, /customer@example\.com/);
  assert.doesNotMatch(text, /customer@example\.com/);
  assert.doesNotMatch(text, /manual review/);
});

test("runTelemetrySummary uses uncapped status aggregates for reliability and text rates", async () => {
  const cwd = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });
  for (let index = 1; index <= 10; index += 1) {
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(index, {
        command: "alpha-success",
        status: "success",
      }),
    });
  }
  for (let index = 11; index <= 14; index += 1) {
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(index, {
        command: `hidden-error-${index}`,
        status: "error",
        error_type: "APIError",
      }),
    });
  }

  const summary = await runTelemetrySummary({ cwd, scope: "local", topLimit: 1 });
  const text = formatTelemetrySummaryText(summary);

  assert.equal(summary.top_commands.length, 1);
  assert.equal(summary.top_commands[0].command, "alpha-success");
  assert.match(summary.recommendations.map((item) => item.message).join("\n"), /Error rate is above 20%/);
  assert.match(text, /Success rate: 71\.4%/);
  assert.doesNotMatch(text, /Success rate: 100\.0%/);
});

test("runTelemetrySummary counts invalid files with bounded relative samples", async () => {
  const cwd = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });
  const dirs = telemetryQueueDirs(cwd);
  await mkdir(dirs.pending, { recursive: true });
  await writeFile(join(dirs.pending, "bad-a.json"), "{bad json");
  await writeFile(join(dirs.pending, "bad-b.json"), "{bad json");

  const summary = await runTelemetrySummary({
    cwd,
    scope: "local",
    invalidSampleLimit: 1,
  });

  assert.equal(summary.event_counts.invalid, 2);
  assert.equal(summary.invalid_events.count, 2);
  assert.equal(summary.invalid_events.samples.length, 1);
  assert.match(summary.invalid_events.samples[0], /^queue\/pending\/invalid-[a-f0-9]{12}\.json$/);
  assert.doesNotMatch(summary.invalid_events.samples[0], /bad-a/);
  assert.doesNotMatch(JSON.stringify(summary.invalid_events.samples), new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("runTelemetrySummary does not expose sensitive invalid file names", async () => {
  const cwd = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });
  const dirs = telemetryQueueDirs(cwd);
  await mkdir(dirs.pending, { recursive: true });
  await writeFile(join(dirs.pending, "X_API_KEY=super-secret-token.json"), "{bad json");

  const summary = await runTelemetrySummary({ cwd, scope: "local" });
  const json = JSON.stringify(summary);

  assert.equal(summary.invalid_events.count, 1);
  assert.match(summary.invalid_events.samples[0], /^queue\/pending\/invalid-[a-f0-9]{12}\.json$/);
  assert.doesNotMatch(json, /X_API_KEY/);
  assert.doesNotMatch(json, /super-secret-token/);
});

test("runTelemetrySummary continues when queue state JSON is corrupted", async () => {
  const cwd = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });
  await appendTelemetryEvent({ cwd, event: telemetryEvent(14) });
  const dirs = telemetryQueueDirs(cwd);
  await writeFile(dirs.state, "{bad json");

  const summary = await runTelemetrySummary({ cwd, scope: "local" });

  assert.equal(summary.event_counts.total, 1);
  assert.equal(summary.queue.state_read_error, true);
  assert.match(summary.limitations.join("\n"), /Queue state metadata could not be read/);
});

test("runTelemetrySummary ignores symlinked queue entries", async () => {
  const cwd = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });
  const dirs = telemetryQueueDirs(cwd);
  await mkdir(dirs.pending, { recursive: true });
  const outsideEvent = join(cwd, "outside-event.json");
  await writeFile(outsideEvent, `${JSON.stringify(telemetryEvent(13, {
    prompt: "symlink raw prompt should not print",
    response: "symlink raw response should not print",
  }))}\n`);
  await symlink(outsideEvent, join(dirs.pending, "outside-event.json"));

  const summary = await runTelemetrySummary({ cwd, scope: "local" });
  const json = JSON.stringify(summary);

  assert.equal(summary.event_counts.total, 0);
  assert.equal(summary.invalid_events.count, 0);
  assert.doesNotMatch(json, /symlink raw prompt should not print/);
  assert.doesNotMatch(json, /symlink raw response should not print/);
});

test("runTelemetrySummary caps top dimensions and builds deterministic recommendations", async () => {
  const cwd = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });
  for (let index = 1; index <= 6; index += 1) {
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(index, {
        project_id: `project-${index}`,
        command: "artifact-review",
      }),
    });
  }

  const summary = await runTelemetrySummary({ cwd, scope: "local", topLimit: 3 });

  assert.equal(summary.top_projects.length, 3);
  assert.equal(summary.top_commands[0].command, "artifact-review");
  assert.match(summary.recommendations.map((item) => item.message).join("\n"), /multimodal\/design workflows/);
});

test("runTelemetrySummary keeps large queues bounded by topLimit", async () => {
  const cwd = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });
  for (let index = 1; index <= 250; index += 1) {
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(index, {
        project_id: `project-${index}`,
        command: index % 2 === 0 ? "context-pack" : "artifact-review",
      }),
    });
  }

  const summary = await runTelemetrySummary({ cwd, scope: "local", topLimit: 5 });

  assert.equal(summary.event_counts.total, 250);
  assert.equal(summary.top_projects.length, 5);
  assert.equal(summary.top_commands.length, 2);
  assert.equal(summary.invalid_events.samples.length, 0);
});

test("runTelemetrySummary supports global scope from a different cwd", async () => {
  const home = await temporaryWorkspace();
  const project = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd: project,
    home,
    scope: "global",
    endpoint: "https://vulca-api.onrender.com/api/v1/gemini-agent/telemetry/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });
  await appendTelemetryEvent({
    cwd: home,
    event: telemetryEvent(21, { project_id: "global-project", command: "context-pack" }),
  });

  const summary = await runTelemetrySummary({ cwd: project, home, scope: "global" });

  assert.equal(summary.scope, "global");
  assert.equal(summary.storage_cwd, home);
  assert.equal(summary.event_counts.total, 1);
  assert.equal(summary.top_projects[0].project_id, "global-project");
});
