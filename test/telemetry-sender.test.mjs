import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  appendTelemetryEvent,
  loadTelemetryState,
  telemetryQueueDirs,
} from "../src/telemetry-queue.mjs";
import {
  flushTelemetryQueue,
  receiverMetrics,
  runTelemetryValidation,
} from "../src/telemetry-sender.mjs";

const ENDPOINT = "http://127.0.0.1:8787/ingest";
const TOKEN = "telemetry-token";
const NOW = new Date("2026-05-29T10:00:00.000Z");

async function temporaryWorkspace() {
  return mkdtemp(join(tmpdir(), "gemini-agent-telemetry-sender-"));
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
    created_at: "2026-05-29T09:00:00.000Z",
    payload: { prompt_truncated: false, response_truncated: false, multimodal: [] },
    ...overrides,
  };
}

async function regularFileNames(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function regularFilePaths(dir) {
  return (await regularFileNames(dir)).map((name) => join(dir, name));
}

async function readPendingEvents(cwd) {
  const { pending } = telemetryQueueDirs(cwd);
  const paths = await regularFilePaths(pending);
  return Promise.all(paths.map(async (path) => JSON.parse(await readFile(path, "utf8"))));
}

function metricsResponse(overrides = {}) {
  return {
    ok: true,
    received_events: 1,
    received_batches: 1,
    last_received_at: "2026-05-29T10:00:01.000Z",
    last_batch_id: "batch_test",
    latest_event: {
      received_at: "2026-05-29T10:00:01.000Z",
      batch_id: "batch_test",
      command: "telemetry validate",
      model: "gemini-3.5-flash",
      status: "success",
    },
    status_counts: { success: 1, error: 0 },
    ...overrides,
  };
}

test("flushTelemetryQueue sends a strict batch and completes the queue", async () => {
  const cwd = await temporaryWorkspace();
  await appendTelemetryEvent({ cwd, event: telemetryEvent(1) });
  await appendTelemetryEvent({ cwd, event: telemetryEvent(2) });

  let request;
  const fetchImpl = async (url, options) => {
    request = {
      url: `${url}`,
      method: options.method,
      headers: options.headers,
      body: JSON.parse(options.body),
    };
    return new Response(JSON.stringify({
      ok: true,
      batch_id: request.body.batch_id,
      received_count: request.body.events.length,
      received_at: "2026-05-29T10:00:01.000Z",
    }), { status: 200 });
  };

  const result = await flushTelemetryQueue({
    cwd,
    endpoint: ENDPOINT,
    token: TOKEN,
    fetchImpl,
    now: NOW,
    batchSize: 2,
  });

  assert.equal(request.url, ENDPOINT);
  assert.equal(request.method, "POST");
  assert.equal(request.headers["Content-Type"], "application/json");
  assert.equal(request.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(request.body.schema_version, 1);
  assert.match(request.body.batch_id, /^batch_/);
  assert.equal(request.body.deployment_id, "dep_test");
  assert.equal(request.body.scheduled_for, NOW.toISOString());
  assert.equal(request.body.sent_at, NOW.toISOString());
  assert.deepEqual(request.body.events.map((event) => event.event_id), ["evt_000001", "evt_000002"]);

  assert.equal(result.ok, true);
  assert.equal(result.sent_count, 2);
  assert.equal(result.batch_id, request.body.batch_id);
  assert.equal(result.ack.batch_id, request.body.batch_id);

  const dirs = telemetryQueueDirs(cwd);
  assert.deepEqual(await regularFileNames(dirs.pending), []);
  assert.deepEqual(await regularFileNames(dirs.inflight), []);
  const state = await loadTelemetryState({ cwd });
  assert.equal(state.sent_success_count, 2);
  assert.equal(state.sent_failure_count, 0);
});

test("flushTelemetryQueue returns zero without sending when queue is empty", async () => {
  const cwd = await temporaryWorkspace();
  let called = false;

  const result = await flushTelemetryQueue({
    cwd,
    endpoint: ENDPOINT,
    token: TOKEN,
    fetchImpl: async () => {
      called = true;
      throw new Error("fetch should not be called");
    },
    now: NOW,
  });

  assert.deepEqual(result, { ok: true, sent_count: 0 });
  assert.equal(called, false);
});

test("flushTelemetryQueue preserves pending queue on receiver failure", async () => {
  const cwd = await temporaryWorkspace();
  await appendTelemetryEvent({ cwd, event: telemetryEvent(3) });

  await assert.rejects(
    () => flushTelemetryQueue({
      cwd,
      endpoint: ENDPOINT,
      token: TOKEN,
      fetchImpl: async () => new Response("service unavailable", { status: 503 }),
      now: NOW,
    }),
    /Telemetry receiver returned 503\./,
  );

  assert.deepEqual((await readPendingEvents(cwd)).map((event) => event.event_id), ["evt_000003"]);
  assert.deepEqual(await regularFileNames(telemetryQueueDirs(cwd).inflight), []);
  const state = await loadTelemetryState({ cwd });
  assert.equal(state.sent_success_count, 0);
  assert.equal(state.sent_failure_count, 1);
});

test("receiverMetrics fetches metrics endpoint and validates strict metrics shape", async () => {
  let request;
  const metrics = await receiverMetrics({
    endpoint: ENDPOINT,
    token: TOKEN,
    fetchImpl: async (url, options) => {
      request = {
        url: `${url}`,
        method: options.method,
        headers: options.headers,
      };
      return new Response(JSON.stringify(metricsResponse({
        received_events: 12,
        received_batches: 3,
        last_batch_id: "batch_latest",
        status_counts: { success: 10, error: 2 },
      })), { status: 200 });
    },
  });

  assert.equal(request.url, "http://127.0.0.1:8787/metrics");
  assert.equal(request.method, "GET");
  assert.equal(request.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(metrics.ok, true);
  assert.equal(metrics.received_events, 12);
  assert.equal(metrics.received_batches, 3);
  assert.deepEqual(metrics.status_counts, { success: 10, error: 2 });
  assert.equal(metrics.clock_skew_warnings, 0);
});

test("runTelemetryValidation creates, flushes, and confirms validation event", async () => {
  const cwd = await temporaryWorkspace();
  const requests = [];
  const responseText = "telemetry-ok";
  let validationBatchId;
  const askGemini = async (prompt) => {
    assert.equal(prompt, "custom validation prompt");
    return responseText;
  };
  const fetchImpl = async (url, options) => {
    requests.push({ url: `${url}`, options });
    if (options.method === "POST") {
      const body = JSON.parse(options.body);
      assert.equal(body.events.length, 1);
      assert.equal(body.events[0].source, "validate");
      assert.equal(body.events[0].command, "telemetry validate");
      assert.equal(body.events[0].model, "gemini-3.5-flash");
      assert.equal(body.events[0].prompt, "custom validation prompt");
      assert.equal(body.events[0].response, responseText);
      assert.equal(body.events[0].created_at, NOW.toISOString());
      assert.equal(Number.isInteger(body.events[0].latency_ms), true);
      validationBatchId = body.batch_id;
      return new Response(JSON.stringify({
        ok: true,
        batch_id: body.batch_id,
        received_count: 1,
        received_at: "2026-05-29T10:00:01.000Z",
      }), { status: 200 });
    }
    return new Response(JSON.stringify(metricsResponse({
      received_events: 1,
      received_batches: 1,
      last_batch_id: validationBatchId,
      latest_event: {
        received_at: "2026-05-29T10:00:01.000Z",
        batch_id: validationBatchId,
        command: "telemetry validate",
        model: "gemini-3.5-flash",
        status: "success",
      },
      clock_skew_warnings: 0,
    })), { status: 200 });
  };

  const result = await runTelemetryValidation({
    cwd,
    endpoint: ENDPOINT,
    token: TOKEN,
    prompt: "custom validation prompt",
    askGemini,
    fetchImpl,
    now: NOW,
  });

  assert.equal(result.ok, true);
  assert.equal(result.flush.sent_count, 1);
  assert.equal(result.metrics.received_events, 1);
  assert.deepEqual(requests.map((request) => request.url), [
    ENDPOINT,
    "http://127.0.0.1:8787/metrics",
  ]);
  assert.deepEqual(await readPendingEvents(cwd), []);
});

test("runTelemetryValidation includes validation event despite default-sized backlog", async () => {
  const cwd = await temporaryWorkspace();
  const prompt = "validation backlog prompt";
  const responseText = "validation backlog response";
  let postedBatch;

  for (let index = 0; index < 100; index += 1) {
    await appendTelemetryEvent({ cwd, event: telemetryEvent(index) });
  }

  const result = await runTelemetryValidation({
    cwd,
    endpoint: ENDPOINT,
    token: TOKEN,
    prompt,
    askGemini: async () => responseText,
    fetchImpl: async (url, options) => {
      if (options.method === "POST") {
        postedBatch = JSON.parse(options.body);
        return new Response(JSON.stringify({
          ok: true,
          batch_id: postedBatch.batch_id,
          received_count: postedBatch.events.length,
          received_at: "2026-05-29T10:00:01.000Z",
        }), { status: 200 });
      }
      return new Response(JSON.stringify(metricsResponse({
        received_events: 101,
        received_batches: 7,
        last_batch_id: "batch_stale",
        latest_event: {
          received_at: "2026-05-29T10:00:01.000Z",
          batch_id: "batch_stale",
          command: "ask",
          model: "gemini-3.5-flash",
          status: "success",
        },
      })), { status: 200 });
    },
    now: NOW,
  });

  const validationEvents = postedBatch.events.filter((event) => event.source === "validate");
  assert.equal(postedBatch.events.length, 101);
  assert.equal(validationEvents.length, 1);
  assert.equal(validationEvents[0].prompt, prompt);
  assert.equal(validationEvents[0].response, responseText);
  assert.equal(result.ok, false);
  assert.equal(result.flush.batch_id, postedBatch.batch_id);
  assert.equal(result.metrics.last_batch_id, "batch_stale");

  const pendingValidationEvents = (await readPendingEvents(cwd))
    .filter((event) => event.source === "validate");
  assert.deepEqual(pendingValidationEvents, []);
});

test("flushTelemetryQueue fails batch on timeout and invalid ACK", async () => {
  const timeoutCwd = await temporaryWorkspace();
  await appendTelemetryEvent({ cwd: timeoutCwd, event: telemetryEvent(4) });
  await assert.rejects(
    () => flushTelemetryQueue({
      cwd: timeoutCwd,
      endpoint: ENDPOINT,
      token: TOKEN,
      timeoutMs: 1,
      fetchImpl: (url, options) => new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
      now: NOW,
    }),
    /aborted/,
  );
  assert.deepEqual((await readPendingEvents(timeoutCwd)).map((event) => event.event_id), ["evt_000004"]);

  const ackCwd = await temporaryWorkspace();
  await appendTelemetryEvent({ cwd: ackCwd, event: telemetryEvent(5) });
  await assert.rejects(
    () => flushTelemetryQueue({
      cwd: ackCwd,
      endpoint: ENDPOINT,
      token: TOKEN,
      fetchImpl: async () => new Response(JSON.stringify({
        ok: true,
        batch_id: "batch_other",
        received_count: 1,
        received_at: "2026-05-29T10:00:01.000Z",
      }), { status: 200 }),
      now: NOW,
    }),
    /batch_id does not match/,
  );
  assert.deepEqual((await readPendingEvents(ackCwd)).map((event) => event.event_id), ["evt_000005"]);
});

test("receiverMetrics rejects invalid metrics response", async () => {
  await assert.rejects(
    () => receiverMetrics({
      endpoint: ENDPOINT,
      token: TOKEN,
      fetchImpl: async () => new Response(JSON.stringify({
        ok: true,
        received_events: 1,
        received_batches: 1,
        last_received_at: null,
        last_batch_id: null,
        latest_event: null,
      }), { status: 200 }),
    }),
    /status_counts/,
  );
});
