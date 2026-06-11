import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { saveTelemetryConfig } from "../src/telemetry-config.mjs";
import {
  appendTelemetryEvent,
  archiveFailedTelemetryEvents,
  claimTelemetryBatch,
  failTelemetryBatch,
  quarantineTelemetryEvent,
  telemetryQueueDirs,
} from "../src/telemetry-queue.mjs";
import { runTelemetryDoctor } from "../src/telemetry-doctor.mjs";

const TOKEN_ENV = "GEMINI_AGENT_TELEMETRY_TOKEN";
const CONFIG_RELATIVE_PATH = ".gemini-agent/telemetry/config.json";

async function temporaryWorkspace() {
  return mkdtemp(join(tmpdir(), "gemini-agent-telemetry-doctor-"));
}

async function writeTelemetryConfigText(cwd, text) {
  await mkdir(join(cwd, ".gemini-agent/telemetry"), { recursive: true });
  await writeFile(join(cwd, CONFIG_RELATIVE_PATH), text);
}

async function writeTelemetryConfig(cwd, config) {
  await writeTelemetryConfigText(cwd, `${JSON.stringify(config, null, 2)}\n`);
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
    created_at: "2026-06-03T09:00:00.000Z",
    payload: { prompt_truncated: false, response_truncated: false, multimodal: [] },
    ...overrides,
  };
}

function telemetryConfig(overrides = {}) {
  return {
    enabled: true,
    level: "raw",
    endpoint: "http://127.0.0.1:8787/ingest",
    token_env: TOKEN_ENV,
    deployment_id: "gemini-agent-main",
    schedule: "daily@09:00",
    created_at: "2026-06-03T09:00:00.000Z",
    updated_at: "2026-06-03T09:00:00.000Z",
    ...overrides,
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

test("runTelemetryDoctor does not create queue directories for empty diagnostics", async () => {
  const cwd = await temporaryWorkspace();

  await runTelemetryDoctor({
    cwd,
    scope: "local",
    env: {},
    fetchImpl: async () => {
      throw new Error("fetch should not be called");
    },
  });

  assert.equal(await pathExists(join(cwd, ".gemini-agent/telemetry/queue")), false);
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
  let requestOptions;
  const result = await runTelemetryDoctor({
    cwd,
    scope: "local",
    env: { [TOKEN_ENV]: "telemetry-token" },
    fetchImpl: async (url, options) => {
      requestedUrl = `${url}`;
      requestOptions = options;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  });

  assert.equal(requestedUrl, "http://127.0.0.1:8787/health");
  assert.equal(requestOptions.method, "GET");
  assert.equal(Object.hasOwn(requestOptions, "body"), false);
  assert.ok(requestOptions.signal instanceof AbortSignal);
  assert.equal(result.ok, true);
  assert.equal(result.config.enabled, true);
  assert.equal(result.checks.token_env_present.ok, true);
  assert.equal(result.checks.endpoint_valid.ok, true);
  assert.equal(result.endpoint_check.ok, true);
  assert.equal(result.queue.pending.count, 1);
  assert.equal(result.small_flush_safe, true);
  assert.equal(result.recommended_action, "Run telemetry flush --dry-run, then telemetry flush --batch-size 1.");
});

test("runTelemetryDoctor reports delivery diagnostics without raw content", async () => {
  const cwd = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });
  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(30, {
      event_id: "evt_private_failed",
      prompt: "private prompt text must not appear",
      response: "private response text must not appear",
    }),
  });
  await appendTelemetryEvent({ cwd, event: telemetryEvent(31) });

  const batch = await claimTelemetryBatch({
    cwd,
    batchSize: 1,
    now: new Date("2026-06-10T09:00:00.000Z"),
  });
  await failTelemetryBatch({
    cwd,
    batchId: batch.batchId,
    retryable: false,
    reason: "unauthorized",
  });

  const result = await runTelemetryDoctor({
    cwd,
    scope: "local",
    env: { [TOKEN_ENV]: "telemetry-token" },
    fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  });

  assert.equal(result.delivery.status, "blocked_by_non_retryable_failures");
  assert.equal(result.delivery.local_total_events, 2);
  assert.equal(result.delivery.sent_events, 0);
  assert.equal(result.delivery.pending_events, 1);
  assert.equal(result.delivery.inflight_events, 0);
  assert.equal(result.delivery.failed_events, 1);
  assert.equal(result.delivery.quarantine_events, 0);
  assert.equal(result.delivery.unsent_events, 2);
  assert.equal(result.delivery.sent_failure_count, 1);
  assert.equal(result.delivery.non_retryable_failure_count, 1);
  assert.equal(result.delivery.last_failure_reason, "unauthorized");
  assert.deepEqual(result.delivery.failed_reason_counts.map((item) => ({
    reason: item.reason,
    batch_count: item.batch_count,
    event_count: item.event_count,
  })), [
    {
      reason: "unauthorized",
      batch_count: 1,
      event_count: 1,
    },
  ]);
  assert.ok(result.delivery.failed_reason_counts[0].bytes > 0);
  assert.match(result.delivery.recommended_action, /Inspect failed reasons/);

  const serializedDelivery = JSON.stringify(result.delivery);
  assert.equal(serializedDelivery.includes("private prompt text must not appear"), false);
  assert.equal(serializedDelivery.includes("private response text must not appear"), false);
  assert.equal(serializedDelivery.includes("evt_private_failed"), false);
  assert.equal(serializedDelivery.includes(batch.batchId), false);
});

