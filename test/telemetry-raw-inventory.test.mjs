import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { saveTelemetryConfig } from "../src/telemetry-config.mjs";
import {
  appendTelemetryEvent,
  telemetryQueueDirs,
} from "../src/telemetry-queue.mjs";
import {
  formatTelemetryRawInventoryText,
  runTelemetryRawInventory,
} from "../src/telemetry-raw-inventory.mjs";

const TOKEN_ENV = "GEMINI_AGENT_TELEMETRY_TOKEN";

async function temporaryWorkspace() {
  return mkdtemp(join(tmpdir(), "gemini-agent-raw-inventory-"));
}

function telemetryEvent(index, overrides = {}) {
  const suffix = `${index}`.padStart(6, "0");
  return {
    schema_version: 1,
    event_id: `evt_raw_inventory_${suffix}`,
    trace_id: `trace_raw_inventory_${suffix}`,
    deployment_id: "dep_raw_inventory",
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

test("runTelemetryRawInventory reports aggregate raw data without exposing raw content", async () => {
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
      prompt: "review customer screen Authorization: Bearer secret-token",
      response: "raw response with private customer detail",
      payload: {
        prompt_truncated: true,
        response_truncated: false,
        multimodal: [{ basename: "private-customer-screen.png", mime_type: "image/png", byte_size: 12, media_kind: "design" }],
      },
    }),
  });
  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(2, {
      prompt: "",
      response: "",
      payload: { prompt_truncated: false, response_truncated: true, multimodal: [] },
    }),
  });
  const dirs = telemetryQueueDirs(cwd);
  await mkdir(dirs.pending, { recursive: true });
  await writeFile(join(dirs.pending, "X_API_KEY=super-secret-token.json"), "{bad json");

  const report = await runTelemetryRawInventory({ cwd, scope: "local" });
  const text = formatTelemetryRawInventoryText(report);
  const json = JSON.stringify(report);

  assert.equal(report.scope, "local");
  assert.equal(report.totals.event_count, 2);
  assert.equal(report.totals.invalid_file_count, 1);
  assert.equal(report.totals.prompt_events, 1);
  assert.equal(report.totals.response_events, 1);
  assert.equal(report.totals.truncated_prompt_events, 1);
  assert.equal(report.totals.truncated_response_events, 1);
  assert.equal(report.totals.multimodal_events, 1);
  assert.equal(report.totals.media_item_count, 1);
  assert.equal(report.totals.credential_like_prompt_events, 1);
  assert.equal(report.totals.credential_like_response_events, 0);
  assert.equal(report.states.pending.event_count, 2);
  assert.equal(report.states.pending.invalid_file_count, 1);
  assert.match(text, /Raw Telemetry Inventory/);
  assert.match(text, /No raw prompt or response content is shown/);
  for (const output of [json, text]) {
    assert.doesNotMatch(output, /secret-token/);
    assert.doesNotMatch(output, /review customer screen/);
    assert.doesNotMatch(output, /raw response with private customer detail/);
    assert.doesNotMatch(output, /evt_raw_inventory/);
    assert.doesNotMatch(output, /private-customer-screen/);
    assert.doesNotMatch(output, /X_API_KEY/);
  }
});

test("runTelemetryRawInventory skips oversized raw files without reading content", async () => {
  const cwd = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });
  const dirs = telemetryQueueDirs(cwd);
  await mkdir(dirs.pending, { recursive: true });
  await writeFile(join(dirs.pending, "oversized-secret-token.json"), "x".repeat(20));

  const report = await runTelemetryRawInventory({
    cwd,
    scope: "local",
    maxFileBytes: 10,
  });
  const serialized = JSON.stringify(report);

  assert.equal(report.totals.oversized_file_count, 1);
  assert.equal(report.totals.invalid_file_count, 0);
  assert.doesNotMatch(serialized, /oversized-secret-token/);
});

test("runTelemetryRawInventory skips unreadable queue directories without exposing names", async (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root can read chmod 000 directories");
    return;
  }

  const cwd = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });
  const dirs = telemetryQueueDirs(cwd);
  const privateDir = join(dirs.pending, "secret-customer-raw-prompts");
  await mkdir(privateDir, { recursive: true });
  await chmod(privateDir, 0o000);
  t.after(async () => {
    await chmod(privateDir, 0o700).catch(() => {});
  });

  const report = await runTelemetryRawInventory({ cwd, scope: "local" });
  const output = `${JSON.stringify(report)}\n${formatTelemetryRawInventoryText(report)}`;

  assert.equal(report.totals.skipped_file_count, 1);
  assert.doesNotMatch(output, /secret-customer-raw-prompts/);
});
