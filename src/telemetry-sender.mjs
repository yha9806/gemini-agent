import { randomUUID } from "node:crypto";
import { validateTelemetryEndpoint } from "./telemetry-config.mjs";
import { getDefaultModel } from "./gemini-client.mjs";
import {
  appendTelemetryEvent,
  claimTelemetryBatch,
  completeTelemetryBatch,
  failTelemetryBatch,
} from "./telemetry-queue.mjs";
import {
  TELEMETRY_SCHEMA_VERSION,
  normalizeTelemetryBatch,
  normalizeTelemetryReceiverAck,
  normalizeTelemetryReceiverMetrics,
} from "./telemetry-schemas.mjs";

const VALIDATION_FLUSH_BATCH_SIZE = 100;
const MAX_VALIDATION_FLUSHES = 10;

function assertPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer.`);
  }
}

function assertTelemetryToken(token) {
  if (typeof token !== "string" || !token.trim()) {
    throw new Error("Telemetry token must be a non-empty string.");
  }
}

function validationBatchRecorded({ flush, metrics, validationEventId }) {
  if (!flush?.event_ids?.includes(validationEventId)) return false;
  const ackedBatchId = flush.ack?.batch_id;
  if (!ackedBatchId || ackedBatchId !== flush.batch_id) return false;
  if (flush.ack.received_count !== flush.sent_count) return false;
  if (metrics.received_events < flush.sent_count) return false;
  if (metrics.received_batches <= 0) return false;
  if (metrics.last_batch_id !== ackedBatchId) return false;
  if (!metrics.latest_event) return false;
  if (metrics.latest_event.batch_id !== ackedBatchId) return false;
  if (metrics.latest_event.command !== "telemetry validate") return false;
  if (metrics.latest_event.model !== getDefaultModel()) return false;
  if (metrics.latest_event.status !== "success") return false;
  return true;
}

async function parseJsonResponse(response, label) {
  try {
    return await response.json();
  } catch (error) {
    throw new Error(`${label} response is not valid JSON.`, { cause: error });
  }
}

function validationError(label, error) {
  const message = error instanceof Error ? error.message : `${error}`;
  return new Error(`${label} response is invalid: ${message}`, { cause: error });
}

function normalizeReceiverAck(value) {
  try {
    return normalizeTelemetryReceiverAck(value);
  } catch (error) {
    throw validationError("Telemetry receiver ACK", error);
  }
}

function normalizeReceiverMetrics(value) {
  try {
    return normalizeTelemetryReceiverMetrics(value);
  } catch (error) {
    throw validationError("Telemetry receiver metrics", error);
  }
}

async function withTimeout(timeoutMs, fn) {
  assertPositiveInteger(timeoutMs, "timeoutMs");
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

function metricsUrlFromEndpoint(endpointUrl) {
  const metricsUrl = new URL(endpointUrl.href);
  if (/\/ingest\/?$/.test(metricsUrl.pathname)) {
    metricsUrl.pathname = metricsUrl.pathname.replace(/\/ingest\/?$/, "/metrics");
  } else if (metricsUrl.pathname.endsWith("/")) {
    metricsUrl.pathname = `${metricsUrl.pathname}metrics`;
  } else {
    metricsUrl.pathname = `${metricsUrl.pathname}/metrics`;
  }
  return metricsUrl;
}

export async function flushTelemetryQueue({
  cwd = process.cwd(),
  endpoint,
  token,
  fetchImpl = fetch,
  now = new Date(),
  timeoutMs = 5000,
  batchSize = 100,
} = {}) {
  const url = validateTelemetryEndpoint(endpoint);
  assertTelemetryToken(token);
  const claimed = await claimTelemetryBatch({ cwd, batchSize, now });
  if (claimed.events.length === 0) {
    return { ok: true, sent_count: 0 };
  }

  const batch = normalizeTelemetryBatch({
    schema_version: TELEMETRY_SCHEMA_VERSION,
    batch_id: claimed.batchId,
    deployment_id: claimed.events[0].deployment_id,
    scheduled_for: now.toISOString(),
    sent_at: now.toISOString(),
    events: claimed.events,
  });

  let ack;
  try {
    const response = await withTimeout(timeoutMs, (signal) => fetchImpl(url.href, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(batch),
      signal,
    }));

    if (!response.ok) {
      throw new Error(`Telemetry receiver returned ${response.status}.`);
    }

    ack = normalizeReceiverAck(await parseJsonResponse(response, "Telemetry receiver ACK"));
    if (ack.batch_id !== batch.batch_id) {
      throw new Error("Telemetry receiver ACK batch_id does not match the sent batch.");
    }
    if (ack.received_count !== batch.events.length) {
      throw new Error("Telemetry receiver ACK received_count does not match the sent batch.");
    }

  } catch (error) {
    await failTelemetryBatch({ cwd, batchId: claimed.batchId });
    throw error;
  }

  await completeTelemetryBatch({ cwd, batchId: claimed.batchId, now });
  return {
    ok: true,
    sent_count: batch.events.length,
    batch_id: batch.batch_id,
    event_ids: batch.events.map((event) => event.event_id),
    ack,
  };
}

export async function receiverMetrics({
  endpoint,
  token,
  fetchImpl = fetch,
  timeoutMs = 5000,
} = {}) {
  const ingestUrl = validateTelemetryEndpoint(endpoint);
  assertTelemetryToken(token);
  const metricsUrl = metricsUrlFromEndpoint(ingestUrl);

  const response = await withTimeout(timeoutMs, (signal) => fetchImpl(metricsUrl.href, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
    },
    signal,
  }));

  if (!response.ok) {
    throw new Error(`Telemetry receiver returned ${response.status}.`);
  }

  return normalizeReceiverMetrics(await parseJsonResponse(response, "Telemetry receiver metrics"));
}

export async function runTelemetryValidation({
  cwd = process.cwd(),
  endpoint,
  token,
  prompt = "gemini-agent telemetry validation: reply with telemetry-ok",
  askGemini,
  fetchImpl = fetch,
  now = new Date(),
  validationBatchSize = VALIDATION_FLUSH_BATCH_SIZE,
  maxValidationFlushes = MAX_VALIDATION_FLUSHES,
} = {}) {
  validateTelemetryEndpoint(endpoint);
  assertTelemetryToken(token);
  assertPositiveInteger(validationBatchSize, "validationBatchSize");
  assertPositiveInteger(maxValidationFlushes, "maxValidationFlushes");

  if (typeof askGemini !== "function") {
    throw new TypeError("runTelemetryValidation requires askGemini.");
  }

  const startedAtMs = Date.now();
  const responseText = await askGemini(prompt);
  const latencyMs = Math.max(0, Math.round(Date.now() - startedAtMs));
  const validationEventId = `evt_${randomUUID()}`;

  await appendTelemetryEvent({
    cwd,
    event: {
      schema_version: TELEMETRY_SCHEMA_VERSION,
      event_id: validationEventId,
      trace_id: `trace_${randomUUID()}`,
      deployment_id: "gemini-agent-validation",
      project_id: "gemini-agent",
      source: "validate",
      command: "telemetry validate",
      model: getDefaultModel(),
      prompt,
      response: `${responseText ?? ""}`,
      status: "success",
      error_type: null,
      latency_ms: latencyMs,
      created_at: now.toISOString(),
      payload: {
        prompt_truncated: false,
        response_truncated: false,
        multimodal: [],
      },
    },
  });

  const flushes = [];
  let validationFlush = null;
  for (let attempt = 0; attempt < maxValidationFlushes; attempt += 1) {
    const flush = await flushTelemetryQueue({
      cwd,
      endpoint,
      token,
      fetchImpl,
      now,
      batchSize: validationBatchSize,
    });
    flushes.push(flush);
    if (flush.event_ids?.includes(validationEventId)) {
      validationFlush = flush;
      break;
    }
    if (flush.sent_count === 0) break;
  }

  const metrics = await receiverMetrics({ endpoint, token, fetchImpl });
  return {
    ok: validationBatchRecorded({
      flush: validationFlush,
      metrics,
      validationEventId,
    }),
    flush: validationFlush,
    flushes,
    metrics,
  };
}
