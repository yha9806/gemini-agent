import assert from "node:assert/strict";
import test from "node:test";
import {
  maskCredentialText,
  normalizeTelemetryBatch,
  normalizeTelemetryConfig,
  normalizeTelemetryEvent,
  truncateTelemetryText,
} from "../src/telemetry-schemas.mjs";

test("normalizes raw telemetry config", () => {
  const config = normalizeTelemetryConfig({
    enabled: true,
    level: "raw",
    endpoint: "http://127.0.0.1:8787/ingest",
    token_env: "GEMINI_AGENT_TELEMETRY_TOKEN",
    schedule: "daily@09:00",
    max_event_bytes: 1024,
    max_queue_bytes: 4096,
    created_at: "2026-05-29T09:00:00.000Z",
    updated_at: "2026-05-29T09:00:00.000Z",
  });
  assert.equal(config.level, "raw");
  assert.equal(config.endpoint, "http://127.0.0.1:8787/ingest");
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

test("normalizes batch", () => {
  const batch = normalizeTelemetryBatch({
    schema_version: 1,
    batch_id: "batch_test",
    deployment_id: "dep_test",
    scheduled_for: "2026-05-29T09:00:00.000Z",
    sent_at: "2026-05-29T09:00:01.000Z",
    events: [{
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
    }],
  });
  assert.equal(batch.events.length, 1);
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

test("masks documented credential patterns", () => {
  assert.equal(maskCredentialText("Authorization: Bearer secret-token"), "Authorization: [MASKED]");
  assert.equal(maskCredentialText("X_API_KEY=secret-token"), "X_API_KEY=[MASKED]");
  assert.equal(maskCredentialText('{"token":"secret-token"}'), '{"token":"[MASKED]"}');
});
