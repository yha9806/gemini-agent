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
  assert.deepEqual(result.palette_split, {
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
  });
  assert.deepEqual(result.multimodal_adjusted, {
    event_count: 0,
    item_count: 0,
    byte_count: 0,
    unknown_mime_items: 0,
    unknown_byte_size_items: 0,
    unknown_kind_items: 0,
    media_items_with_mime: 0,
    media_items_with_byte_size: 0,
    media_items_with_kind: 0,
    correction_event_count: 0,
    corrected_original_event_count: 0,
    orphan_correction_event_count: 0,
    superseded_correction_event_count: 0,
    applied_correction_event_count: 0,
    top_media_mime: [],
    top_media_kind: [],
    top_commands: [],
    top_correction_versions: [],
  });
  assert.deepEqual(result.top_projects, []);
  assert.deepEqual(result.top_workspaces, []);
  assert.deepEqual(result.top_user_labels, []);
  assert.deepEqual(result.top_commands, []);
  assert.equal(await pathExists(join(cwd, ".gemini-agent/telemetry/queue")), false);
});

test("runTelemetrySummary reports workspace and user label dimensions safely", async () => {
  const cwd = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });

  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(61, {
      context: { workspace_id: "ws_vulca", user_label: "vulca-operator", cwd: "[PATH]/vulca" },
    }),
  });
  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(62, {
      context: { workspace_id: "ws_vulca", user_label: "person@example.com", cwd: "[PATH]/vulca" },
    }),
  });

  const summary = await runTelemetrySummary({ cwd, scope: "local" });
  const text = formatTelemetrySummaryText(summary);

  assert.deepEqual(summary.top_workspaces, [
    { workspace_id: "ws_vulca", event_count: 2, success_count: 2, error_count: 0, unknown_count: 0 },
  ]);
  assert.deepEqual(summary.top_user_labels, [
    { user_label: "vulca-operator", event_count: 1, success_count: 1, error_count: 0, unknown_count: 0 },
  ]);
  assert.doesNotMatch(JSON.stringify(summary), /person@example.com|\[PATH\]/);
  assert.doesNotMatch(text, /person@example.com|\[PATH\]/);
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

test("runTelemetrySummary canonicalizes command variants before aggregating", async () => {
  const cwd = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });

  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(101, {
      command: " Diff_Review ",
      economics: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
    }),
  });
  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(102, {
      command: "diff-review",
      economics: { input_tokens: 50, output_tokens: 10, total_tokens: 60 },
    }),
  });
  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(103, {
      command: "plan_critique",
      economics: { input_tokens: 25, output_tokens: 5, total_tokens: 30 },
    }),
  });
  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(104, {
      command: "plan-critique",
      economics: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    }),
  });

  const result = await runTelemetrySummary({ cwd, scope: "local" });
  const commands = new Map(result.top_commands.map((item) => [item.command, item]));
  const serialized = JSON.stringify(result);

  assert.equal(commands.get("diff-review")?.event_count, 2);
  assert.equal(commands.get("diff-review")?.success_count, 2);
  assert.equal(commands.get("plan-critique")?.event_count, 2);
  assert.equal(commands.has("Diff_Review"), false);
  assert.equal(commands.has("diff_review"), false);
  assert.equal(commands.has("plan_critique"), false);
  assert.equal(result.usage.estimated_codex_tokens_saved, 185);
  assert.doesNotMatch(serialized, /prompt 000101/);
  assert.doesNotMatch(serialized, /response 000101/);
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
          { mime_type: "image/png", byte_size: 1024, basename: "secret-customer-screen.png", media_kind: "image" },
          { mime_type: "image/png", byte_size: 2048, media_kind: "image" },
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
          { mime_type: "image/jpeg", byte_size: 512, media_kind: "image" },
          { byte_size: 128, basename: "private-artifact.jpg" },
          { mime_type: "application/pdf", media_kind: "document" },
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
    unknown_kind_items: 1,
    media_items_with_mime: 4,
    media_items_with_byte_size: 4,
    media_items_with_kind: 4,
    top_media_mime: [
      { mime_type: "image/png", event_count: 1, item_count: 2, byte_count: 3072 },
      { mime_type: "application/pdf", event_count: 1, item_count: 1, byte_count: 0 },
      { mime_type: "image/jpeg", event_count: 1, item_count: 1, byte_count: 512 },
      { mime_type: "unknown", event_count: 1, item_count: 1, byte_count: 128 },
    ],
    top_media_kind: [
      { media_kind: "image", event_count: 2, item_count: 3, byte_count: 3584 },
      { media_kind: "document", event_count: 1, item_count: 1, byte_count: 0 },
      { media_kind: "unknown", event_count: 1, item_count: 1, byte_count: 128 },
    ],
    top_commands: [
      {
        command: "artifact-review-backfill",
        event_count: 1,
        item_count: 3,
        byte_count: 640,
        unknown_mime_items: 1,
        unknown_byte_size_items: 1,
        unknown_kind_items: 1,
        media_items_with_mime: 2,
        media_items_with_byte_size: 2,
        media_items_with_kind: 2,
      },
      {
        command: "gemini-artifact-review",
        event_count: 1,
        item_count: 2,
        byte_count: 3072,
        unknown_mime_items: 0,
        unknown_byte_size_items: 0,
        unknown_kind_items: 0,
        media_items_with_mime: 2,
        media_items_with_byte_size: 2,
        media_items_with_kind: 2,
      },
    ],
  });
  assert.match(text, /Multimodal:/);
  assert.match(text, /Top multimodal commands:/);
  assert.match(text, /artifact-review-backfill: 1 events, 3 media items, 640 bytes/);
  assert.match(text, /Adjusted multimodal:/);
  assert.match(text, /Top adjusted multimodal commands:/);
  assert.match(summary.recommendations.map((item) => item.message).join("\n"), /multimodal metadata has unknown MIME types/);
  assert.doesNotMatch(JSON.stringify(summary), /secret-customer-screen/);
  assert.doesNotMatch(text, /private-artifact/);
});

