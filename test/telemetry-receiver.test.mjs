import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createTelemetryReceiver } from "../src/telemetry-receiver.mjs";
import {
  normalizeTelemetryReceiverAck,
  normalizeTelemetryReceiverMetrics,
} from "../src/telemetry-schemas.mjs";

const TOKEN = "receiver-test-token";

async function temporaryStorage() {
  return mkdtemp(join(tmpdir(), "gemini-agent-telemetry-receiver-"));
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

function telemetryBatch(overrides = {}) {
  const now = new Date().toISOString();
  return {
    schema_version: 1,
    batch_id: `batch_${Math.random().toString(16).slice(2)}`,
    deployment_id: "dep_test",
    scheduled_for: now,
    sent_at: now,
    events: [telemetryEvent(1)],
    ...overrides,
  };
}

async function withReceiver(options, fn) {
  const receiver = createTelemetryReceiver({
    host: "127.0.0.1",
    port: 0,
    storage: await temporaryStorage(),
    ...options,
  });
  await receiver.start();
  const { port } = receiver.server.address();
  try {
    return await fn({ ...receiver, url: `http://127.0.0.1:${port}` });
  } finally {
    await receiver.stop();
  }
}

async function postJson(url, body, headers = {}) {
  return fetch(`${url}/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function rawFilePaths(storage) {
  const rawDir = join(storage, "raw");
  try {
    const names = await readdir(rawDir);
    return names.map((name) => join(rawDir, name)).sort();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

test("health and ingest help are public", async () => {
  await withReceiver({ token: TOKEN }, async ({ url }) => {
    const health = await fetch(`${url}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const help = await fetch(`${url}/ingest`);
    assert.equal(help.status, 200);
    assert.match(await help.text(), /POST \/ingest/);
  });
});

test("POST ingest requires bearer token unless loopback unauthenticated is enabled", async () => {
  await withReceiver({ token: TOKEN }, async ({ url }) => {
    const missing = await postJson(url, telemetryBatch());
    assert.equal(missing.status, 401);

    const wrong = await postJson(url, telemetryBatch(), { Authorization: "Bearer wrong" });
    assert.equal(wrong.status, 401);
  });

  await withReceiver({ allowUnauthenticatedLoopback: true }, async ({ url }) => {
    const response = await postJson(url, telemetryBatch());
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
  });
});

test("successful ingest stores raw JSONL, indexes metrics, and returns strict ACK", async () => {
  const storage = await temporaryStorage();
  await withReceiver({ storage, token: TOKEN }, async ({ url }) => {
    const batch = telemetryBatch({
      batch_id: "batch_success",
      events: [
        telemetryEvent(1),
        telemetryEvent(2, { status: "error", error_type: "APIError", command: "review" }),
      ],
    });

    const response = await postJson(url, batch, { Authorization: `Bearer ${TOKEN}` });
    assert.equal(response.status, 200);
    const ack = normalizeTelemetryReceiverAck(await response.json());
    assert.equal(ack.batch_id, "batch_success");
    assert.equal(ack.received_count, 2);

    const paths = await rawFilePaths(storage);
    assert.deepEqual(paths.map((path) => /\d{4}-\d{2}-\d{2}\.jsonl$/.test(path)), [true]);
    const lines = (await readFile(paths[0], "utf8")).trim().split("\n");
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).batch_id, "batch_success");

    const metricsResponse = await fetch(`${url}/metrics`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(metricsResponse.status, 200);
    const metrics = normalizeTelemetryReceiverMetrics(await metricsResponse.json());
    assert.equal(metrics.received_events, 2);
    assert.equal(metrics.received_batches, 1);
    assert.equal(metrics.last_batch_id, "batch_success");
    assert.deepEqual(metrics.status_counts, { success: 1, error: 1 });
    assert.equal(metrics.clock_skew_warnings, 0);
    assert.deepEqual(metrics.latest_event, {
      received_at: metrics.latest_event.received_at,
      batch_id: "batch_success",
      command: "review",
      model: "gemini-3.5-flash",
      status: "error",
    });
  });
});

