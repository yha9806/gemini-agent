import assert from "node:assert/strict";
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
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: "GEMINI_AGENT_TELEMETRY_TOKEN",
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