test("runTelemetrySummary reports safe multimodal command coverage", async () => {
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
      command: "artifact-review /Users/example/private.png Authorization: Bearer secret-token",
      payload: {
        prompt_truncated: false,
        response_truncated: false,
        multimodal: [{ basename: "top-secret-design.png" }],
      },
    }),
  });

  const summary = await runTelemetrySummary({ cwd, scope: "local" });
  const serialized = JSON.stringify(summary);

  assert.deepEqual(summary.multimodal.top_commands, [
    {
      command: "other",
      event_count: 1,
      item_count: 1,
      byte_count: 0,
      unknown_mime_items: 1,
      unknown_byte_size_items: 1,
      unknown_kind_items: 1,
      media_items_with_mime: 0,
      media_items_with_byte_size: 0,
      media_items_with_kind: 0,
    },
  ]);
  assert.doesNotMatch(serialized, /\/Users/);
  assert.doesNotMatch(serialized, /secret-token/);
  assert.doesNotMatch(serialized, /private\.png|top-secret-design/);
});

test("runTelemetrySummary reports aggregate backfill media manifest sources", async () => {
  const cwd = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });

  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(36, {
      command: "artifact-review-backfill",
      payload: {
        prompt_truncated: false,
        response_truncated: false,
        multimodal: [
          { mime_type: "image/png", byte_size: 11, basename: "private-one.png" },
          { mime_type: "image/png", byte_size: 22, basename: "private-two.png" },
        ],
      },
      metadata: {
        media_manifest_source: "artifact_media_manifest",
      },
    }),
  });
  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(37, {
      command: "artifact-review-backfill-correction",
      payload: {
        prompt_truncated: false,
        response_truncated: false,
        multimodal: [{ mime_type: "image/png", byte_size: 33, basename: "private-three.png" }],
      },
      metadata: {
        correction_for_event_id: "artifact_private_original",
        correction_version: "media-v4",
        media_manifest_source: "none",
      },
    }),
  });
  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(38, {
      command: "artifact-review-backfill",
      payload: {
        prompt_truncated: false,
        response_truncated: false,
        multimodal: [{ mime_type: "image/png", byte_size: 44, basename: "private-four.png" }],
      },
      metadata: {
        media_manifest_source: "source path /Users/example/private.png",
      },
    }),
  });

  const summary = await runTelemetrySummary({ cwd, scope: "local" });
  const text = formatTelemetrySummaryText(summary);
  const serialized = JSON.stringify(summary);

  assert.deepEqual(summary.backfill.media_manifest_sources, [
    {
      media_manifest_source: "artifact_media_manifest",
      event_count: 1,
      media_item_count: 2,
      success_count: 1,
      error_count: 0,
      unknown_count: 0,
    },
    {
      media_manifest_source: "none",
      event_count: 1,
      media_item_count: 1,
      success_count: 1,
      error_count: 0,
      unknown_count: 0,
    },
    {
      media_manifest_source: "unknown",
      event_count: 1,
      media_item_count: 1,
      success_count: 1,
      error_count: 0,
      unknown_count: 0,
    },
  ]);
  assert.match(text, /Backfill media manifest sources:/);
  assert.match(text, /artifact_media_manifest: 1 events, 2 media items/);
  assert.doesNotMatch(serialized, /private-one|private-two|private-three|private-four|\/Users/);
  assert.doesNotMatch(text, /private|\/Users/);
});