test("metrics and dashboard expose correction overlays without raw event ids", async () => {
  await withReceiver({ token: TOKEN }, async ({ url }) => {
    const batch = telemetryBatch({
      batch_id: "batch_corrections",
      events: [
        telemetryEvent(10, {
          event_id: "artifact_original_private",
          command: "artifact-review-backfill",
          payload: {
            prompt_truncated: false,
            response_truncated: false,
            multimodal: [{ basename: "private-source.png" }],
          },
        }),
        telemetryEvent(11, {
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
            correction_for_event_id: "artifact_original_private",
            correction_version: "media-v1",
          },
        }),
        telemetryEvent(12, {
          event_id: "artifact_correction_beta",
          command: "artifact-review-backfill-correction",
          payload: {
            prompt_truncated: false,
            response_truncated: false,
            multimodal: [{ mime_type: "image/png", byte_size: 200 }],
          },
          metadata: {
            correction_for_event_id: "artifact_original_private",
            correction_version: "media-v1",
          },
        }),
      ],
    });

    const response = await postJson(url, batch, { Authorization: `Bearer ${TOKEN}` });
    assert.equal(response.status, 200);

    const metrics = normalizeTelemetryReceiverMetrics(await (await fetch(`${url}/metrics`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })).json());
    assert.deepEqual(metrics.corrections, {
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

    const dashboard = await (await fetch(`${url}/dashboard`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })).text();
    assert.match(dashboard, /Corrections/);
    assert.match(dashboard, /media-v1/);
    assert.doesNotMatch(dashboard, /artifact_original_private/);
    assert.doesNotMatch(dashboard, /private-source/);
  });
});

test("metrics sanitizes invalid correction versions", async () => {
  await withReceiver({ token: TOKEN }, async ({ url }) => {
    const batch = telemetryBatch({
      batch_id: "batch_invalid_correction_version",
      events: [
        telemetryEvent(13, {
          event_id: "artifact_correction_invalid_version",
          command: "artifact-review-backfill-correction",
          payload: {
            prompt_truncated: false,
            response_truncated: false,
            multimodal: [{ mime_type: "image/png", byte_size: 25 }],
          },
          metadata: {
            correction_for_event_id: 123,
            correction_version: "media-v1<script>",
          },
        }),
      ],
    });

    const response = await postJson(url, batch, { Authorization: `Bearer ${TOKEN}` });
    assert.equal(response.status, 200);

    const metrics = normalizeTelemetryReceiverMetrics(await (await fetch(`${url}/metrics`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })).json());
    assert.equal(metrics.corrections.corrected_original_event_count, 0);
    assert.deepEqual(metrics.corrections.top_versions, [{
      correction_version: "unknown",
      event_count: 1,
      corrected_original_event_count: 0,
      media_item_count: 1,
      media_byte_count: 25,
    }]);

    const dashboard = await (await fetch(`${url}/dashboard`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })).text();
    assert.match(dashboard, /unknown/);
    assert.doesNotMatch(dashboard, /<script>/);
  });
});

