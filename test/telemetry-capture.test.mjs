import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  captureGeminiTelemetry,
  drainTelemetryCapture,
  resetTelemetryCaptureForTests,
} from "../src/telemetry-capture.mjs";
import { saveTelemetryConfig } from "../src/telemetry-config.mjs";
import { telemetryQueueDirs } from "../src/telemetry-queue.mjs";
import { normalizeTelemetryEvent } from "../src/telemetry-schemas.mjs";

async function tempDir() {
  return mkdtemp(join(tmpdir(), "gemini-agent-capture-"));
}

async function readPendingEvents(cwd) {
  const files = await readdir(telemetryQueueDirs(cwd).pending);
  return Promise.all(files.sort().map(async (file) => (
    JSON.parse(await readFile(join(telemetryQueueDirs(cwd).pending, file), "utf8"))
  )));
}

function expectedWorkspaceId(cwd) {
  return `ws_${createHash("sha256").update(cwd).digest("hex").slice(0, 24)}`;
}

test("captureGeminiTelemetry is no-op when telemetry is disabled", async () => {
  resetTelemetryCaptureForTests();
  const cwd = await tempDir();

  await captureGeminiTelemetry({
    cwd,
    command: "ask",
    prompt: "hello",
    response: "world",
    status: "success",
    latencyMs: 1,
  });
  await drainTelemetryCapture({ timeoutMs: 100 });

  await assert.rejects(() => readdir(telemetryQueueDirs(cwd).pending), /ENOENT/);
});

test("captureGeminiTelemetry writes strict raw events when config is enabled", async () => {
  resetTelemetryCaptureForTests();
  const cwd = await tempDir();
  const config = await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: "GEMINI_AGENT_TELEMETRY_TOKEN",
    userLabel: "local-admin",
    now: new Date("2026-05-29T09:00:00.000Z"),
  });

  await captureGeminiTelemetry({
    cwd,
    command: "ask",
    prompt: "hello",
    response: "world",
    status: "success",
    latencyMs: 1,
    now: new Date("2026-05-29T09:00:01.000Z"),
  });
  await drainTelemetryCapture({ timeoutMs: 1000 });

  const events = await readPendingEvents(cwd);
  assert.equal(events.length, 1);
  assert.equal(events[0].model, "gemini-3.5-flash");
  assert.equal(events[0].source, "cli");
  assert.equal(events[0].status, "success");
  assert.equal(events[0].created_at, "2026-05-29T09:00:01.000Z");
  assert.deepEqual(events[0].payload, {
    prompt_truncated: false,
    response_truncated: false,
    multimodal: [],
  });
  assert.equal(events[0].context.cwd, cwd);
  assert.equal(events[0].context.install_id, config.install_id);
  assert.equal(events[0].context.workspace_id, expectedWorkspaceId(cwd));
  assert.equal(events[0].context.user_label, "local-admin");
  assert.doesNotMatch(events[0].context.workspace_id, /gemini-agent|tmp|Users/);
  assert.equal(events[0].context.session_id, null);
  assert.equal(events[0].outcome.task_outcome, "unknown");
  assert.equal(events[0].economics.latency_bucket, "lt_1s");
});

test("captureGeminiTelemetry preserves explicit product telemetry metadata", async () => {
  resetTelemetryCaptureForTests();
  const cwd = await tempDir();
  const appended = [];

  await captureGeminiTelemetry({
    cwd,
    command: "diff-review",
    prompt: "review",
    response: "ok",
    status: "success",
    latencyMs: 6123,
    context: {
      session_id: "session-a",
      run_id: "run-2.16",
      task_id: "task-a",
      parent_codex_session: "codex-parent",
      install_id: "install_override",
      workspace_id: "ws_override",
      user_label: "override-user",
    },
    outcome: {
      task_outcome: "success",
      user_acceptance: "accepted",
      accepted_files: ["src/cli.mjs"],
      modified_after_review: false,
      followup_required: false,
    },
    economics: {
      codex_tokens_saved_estimate: 900,
      input_tokens: 11,
      output_tokens: 22,
      total_tokens: 33,
      cost_bucket: "low",
    },
    loadConfig: async () => ({ enabled: true, level: "raw", max_queue_bytes: 1024 }),
    appendEvent: async ({ event }) => appended.push(normalizeTelemetryEvent(event)),
  });

  assert.equal(appended.length, 1);
  assert.equal(appended[0].context.cwd, cwd);
  assert.equal(appended[0].context.install_id, "install_override");
  assert.equal(appended[0].context.workspace_id, "ws_override");
  assert.equal(appended[0].context.user_label, "override-user");
  assert.equal(appended[0].context.session_id, "session-a");
  assert.equal(appended[0].context.run_id, "run-2.16");
  assert.equal(appended[0].outcome.user_acceptance, "accepted");
  assert.deepEqual(appended[0].outcome.accepted_files, ["src/cli.mjs"]);
  assert.equal(appended[0].economics.codex_tokens_saved_estimate, 900);
  assert.equal(appended[0].economics.input_tokens, 11);
  assert.equal(appended[0].economics.output_tokens, 22);
  assert.equal(appended[0].economics.total_tokens, 33);
  assert.equal(appended[0].economics.latency_bucket, "5_15s");
  assert.equal(appended[0].economics.cost_bucket, "low");
});

