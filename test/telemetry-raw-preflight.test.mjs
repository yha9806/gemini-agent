import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { saveTelemetryConfig } from "../src/telemetry-config.mjs";
import {
  appendTelemetryEvent,
  telemetryQueueDirs,
} from "../src/telemetry-queue.mjs";
import {
  formatTelemetryRawPreflightText,
  runTelemetryRawPreflight,
} from "../src/telemetry-raw-preflight.mjs";

const TOKEN_ENV = "GEMINI_AGENT_TELEMETRY_TOKEN";

async function temporaryWorkspace() {
  return mkdtemp(join(tmpdir(), "gemini-agent-raw-preflight-"));
}

function telemetryEvent(index, overrides = {}) {
  const suffix = `${index}`.padStart(6, "0");
  return {
    schema_version: 1,
    event_id: `evt_raw_preflight_${suffix}`,
    trace_id: `trace_raw_preflight_${suffix}`,
    deployment_id: "dep_raw_preflight",
    project_id: "gemini-agent",
    source: "cli",
    command: "artifact-review",
    model: "gemini-3.5-flash",
    prompt: `prompt ${suffix}`,
    response: `response ${suffix}`,
    status: "success",
    error_type: null,
    latency_ms: 1,
    created_at: "2026-06-10T09:00:00.000Z",
    payload: { prompt_truncated: false, response_truncated: false, multimodal: [] },
    ...overrides,
  };
}

test("runTelemetryRawPreflight reports pending upload risk without exposing raw content", async () => {
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
      prompt: "review Authorization: Bearer secret-token",
      response: "private response should not print",
      payload: {
        prompt_truncated: true,
        response_truncated: false,
        multimodal: [{ basename: "private-screen.png", mime_type: "image/png", byte_size: 12, media_kind: "screenshot" }],
      },
    }),
  });
  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(2, {
      prompt: "second prompt should not print",
      response: "second response should not print",
    }),
  });

  const report = await runTelemetryRawPreflight({
    cwd,
    scope: "local",
    batchSize: 1,
    now: new Date("2026-06-10T12:00:00.000Z"),
  });
  const output = `${JSON.stringify(report)}\n${formatTelemetryRawPreflightText(report)}`;

  assert.equal(report.ok, true);
  assert.equal(report.scope, "local");
  assert.equal(report.pending.total_count, 2);
  assert.equal(report.batch.would_send_count, 1);
  assert.equal(report.batch.excluded_by_batch_size_count, 1);
  assert.equal(report.risk.event_count, 1);
  assert.equal(report.risk.prompt_events, 1);
  assert.equal(report.risk.response_events, 1);
  assert.equal(report.risk.truncated_prompt_events, 1);
  assert.equal(report.risk.multimodal_events, 1);
  assert.equal(report.risk.media_item_count, 1);
  assert.equal(report.risk.credential_like_prompt_events, 1);
  assert.equal(report.risk.credential_like_response_events, 0);
  assert.match(report.next_command, /telemetry flush --dry-run/);
  assert.doesNotMatch(report.next_command, /--global/);
  assert.equal((await readdir(telemetryQueueDirs(cwd).pending)).length, 2);
  for (const value of [output]) {
    assert.doesNotMatch(value, /secret-token/);
    assert.doesNotMatch(value, /private response should not print/);
    assert.doesNotMatch(value, /second prompt should not print/);
    assert.doesNotMatch(value, /evt_raw_preflight/);
    assert.doesNotMatch(value, /private-screen/);
    assert.doesNotMatch(value, /queue\/pending/);
  }
});

test("runTelemetryRawPreflight reports invalid pending files without exposing filenames", async () => {
  const cwd = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });
  const dirs = telemetryQueueDirs(cwd);
  await mkdir(dirs.pending, { recursive: true });
  await writeFile(join(dirs.pending, "PRIVATE_API_KEY=secret.json"), "{bad json");

  const report = await runTelemetryRawPreflight({ cwd, scope: "local", batchSize: 1 });
  const output = JSON.stringify(report);

  assert.equal(report.pending.total_count, 1);
  assert.equal(report.batch.would_send_count, 0);
  assert.equal(report.risk.invalid_file_count, 1);
  assert.doesNotMatch(output, /PRIVATE_API_KEY=secret|bad json/);
});

test("runTelemetryRawPreflight mirrors flush max-bytes preview without sending", async () => {
  const cwd = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });
  await appendTelemetryEvent({ cwd, event: telemetryEvent(1) });

  const report = await runTelemetryRawPreflight({
    cwd,
    scope: "local",
    batchSize: 1,
    maxBytes: 10,
  });

  assert.equal(report.batch.would_send_count, 1);
  assert.equal(report.batch.exceeds_max_bytes, true);
  assert.equal(report.risk.event_count, 1);
  assert.equal((await readdir(telemetryQueueDirs(cwd).pending)).length, 1);
});

test("runTelemetryRawPreflight rejects invalid bounds", async () => {
  const cwd = await temporaryWorkspace();
  await assert.rejects(
    () => runTelemetryRawPreflight({ cwd, scope: "local", batchSize: 0 }),
    /batchSize must be a positive integer/,
  );
  await assert.rejects(
    () => runTelemetryRawPreflight({ cwd, scope: "local", maxBytes: 0 }),
    /maxBytes must be a positive integer/,
  );
});
