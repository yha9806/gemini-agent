import assert from "node:assert/strict";
import test from "node:test";
import {
  CREDENTIAL_MASK_VERSION,
  credentialMaskPatterns,
  maskCredentialText,
  normalizeTelemetryBatch,
  normalizeTelemetryConfig,
  normalizeTelemetryEvent,
  normalizeTelemetryReceiverAck,
  normalizeTelemetryReceiverMetrics,
  truncateTelemetryText,
} from "../src/telemetry-schemas.mjs";

function validTelemetryConfig(overrides = {}) {
  return {
    enabled: true,
    level: "raw",
    endpoint: "http://127.0.0.1:8787/ingest",
    token_env: "GEMINI_AGENT_TELEMETRY_TOKEN",
    schedule: "daily@09:00",
    max_event_bytes: 1024,
    max_queue_bytes: 4096,
    created_at: "2026-05-29T09:00:00.000Z",
    updated_at: "2026-05-29T09:00:00.000Z",
    ...overrides,
  };
}

function validTelemetryEvent(overrides = {}) {
  return {
    schema_version: 1,
    event_id: "evt_test",
    trace_id: "trace_test",
    deployment_id: "dep_test",
    project_id: "gemini-agent",
    source: "cli",
    command: "ask",
    model: "gemini-3.5-flash",
    prompt: "hello",
    response: "world",
    status: "success",
    error_type: null,
    latency_ms: 1,
    created_at: "2026-05-29T09:00:00.000Z",
    payload: { prompt_truncated: false, response_truncated: false, multimodal: [] },
    ...overrides,
  };
}

function validTelemetryBatch(overrides = {}) {
  return {
    schema_version: 1,
    batch_id: "batch_test",
    deployment_id: "dep_test",
    scheduled_for: "2026-05-29T09:00:00.000Z",
    sent_at: "2026-05-29T09:00:01.000Z",
    events: [validTelemetryEvent()],
    ...overrides,
  };
}

function validTelemetryMetrics(overrides = {}) {
  return {
    ok: true,
    received_events: 12,
    received_batches: 3,
    last_received_at: "2026-05-29T09:00:06.000Z",
    last_batch_id: "batch_test",
    latest_event: {
      received_at: "2026-05-29T09:00:06.000Z",
      batch_id: "batch_test",
      command: "ask",
      model: "gemini-3.5-flash",
      status: "success",
    },
    status_counts: {
      success: 10,
      error: 2,
    },
    clock_skew_warnings: 1,
    ...overrides,
  };
}

test("normalizes raw telemetry config", () => {
  const config = normalizeTelemetryConfig(validTelemetryConfig({
    install_id: "install_11111111-1111-4111-8111-111111111111",
    user_label: "local-admin",
  }));
  assert.equal(config.level, "raw");
  assert.equal(config.endpoint, "http://127.0.0.1:8787/ingest");
  assert.equal(config.install_id, "install_11111111-1111-4111-8111-111111111111");
  assert.equal(config.user_label, "local-admin");
});

test("normalizes event and masks credential-shaped raw text", () => {
  const event = normalizeTelemetryEvent({
    schema_version: 1,
    event_id: "evt_test",
    trace_id: "trace_test",
    deployment_id: "dep_test",
    project_id: "gemini-agent",
    source: "cli",
    command: "ask",
    model: "gemini-3.5-flash",
    prompt: "Authorization: Bearer abc.def.ghi",
    response: "GEMINI_API_KEY=AIzaSyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    status: "success",
    error_type: null,
    latency_ms: 12,
    created_at: "2026-05-29T09:00:00.000Z",
    payload: {
      prompt_truncated: false,
      response_truncated: false,
      multimodal: [],
    },
  });
  assert.equal(event.prompt, "Authorization: [MASKED]");
  assert.equal(event.response, "GEMINI_API_KEY=[MASKED]");
});