test("runTelemetrySummary caps and sorts multimodal command coverage deterministically", async () => {
  const cwd = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });

  for (const [index, command] of [
    [35, "palette-split"],
    [36, "gemini-artifact-review"],
    [37, "artifact-review"],
  ]) {
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(index, {
        command,
        payload: {
          prompt_truncated: false,
          response_truncated: false,
          multimodal: [{ mime_type: "image/png", byte_size: 1, media_kind: "image" }],
        },
      }),
    });
  }

  const summary = await runTelemetrySummary({ cwd, scope: "local", topLimit: 2 });

  assert.deepEqual(summary.multimodal.top_commands.map((item) => item.command), [
    "artifact-review",
    "gemini-artifact-review",
  ]);
  assert.equal(summary.multimodal.top_commands.length, 2);
});

test("runTelemetrySummary aggregates palette-split quality metrics with legacy events", async () => {
  const cwd = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });

  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(37, {
      command: "palette-split",
      metadata: {
        actual_model: "gemini-3.1-flash-image",
        workflow: "palette-split",
        quality: {
          quality_score: 82,
          mask_resized: true,
          empty_target_count: 1,
          degenerate_target_count: 0,
          foreground_area_pct: 45.5,
        },
      },
    }),
  });
  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(38, {
      command: "palette-split",
      status: "error",
      metadata: {
        actual_model: "gemini-3.1-flash-image",
        workflow: "palette-split",
      },
    }),
  });
  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(39, {
      command: "ask",
      metadata: {
        quality: {
          quality_score: 1,
          foreground_area_pct: 1,
        },
      },
    }),
  });

  const summary = await runTelemetrySummary({ cwd, scope: "local" });
  const text = formatTelemetrySummaryText(summary);

  assert.deepEqual(summary.palette_split, {
    event_count: 2,
    success_count: 1,
    error_count: 1,
    quality_event_count: 1,
    avg_quality_score: 82,
    resized_mask_count: 1,
    empty_target_count: 1,
    degenerate_target_count: 0,
    avg_foreground_area_pct: 45.5,
    top_actual_models: [
      {
        actual_model: "gemini-3.1-flash-image",
        event_count: 2,
        success_count: 1,
        error_count: 1,
        unknown_count: 0,
      },
    ],
  });
  assert.match(text, /Palette split:/);
  assert.match(text, /Average quality score: 82/);
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
    unknown_kind_items: 1,
    media_items_with_mime: 0,
    media_items_with_byte_size: 0,
    media_items_with_kind: 0,
    top_media_mime: [
      { mime_type: "unknown", event_count: 1, item_count: 1, byte_count: 0 },
    ],
    top_media_kind: [
      { media_kind: "unknown", event_count: 1, item_count: 1, byte_count: 0 },
    ],
    top_commands: [
      {
        command: "artifact-review-backfill",
        event_count: 1,
        item_count: 1,
        byte_count: 0,
        unknown_mime_items: 1,
        unknown_byte_size_items: 1,
        unknown_kind_items: 1,
        media_items_with_mime: 0,
        media_items_with_byte_size: 0,
        media_items_with_kind: 0,
      },
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

test("runTelemetrySummary applies correction media to adjusted multimodal totals", async () => {
  const cwd = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });

  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(401, {
      event_id: "artifact_original_private_screen",
      command: "artifact-review-backfill",
      prompt: "raw prompt private customer",
      response: "raw response private customer",
      payload: {
        prompt_truncated: false,
        response_truncated: false,
        multimodal: [{ basename: "private-customer-screen.png" }],
      },
    }),
  });
  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(402, {
      event_id: "artifact_correction_private_screen",
      command: "artifact-review-backfill-correction",
      payload: {
        prompt_truncated: false,
        response_truncated: false,
        multimodal: [
          { mime_type: "image/png", byte_size: 100, basename: "private-customer-screen.png", media_kind: "screenshot" },
        ],
      },
      metadata: {
        correction_for_event_id: "artifact_original_private_screen",
        correction_version: "media-v1",
      },
    }),
  });

  const summary = await runTelemetrySummary({ cwd, scope: "local" });
  const text = formatTelemetrySummaryText(summary);
  const serialized = JSON.stringify(summary);

  assert.deepEqual(summary.multimodal, {
    event_count: 1,
    item_count: 1,
    byte_count: 0,
    unknown_mime_items: 1,
    unknown_byte_size_items: 1,
    unknown_kind_items: 1,
    media_items_with_mime: 0,
    media_items_with_byte_size: 0,
    media_items_with_kind: 0,
    top_media_mime: [
      { mime_type: "unknown", event_count: 1, item_count: 1, byte_count: 0 },
    ],
    top_media_kind: [
      { media_kind: "unknown", event_count: 1, item_count: 1, byte_count: 0 },
    ],
    top_commands: [
      {
        command: "artifact-review-backfill",
        event_count: 1,
        item_count: 1,
        byte_count: 0,
        unknown_mime_items: 1,
        unknown_byte_size_items: 1,
        unknown_kind_items: 1,
        media_items_with_mime: 0,
        media_items_with_byte_size: 0,
        media_items_with_kind: 0,
      },
    ],
  });
  assert.deepEqual(summary.multimodal_adjusted, {
    event_count: 1,
    item_count: 1,
    byte_count: 100,
    unknown_mime_items: 0,
    unknown_byte_size_items: 0,
    unknown_kind_items: 0,
    media_items_with_mime: 1,
    media_items_with_byte_size: 1,
    media_items_with_kind: 1,
    correction_event_count: 1,
    corrected_original_event_count: 1,
    orphan_correction_event_count: 0,
    superseded_correction_event_count: 0,
    applied_correction_event_count: 1,
    top_media_mime: [
      { mime_type: "image/png", event_count: 1, item_count: 1, byte_count: 100 },
    ],
    top_media_kind: [
      { media_kind: "screenshot", event_count: 1, item_count: 1, byte_count: 100 },
    ],
    top_commands: [
      {
        command: "artifact-review-backfill",
        event_count: 1,
        item_count: 1,
        byte_count: 100,
        unknown_mime_items: 0,
        unknown_byte_size_items: 0,
        unknown_kind_items: 0,
        media_items_with_mime: 1,
        media_items_with_byte_size: 1,
        media_items_with_kind: 1,
      },
    ],
    top_correction_versions: [
      {
        correction_version: "media-v1",
        event_count: 1,
        corrected_original_event_count: 1,
        media_item_count: 1,
        media_byte_count: 100,
      },
    ],
  });
  assert.match(text, /Applied correction events: 1/);
  assert.doesNotMatch(serialized, /artifact_original_private_screen/);
  assert.doesNotMatch(serialized, /artifact_correction_private_screen/);
  assert.doesNotMatch(serialized, /private-customer-screen/);
  assert.doesNotMatch(serialized, /raw prompt private customer/);
  assert.doesNotMatch(text, /private-customer-screen/);
});