test("metrics and dashboard expose palette split quality without raw identifiers", async () => {
  await withReceiver({ token: TOKEN }, async ({ url }) => {
    const batch = telemetryBatch({
      batch_id: "batch_palette_quality",
      events: [
        telemetryEvent(20, {
          event_id: "palette_private_event",
          command: "palette-split",
          payload: {
            prompt_truncated: false,
            response_truncated: false,
            multimodal: [
              { mime_type: "image/png", byte_size: 123, basename: "private-source.png" },
            ],
          },
          metadata: {
            actual_model: "gemini-3.1-flash-image",
            workflow: "palette-split",
            quality: {
              quality_score: 90,
              mask_resized: true,
              empty_target_count: 0,
              degenerate_target_count: 1,
              foreground_area_pct: 12.8,
            },
          },
        }),
        telemetryEvent(21, {
          event_id: "palette_legacy_event",
          command: "palette-split",
          status: "error",
          metadata: {
            actual_model: "gemini-3.1-flash-image",
            workflow: "palette-split",
          },
        }),
      ],
    });

    const response = await postJson(url, batch, { Authorization: `Bearer ${TOKEN}` });
    assert.equal(response.status, 200);

    const metrics = normalizeTelemetryReceiverMetrics(await (await fetch(`${url}/metrics`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })).json());
    assert.deepEqual(metrics.palette_split, {
      event_count: 2,
      success_count: 1,
      error_count: 1,
      quality_event_count: 1,
      avg_quality_score: 90,
      resized_mask_count: 1,
      empty_target_count: 0,
      degenerate_target_count: 1,
      avg_foreground_area_pct: 12.8,
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

    const dashboard = await (await fetch(`${url}/dashboard`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })).text();
    assert.match(dashboard, /Palette split/);
    assert.match(dashboard, /Average quality score: 90/);
    assert.match(dashboard, /gemini-3\.1-flash-image/);
    assert.doesNotMatch(dashboard, /palette_private_event/);
    assert.doesNotMatch(dashboard, /private-source/);
  });
});

test("metrics and dashboard expose product-adjusted telemetry purpose without raw identifiers", async () => {
  await withReceiver({ token: TOKEN }, async ({ url }) => {
    const batch = telemetryBatch({
      batch_id: "batch_product_adjusted",
      events: [
        telemetryEvent(30, {
          event_id: "product_private_event",
          command: "diff-review",
        }),
        telemetryEvent(31, {
          event_id: "validation_private_event",
          command: "artifact-review",
          prompt: "private validation prompt",
          response: "private validation response",
          metadata: {
            telemetry_purpose: "validation",
          },
        }),
        telemetryEvent(32, {
          event_id: "invalid_purpose_private_event",
          command: "plan-critique",
          metadata: {
            telemetry_purpose: "canary /Users/example/private Authorization: Bearer secret-token",
          },
        }),
      ],
    });

    const response = await postJson(url, batch, { Authorization: `Bearer ${TOKEN}` });
    assert.equal(response.status, 200);

    const metrics = normalizeTelemetryReceiverMetrics(await (await fetch(`${url}/metrics`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })).json());
    assert.deepEqual(metrics.product_analytics, {
      product_adjusted: true,
      event_count: 3,
      product_adjusted_event_count: 2,
      validation_event_count: 1,
      note: "Product analytics exclude validation telemetry; health and delivery counts include all events.",
    });
    assert.equal(metrics.received_events, 3);

    const dashboard = await (await fetch(`${url}/dashboard`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })).text();
    assert.match(dashboard, /Product analytics/);
    assert.match(dashboard, /Product-adjusted events: 2 of 3/);
    assert.match(dashboard, /Validation events excluded from product metrics: 1/);
    assert.doesNotMatch(dashboard, /product_private_event|validation_private_event|invalid_purpose_private_event/);
    assert.doesNotMatch(dashboard, /private validation prompt|private validation response/);
    assert.doesNotMatch(dashboard, /\/Users\/example|secret-token|Authorization: Bearer|canary/);
  });
});

test("ingest is idempotent when the exact same batch is retried", async () => {
  await withReceiver({ token: TOKEN }, async ({ url }) => {
    const batch = telemetryBatch({
      batch_id: "batch_retry_exact",
      events: [
        telemetryEvent(1),
        telemetryEvent(2, { status: "error", error_type: "APIError" }),
      ],
    });

    const first = await postJson(url, batch, { Authorization: `Bearer ${TOKEN}` });
    assert.equal(first.status, 200);
    assert.equal(normalizeTelemetryReceiverAck(await first.json()).received_count, 2);

    const second = await postJson(url, batch, { Authorization: `Bearer ${TOKEN}` });
    assert.equal(second.status, 200);
    const retryAck = normalizeTelemetryReceiverAck(await second.json());
    assert.equal(retryAck.batch_id, "batch_retry_exact");
    assert.equal(retryAck.received_count, 2);

    const metrics = normalizeTelemetryReceiverMetrics(await (await fetch(`${url}/metrics`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })).json());
    assert.equal(metrics.received_events, 2);
    assert.equal(metrics.received_batches, 1);
    assert.deepEqual(metrics.status_counts, { success: 1, error: 1 });
  });
});