test("normalizes product telemetry context, outcome, and economics fields", () => {
  const event = normalizeTelemetryEvent(validTelemetryEvent({
    context: {
      cwd: "/Users/example/project",
      session_id: "session-1",
      run_id: "run-2.16",
      task_id: "task-1",
      parent_codex_session: "codex-session-1",
      install_id: "install_11111111-1111-4111-8111-111111111111",
      workspace_id: "ws_0123456789abcdef01234567",
      user_label: "local-admin",
    },
    outcome: {
      task_outcome: "success",
      user_acceptance: "accepted",
      accepted_files: ["src/telemetry-schemas.mjs"],
      modified_after_review: false,
      followup_required: true,
    },
    economics: {
      codex_tokens_saved_estimate: 1200,
      input_tokens: 30,
      output_tokens: 40,
      total_tokens: 70,
      latency_bucket: "5_15s",
      cost_bucket: "low",
    },
  }));

  assert.equal(event.context.cwd, "/Users/example/project");
  assert.equal(event.context.run_id, "run-2.16");
  assert.equal(event.context.install_id, "install_11111111-1111-4111-8111-111111111111");
  assert.equal(event.context.workspace_id, "ws_0123456789abcdef01234567");
  assert.equal(event.context.user_label, "local-admin");
  assert.equal(event.outcome.task_outcome, "success");
  assert.deepEqual(event.outcome.accepted_files, ["src/telemetry-schemas.mjs"]);
  assert.equal(event.economics.total_tokens, 70);
  assert.equal(event.economics.latency_bucket, "5_15s");
});

test("defaults product telemetry fields without sharing nested values", () => {
  const first = normalizeTelemetryEvent(validTelemetryEvent({ event_id: "evt_first" }));
  const second = normalizeTelemetryEvent(validTelemetryEvent({ event_id: "evt_second" }));

  assert.deepEqual(first.context, {
    cwd: null,
    session_id: null,
    run_id: null,
    task_id: null,
    parent_codex_session: null,
    install_id: null,
    workspace_id: null,
    user_label: null,
  });
  assert.deepEqual(first.outcome, {
    task_outcome: "unknown",
    user_acceptance: "unknown",
    accepted_files: [],
    modified_after_review: null,
    followup_required: null,
  });
  assert.deepEqual(first.economics, {
    codex_tokens_saved_estimate: null,
    input_tokens: null,
    output_tokens: null,
    total_tokens: null,
    latency_bucket: null,
    cost_bucket: null,
  });

  first.outcome.accepted_files.push("changed.js");
  assert.deepEqual(second.outcome.accepted_files, []);
});

test("maps raw-v1 metadata and usage into product telemetry fields", () => {
  const batch = normalizeTelemetryBatch({
    schema_version: "raw-v1",
    batch_id: "batch_raw_product",
    deployment_id: "dep_test",
    agent_version: "0.1.0",
    generated_at: "2026-06-03T09:00:00.000Z",
    checksum: "sha256:test",
    events: [{
      event_id: "evt_raw_product",
      source_host_app: "codex",
      trigger_source: "manual",
      model_provider: "google",
      model: "gemini-3.5-flash",
      command: "artifact-review",
      started_at: "2026-06-03T08:59:58.000Z",
      ended_at: "2026-06-03T09:00:00.000Z",
      latency_ms: 2000,
      status: "success",
      usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
      request_raw: {},
      prompt_raw: "prompt",
      response_raw: "response",
      response_candidates_raw: [],
      tool_calls_raw: [],
      media_manifest: [],
      error: null,
      metadata: {
        project_id: "vulca",
        trace_id: "trace_raw_product",
        context: { cwd: "/tmp/vulca", run_id: "run-2.16" },
        outcome: { task_outcome: "partial", followup_required: true },
        economics: { codex_tokens_saved_estimate: 500, latency_bucket: "1_5s" },
      },
    }],
  });

  assert.equal(batch.events[0].project_id, "vulca");
  assert.equal(batch.events[0].trace_id, "trace_raw_product");
  assert.equal(batch.events[0].context.cwd, "/tmp/vulca");
  assert.equal(batch.events[0].context.run_id, "run-2.16");
  assert.equal(batch.events[0].outcome.task_outcome, "partial");
  assert.equal(batch.events[0].outcome.followup_required, true);
  assert.equal(batch.events[0].economics.input_tokens, 10);
  assert.equal(batch.events[0].economics.output_tokens, 20);
  assert.equal(batch.events[0].economics.total_tokens, 30);
  assert.equal(batch.events[0].economics.codex_tokens_saved_estimate, 500);
  assert.equal(batch.events[0].economics.latency_bucket, "1_5s");
});