test("runTelemetrySummary preserves original media fields when correction omits them", async () => {
  const cwd = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });

  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(403, {
      event_id: "artifact_original_partial_media",
      command: "artifact-review-backfill",
      payload: {
        prompt_truncated: false,
        response_truncated: false,
        multimodal: [
          { mime_type: "image/jpeg", byte_size: 200, basename: "private-original.jpg", media_kind: "image" },
        ],
      },
    }),
  });
  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(404, {
      event_id: "artifact_correction_partial_media",
      command: "artifact-review-backfill-correction",
      payload: {
        prompt_truncated: false,
        response_truncated: false,
        multimodal: [
          { mime_type: "image/png", byte_size: 100, basename: "private-correction.png" },
        ],
      },
      metadata: {
        correction_for_event_id: "artifact_original_partial_media",
        correction_version: "media-v1",
      },
    }),
  });

  const summary = await runTelemetrySummary({ cwd, scope: "local" });
  const serialized = JSON.stringify(summary);

  assert.equal(summary.multimodal_adjusted.item_count, 1);
  assert.equal(summary.multimodal_adjusted.byte_count, 100);
  assert.equal(summary.multimodal_adjusted.media_items_with_kind, 1);
  assert.equal(summary.multimodal_adjusted.unknown_kind_items, 0);
  assert.deepEqual(summary.multimodal_adjusted.top_media_mime, [
    { mime_type: "image/png", event_count: 1, item_count: 1, byte_count: 100 },
  ]);
  assert.deepEqual(summary.multimodal_adjusted.top_media_kind, [
    { media_kind: "image", event_count: 1, item_count: 1, byte_count: 100 },
  ]);
  assert.doesNotMatch(serialized, /artifact_original_partial_media/);
  assert.doesNotMatch(serialized, /artifact_correction_partial_media/);
  assert.doesNotMatch(serialized, /private-original/);
  assert.doesNotMatch(serialized, /private-correction/);
});