test("runTelemetryDoctor points quarantined queues at quarantine inspect", async () => {
  const cwd = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });
  const event = await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(303, {
      event_id: "evt_private_quarantine",
      prompt: "private quarantine prompt",
      response: "private quarantine response",
    }),
  });
  await quarantineTelemetryEvent({
    cwd,
    eventId: event.event_id,
    reason: "repeated_http_403",
  });

  const result = await runTelemetryDoctor({
    cwd,
    scope: "local",
    env: { [TOKEN_ENV]: "telemetry-token" },
    fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  });

  const expected = "Run telemetry quarantine inspect --json, then telemetry quarantine archive --reason <reason> --dry-run before --write for resolved receiver-policy cases.";
  assert.equal(result.delivery.status, "quarantined_events_present");
  assert.equal(result.delivery.quarantine_events, 1);
  assert.equal(result.delivery.recommended_action, expected);
  assert.equal(result.recommended_action, expected);

  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /evt_private_quarantine/);
  assert.doesNotMatch(serialized, /private quarantine prompt/);
  assert.doesNotMatch(serialized, /private quarantine response/);
});

test("runTelemetryDoctor does not block on archived historical non-retryable failures", async () => {
  const cwd = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });
  await appendTelemetryEvent({ cwd, event: telemetryEvent(33) });
  await appendTelemetryEvent({ cwd, event: telemetryEvent(34) });

  const batch = await claimTelemetryBatch({
    cwd,
    batchSize: 1,
    now: new Date("2026-06-10T09:10:00.000Z"),
  });
  await failTelemetryBatch({
    cwd,
    batchId: batch.batchId,
    retryable: false,
    reason: "unauthorized",
  });
  await archiveFailedTelemetryEvents({
    cwd,
    reason: "unauthorized",
    batchSize: 1,
    dryRun: false,
  });

  const result = await runTelemetryDoctor({
    cwd,
    scope: "local",
    env: { [TOKEN_ENV]: "telemetry-token" },
    fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  });

  assert.equal(result.delivery.failed_events, 0);
  assert.equal(result.delivery.non_retryable_failure_count, 1);
  assert.equal(result.delivery.pending_events, 1);
  assert.equal(result.delivery.status, "flush_ready");
  assert.match(result.delivery.recommended_action, /telemetry flush --dry-run/);
});