test("rejects telemetry models other than gemini 3.5 flash", () => {
  assert.throws(
    () => normalizeTelemetryEvent(validTelemetryEvent({ model: "gemini-2.5-flash" })),
    /model|gemini-3\.5-flash/,
  );
  assert.throws(
    () => normalizeTelemetryReceiverMetrics(validTelemetryMetrics({
      latest_event: { ...validTelemetryMetrics().latest_event, model: "gemini-2.5-flash" },
    })),
    /model|gemini-3\.5-flash/,
  );
});

test("omitted telemetry event payloads do not share objects", () => {
  const { payload, ...eventWithoutPayload } = validTelemetryEvent();
  assert.equal(payload.multimodal.length, 0);
  const first = normalizeTelemetryEvent({ ...eventWithoutPayload, event_id: "evt_first" });
  const second = normalizeTelemetryEvent({ ...eventWithoutPayload, event_id: "evt_second" });
  assert.notEqual(first.payload, second.payload);
  assert.notEqual(first.payload.multimodal, second.payload.multimodal);
  first.payload.multimodal.push({ mime_type: "image/png" });
  assert.deepEqual(second.payload.multimodal, []);
});

test("normalizes batch", () => {
  const batch = normalizeTelemetryBatch(validTelemetryBatch());
  assert.equal(batch.events.length, 1);
});

test("normalizes receiver ingest ack", () => {
  const ack = normalizeTelemetryReceiverAck({
    ok: true,
    batch_id: "batch_test",
    received_count: 1,
    received_at: "2026-05-29T09:00:02.000Z",
  });
  assert.equal(ack.ok, true);
  assert.equal(ack.batch_id, "batch_test");
  assert.equal(ack.received_count, 1);
});

test("rejects empty receiver ingest ack count", () => {
  assert.throws(
    () => normalizeTelemetryReceiverAck({
      ok: true,
      batch_id: "batch_test",
      received_count: 0,
      received_at: "2026-05-29T09:00:02.000Z",
    }),
    /received_count/,
  );
});

test("normalizes receiver metrics response", () => {
  const metrics = normalizeTelemetryReceiverMetrics(validTelemetryMetrics());
  assert.equal(metrics.ok, true);
  assert.equal(metrics.received_events, 12);
  assert.equal(metrics.latest_event.command, "ask");
  assert.deepEqual(metrics.status_counts, { success: 10, error: 2 });
  assert.equal(metrics.clock_skew_warnings, 1);
});

test("defaults receiver metrics clock skew warnings", () => {
  const { clock_skew_warnings, ...metricsWithoutSkew } = validTelemetryMetrics();
  assert.equal(clock_skew_warnings, 1);
  const metrics = normalizeTelemetryReceiverMetrics(metricsWithoutSkew);
  assert.equal(metrics.clock_skew_warnings, 0);
});

test("requires receiver metrics status counts", () => {
  assert.throws(
    () => normalizeTelemetryReceiverMetrics({
      ok: true,
      received_events: 12,
      received_batches: 3,
      last_received_at: "2026-05-29T09:00:06.000Z",
      last_batch_id: "batch_test",
      latest_event: null,
      clock_skew_warnings: 1,
    }),
    /status_counts/,
  );
});

