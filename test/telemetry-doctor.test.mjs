import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { saveTelemetryConfig } from "../src/telemetry-config.mjs";
import { appendTelemetryEvent } from "../src/telemetry-queue.mjs";
import { runTelemetryDoctor } from "../src/telemetry-doctor.mjs";

const TOKEN_ENV = "GEMINI_AGENT_TELEMETRY_TOKEN";

async function temporaryWorkspace() {
  return mkdtemp(join(tmpdir(), "gemini-agent-telemetry-doctor-"));
}

function telemetryEvent(index) {
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
    created_at: "2026-06-03T09:00:00.000Z",
    payload: { prompt_truncated: false, response_truncated: false, multimodal: [] },
  };
}

test("runTelemetryDoctor reports disabled config without throwing", async () => {
  const cwd = await temporaryWorkspace();

  const result = await runTelemetryDoctor({
    cwd,
    scope: "local",
    env: {},
    fetchImpl: async () => {
      throw new Error("fetch should not be called");
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.config.enabled, false);
  assert.equal(result.checks.config_enabled.ok, false);
  assert.equal(result.checks.token_env_present.ok, false);
  assert.equal(result.small_flush_safe, false);
});

test("runTelemetryDoctor reports token, endpoint health, queue, and recommendation", async () => {
  const cwd = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });
  await appendTelemetryEvent({ cwd, event: telemetryEvent(1) });

  let requestedUrl;
  const result = await runTelemetryDoctor({
    cwd,
    scope: "local",
    env: { [TOKEN_ENV]: "telemetry-token" },
    fetchImpl: async (url) => {
      requestedUrl = `${url}`;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  });

  assert.equal(requestedUrl, "http://127.0.0.1:8787/health");
  assert.equal(result.ok, true);
  assert.equal(result.config.enabled, true);
  assert.equal(result.checks.token_env_present.ok, true);
  assert.equal(result.checks.endpoint_valid.ok, true);
  assert.equal(result.endpoint_check.ok, true);
  assert.equal(result.queue.pending.count, 1);
  assert.equal(result.small_flush_safe, true);
  assert.equal(result.recommended_action, "Run telemetry flush --dry-run, then telemetry flush --batch-size 1.");
});

test("runTelemetryDoctor treats health endpoint failure as diagnostic only", async () => {
  const cwd = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });
  await appendTelemetryEvent({ cwd, event: telemetryEvent(2) });

  const result = await runTelemetryDoctor({
    cwd,
    scope: "local",
    env: { [TOKEN_ENV]: "telemetry-token" },
    fetchImpl: async () => new Response("method not allowed", { status: 405 }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.endpoint_check.ok, false);
  assert.equal(result.endpoint_check.status, 405);
  assert.equal(result.small_flush_safe, true);
});