test("captureGeminiTelemetry routes events to the global queue when only global config exists", async () => {
  resetTelemetryCaptureForTests();
  const cwd = await tempDir();
  const home = await tempDir();
  await saveTelemetryConfig({
    cwd,
    home,
    scope: "global",
    endpoint: "https://vulca-api.onrender.com/api/v1/gemini-agent/telemetry/ingest",
    tokenEnv: "GEMINI_AGENT_TELEMETRY_TOKEN",
    deploymentId: "gemini-agent-main",
    now: new Date("2026-06-03T09:00:00.000Z"),
  });

  await captureGeminiTelemetry({
    cwd,
    home,
    command: "ask",
    prompt: "global prompt",
    response: "global response",
    status: "success",
    latencyMs: 1,
    now: new Date("2026-06-03T09:00:01.000Z"),
  });
  await drainTelemetryCapture({ timeoutMs: 1000 });

  await assert.rejects(() => readdir(telemetryQueueDirs(cwd).pending), /ENOENT/);
  const events = await readPendingEvents(home);
  assert.equal(events.length, 1);
  assert.equal(events[0].deployment_id, "gemini-agent-main");
  assert.equal(events[0].prompt, "global prompt");
  assert.equal(events[0].response, "global response");
});

test("captureGeminiTelemetry passes queue byte bound and can be reset for tests", async () => {
  resetTelemetryCaptureForTests();
  const cwd = await tempDir();
  const appended = [];

  await captureGeminiTelemetry({
    cwd,
    command: "ask",
    prompt: "hello",
    response: "world",
    status: "success",
    loadConfig: async () => ({ enabled: true, level: "raw", max_queue_bytes: 1234 }),
    appendEvent: async (entry) => appended.push(entry),
  });
  await drainTelemetryCapture({ timeoutMs: 100 });

  assert.equal(appended.length, 1);
  assert.equal(appended[0].maxQueueBytes, 1234);
  resetTelemetryCaptureForTests();
  assert.doesNotThrow(() => resetTelemetryCaptureForTests());
});

test("captureGeminiTelemetry uses configured deployment id by default", async () => {
  resetTelemetryCaptureForTests();
  const cwd = await tempDir();
  const appended = [];

  await captureGeminiTelemetry({
    cwd,
    command: "ask",
    prompt: "hello",
    response: "world",
    status: "success",
    loadConfig: async () => ({
      enabled: true,
      level: "raw",
      deployment_id: "gemini-agent-main",
      max_event_bytes: 1024 * 1024,
      max_queue_bytes: 1024,
    }),
    appendEvent: async ({ event }) => appended.push(event),
  });
  await drainTelemetryCapture({ timeoutMs: 100 });

  assert.equal(appended.length, 1);
  assert.equal(appended[0].deployment_id, "gemini-agent-main");
});

test("captureGeminiTelemetry truncates raw prompt and response to max_event_bytes", async () => {
  resetTelemetryCaptureForTests();
  const cwd = await tempDir();
  const appended = [];

  await captureGeminiTelemetry({
    cwd,
    command: "ask",
    prompt: "abcdef",
    response: "ghijkl",
    status: "success",
    loadConfig: async () => ({
      enabled: true,
      level: "raw",
      max_event_bytes: 3,
      max_queue_bytes: 1024,
    }),
    appendEvent: async ({ event }) => appended.push(event),
  });

  assert.equal(appended.length, 1);
  assert.equal(appended[0].prompt, "abc");
  assert.equal(appended[0].response, "ghi");
  assert.equal(appended[0].payload.prompt_truncated, true);
  assert.equal(appended[0].payload.response_truncated, true);
});

test("captureGeminiTelemetry truncates multibyte text without malformed output", async () => {
  resetTelemetryCaptureForTests();
  const cwd = await tempDir();
  const appended = [];

  await captureGeminiTelemetry({
    cwd,
    command: "ask",
    prompt: "ééé",
    response: "ok",
    status: "success",
    loadConfig: async () => ({
      enabled: true,
      level: "raw",
      max_event_bytes: 3,
      max_queue_bytes: 1024,
    }),
    appendEvent: async ({ event }) => appended.push(event),
  });

  assert.equal(appended.length, 1);
  assert.equal(appended[0].prompt, "é");
  assert.equal(Buffer.from(appended[0].prompt, "utf8").includes(0xef), false);
  assert.equal(appended[0].payload.prompt_truncated, true);
  assert.equal(appended[0].payload.response_truncated, false);
});

test("captureGeminiTelemetry caches config lookup per cwd and loader", async () => {
  resetTelemetryCaptureForTests();
  const cwd = await tempDir();
  let loadCount = 0;
  const loadConfig = async () => {
    loadCount += 1;
    return null;
  };

  await captureGeminiTelemetry({ cwd, command: "ask", prompt: "one", response: "ok", status: "success", loadConfig });
  await captureGeminiTelemetry({ cwd, command: "ask", prompt: "two", response: "ok", status: "success", loadConfig });

  assert.equal(loadCount, 1);
});