test("validates receiver metrics status counts", () => {
  assert.throws(
    () => normalizeTelemetryReceiverMetrics({
      ok: true,
      received_events: 12,
      received_batches: 3,
      last_received_at: null,
      last_batch_id: null,
      latest_event: null,
      status_counts: { success: 10.5, error: 0 },
      clock_skew_warnings: 1,
    }),
    /status_counts[\s\S]*success/,
  );
  assert.throws(
    () => normalizeTelemetryReceiverMetrics({
      ok: true,
      received_events: 12,
      received_batches: 3,
      last_received_at: null,
      last_batch_id: null,
      latest_event: null,
      status_counts: { success: 10, error: -1 },
      clock_skew_warnings: 1,
    }),
    /status_counts[\s\S]*error/,
  );
});

test("rejects unknown telemetry contract fields", () => {
  assert.throws(() => normalizeTelemetryConfig(validTelemetryConfig({ extra: true })), /unrecognized/i);
  assert.throws(() => normalizeTelemetryEvent(validTelemetryEvent({ extra: true })), /unrecognized/i);
  assert.throws(() => normalizeTelemetryEvent(validTelemetryEvent({
    payload: { prompt_truncated: false, response_truncated: false, multimodal: [], extra: true },
  })), /unrecognized/i);
  assert.throws(() => normalizeTelemetryEvent(validTelemetryEvent({
    payload: {
      prompt_truncated: false,
      response_truncated: false,
      multimodal: [{ mime_type: "image/png", extra: true }],
    },
  })), /unrecognized/i);
  assert.throws(() => normalizeTelemetryEvent(validTelemetryEvent({
    context: {
      cwd: null,
      session_id: null,
      run_id: null,
      task_id: null,
      parent_codex_session: null,
      extra: true,
    },
  })), /unrecognized/i);
  assert.throws(() => normalizeTelemetryEvent(validTelemetryEvent({
    outcome: {
      task_outcome: "unknown",
      user_acceptance: "unknown",
      accepted_files: [],
      modified_after_review: null,
      followup_required: null,
      extra: true,
    },
  })), /unrecognized/i);
  assert.throws(() => normalizeTelemetryEvent(validTelemetryEvent({
    economics: {
      codex_tokens_saved_estimate: null,
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      latency_bucket: null,
      cost_bucket: null,
      extra: true,
    },
  })), /unrecognized/i);
  assert.throws(() => normalizeTelemetryBatch(validTelemetryBatch({ extra: true })), /unrecognized/i);
  assert.throws(() => normalizeTelemetryReceiverAck({
    ok: true,
    batch_id: "batch_test",
    received_count: 1,
    received_at: "2026-05-29T09:00:02.000Z",
    extra: true,
  }), /unrecognized/i);
  assert.throws(() => normalizeTelemetryReceiverMetrics(validTelemetryMetrics({ extra: true })), /unrecognized/i);
  assert.throws(() => normalizeTelemetryReceiverMetrics(validTelemetryMetrics({
    latest_event: {
      received_at: "2026-05-29T09:00:06.000Z",
      batch_id: "batch_test",
      command: "ask",
      model: "gemini-3.5-flash",
      status: "success",
      extra: true,
    },
  })), /unrecognized/i);
  assert.throws(() => normalizeTelemetryReceiverMetrics(validTelemetryMetrics({
    status_counts: { success: 10, error: 2, extra: true },
  })), /unrecognized/i);
});

test("rejects non-UTC telemetry timestamps", () => {
  const offset = "2026-05-29T09:00:00+01:00";
  assert.throws(() => normalizeTelemetryConfig(validTelemetryConfig({ created_at: offset })), /UTC|Z/);
  assert.throws(() => normalizeTelemetryConfig(validTelemetryConfig({ updated_at: offset })), /UTC|Z/);
  assert.throws(() => normalizeTelemetryEvent(validTelemetryEvent({ created_at: offset })), /UTC|Z/);
  assert.throws(() => normalizeTelemetryBatch(validTelemetryBatch({ scheduled_for: offset })), /UTC|Z/);
  assert.throws(() => normalizeTelemetryBatch(validTelemetryBatch({ sent_at: offset })), /UTC|Z/);
  assert.throws(() => normalizeTelemetryReceiverAck({
    ok: true,
    batch_id: "batch_test",
    received_count: 1,
    received_at: offset,
  }), /UTC|Z/);
  assert.throws(() => normalizeTelemetryReceiverMetrics(validTelemetryMetrics({
    last_received_at: offset,
  })), /UTC|Z/);
  assert.throws(() => normalizeTelemetryReceiverMetrics(validTelemetryMetrics({
    latest_event: { ...validTelemetryMetrics().latest_event, received_at: offset },
  })), /UTC|Z/);
});

