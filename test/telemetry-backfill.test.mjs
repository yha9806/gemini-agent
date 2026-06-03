import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import test from "node:test";
import {
  artifactReviewsToRawTelemetryBatch,
  sanitizeBackfillValue,
} from "../src/telemetry-backfill.mjs";
import {
  RAW_TELEMETRY_SCHEMA_VERSION,
  normalizeRawTelemetryBatch,
  normalizeTelemetryBatch,
} from "../src/telemetry-schemas.mjs";

async function tempDir() {
  return mkdtemp(join(tmpdir(), "gemini-agent-backfill-"));
}

async function writeArtifact(dir, name, value) {
  await writeFile(join(dir, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function artifact(overrides = {}) {
  return {
    kind: "artifact_review",
    artifact_type: "image",
    summary: ["Review of Run 2 /Users/example/private/project/secret.png"],
    important_details: ["Authorization: Bearer secret-token"],
    metadata: {
      model: "gemini-3.5-flash",
      generated_at: "2026-06-03T14:55:51.114Z",
      sources: ["/Users/example/private/project/secret.png"],
      omitted_sources: [],
    },
    ...overrides,
  };
}

test("sanitizeBackfillValue masks credentials and absolute local paths", () => {
  const sanitized = sanitizeBackfillValue({
    summary: "Bearer secret-token in /Users/example/private/file.png",
    source: "file:///Users/example/private/file.png",
  });

  assert.equal(sanitized.summary, "Bearer [MASKED] in [PATH]/file.png");
  assert.equal(sanitized.source, "[PATH]/file.png");
});

test("artifactReviewsToRawTelemetryBatch converts timestamped artifact reviews to raw-v1 events", async () => {
  const artifactsDir = await tempDir();
  await writeArtifact(artifactsDir, "2026-06-03T145551114Z-artifacts.json", artifact());
  await writeArtifact(artifactsDir, "latest.json", artifact({
    metadata: { model: "gemini-3.5-flash", generated_at: "2026-06-04T00:00:00.000Z", sources: [] },
  }));

  const batch = await artifactReviewsToRawTelemetryBatch({
    artifactsDir,
    deploymentId: "gemini-agent-main",
    agentVersion: "0.1.0",
    batchId: "batch_backfill_test",
    generatedAt: new Date("2026-06-03T15:00:00.000Z"),
  });

  assert.equal(batch.schema_version, RAW_TELEMETRY_SCHEMA_VERSION);
  assert.equal(batch.events.length, 1);
  assert.equal(batch.events[0].command, "artifact-review-backfill");
  assert.equal(batch.events[0].model, "gemini-3.5-flash");
  assert.equal(batch.events[0].started_at, "2026-06-03T14:55:51.114Z");
  assert.equal(batch.events[0].metadata.backfill_source, "artifact_review_json");
  assert.equal(batch.events[0].metadata.artifact_type, "image");
  assert.equal(batch.events[0].metadata.context.run_id, "run-2");
  assert.doesNotMatch(batch.events[0].response_raw, /\/Users\/example/);
  assert.doesNotMatch(batch.events[0].response_raw, /secret-token/);
  assert.doesNotThrow(() => normalizeRawTelemetryBatch(batch));

  const legacy = normalizeTelemetryBatch(batch);
  assert.equal(legacy.events[0].command, "artifact-review-backfill");
  assert.equal(legacy.events[0].context.run_id, "run-2");
});

test("artifactReviewsToRawTelemetryBatch enforces file count and byte limits", async () => {
  const artifactsDir = await tempDir();
  await mkdir(artifactsDir, { recursive: true });
  await writeArtifact(artifactsDir, "2026-06-03T000000000Z-artifacts.json", artifact());
  await writeArtifact(artifactsDir, "2026-06-03T000001000Z-artifacts.json", artifact());

  await assert.rejects(
    () => artifactReviewsToRawTelemetryBatch({
      artifactsDir,
      deploymentId: "gemini-agent-main",
      agentVersion: "0.1.0",
      maxFiles: 1,
    }),
    /too many artifact review files/,
  );

  await assert.rejects(
    () => artifactReviewsToRawTelemetryBatch({
      artifactsDir,
      deploymentId: "gemini-agent-main",
      agentVersion: "0.1.0",
      maxArtifactBytes: 16,
    }),
    /exceeds maxArtifactBytes/,
  );
});