test("runTelemetrySummary handles correction media count mismatches", async () => {
  const cwd = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });

  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(405, {
      event_id: "artifact_original_correction_shorter",
      command: "artifact-review-backfill",
      payload: {
        prompt_truncated: false,
        response_truncated: false,
        multimodal: [
          { mime_type: "image/jpeg", byte_size: 200, media_kind: "image" },
          { mime_type: "image/png", byte_size: 20, media_kind: "screenshot" },
        ],
      },
    }),
  });
  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(406, {
      event_id: "artifact_correction_shorter",
      command: "artifact-review-backfill-correction",
      payload: {
        prompt_truncated: false,
        response_truncated: false,
        multimodal: [
          { mime_type: "image/png", byte_size: 10 },
        ],
      },
      metadata: {
        correction_for_event_id: "artifact_original_correction_shorter",
        correction_version: "media-v1",
      },
    }),
  });
  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(407, {
      event_id: "artifact_original_correction_longer",
      command: "artifact-review-backfill",
      payload: {
        prompt_truncated: false,
        response_truncated: false,
        multimodal: [
          { mime_type: "image/jpeg", byte_size: 300, media_kind: "image" },
        ],
      },
    }),
  });
  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(408, {
      event_id: "artifact_correction_longer",
      command: "artifact-review-backfill-correction",
      payload: {
        prompt_truncated: false,
        response_truncated: false,
        multimodal: [
          { mime_type: "image/png", byte_size: 10 },
          { mime_type: "image/png", byte_size: 30, media_kind: "design" },
        ],
      },
      metadata: {
        correction_for_event_id: "artifact_original_correction_longer",
        correction_version: "media-v1",
      },
    }),
  });

  const summary = await runTelemetrySummary({ cwd, scope: "local" });

  assert.equal(summary.multimodal_adjusted.event_count, 2);
  assert.equal(summary.multimodal_adjusted.item_count, 4);
  assert.equal(summary.multimodal_adjusted.byte_count, 70);
  assert.equal(summary.multimodal_adjusted.media_items_with_kind, 4);
  assert.equal(summary.multimodal_adjusted.unknown_kind_items, 0);
  assert.deepEqual(summary.multimodal_adjusted.top_media_kind, [
    { media_kind: "image", event_count: 2, item_count: 2, byte_count: 20 },
    { media_kind: "design", event_count: 1, item_count: 1, byte_count: 30 },
    { media_kind: "screenshot", event_count: 1, item_count: 1, byte_count: 20 },
  ]);
});

test("runTelemetrySummary chooses one correction deterministically and counts orphan corrections", async () => {
  const cwd = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });

  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(411, {
      event_id: "artifact_original_precedence",
      command: "artifact-review-backfill",
      payload: {
        prompt_truncated: false,
        response_truncated: false,
        multimodal: [{ mime_type: "image/png" }],
      },
    }),
  });
  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(412, {
      event_id: "artifact_correction_media_v1",
      command: "artifact-review-backfill-correction",
      created_at: "2026-06-04T09:00:00.000Z",
      payload: {
        prompt_truncated: false,
        response_truncated: false,
        multimodal: [{ mime_type: "image/png", byte_size: 10, media_kind: "image" }],
      },
      metadata: {
        correction_for_event_id: "artifact_original_precedence",
        correction_version: "media-v1",
      },
    }),
  });
  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(413, {
      event_id: "artifact_correction_media_v2",
      command: "artifact-review-backfill-correction",
      created_at: "2026-06-04T08:00:00.000Z",
      payload: {
        prompt_truncated: false,
        response_truncated: false,
        multimodal: [{ mime_type: "image/png", byte_size: 20, media_kind: "screenshot" }],
      },
      metadata: {
        correction_for_event_id: "artifact_original_precedence",
        correction_version: "media-v2",
      },
    }),
  });
  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(414, {
      event_id: "artifact_correction_orphan",
      command: "artifact-review-backfill-correction",
      payload: {
        prompt_truncated: false,
        response_truncated: false,
        multimodal: [{ mime_type: "image/png", byte_size: 999, media_kind: "design" }],
      },
      metadata: {
        correction_for_event_id: "artifact_missing_original",
        correction_version: "media-v9",
      },
    }),
  });

  const summary = await runTelemetrySummary({ cwd, scope: "local" });

  assert.equal(summary.multimodal_adjusted.correction_event_count, 3);
  assert.equal(summary.multimodal_adjusted.corrected_original_event_count, 1);
  assert.equal(summary.multimodal_adjusted.applied_correction_event_count, 1);
  assert.equal(summary.multimodal_adjusted.superseded_correction_event_count, 1);
  assert.equal(summary.multimodal_adjusted.orphan_correction_event_count, 1);
  assert.equal(summary.multimodal_adjusted.byte_count, 20);
  assert.deepEqual(summary.multimodal_adjusted.top_media_kind, [
    { media_kind: "screenshot", event_count: 1, item_count: 1, byte_count: 20 },
  ]);
  assert.deepEqual(summary.multimodal_adjusted.top_correction_versions, [
    {
      correction_version: "media-v2",
      event_count: 1,
      corrected_original_event_count: 1,
      media_item_count: 1,
      media_byte_count: 20,
    },
  ]);
});