test("truncates text by byte limit without splitting utf8 characters", () => {
  const ascii = truncateTelemetryText("abcdef", 3);
  assert.equal(ascii.text, "abc");
  assert.equal(ascii.truncated, true);

  const unicode = truncateTelemetryText("a你b", 2);
  assert.equal(unicode.text, "a");
  assert.equal(unicode.truncated, true);

  const malformed = Buffer.from([0xe4, 0xbd]).toString("utf8");
  assert.doesNotThrow(() => truncateTelemetryText(malformed, 1));
});

test("rejects invalid telemetry truncation byte limits", () => {
  assert.throws(() => truncateTelemetryText("abcdef", -1), RangeError);
  assert.throws(() => truncateTelemetryText("abcdef", 1.5), RangeError);
  assert.throws(() => truncateTelemetryText("abcdef", Number.NaN), RangeError);
});

test("masks documented credential patterns", () => {
  assert.equal(maskCredentialText("Authorization: Bearer secret-token"), "Authorization: [MASKED]");
  assert.equal(maskCredentialText("Authorization: ApiKey secret-token"), "Authorization: [MASKED]");
  assert.equal(maskCredentialText("Authorization: Token secret-token"), "Authorization: [MASKED]");
  assert.equal(maskCredentialText("X-API-Key: secret-token"), "X-API-Key: [MASKED]");
  assert.equal(maskCredentialText("X_API_KEY=secret-token"), "X_API_KEY=[MASKED]");
  assert.equal(maskCredentialText("OPENAI_API_KEY = sk-live-secret"), "OPENAI_API_KEY = [MASKED]");
  assert.equal(maskCredentialText('X_API_KEY="secret-token"'), 'X_API_KEY="[MASKED]"');
  assert.equal(maskCredentialText("X_TOKEN='secret-token'"), "X_TOKEN='[MASKED]'");
  assert.equal(maskCredentialText('{"token":"secret-token"}'), '{"token":"[MASKED]"}');
});

test("masks standalone bearer tokens without crossing lines", () => {
  assert.equal(maskCredentialText('curl -H "Bearer secret-token"'), 'curl -H "Bearer [MASKED]"');
  assert.equal(maskCredentialText("curl -H 'Bearer abcdef+ghijk/lmnop=='"), "curl -H 'Bearer [MASKED]'");
  assert.equal(maskCredentialText("Bearer abcdef:ghijkl"), "Bearer [MASKED]");
  assert.equal(maskCredentialText("Bearer abcdef%2Fghijkl"), "Bearer [MASKED]");
  assert.equal(maskCredentialText('curl -H "Bearer abcdef:ghijkl"'), 'curl -H "Bearer [MASKED]"');
  assert.equal(maskCredentialText("Bearer abcdef:ghijkl\nBearer abcdef%2Fghijkl"), "Bearer [MASKED]\nBearer [MASKED]");
  assert.equal(maskCredentialText("Bearer\nsecret-token"), "Bearer\nsecret-token");
  assert.equal(
    maskCredentialText("Authorization: Bearer secret-token\nX-Debug: Bearer debug-token\nNote: Bearer dev"),
    "Authorization: [MASKED]\nX-Debug: Bearer [MASKED]\nNote: Bearer dev",
  );
});

test("exposes credential mask pattern audit metadata", () => {
  const patterns = credentialMaskPatterns();
  assert.equal(typeof CREDENTIAL_MASK_VERSION, "number");
  assert.ok(patterns.length > 0);
  assert.ok(patterns.every((entry) => entry.masking_version === CREDENTIAL_MASK_VERSION));
  assert.ok(patterns.every((entry) => typeof entry.flags === "string"));
});