test("ingest is idempotent when a different batch retries the same event id", async () => {
  await withReceiver({ token: TOKEN }, async ({ url }) => {
    const firstBatch = telemetryBatch({
      batch_id: "batch_retry_original",
      events: [telemetryEvent(1, { status: "error", error_type: "APIError" })],
    });
    const retryBatch = telemetryBatch({
      batch_id: "batch_retry_new_id",
      events: [telemetryEvent(1, { status: "error", error_type: "APIError" })],
    });

    assert.equal((await postJson(url, firstBatch, { Authorization: `Bearer ${TOKEN}` })).status, 200);

    const retry = await postJson(url, retryBatch, { Authorization: `Bearer ${TOKEN}` });
    assert.equal(retry.status, 200);
    const retryAck = normalizeTelemetryReceiverAck(await retry.json());
    assert.equal(retryAck.batch_id, "batch_retry_new_id");
    assert.equal(retryAck.received_count, 1);

    const metrics = normalizeTelemetryReceiverMetrics(await (await fetch(`${url}/metrics`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })).json());
    assert.equal(metrics.received_events, 1);
    assert.equal(metrics.received_batches, 1);
    assert.equal(metrics.last_batch_id, "batch_retry_original");
    assert.deepEqual(metrics.status_counts, { success: 0, error: 1 });
  });
});

test("ingest accepts mixed duplicate and new events without inflating duplicate metrics", async () => {
  await withReceiver({ token: TOKEN }, async ({ url }) => {
    const firstBatch = telemetryBatch({
      batch_id: "batch_mixed_original",
      events: [telemetryEvent(1)],
    });
    const mixedBatch = telemetryBatch({
      batch_id: "batch_mixed_retry",
      events: [
        telemetryEvent(1),
        telemetryEvent(2, { status: "error", error_type: "APIError", command: "review" }),
      ],
    });

    assert.equal((await postJson(url, firstBatch, { Authorization: `Bearer ${TOKEN}` })).status, 200);

    const mixed = await postJson(url, mixedBatch, { Authorization: `Bearer ${TOKEN}` });
    assert.equal(mixed.status, 200);
    const mixedAck = normalizeTelemetryReceiverAck(await mixed.json());
    assert.equal(mixedAck.batch_id, "batch_mixed_retry");
    assert.equal(mixedAck.received_count, 2);

    const metrics = normalizeTelemetryReceiverMetrics(await (await fetch(`${url}/metrics`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })).json());
    assert.equal(metrics.received_events, 2);
    assert.equal(metrics.received_batches, 2);
    assert.equal(metrics.last_batch_id, "batch_mixed_retry");
    assert.deepEqual(metrics.status_counts, { success: 1, error: 1 });
    assert.deepEqual(metrics.latest_event, {
      received_at: metrics.latest_event.received_at,
      batch_id: "batch_mixed_retry",
      command: "review",
      model: "gemini-3.5-flash",
      status: "error",
    });
  });
});

