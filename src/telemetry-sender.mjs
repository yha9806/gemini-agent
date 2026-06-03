import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { validateTelemetryEndpoint } from "./telemetry-config.mjs";
import { getDefaultModel } from "./gemini-client.mjs";
import {
  appendTelemetryEvent,
  claimTelemetryBatch,
  completeTelemetryBatch,
  failTelemetryBatch,
  peekTelemetryEvents,
} from "./telemetry-queue.mjs";
import {
  RAW_TELEMETRY_SCHEMA_VERSION,
  TELEMETRY_SCHEMA_VERSION,
  normalizeRawTelemetryBatch,
  normalizeTelemetryReceiverAck,
  normalizeTelemetryReceiverMetrics,
} from "./telemetry-schemas.mjs";

const VALIDATION_FLUSH_BATCH_SIZE = 100;
const require = createRequire(import.meta.url);
const packageJson = require("../package.json");

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
  if (!validationBatchAcked({ flush, validationEventId })) return false;
  const ackedBatchId = flush.ack.batch_id;
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

function validationBatchAcked({ flush, validationEventId }) {
  if (!flush?.event_ids?.includes(validationEventId)) return false;
  const ackedBatchId = flush.ack?.batch_id;
  if (!ackedBatchId || ackedBatchId !== flush.batch_id) return false;
  if (flush.ack.received_count !== flush.sent_count) return false;
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
    if (
      value
      && typeof value === "object"
      && !Array.isArray(value)
      && value.ok === true
      && typeof value.batch_id === "string"
      && Array.isArray(value.accepted_event_ids)
      && Array.isArray(value.rejected)
      && typeof value.received_at === "string"
    ) {
      return {
        ok: true,
        batch_id: value.batch_id,
        received_count: value.accepted_event_ids.length,
        received_at: value.received_at,
        accepted_event_ids: value.accepted_event_ids,
        rejected: value.rejected,
      };
    }
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
  let timeoutReject;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutReject = reject;
  });
  const timeout = setTimeout(() => {
    const error = new Error(`Telemetry request aborted after ${timeoutMs}ms timeout.`);
    timeoutReject(error);
    controller.abort(error);
  }, timeoutMs);
  try {
    return await Promise.race([fn(controller.signal), timeoutPromise]);
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

function endedAtFromLegacy(event) {
  const startMs = Date.parse(event.created_at);
  if (Number.isNaN(startMs)) return event.created_at;
  return new Date(startMs + event.latency_ms).toISOString();
}

function sourceHostAppFromLegacy(event) {
  if (event.source === "mcp") return "mcp";
  if (event.source === "cli" || event.source === "validate") return "cli";
  return "other";
}

function triggerSourceFromLegacy(event) {
  if (event.source === "mcp") return "mcp";
  if (/\bglobal[_ -]?policy\b/i.test(event.command)) return "global_policy";
  if (/\b(scheduled|schedule|tick)\b/i.test(event.command)) return "scheduled";
  return "manual";
}

function rawEventFromLegacy(event) {
  return {
    event_id: event.event_id,
    source_host_app: sourceHostAppFromLegacy(event),
    trigger_source: triggerSourceFromLegacy(event),
    model_provider: "google",
    model: event.model,
    command: event.command,
    started_at: event.created_at,
    ended_at: endedAtFromLegacy(event),
    latency_ms: event.latency_ms,
    status: event.status,
    usage: {
      input_tokens: event.economics?.input_tokens ?? null,
      output_tokens: event.economics?.output_tokens ?? null,
      total_tokens: event.economics?.total_tokens ?? null,
    },
    request_raw: {
      trace_id: event.trace_id,
      project_id: event.project_id,
      source: event.source,
      prompt: event.prompt,
      payload: event.payload,
    },
    prompt_raw: event.prompt,
    response_raw: event.response,
    response_candidates_raw: [],
    tool_calls_raw: [],
    media_manifest: event.payload?.multimodal ?? [],
    error: event.status === "error" ? {
      type: event.error_type,
      message: event.error_type,
    } : null,
    metadata: {
      legacy_schema_version: event.schema_version,
      trace_id: event.trace_id,
      project_id: event.project_id,
      prompt_truncated: event.payload?.prompt_truncated ?? false,
      response_truncated: event.payload?.response_truncated ?? false,
      source: event.source,
      context: event.context,
      outcome: event.outcome,
      economics: event.economics,
    },
  };
}

function checksumEvents(events) {
  const digest = createHash("sha256")
    .update(JSON.stringify(events))
    .digest("hex");
  return `sha256:${digest}`;
}

function rawBatchFromEvents({ events, batchId, now }) {
  const rawEvents = events.map((event) => rawEventFromLegacy(event));
  const normalizedEvents = normalizeRawTelemetryBatch({
    schema_version: RAW_TELEMETRY_SCHEMA_VERSION,
    batch_id: batchId,
    deployment_id: events[0].deployment_id,
    agent_version: packageJson.version,
    generated_at: now.toISOString(),
    checksum: "sha256:pending",
    events: rawEvents,
  }).events;
  return normalizeRawTelemetryBatch({
    schema_version: RAW_TELEMETRY_SCHEMA_VERSION,
    batch_id: batchId,
    deployment_id: events[0].deployment_id,
    agent_version: packageJson.version,
    generated_at: now.toISOString(),
    checksum: checksumEvents(normalizedEvents),
    events: normalizedEvents,
  });
}

function rawBatchFromClaimed({ claimed, now }) {
  return rawBatchFromEvents({
    events: claimed.events,
    batchId: claimed.batchId,
    now,
  });
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function previewBatchId(now) {
  const day = now.toISOString().slice(0, 10).replaceAll("-", "");
  return `batch_${day}_${now.getTime()}_00000000-0000-4000-8000-000000000000`;
}

function httpFailureForStatus(status) {
  if (status === 401) {
    return {
      retryable: false,
      reason: "unauthorized",
      error: new Error("Telemetry receiver returned 401; disable sender until token is fixed."),
    };
  }
  if (status === 413) {
    return {
      retryable: false,
      reason: "payload_too_large",
      error: new Error("Telemetry batch is too large; receiver returned 413."),
    };
  }
  if (status >= 400 && status < 500 && status !== 429) {
    return {
      retryable: false,
      reason: `http_${status}`,
      error: new Error(`Telemetry receiver returned non-retryable ${status}.`),
    };
  }
  return {
    retryable: true,
    reason: `http_${status}`,
    error: new Error(`Telemetry receiver returned ${status}.`),
  };
}

function rejectedEventId(rejection) {
  if (typeof rejection === "string") return rejection;
  if (rejection && typeof rejection === "object" && typeof rejection.event_id === "string") {
    return rejection.event_id;
  }
  return null;
}

function acceptedEventIdsForAck(ack, batch) {
  if (!Object.hasOwn(ack, "accepted_event_ids")) {
    if (ack.received_count !== batch.events.length) {
      throw new Error("Telemetry receiver ACK received_count does not match the sent batch.");
    }
    return batch.events.map((event) => event.event_id);
  }

  const batchEventIds = new Set(batch.events.map((event) => event.event_id));
  const coveredEventIds = new Set();
  const acceptedEventIds = new Set();

  for (const eventId of ack.accepted_event_ids) {
    if (typeof eventId !== "string" || !batchEventIds.has(eventId)) {
      throw new Error("Telemetry receiver ACK does not cover the sent batch.");
    }
    if (acceptedEventIds.has(eventId) || coveredEventIds.has(eventId)) {
      throw new Error("Telemetry receiver ACK must list each sent event exactly once.");
    }
    acceptedEventIds.add(eventId);
    coveredEventIds.add(eventId);
  }

  const rejectedEventIds = new Set();
  for (const rejection of ack.rejected) {
    const eventId = rejectedEventId(rejection);
    if (!eventId || !batchEventIds.has(eventId)) {
      throw new Error("Telemetry receiver ACK does not cover the sent batch.");
    }
    if (rejectedEventIds.has(eventId) || coveredEventIds.has(eventId)) {
      throw new Error("Telemetry receiver ACK must list each sent event exactly once.");
    }
    rejectedEventIds.add(eventId);
    coveredEventIds.add(eventId);
  }

  if (coveredEventIds.size !== batchEventIds.size) {
    throw new Error("Telemetry receiver ACK does not cover the sent batch.");
  }

  return ack.accepted_event_ids;
}

export async function previewTelemetryFlush({
  cwd = process.cwd(),
  now = new Date(),
  batchSize = 100,
  maxBytes,
} = {}) {
  assertPositiveInteger(batchSize, "batchSize");
  if (maxBytes !== undefined) assertPositiveInteger(maxBytes, "maxBytes");

  const peeked = await peekTelemetryEvents({ cwd, batchSize });
  if (peeked.events.length === 0) {
    return {
      ok: true,
      dry_run: true,
      would_send_count: 0,
      event_ids: [],
      batch_bytes: 0,
      exceeds_max_bytes: false,
    };
  }

  const batch = rawBatchFromEvents({
    events: peeked.events,
    batchId: previewBatchId(now),
    now,
  });
  const batchBytes = byteLength(batch);
  return {
    ok: true,
    dry_run: true,
    would_send_count: batch.events.length,
    event_ids: batch.events.map((event) => event.event_id),
    batch_bytes: batchBytes,
    exceeds_max_bytes: maxBytes !== undefined && batchBytes > maxBytes,
  };
}

export async function flushTelemetryQueue({
  cwd = process.cwd(),
  endpoint,
  token,
  fetchImpl = fetch,
  now = new Date(),
  timeoutMs = 5000,
  batchSize = 100,
  dryRun = false,
  maxBytes,
} = {}) {
  const url = validateTelemetryEndpoint(endpoint);
  assertTelemetryToken(token);
  if (dryRun) {
    return previewTelemetryFlush({ cwd, now, batchSize, maxBytes });
  }
  if (maxBytes !== undefined) {
    assertPositiveInteger(maxBytes, "maxBytes");
    const preview = await previewTelemetryFlush({ cwd, now, batchSize, maxBytes });
    if (preview.would_send_count > 0 && preview.exceeds_max_bytes) {
      throw new Error("Telemetry batch exceeds maxBytes before send.");
    }
  }

  const claimed = await claimTelemetryBatch({ cwd, batchSize, now });
  if (claimed.events.length === 0) {
    return { ok: true, sent_count: 0 };
  }

  const batch = rawBatchFromClaimed({ claimed, now });

  let ack;
  let acceptedEventIds;
  let failure = { retryable: true, reason: "receiver_error" };
  try {
    ack = await withTimeout(timeoutMs, async (signal) => {
      const response = await fetchImpl(url.href, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(batch),
        signal,
      });

      if (!response.ok) {
        failure = httpFailureForStatus(response.status);
        throw failure.error;
      }

      const normalizedAck = normalizeReceiverAck(await parseJsonResponse(response, "Telemetry receiver ACK"));
      if (normalizedAck.batch_id !== batch.batch_id) {
        throw new Error("Telemetry receiver ACK batch_id does not match the sent batch.");
      }
      acceptedEventIds = acceptedEventIdsForAck(normalizedAck, batch);
      return normalizedAck;
    });

  } catch (error) {
    await failTelemetryBatch({
      cwd,
      batchId: claimed.batchId,
      retryable: failure.retryable,
      reason: failure.reason,
    });
    throw error;
  }

  await completeTelemetryBatch({ cwd, batchId: claimed.batchId, now });
  return {
    ok: true,
    sent_count: acceptedEventIds.length,
    batch_id: batch.batch_id,
    event_ids: acceptedEventIds,
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

  return withTimeout(timeoutMs, async (signal) => {
    const response = await fetchImpl(metricsUrl.href, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
      },
      signal,
    });

    if (!response.ok) {
      throw new Error(`Telemetry receiver returned ${response.status}.`);
    }

    return normalizeReceiverMetrics(await parseJsonResponse(response, "Telemetry receiver metrics"));
  });
}