test("runTelemetrySummary applies corrections to originals without raw multimodal items", async () => {
  const cwd = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });

  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(426, {
      event_id: "artifact_original_without_media",
      command: "artifact-review-backfill",
      payload: { prompt_truncated: false, response_truncated: false, multimodal: [] },
    }),
  });
  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(427, {
      event_id: "artifact_correction_without_media_original",
      command: "artifact-review-backfill-correction",
      payload: {
        prompt_truncated: false,
        response_truncated: false,
        multimodal: [{ mime_type: "image/png", byte_size: 44, media_kind: "design" }],
      },
      metadata: {
        correction_for_event_id: "artifact_original_without_media",
        correction_version: "media-v1",
      },
    }),
  });

  const summary = await runTelemetrySummary({ cwd, scope: "local" });
  const serialized = JSON.stringify(summary);

  assert.equal(summary.multimodal.event_count, 0);
  assert.equal(summary.multimodal_adjusted.event_count, 1);
  assert.equal(summary.multimodal_adjusted.item_count, 1);
  assert.equal(summary.multimodal_adjusted.orphan_correction_event_count, 0);
  assert.equal(summary.multimodal_adjusted.applied_correction_event_count, 1);
  assert.deepEqual(summary.multimodal_adjusted.top_media_kind, [
    { media_kind: "design", event_count: 1, item_count: 1, byte_count: 44 },
  ]);
  assert.doesNotMatch(serialized, /artifact_original_without_media/);
  assert.doesNotMatch(serialized, /artifact_correction_without_media_original/);
});

test("runTelemetrySummary falls back to lexical correction versions and valid timestamps", async () => {
  const cwd = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });

  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(421, {
      event_id: "artifact_original_lexical",
      command: "artifact-review-backfill",
      payload: { prompt_truncated: false, response_truncated: false, multimodal: [{ byte_size: 1 }] },
    }),
  });
  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(422, {
      event_id: "artifact_correction_beta_new",
      command: "artifact-review-backfill-correction",
      created_at: "2026-06-04T08:00:00.000Z",
      payload: {
        prompt_truncated: false,
        response_truncated: false,
        multimodal: [{ mime_type: "image/png", byte_size: 30, media_kind: "screenshot" }],
      },
      metadata: {
        correction_for_event_id: "artifact_original_lexical",
        correction_version: "beta",
      },
    }),
  });
  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(423, {
      event_id: "artifact_correction_alpha_late",
      command: "artifact-review-backfill-correction",
      created_at: "2026-06-04T10:00:00.000Z",
      payload: {
        prompt_truncated: false,
        response_truncated: false,
        multimodal: [{ mime_type: "image/png", byte_size: 10, media_kind: "image" }],
      },
      metadata: {
        correction_for_event_id: "artifact_original_lexical",
        correction_version: "alpha",
      },
    }),
  });
  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(424, {
      event_id: "artifact_correction_beta_old",
      command: "artifact-review-backfill-correction",
      created_at: "2026-06-04T07:00:00.000Z",
      payload: {
        prompt_truncated: false,
        response_truncated: false,
        multimodal: [{ mime_type: "image/png", byte_size: 20, media_kind: "design" }],
      },
      metadata: {
        correction_for_event_id: "artifact_original_lexical",
        correction_version: "beta",
      },
    }),
  });

  const summary = await runTelemetrySummary({ cwd, scope: "local" });

  assert.equal(summary.multimodal_adjusted.byte_count, 30);
  assert.deepEqual(summary.multimodal_adjusted.top_media_kind, [
    { media_kind: "screenshot", event_count: 1, item_count: 1, byte_count: 30 },
  ]);
  assert.equal(summary.multimodal_adjusted.superseded_correction_event_count, 2);
});

