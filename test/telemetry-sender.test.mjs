import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
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

async function directoryNames(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
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
  assert.equal(request.body.schema_version, "raw-v1");
  assert.match(request.body.batch_id, /^batch_/);
  assert.equal(request.body.deployment_id, "dep_test");
  assert.equal(request.body.agent_version, "0.1.0");
  assert.equal(request.body.generated_at, NOW.toISOString());
  assert.match(request.body.checksum, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(request.body.events.map((event) => event.event_id), ["evt_000001", "evt_000002"]);
  assert.deepEqual(request.body.events.map((event) => event.prompt_raw), ["prompt 000001", "prompt 000002"]);
  assert.deepEqual(request.body.events.map((event) => event.source_host_app), ["cli", "cli"]);
  assert.deepEqual(request.body.events.map((event) => event.trigger_source), ["manual", "manual"]);

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

test("flushTelemetryQueue maps MCP legacy events to raw-v1 source fields", async () => {
  const cwd = await temporaryWorkspace();
  await appendTelemetryEvent({ cwd, event: telemetryEvent(18, { source: "mcp" }) });

  let postedEvent;
  await flushTelemetryQueue({
    cwd,
    endpoint: ENDPOINT,
    token: TOKEN,
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      postedEvent = body.events[0];
      return new Response(JSON.stringify({
        ok: true,
        batch_id: body.batch_id,
        received_count: body.events.length,
        received_at: "2026-05-29T10:00:01.000Z",
      }), { status: 200 });
    },
    now: NOW,
  });

  assert.equal(postedEvent.source_host_app, "mcp");
  assert.equal(postedEvent.trigger_source, "mcp");
});

test("flushTelemetryQueue rejects missing token before claiming queued events", async () => {
  const cwd = await temporaryWorkspace();
  await appendTelemetryEvent({ cwd, event: telemetryEvent(9) });
  let called = false;

  await assert.rejects(
    () => flushTelemetryQueue({
      cwd,
      endpoint: ENDPOINT,
      fetchImpl: async () => {
        called = true;
        throw new Error("fetch should not be called");
      },
      now: NOW,
    }),
    /Telemetry token must be a non-empty string\./,
  );

  assert.equal(called, false);
  assert.deepEqual((await readPendingEvents(cwd)).map((event) => event.event_id), ["evt_000009"]);
  assert.deepEqual(await regularFileNames(telemetryQueueDirs(cwd).inflight), []);
  const state = await loadTelemetryState({ cwd });
  assert.equal(state.sent_failure_count, 0);
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

test("flushTelemetryQueue surfaces post-ACK completion failure without failing the batch", async () => {
  const cwd = await temporaryWorkspace();
  await appendTelemetryEvent({ cwd, event: telemetryEvent(6) });
  const dirs = telemetryQueueDirs(cwd);

  await assert.rejects(
    () => flushTelemetryQueue({
      cwd,
      endpoint: ENDPOINT,
      token: TOKEN,
      fetchImpl: async (url, options) => {
        const body = JSON.parse(options.body);
        await writeFile(join(dirs.sent, "2026-05-29"), "not a directory\n");
        return new Response(JSON.stringify({
          ok: true,
          batch_id: body.batch_id,
          received_count: body.events.length,
          received_at: "2026-05-29T10:00:01.000Z",
        }), { status: 200 });
      },
      now: NOW,
    }),
    /EEXIST|not a directory|ENOTDIR/,
  );

  assert.deepEqual(await readPendingEvents(cwd), []);
  assert.equal((await directoryNames(dirs.inflight)).length, 1);
  const state = await loadTelemetryState({ cwd });
  assert.equal(state.sent_success_count, 0);
  assert.equal(state.sent_failure_count, 0);
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

test("receiverMetrics rejects empty token before fetching", async () => {
  let called = false;

  await assert.rejects(
    () => receiverMetrics({
      endpoint: ENDPOINT,
      token: " ",
      fetchImpl: async () => {
        called = true;
        throw new Error("fetch should not be called");
      },
    }),
    /Telemetry token must be a non-empty string\./,
  );

  assert.equal(called, false);
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
      assert.equal(body.events[0].schema_version, undefined);
      assert.equal(body.events[0].source_host_app, "cli");
      assert.equal(body.events[0].trigger_source, "manual");
      assert.equal(body.events[0].command, "telemetry validate");
      assert.equal(body.events[0].model, "gemini-3.5-flash");
      assert.equal(body.events[0].prompt_raw, "custom validation prompt");
      assert.equal(body.events[0].response_raw, responseText);
      assert.equal(body.events[0].started_at, NOW.toISOString());
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

test("runTelemetryValidation treats protected metrics as optional after ingest ACK", async () => {
  const cwd = await temporaryWorkspace();
  let validationBatchId;
  const requests = [];

  const result = await runTelemetryValidation({
    cwd,
    endpoint: ENDPOINT,
    token: TOKEN,
    prompt: "validation prompt with protected metrics",
    askGemini: async () => "telemetry-ok",
    fetchImpl: async (url, options) => {
      requests.push({ url: `${url}`, method: options.method ?? "GET" });
      if (options.method === "POST") {
        const body = JSON.parse(options.body);
        validationBatchId = body.batch_id;
        return new Response(JSON.stringify({
          ok: true,
          batch_id: body.batch_id,
          accepted_event_ids: body.events.map((event) => event.event_id),
          rejected: [],
          received_at: "2026-05-29T10:00:01.000Z",
        }), { status: 200 });
      }

      return new Response(JSON.stringify({ detail: "Not authenticated" }), { status: 401 });
    },
    now: NOW,
  });

  assert.equal(result.ok, true);
  assert.equal(result.flush.batch_id, validationBatchId);
  assert.equal(result.flush.sent_count, 1);
  assert.equal(result.metrics, null);
  assert.match(result.metrics_warning.message, /Telemetry receiver returned 401\./);
  assert.deepEqual(requests.map((request) => request.url), [
    ENDPOINT,
    "http://127.0.0.1:8787/metrics",
  ]);
  assert.deepEqual(await readPendingEvents(cwd), []);
});

test("runTelemetryValidation rejects missing token before askGemini or queue append", async () => {
  const cwd = await temporaryWorkspace();
  let called = false;

  await assert.rejects(
    () => runTelemetryValidation({
      cwd,
      endpoint: ENDPOINT,
      token: "",
      askGemini: async () => {
        called = true;
        return "telemetry-ok";
      },
      fetchImpl: async () => {
        throw new Error("fetch should not be called");
      },
      now: NOW,
    }),
    /Telemetry token must be a non-empty string\./,
  );

  assert.equal(called, false);
  assert.deepEqual(await readPendingEvents(cwd), []);
});

test("runTelemetryValidation uses configured deployment id for validation batches", async () => {
  const cwd = await temporaryWorkspace();
  let requestBody;

  const result = await runTelemetryValidation({
    cwd,
    endpoint: ENDPOINT,
    token: TOKEN,
    deploymentId: "gemini-agent-main",
    askGemini: async () => "telemetry-ok",
    fetchImpl: async (url, options) => {
      if (options.method === "POST") {
        requestBody = JSON.parse(options.body);
        return new Response(JSON.stringify({
          ok: true,
          batch_id: requestBody.batch_id,
          received_count: requestBody.events.length,
          received_at: "2026-05-29T10:00:01.000Z",
        }), { status: 200 });
      }

      return new Response(JSON.stringify(metricsResponse({
        received_events: 1,
        received_batches: 1,
        last_batch_id: requestBody.batch_id,
        latest_event: {
          received_at: "2026-05-29T10:00:01.000Z",
          batch_id: requestBody.batch_id,
          command: "telemetry validate",
          model: "gemini-3.5-flash",
          status: "success",
        },
      })), { status: 200 });
    },
    now: NOW,
  });

  assert.equal(result.ok, true);
  assert.equal(requestBody.deployment_id, "gemini-agent-main");
});

test("runTelemetryValidation rejects invalid endpoint before askGemini or queue append", async () => {
  const cwd = await temporaryWorkspace();
  let called = false;

  await assert.rejects(
    () => runTelemetryValidation({
      cwd,
      endpoint: "ftp://example.test/ingest",
      token: TOKEN,
      askGemini: async () => {
        called = true;
        return "telemetry-ok";
      },
      fetchImpl: async () => {
        throw new Error("fetch should not be called");
      },
      now: NOW,
    }),
    /Telemetry endpoint must use HTTP or HTTPS\./,
  );

  assert.equal(called, false);
  assert.deepEqual(await readPendingEvents(cwd), []);
});

test("runTelemetryValidation returns false for inconsistent validation metrics", async () => {
  const cases = [
    ["missing received events", { received_events: 0 }],
    ["missing received batches", { received_batches: 0 }],
    ["missing latest event", { latest_event: null }],
    ["wrong latest batch", { latest_event: { batch_id: "batch_other" } }],
    ["wrong latest command", { latest_event: { command: "ask" } }],
    ["wrong latest status", { latest_event: { status: "error" } }],
  ];

  for (const [name, metricsOverrides] of cases) {
    const cwd = await temporaryWorkspace();
    let validationBatchId;
    const result = await runTelemetryValidation({
      cwd,
      endpoint: ENDPOINT,
      token: TOKEN,
      prompt: `validation prompt ${name}`,
      askGemini: async () => "telemetry-ok",
      fetchImpl: async (url, options) => {
        if (options.method === "POST") {
          const body = JSON.parse(options.body);
          validationBatchId = body.batch_id;
          return new Response(JSON.stringify({
            ok: true,
            batch_id: body.batch_id,
            received_count: body.events.length,
            received_at: "2026-05-29T10:00:01.000Z",
          }), { status: 200 });
        }

        const baseLatestEvent = {
          received_at: "2026-05-29T10:00:01.000Z",
          batch_id: validationBatchId,
          command: "telemetry validate",
          model: "gemini-3.5-flash",
          status: "success",
        };
        const latestOverride = metricsOverrides.latest_event;
        const latest_event = latestOverride === null
          ? null
          : { ...baseLatestEvent, ...(latestOverride ?? {}) };
        return new Response(JSON.stringify(metricsResponse({
          received_events: 1,
          received_batches: 1,
          last_batch_id: validationBatchId,
          ...metricsOverrides,
          latest_event,
        })), { status: 200 });
      },
      now: NOW,
    });

    assert.equal(result.ok, false, name);
  }
});

test("runTelemetryValidation uses bounded flushes until default-sized backlog validation is sent", async () => {
  const cwd = await temporaryWorkspace();
  const prompt = "validation backlog prompt";
  const responseText = "validation backlog response";
  const postedBatches = [];
  let validationBatch;

  for (let index = 0; index < 1000; index += 1) {
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
        const postedBatch = JSON.parse(options.body);
        postedBatches.push(postedBatch);
        const validationEvents = postedBatch.events.filter((event) => event.command === "telemetry validate");
        if (validationEvents.length > 0) {
          validationBatch = postedBatch;
        }
        return new Response(JSON.stringify({
          ok: true,
          batch_id: postedBatch.batch_id,
          received_count: postedBatch.events.length,
          received_at: "2026-05-29T10:00:01.000Z",
        }), { status: 200 });
      }
      return new Response(JSON.stringify(metricsResponse({
        received_events: 1001,
        received_batches: postedBatches.length,
        last_batch_id: validationBatch.batch_id,
        latest_event: {
          received_at: "2026-05-29T10:00:01.000Z",
          batch_id: validationBatch.batch_id,
          command: "telemetry validate",
          model: "gemini-3.5-flash",
          status: "success",
        },
      })), { status: 200 });
    },
    now: NOW,
  });

  assert.equal(postedBatches.length, 11);
  assert.deepEqual(postedBatches.map((batch) => batch.events.length), [
    100,
    100,
    100,
    100,
    100,
    100,
    100,
    100,
    100,
    100,
    1,
  ]);
  const validationEvents = validationBatch.events.filter((event) => event.command === "telemetry validate");
  assert.equal(validationEvents.length, 1);
  assert.equal(validationEvents[0].prompt_raw, prompt);
  assert.equal(validationEvents[0].response_raw, responseText);
  assert.equal(result.ok, true);
  assert.equal(result.flush.batch_id, validationBatch.batch_id);
  assert.deepEqual(result.flush.event_ids, [validationEvents[0].event_id]);
  assert.equal(result.metrics.last_batch_id, validationBatch.batch_id);

  const pendingValidationEvents = (await readPendingEvents(cwd))
    .filter((event) => event.source === "validate");
  assert.deepEqual(pendingValidationEvents, []);
});

test("runTelemetryValidation returns false when max bounded flushes are exhausted first", async () => {
  const cwd = await temporaryWorkspace();
  const postedBatches = [];

  for (let index = 0; index < 200; index += 1) {
    await appendTelemetryEvent({ cwd, event: telemetryEvent(index) });
  }

  const result = await runTelemetryValidation({
    cwd,
    endpoint: ENDPOINT,
    token: TOKEN,
    askGemini: async () => "telemetry-ok",
    fetchImpl: async (url, options) => {
      if (options.method === "POST") {
        const postedBatch = JSON.parse(options.body);
        postedBatches.push(postedBatch);
        return new Response(JSON.stringify({
          ok: true,
          batch_id: postedBatch.batch_id,
          received_count: postedBatch.events.length,
          received_at: "2026-05-29T10:00:01.000Z",
        }), { status: 200 });
      }
      return new Response(JSON.stringify(metricsResponse({
        received_events: 100,
        received_batches: 1,
        last_batch_id: postedBatches.at(-1).batch_id,
        latest_event: {
          received_at: "2026-05-29T10:00:01.000Z",
          batch_id: postedBatches.at(-1).batch_id,
          command: "ask",
          model: "gemini-3.5-flash",
          status: "success",
        },
      })), { status: 200 });
    },
    now: NOW,
    maxValidationFlushes: 1,
  });

  assert.equal(result.ok, false);
  assert.equal(postedBatches.length, 1);
  assert.equal(postedBatches[0].events.length, 100);
  assert.equal(postedBatches[0].events.some((event) => event.command === "telemetry validate"), false);
  assert.equal(result.flushes.length, 1);
  assert.equal(result.flush, null);
  assert.equal((await readPendingEvents(cwd)).some((event) => event.source === "validate"), true);
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

test("flushTelemetryQueue times out stalled ACK body parsing and requeues the batch", async () => {
  const cwd = await temporaryWorkspace();
  await appendTelemetryEvent({ cwd, event: telemetryEvent(7) });
  let jsonAborted = false;

  await assert.rejects(
    () => flushTelemetryQueue({
      cwd,
      endpoint: ENDPOINT,
      token: TOKEN,
      timeoutMs: 5,
      fetchImpl: async (_, options) => ({
        ok: true,
        status: 200,
        json: () => new Promise((_, reject) => {
          options.signal.addEventListener("abort", () => {
            jsonAborted = true;
            reject(options.signal.reason ?? new Error("aborted"));
          });
        }),
      }),
      now: NOW,
    }),
    /Telemetry request aborted after 5ms timeout\./,
  );

  assert.equal(jsonAborted, true);
  assert.deepEqual((await readPendingEvents(cwd)).map((event) => event.event_id), ["evt_000007"]);
  assert.deepEqual(await regularFileNames(telemetryQueueDirs(cwd).inflight), []);
  const state = await loadTelemetryState({ cwd });
  assert.equal(state.sent_success_count, 0);
  assert.equal(state.sent_failure_count, 1);
});

test("receiverMetrics times out stalled metrics body parsing", async () => {
  let jsonAborted = false;

  await assert.rejects(
    () => receiverMetrics({
      endpoint: ENDPOINT,
      token: TOKEN,
      timeoutMs: 5,
      fetchImpl: async (_, options) => ({
        ok: true,
        status: 200,
        json: () => new Promise((_, reject) => {
          options.signal.addEventListener("abort", () => {
            jsonAborted = true;
            reject(options.signal.reason ?? new Error("aborted"));
          });
        }),
      }),
    }),
    /Telemetry request aborted after 5ms timeout\./,
  );

  assert.equal(jsonAborted, true);
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

test("flushTelemetryQueue archives 401 batches as non-retryable unauthorized failures", async () => {
  const cwd = await temporaryWorkspace();
  await appendTelemetryEvent({ cwd, event: telemetryEvent(10) });

  await assert.rejects(
    () => flushTelemetryQueue({
      cwd,
      endpoint: ENDPOINT,
      token: TOKEN,
      fetchImpl: async () => new Response("unauthorized", { status: 401 }),
      now: NOW,
    }),
    /disable sender until token is fixed/,
  );

  const dirs = telemetryQueueDirs(cwd);
  assert.deepEqual(await regularFileNames(dirs.pending), []);
  assert.deepEqual(await regularFileNames(dirs.inflight), []);
  const failedBatches = await directoryNames(dirs.failed);
  assert.equal(failedBatches.length, 1);
  const reason = JSON.parse(await readFile(join(dirs.failed, failedBatches[0], "reason.json"), "utf8"));
  assert.equal(reason.reason, "unauthorized");
  const state = await loadTelemetryState({ cwd });
  assert.equal(state.sent_failure_count, 1);
  assert.equal(state.non_retryable_failure_count, 1);
  assert.equal(state.last_failure_reason, "unauthorized");
});

test("flushTelemetryQueue archives 413 batches as non-retryable payload failures", async () => {
  const cwd = await temporaryWorkspace();
  await appendTelemetryEvent({ cwd, event: telemetryEvent(11) });

  await assert.rejects(
    () => flushTelemetryQueue({
      cwd,
      endpoint: ENDPOINT,
      token: TOKEN,
      fetchImpl: async () => new Response("too large", { status: 413 }),
      now: NOW,
    }),
    /Telemetry batch is too large/,
  );

  const dirs = telemetryQueueDirs(cwd);
  assert.deepEqual(await regularFileNames(dirs.pending), []);
  assert.deepEqual(await regularFileNames(dirs.inflight), []);
  const failedBatches = await directoryNames(dirs.failed);
  assert.equal(failedBatches.length, 1);
  const reason = JSON.parse(await readFile(join(dirs.failed, failedBatches[0], "reason.json"), "utf8"));
  assert.equal(reason.reason, "payload_too_large");
});

test("flushTelemetryQueue archives other 4xx batches as non-retryable failures", async () => {
  const cwd = await temporaryWorkspace();
  await appendTelemetryEvent({ cwd, event: telemetryEvent(12) });

  await assert.rejects(
    () => flushTelemetryQueue({
      cwd,
      endpoint: ENDPOINT,
      token: TOKEN,
      fetchImpl: async () => new Response("unprocessable", { status: 422 }),
      now: NOW,
    }),
    /non-retryable 422/,
  );

  const dirs = telemetryQueueDirs(cwd);
  assert.deepEqual(await regularFileNames(dirs.pending), []);
  assert.deepEqual(await regularFileNames(dirs.inflight), []);
  const failedBatches = await directoryNames(dirs.failed);
  assert.equal(failedBatches.length, 1);
  const reason = JSON.parse(await readFile(join(dirs.failed, failedBatches[0], "reason.json"), "utf8"));
  assert.equal(reason.reason, "http_422");
});

test("flushTelemetryQueue completes production ACKs with partial event rejection", async () => {
  const cwd = await temporaryWorkspace();
  await appendTelemetryEvent({ cwd, event: telemetryEvent(13) });
  await appendTelemetryEvent({ cwd, event: telemetryEvent(14) });
  let postedBatch;

  const result = await flushTelemetryQueue({
    cwd,
    endpoint: ENDPOINT,
    token: TOKEN,
    fetchImpl: async (url, options) => {
      postedBatch = JSON.parse(options.body);
      return new Response(JSON.stringify({
        ok: true,
        batch_id: postedBatch.batch_id,
        accepted_event_ids: [postedBatch.events[0].event_id],
        rejected: [{
          event_id: postedBatch.events[1].event_id,
          reason: "invalid_event",
        }],
        received_at: "2026-05-29T10:00:01.000Z",
      }), { status: 200 });
    },
    now: NOW,
    batchSize: 2,
  });

  assert.equal(result.ok, true);
  assert.equal(result.sent_count, 1);
  assert.deepEqual(result.event_ids, [postedBatch.events[0].event_id]);
  assert.deepEqual(result.ack.accepted_event_ids, [postedBatch.events[0].event_id]);
  assert.equal(result.ack.rejected[0].event_id, postedBatch.events[1].event_id);

  const dirs = telemetryQueueDirs(cwd);
  assert.deepEqual(await regularFileNames(dirs.pending), []);
  assert.deepEqual(await regularFileNames(dirs.inflight), []);
  assert.deepEqual(await directoryNames(dirs.failed), []);
});

test("flushTelemetryQueue rejects malformed production ACKs that do not cover the batch", async () => {
  const cwd = await temporaryWorkspace();
  await appendTelemetryEvent({ cwd, event: telemetryEvent(15) });
  await appendTelemetryEvent({ cwd, event: telemetryEvent(16) });

  await assert.rejects(
    () => flushTelemetryQueue({
      cwd,
      endpoint: ENDPOINT,
      token: TOKEN,
      fetchImpl: async (url, options) => {
        const body = JSON.parse(options.body);
        return new Response(JSON.stringify({
          ok: true,
          batch_id: body.batch_id,
          accepted_event_ids: [body.events[0].event_id],
          rejected: [],
          received_at: "2026-05-29T10:00:01.000Z",
        }), { status: 200 });
      },
      now: NOW,
      batchSize: 2,
    }),
    /does not cover the sent batch/,
  );

  assert.deepEqual((await readPendingEvents(cwd)).map((event) => event.event_id), [
    "evt_000015",
    "evt_000016",
  ]);
  assert.deepEqual(await regularFileNames(telemetryQueueDirs(cwd).inflight), []);
});

test("flushTelemetryQueue rejects production ACKs with accepted and rejected overlap", async () => {
  const cwd = await temporaryWorkspace();
  await appendTelemetryEvent({ cwd, event: telemetryEvent(17) });

  await assert.rejects(
    () => flushTelemetryQueue({
      cwd,
      endpoint: ENDPOINT,
      token: TOKEN,
      fetchImpl: async (url, options) => {
        const body = JSON.parse(options.body);
        const eventId = body.events[0].event_id;
        return new Response(JSON.stringify({
          ok: true,
          batch_id: body.batch_id,
          accepted_event_ids: [eventId],
          rejected: [{ event_id: eventId, reason: "invalid_event" }],
          received_at: "2026-05-29T10:00:01.000Z",
        }), { status: 200 });
      },
      now: NOW,
    }),
    /exactly once/,
  );

  assert.deepEqual((await readPendingEvents(cwd)).map((event) => event.event_id), ["evt_000017"]);
  assert.deepEqual(await regularFileNames(telemetryQueueDirs(cwd).inflight), []);
});

test("flushTelemetryQueue rejects production ACKs with duplicate accepted event ids", async () => {
  const cwd = await temporaryWorkspace();
  await appendTelemetryEvent({ cwd, event: telemetryEvent(18) });
  await appendTelemetryEvent({ cwd, event: telemetryEvent(19) });

  await assert.rejects(
    () => flushTelemetryQueue({
      cwd,
      endpoint: ENDPOINT,
      token: TOKEN,
      fetchImpl: async (url, options) => {
        const body = JSON.parse(options.body);
        return new Response(JSON.stringify({
          ok: true,
          batch_id: body.batch_id,
          accepted_event_ids: [
            body.events[0].event_id,
            body.events[0].event_id,
          ],
          rejected: [{ event_id: body.events[1].event_id, reason: "invalid_event" }],
          received_at: "2026-05-29T10:00:01.000Z",
        }), { status: 200 });
      },
      now: NOW,
      batchSize: 2,
    }),
    /exactly once/,
  );

  assert.deepEqual((await readPendingEvents(cwd)).map((event) => event.event_id), [
    "evt_000018",
    "evt_000019",
  ]);
  assert.deepEqual(await regularFileNames(telemetryQueueDirs(cwd).inflight), []);
});

test("flushTelemetryQueue treats 429 as retryable and requeues the batch", async () => {
  const cwd = await temporaryWorkspace();
  await appendTelemetryEvent({ cwd, event: telemetryEvent(20) });

  await assert.rejects(
    () => flushTelemetryQueue({
      cwd,
      endpoint: ENDPOINT,
      token: TOKEN,
      fetchImpl: async () => new Response("rate limited", { status: 429 }),
      now: NOW,
    }),
    /Telemetry receiver returned 429\./,
  );

  const dirs = telemetryQueueDirs(cwd);
  assert.deepEqual((await readPendingEvents(cwd)).map((event) => event.event_id), ["evt_000020"]);
  assert.deepEqual(await regularFileNames(dirs.inflight), []);
  assert.deepEqual(await directoryNames(dirs.failed), []);
});