export async function runTelemetryValidation({
  cwd = process.cwd(),
  endpoint,
  token,
  deploymentId = "gemini-agent-validation",
  prompt = "gemini-agent telemetry validation: reply with telemetry-ok",
  askGemini,
  fetchImpl = fetch,
  now = new Date(),
  validationBatchSize = VALIDATION_FLUSH_BATCH_SIZE,
  maxValidationFlushes,
} = {}) {
  validateTelemetryEndpoint(endpoint);
  assertTelemetryToken(token);
  assertPositiveInteger(validationBatchSize, "validationBatchSize");
  if (maxValidationFlushes !== undefined) {
    assertPositiveInteger(maxValidationFlushes, "maxValidationFlushes");
  }

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
      deployment_id: deploymentId,
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
  let attempt = 0;
  while (maxValidationFlushes === undefined || attempt < maxValidationFlushes) {
    const flush = await flushTelemetryQueue({
      cwd,
      endpoint,
      token,
      fetchImpl,
      now,
      batchSize: validationBatchSize,
    });
    attempt += 1;
    flushes.push(flush);
    if (flush.event_ids?.includes(validationEventId)) {
      validationFlush = flush;
      break;
    }
    if (flush.sent_count === 0) break;
  }

  let metrics = null;
  let metrics_warning = null;
  try {
    metrics = await receiverMetrics({ endpoint, token, fetchImpl });
  } catch (error) {
    metrics_warning = {
      message: error instanceof Error ? error.message : `${error}`,
    };
  }

  return {
    ok: metrics
      ? validationBatchRecorded({
        flush: validationFlush,
        metrics,
        validationEventId,
      })
      : validationBatchAcked({ flush: validationFlush, validationEventId }),
    flush: validationFlush,
    flushes,
    metrics,
    metrics_warning,
  };
}