test("runTelemetryDoctor treats malformed failed reason as unknown", async () => {
  const cwd = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });
  await appendTelemetryEvent({ cwd, event: telemetryEvent(32) });
  const batch = await claimTelemetryBatch({
    cwd,
    batchSize: 1,
    now: new Date("2026-06-10T09:05:00.000Z"),
  });
  await failTelemetryBatch({
    cwd,
    batchId: batch.batchId,
    retryable: false,
    reason: "http_422",
  });
  await writeFile(
    join(telemetryQueueDirs(cwd).failed, batch.batchId, "reason.json"),
    "{ this is not valid json\n",
  );

  const result = await runTelemetryDoctor({
    cwd,
    scope: "local",
    env: { [TOKEN_ENV]: "telemetry-token" },
    fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  });

  assert.equal(result.delivery.status, "blocked_by_non_retryable_failures");
  assert.deepEqual(result.delivery.failed_reason_counts.map((item) => ({
    reason: item.reason,
    batch_count: item.batch_count,
    event_count: item.event_count,
  })), [
    {
      reason: "unknown",
      batch_count: 1,
      event_count: 1,
    },
  ]);
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

test("runTelemetryDoctor reports invalid endpoint config without throwing or fetching", async () => {
  const cwd = await temporaryWorkspace();
  await writeTelemetryConfig(cwd, telemetryConfig({
    endpoint: "http://example.com/ingest",
  }));
  await appendTelemetryEvent({ cwd, event: telemetryEvent(3) });

  let fetchCalled = false;
  const result = await runTelemetryDoctor({
    cwd,
    scope: "local",
    env: { [TOKEN_ENV]: "telemetry-token" },
    fetchImpl: async () => {
      fetchCalled = true;
      throw new Error("fetch should not be called");
    },
  });

  assert.equal(fetchCalled, false);
  assert.equal(result.ok, false);
  assert.equal(result.config.enabled, true);
  assert.equal(result.checks.config_valid.ok, false);
  assert.equal(result.checks.endpoint_valid.ok, false);
  assert.match(result.checks.endpoint_valid.message, /Non-loopback telemetry endpoints must use HTTPS/);
  assert.equal(result.endpoint_check.skipped, true);
  assert.equal(result.small_flush_safe, false);
  assert.equal(result.recommended_action, "Fix the telemetry endpoint URL.");
});

test("runTelemetryDoctor reports malformed config JSON without throwing or fetching", async () => {
  const cwd = await temporaryWorkspace();
  await writeTelemetryConfigText(cwd, "{ this is not json\n");

  let fetchCalled = false;
  const result = await runTelemetryDoctor({
    cwd,
    scope: "local",
    env: { [TOKEN_ENV]: "telemetry-token" },
    fetchImpl: async () => {
      fetchCalled = true;
      throw new Error("fetch should not be called");
    },
  });

  assert.equal(fetchCalled, false);
  assert.equal(result.ok, false);
  assert.equal(result.config.enabled, false);
  assert.equal(result.checks.config_valid.ok, false);
  assert.match(result.checks.config_valid.message, /Telemetry config is not valid JSON/);
  assert.equal(result.checks.endpoint_valid.ok, false);
  assert.equal(result.endpoint_check.skipped, true);
  assert.equal(result.small_flush_safe, false);
  assert.equal(result.recommended_action, "Fix the telemetry config.");
});

test("runTelemetryDoctor rejects forbidden token env names before health or flush recommendation", async () => {
  const cwd = await temporaryWorkspace();
  await writeTelemetryConfig(cwd, telemetryConfig({
    token_env: "GEMINI_API_KEY",
  }));
  await appendTelemetryEvent({ cwd, event: telemetryEvent(4) });

  let fetchCalled = false;
  const result = await runTelemetryDoctor({
    cwd,
    scope: "local",
    env: { GEMINI_API_KEY: "gemini-api-key" },
    fetchImpl: async () => {
      fetchCalled = true;
      throw new Error("fetch should not be called");
    },
  });

  assert.equal(fetchCalled, false);
  assert.equal(result.ok, false);
  assert.equal(result.checks.config_valid.ok, false);
  assert.equal(result.checks.token_env_valid.ok, false);
  assert.equal(result.checks.token_env_present.ok, false);
  assert.match(result.checks.token_env_valid.message, /must not be GEMINI_API_KEY/);
  assert.equal(result.endpoint_check.skipped, true);
  assert.equal(result.small_flush_safe, false);
  assert.equal(result.recommended_action, "Fix the telemetry token environment variable name.");
});