test("runTelemetrySummary recommendations use adjusted media-kind coverage", async () => {
  const cwd = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });

  for (let index = 1; index <= 6; index += 1) {
    const originalId = `artifact_original_recommendation_${index}`;
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(430 + index, {
        event_id: originalId,
        command: "artifact-review-backfill",
        payload: {
          prompt_truncated: false,
          response_truncated: false,
          multimodal: [],
        },
      }),
    });
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(440 + index, {
        event_id: `artifact_correction_recommendation_${index}`,
        command: "artifact-review-backfill-correction",
        payload: {
          prompt_truncated: false,
          response_truncated: false,
          multimodal: [{ mime_type: "image/png", byte_size: index, media_kind: "screenshot" }],
        },
        metadata: {
          correction_for_event_id: originalId,
          correction_version: "media-v1",
        },
      }),
    });
  }

  const summary = await runTelemetrySummary({ cwd, scope: "local" });
  const messages = summary.recommendations.map((item) => item.message).join("\n");

  assert.equal(summary.multimodal.item_count, 0);
  assert.equal(summary.multimodal_adjusted.item_count, 6);
  assert.match(messages, /Correction-aware multimodal coverage is materially better/);
  assert.doesNotMatch(messages, /Most multimodal metadata is missing media kind/);
});

test("runTelemetrySummary handles malformed correction payloads without leaking identifiers", async () => {
  const cwd = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });

  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(451, {
      event_id: "artifact_original_malformed",
      command: "artifact-review-backfill",
      payload: {
        prompt_truncated: false,
        response_truncated: false,
        multimodal: [{ basename: "private-malformed.png" }],
      },
    }),
  });
  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(452, {
      event_id: "artifact_correction_missing_target",
      command: "artifact-review-backfill-correction",
      payload: {
        prompt_truncated: false,
        response_truncated: false,
        multimodal: [],
      },
      metadata: {
        correction_version: "media-v1",
      },
    }),
  });

  const summary = await runTelemetrySummary({ cwd, scope: "local" });
  const text = formatTelemetrySummaryText(summary);
  const serialized = JSON.stringify(summary);

  assert.equal(summary.multimodal_adjusted.correction_event_count, 1);
  assert.equal(summary.multimodal_adjusted.orphan_correction_event_count, 1);
  assert.equal(summary.multimodal_adjusted.applied_correction_event_count, 0);
  assert.doesNotMatch(serialized, /artifact_original_malformed/);
  assert.doesNotMatch(serialized, /artifact_correction_missing_target/);
  assert.doesNotMatch(serialized, /private-malformed/);
  assert.doesNotMatch(text, /private-malformed/);
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