test("raw pruning removes JSONL bytes without deleting SQLite metrics", async () => {
  const storage = await temporaryStorage();
  await withReceiver({ storage, token: TOKEN, maxRawBytes: 1 }, async ({ url }) => {
    const response = await postJson(url, telemetryBatch({ batch_id: "batch_pruned" }), {
      Authorization: `Bearer ${TOKEN}`,
    });
    assert.equal(response.status, 200);

    const paths = await rawFilePaths(storage);
    const totalRawBytes = (await Promise.all(paths.map((path) => stat(path))))
      .reduce((sum, entry) => sum + entry.size, 0);
    assert.equal(totalRawBytes, 0);

    const metrics = normalizeTelemetryReceiverMetrics(await (await fetch(`${url}/metrics`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })).json());
    assert.equal(metrics.received_events, 1);
    assert.equal(metrics.received_batches, 1);
    assert.equal(metrics.last_batch_id, "batch_pruned");
  });
});

test("ingest rejects bodies above maxBodyBytes with 413", async () => {
  await withReceiver({ token: TOKEN, maxBodyBytes: 16 }, async ({ url }) => {
    const response = await postJson(url, telemetryBatch(), { Authorization: `Bearer ${TOKEN}` });
    assert.equal(response.status, 413);
  });
});

test("metrics records clock skew warnings when sent_at differs by more than one hour", async () => {
  await withReceiver({ token: TOKEN }, async ({ url }) => {
    const response = await postJson(url, telemetryBatch({
      batch_id: "batch_skew",
      sent_at: "2020-01-01T00:00:00.000Z",
    }), { Authorization: `Bearer ${TOKEN}` });
    assert.equal(response.status, 200);

    const metrics = normalizeTelemetryReceiverMetrics(await (await fetch(`${url}/metrics`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })).json());
    assert.equal(metrics.clock_skew_warnings, 1);
  });
});

test("strict schema rejects unsupported model", async () => {
  await withReceiver({ token: TOKEN }, async ({ url }) => {
    const response = await postJson(url, telemetryBatch({
      events: [telemetryEvent(1, { model: "gemini-2.0-flash" })],
    }), { Authorization: `Bearer ${TOKEN}` });
    assert.equal(response.status, 400);
    assert.match(await response.text(), /gemini-3\.5-flash|Invalid telemetry batch/);
  });
});

test("metrics and dashboard require auth unless loopback unauthenticated is enabled", async () => {
  await withReceiver({ token: TOKEN }, async ({ url }) => {
    assert.equal((await fetch(`${url}/metrics`)).status, 401);
    assert.equal((await fetch(`${url}/dashboard`)).status, 401);
  });

  await withReceiver({ allowUnauthenticatedLoopback: true }, async ({ url }) => {
    assert.equal((await fetch(`${url}/metrics`)).status, 200);
    const dashboard = await fetch(`${url}/dashboard`);
    assert.equal(dashboard.status, 200);
    assert.match(await dashboard.text(), /Telemetry Receiver/);
  });
});

test("CLI fails clearly when required token env is missing", async () => {
  const result = await runCli(["--port", "0"], { env: { GEMINI_AGENT_TELEMETRY_TOKEN: "" } });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /GEMINI_AGENT_TELEMETRY_TOKEN/);
  assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND|Cannot find module|requires receiver module wiring/);
});

test("CLI starts with loopback unauthenticated mode and logs address", async () => {
  const storage = await temporaryStorage();
  const child = spawn(process.execPath, [
    fileURLToPath(new URL("../src/telemetry-receiver-cli.mjs", import.meta.url)),
    "--port",
    "0",
    "--storage",
    storage,
    "--allow-unauthenticated-loopback",
  ], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    stdio: ["ignore", "ignore", "pipe"],
  });

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`CLI did not start. stderr: ${stderr}`)), 5000);
    child.on("error", reject);
    child.stderr.on("data", () => {
      if (/Telemetry receiver listening on http:\/\/127\.0\.0\.1:\d+/.test(stderr)) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });

  child.kill("SIGTERM");
  await new Promise((resolve) => child.on("close", resolve));
  await access(storage, constants.R_OK);
});

function runCli(args, { env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      fileURLToPath(new URL("../src/telemetry-receiver-cli.mjs", import.meta.url)),
      ...args,
    ], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}