test("runTelemetryDoctor rejects inherited token env values like flush does", async () => {
  const cwd = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });
  await appendTelemetryEvent({ cwd, event: telemetryEvent(5) });

  const env = Object.create({ [TOKEN_ENV]: "inherited-token" });
  let fetchCalled = false;
  const result = await runTelemetryDoctor({
    cwd,
    scope: "local",
    env,
    fetchImpl: async () => {
      fetchCalled = true;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  });

  assert.equal(fetchCalled, true);
  assert.equal(result.ok, false);
  assert.equal(result.checks.config_valid.ok, true);
  assert.equal(result.checks.token_env_valid.ok, true);
  assert.equal(result.checks.token_env_present.ok, false);
  assert.match(result.checks.token_env_present.message, /is not set/);
  assert.equal(result.endpoint_check.ok, true);
  assert.equal(result.small_flush_safe, false);
  assert.equal(result.recommended_action, "Set the configured telemetry token environment variable.");
});

test("runTelemetryDoctor does not echo unknown fields from invalid config diagnostics", async () => {
  const cwd = await temporaryWorkspace();
  await writeTelemetryConfig(cwd, telemetryConfig({
    token: "secret-value",
    extra: "hidden",
  }));

  const result = await runTelemetryDoctor({
    cwd,
    scope: "local",
    env: { [TOKEN_ENV]: "telemetry-token" },
    fetchImpl: async () => {
      throw new Error("fetch should not be called");
    },
  });

  const serializedConfig = JSON.stringify(result.config);
  assert.equal(result.ok, false);
  assert.equal(result.checks.config_valid.ok, false);
  assert.equal(result.checks.config_valid.message.includes("token"), false);
  assert.equal(result.checks.config_valid.message.includes("extra"), false);
  assert.equal(result.checks.config_valid.message.includes("secret-value"), false);
  assert.equal(result.checks.config_valid.message.includes("hidden"), false);
  assert.equal(serializedConfig.includes("secret-value"), false);
  assert.equal(serializedConfig.includes("hidden"), false);
  assert.equal(Object.hasOwn(result.config, "token"), false);
  assert.equal(Object.hasOwn(result.config, "extra"), false);
});

test("runTelemetryDoctor uses supplied home for global config lookup", async () => {
  const cwd = await temporaryWorkspace();
  const home = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd,
    home,
    scope: "global",
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });
  await appendTelemetryEvent({ cwd: home, event: telemetryEvent(4) });

  const result = await runTelemetryDoctor({
    cwd,
    home,
    scope: "global",
    env: { [TOKEN_ENV]: "telemetry-token" },
    fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  });

  assert.equal(result.scope, "global");
  assert.equal(result.storage_cwd, home);
  assert.equal(result.ok, true);
  assert.equal(result.queue.pending.count, 1);
});

test("runTelemetryDoctor auto scope keeps enabled local config ahead of invalid global config", async () => {
  const cwd = await temporaryWorkspace();
  const home = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd,
    home,
    scope: "local",
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "local-telemetry",
  });
  await writeTelemetryConfig(home, telemetryConfig({
    endpoint: "http://example.com/ingest",
    deployment_id: "global-telemetry",
  }));

  let requestedUrl;
  const result = await runTelemetryDoctor({
    cwd,
    home,
    scope: "auto",
    env: { [TOKEN_ENV]: "telemetry-token" },
    fetchImpl: async (url) => {
      requestedUrl = `${url}`;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  });

  assert.equal(requestedUrl, "http://127.0.0.1:8787/health");
  assert.equal(result.scope, "local");
  assert.equal(result.storage_cwd, cwd);
  assert.equal(result.config.deployment_id, "local-telemetry");
  assert.equal(result.ok, true);
});

test("runTelemetryDoctor aborts stalled endpoint health checks", { timeout: 1000 }, async () => {
  const cwd = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });

  let observedAbort = false;
  const result = await runTelemetryDoctor({
    cwd,
    scope: "local",
    env: { [TOKEN_ENV]: "telemetry-token" },
    timeoutMs: 5,
    fetchImpl: async (url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => {
        observedAbort = true;
        reject(signal.reason);
      }, { once: true });
    }),
  });

  assert.equal(observedAbort, true);
  assert.equal(result.ok, true);
  assert.equal(result.endpoint_check.ok, false);
  assert.match(result.endpoint_check.error, /timed out/);
});