test("runTelemetrySummary aggregates context loop modes without leaking paths", async () => {
  const cwd = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });

  const events = [
    telemetryEvent(301, {
      command: "plan-critique",
      metadata: {
        gate: "plan_critique",
        context_pack_mode: "auto",
        fresh_input_mode: "stdin",
        has_fresh_input: true,
      },
    }),
    telemetryEvent(302, {
      command: "diff-review",
      metadata: {
        gate: "diff_review",
        context_pack_mode: "explicit",
        fresh_input_mode: "diff",
        has_fresh_input: true,
        context_pack_path: "/Users/example/private/latest.json",
      },
    }),
    telemetryEvent(303, {
      command: "patch-precheck",
      metadata: {
        gate: "patch_precheck",
        context_pack_mode: "none",
        fresh_input_mode: "file",
        has_fresh_input: true,
        context_pack_preflight_warning: true,
      },
    }),
    telemetryEvent(304, {
      command: "research-brief",
      metadata: {
        gate: "research_brief",
        context_pack_mode: "not-a-real-mode",
        fresh_input_mode: "/Users/example/private/file.md",
        context_pack_preflight_warning: true,
      },
    }),
    telemetryEvent(305, {
      command: "plan-critique",
      metadata: {
        gate: "plan_critique",
      },
    }),
    telemetryEvent(306, {
      command: "ask",
      metadata: {
        context_pack_mode: "auto",
        fresh_input_mode: "stdin",
      },
    }),
  ];
  for (const event of events) {
    await appendTelemetryEvent({ cwd, event });
  }

  const summary = await runTelemetrySummary({ cwd, scope: "local", topLimit: 10 });
  const serialized = JSON.stringify(summary);

  assert.equal(summary.context_loop.gate_event_count, 5);
  assert.equal(summary.context_loop.context_pack_reused_event_count, 2);
  assert.equal(summary.context_loop.auto_context_pack_event_count, 1);
  assert.equal(summary.context_loop.explicit_context_pack_event_count, 1);
  assert.equal(summary.context_loop.no_context_pack_event_count, 1);
  assert.equal(summary.context_loop.unknown_context_pack_mode_event_count, 2);
  assert.equal(summary.context_loop.has_fresh_input_count, 3);
  assert.equal(summary.context_loop.context_pack_preflight_warning_count, 2);
  assert.deepEqual(summary.context_loop.top_context_pack_modes, [
    { context_pack_mode: "unknown", event_count: 2 },
    { context_pack_mode: "auto", event_count: 1 },
    { context_pack_mode: "explicit", event_count: 1 },
    { context_pack_mode: "none", event_count: 1 },
  ]);
  assert.deepEqual(summary.context_loop.top_fresh_input_modes, [
    { fresh_input_mode: "unknown", event_count: 2 },
    { fresh_input_mode: "diff", event_count: 1 },
    { fresh_input_mode: "file", event_count: 1 },
    { fresh_input_mode: "stdin", event_count: 1 },
  ]);
  assert.deepEqual(summary.context_loop.top_gate_commands, [
    {
      command: "plan-critique",
      event_count: 2,
      context_pack_reused_event_count: 1,
      auto_context_pack_event_count: 1,
      explicit_context_pack_event_count: 0,
      no_context_pack_event_count: 0,
      unknown_context_pack_mode_event_count: 1,
      has_fresh_input_count: 1,
      context_pack_preflight_warning_count: 0,
    },
    {
      command: "diff-review",
      event_count: 1,
      context_pack_reused_event_count: 1,
      auto_context_pack_event_count: 0,
      explicit_context_pack_event_count: 1,
      no_context_pack_event_count: 0,
      unknown_context_pack_mode_event_count: 0,
      has_fresh_input_count: 1,
      context_pack_preflight_warning_count: 0,
    },
    {
      command: "patch-precheck",
      event_count: 1,
      context_pack_reused_event_count: 0,
      auto_context_pack_event_count: 0,
      explicit_context_pack_event_count: 0,
      no_context_pack_event_count: 1,
      unknown_context_pack_mode_event_count: 0,
      has_fresh_input_count: 1,
      context_pack_preflight_warning_count: 1,
    },
    {
      command: "research-brief",
      event_count: 1,
      context_pack_reused_event_count: 0,
      auto_context_pack_event_count: 0,
      explicit_context_pack_event_count: 0,
      no_context_pack_event_count: 0,
      unknown_context_pack_mode_event_count: 1,
      has_fresh_input_count: 0,
      context_pack_preflight_warning_count: 1,
    },
  ]);
  assert.doesNotMatch(serialized, /\/Users\/example|latest\.json|file\.md|not-a-real-mode/);
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
  for (let index = 1; index <= 50; index += 1) {
    const originalId = `artifact_large_original_${index}`;
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(1000 + index, {
        event_id: originalId,
        project_id: `correction-project-${index}`,
        command: "artifact-review-backfill",
        payload: {
          prompt_truncated: false,
          response_truncated: false,
          multimodal: [{ basename: `private-large-${index}.png` }],
        },
      }),
    });
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(2000 + index, {
        event_id: `artifact_large_correction_${index}`,
        command: "artifact-review-backfill-correction",
        payload: {
          prompt_truncated: false,
          response_truncated: false,
          multimodal: [
            {
              mime_type: "image/png",
              byte_size: index,
              media_kind: index % 2 === 0 ? "design" : "screenshot",
            },
          ],
        },
        metadata: {
          correction_for_event_id: originalId,
          correction_version: `media-v${index % 3}`,
        },
      }),
    });
  }

  const summary = await runTelemetrySummary({ cwd, scope: "local", topLimit: 5 });

  assert.equal(summary.event_counts.total, 350);
  assert.equal(summary.top_projects.length, 5);
  assert.equal(summary.top_commands.length, 4);
  assert.equal(summary.multimodal_adjusted.top_media_mime.length <= 5, true);
  assert.equal(summary.multimodal_adjusted.top_media_kind.length <= 5, true);
  assert.equal(summary.multimodal_adjusted.top_correction_versions.length <= 5, true);
  assert.doesNotMatch(JSON.stringify(summary), /artifact_large_original|artifact_large_correction|private-large/);
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
