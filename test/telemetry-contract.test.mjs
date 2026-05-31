import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  RAW_TELEMETRY_SCHEMA_VERSION,
  normalizeRawTelemetryBatch,
} from "../src/telemetry-schemas.mjs";

const rawFixturePath = fileURLToPath(new URL("./fixtures/telemetry/raw-v1-batch.json", import.meta.url));

async function rawFixture(overrides = {}) {
  const fixture = JSON.parse(await readFile(rawFixturePath, "utf8"));
  return { ...fixture, ...overrides };
}

test("normalizeRawTelemetryBatch normalizes the raw-v1 fixture", async () => {
  const batch = normalizeRawTelemetryBatch(await rawFixture());

  assert.equal(RAW_TELEMETRY_SCHEMA_VERSION, "raw-v1");
  assert.equal(batch.schema_version, RAW_TELEMETRY_SCHEMA_VERSION);
  assert.equal(batch.batch_id, "batch-test-1");
  assert.equal(batch.events.length, 1);
  assert.equal(batch.events[0].model, "gemini-3.5-flash");
});

test("normalizeRawTelemetryBatch masks credentials in raw prompt and response", async () => {
  const fixture = await rawFixture();
  fixture.events[0].prompt_raw = "Authorization: Bearer abc.def.ghi";
  fixture.events[0].response_raw = "GEMINI_API_KEY=AIzaSyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

  const batch = normalizeRawTelemetryBatch(fixture);

  assert.equal(batch.events[0].prompt_raw, "Authorization: [MASKED]");
  assert.equal(batch.events[0].response_raw, "GEMINI_API_KEY=[MASKED]");
});

test("normalizeRawTelemetryBatch rejects unsupported raw schema versions", async () => {
  await assert.rejects(
    async () => normalizeRawTelemetryBatch(await rawFixture({ schema_version: "raw-v2" })),
    /raw-v1/,
  );
});

test("normalizeRawTelemetryBatch rejects invalid source and trigger enum values", async () => {
  const invalidSource = await rawFixture();
  invalidSource.events[0].source_host_app = "gemini-agent";
  await assert.rejects(
    async () => normalizeRawTelemetryBatch(invalidSource),
    /source_host_app/,
  );

  const invalidTrigger = await rawFixture();
  invalidTrigger.events[0].trigger_source = "validate";
  await assert.rejects(
    async () => normalizeRawTelemetryBatch(invalidTrigger),
    /trigger_source/,
  );
});