test("captureGeminiTelemetry refreshes cached config after TTL", async () => {
  resetTelemetryCaptureForTests();
  const cwd = await tempDir();
  const appended = [];
  let loadCount = 0;
  const configs = [
    { enabled: true, level: "raw", max_queue_bytes: 1024 },
    { enabled: false, level: "raw", max_queue_bytes: 1024 },
  ];
  const loadConfig = async () => configs[Math.min(loadCount++, configs.length - 1)];

  await captureGeminiTelemetry({
    cwd,
    command: "ask",
    prompt: "one",
    response: "ok",
    status: "success",
    loadConfig,
    appendEvent: async ({ event }) => appended.push(event),
    configCacheTtlMs: 1,
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await captureGeminiTelemetry({
    cwd,
    command: "ask",
    prompt: "two",
    response: "ok",
    status: "success",
    loadConfig,
    appendEvent: async ({ event }) => appended.push(event),
    configCacheTtlMs: 1,
  });

  assert.equal(loadCount, 2);
  assert.equal(appended.length, 1);
  assert.equal(appended[0].prompt, "one");
});

test("captureGeminiTelemetry refreshes enabled config immediately after disable", async () => {
  resetTelemetryCaptureForTests();
  const cwd = await tempDir();
  const appended = [];
  let enabled = true;
  let loadCount = 0;
  const loadConfig = async () => {
    loadCount += 1;
    return enabled
      ? { enabled: true, level: "raw", max_queue_bytes: 1024 }
      : { enabled: false, level: "raw", max_queue_bytes: 1024 };
  };

  await captureGeminiTelemetry({
    cwd,
    command: "ask",
    prompt: "one",
    response: "ok",
    status: "success",
    loadConfig,
    appendEvent: async ({ event }) => appended.push(event),
    configCacheTtlMs: 60_000,
  });
  enabled = false;
  await captureGeminiTelemetry({
    cwd,
    command: "ask",
    prompt: "two",
    response: "ok",
    status: "success",
    loadConfig,
    appendEvent: async ({ event }) => appended.push(event),
    configCacheTtlMs: 60_000,
  });

  assert.equal(loadCount, 2);
  assert.equal(appended.length, 1);
  assert.equal(appended[0].prompt, "one");
});

test("captureGeminiTelemetry never throws or rejects when load or append fails", async () => {
  resetTelemetryCaptureForTests();
  const cwd = await tempDir();

  await assert.doesNotReject(() => captureGeminiTelemetry({
    cwd,
    command: "ask",
    prompt: "hello",
    response: "world",
    status: "success",
    loadConfig: async () => {
      throw new Error("config unreadable");
    },
  }));

  resetTelemetryCaptureForTests();
  await assert.doesNotReject(() => captureGeminiTelemetry({
    cwd,
    command: "ask",
    prompt: "hello",
    response: "world",
    status: "success",
    loadConfig: async () => ({ enabled: true, level: "raw", max_queue_bytes: 1024 }),
    appendEvent: async () => {
      throw new Error("disk full");
    },
  }));
  await drainTelemetryCapture({ timeoutMs: 100 });
});

test("captureGeminiTelemetry queues concurrent events without lock loss", async () => {
  resetTelemetryCaptureForTests();
  const cwd = await tempDir();
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: "GEMINI_AGENT_TELEMETRY_TOKEN",
  });

  await Promise.all(Array.from({ length: 5 }, (_, index) => captureGeminiTelemetry({
    cwd,
    command: "ask",
    prompt: `prompt ${index}`,
    response: `response ${index}`,
    status: "success",
  })));
  await drainTelemetryCapture({ timeoutMs: 1000 });

  assert.equal((await readdir(telemetryQueueDirs(cwd).pending)).length, 5);
});

test("captureGeminiTelemetry stores multimodal metadata without raw content", async () => {
  resetTelemetryCaptureForTests();
  const cwd = await tempDir();
  const appended = [];
  const contents = [
    { inlineData: { mimeType: "image/png", data: "YWJjZA==" } },
    { fileData: { mimeType: "application/pdf", fileUri: "file:///tmp/reports/audit.pdf", sha256: "already-known" } },
  ];

  await captureGeminiTelemetry({
    cwd,
    command: "artifact-review",
    prompt: "review artifact",
    response: "ok",
    status: "success",
    contents,
    loadConfig: async () => ({ enabled: true, level: "raw", max_queue_bytes: 1024 }),
    appendEvent: async ({ event }) => appended.push(normalizeTelemetryEvent(event)),
  });

  assert.equal(appended.length, 1);
  assert.deepEqual(appended[0].payload.multimodal, [
    { mime_type: "image/png", byte_size: 4 },
    { mime_type: "application/pdf", basename: "audit.pdf", sha256: "already-known" },
  ]);
  assert.doesNotMatch(JSON.stringify(appended[0].payload.multimodal), /YWJjZA/);
});
