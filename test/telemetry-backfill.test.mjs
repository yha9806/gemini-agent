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

test("artifactReviewsToRawTelemetryBatch enriches media manifest from artifact sources", async () => {
  const projectRoot = await tempDir();
  const artifactsDir = join(projectRoot, ".gemini-agent", "artifacts");
  const sourceDir = join(projectRoot, "outputs");
  await mkdir(artifactsDir, { recursive: true });
  await mkdir(sourceDir, { recursive: true });
  const sourceBytes = Buffer.from("not real png but size is useful");
  await writeFile(join(sourceDir, "screen.png"), sourceBytes);
  await writeArtifact(artifactsDir, "2026-06-03T145551114Z-artifacts.json", artifact({
    metadata: {
      model: "gemini-3.5-flash",
      generated_at: "2026-06-03T14:55:51.114Z",
      sources: ["outputs/screen.png"],
      omitted_sources: [],
    },
  }));

  const batch = await artifactReviewsToRawTelemetryBatch({
    artifactsDir,
    deploymentId: "gemini-agent-main",
    agentVersion: "0.1.0",
    batchId: "batch_backfill_media_test",
  });

  assert.deepEqual(batch.events[0].media_manifest, [{
    basename: "screen.png",
    mime_type: "image/png",
    byte_size: sourceBytes.length,
  }]);
  assert.doesNotMatch(JSON.stringify(batch.events[0].media_manifest), /outputs/);
  assert.doesNotThrow(() => normalizeRawTelemetryBatch(batch));
});

test("artifactReviewsToRawTelemetryBatch creates deterministic correction events", async () => {
  const artifactsDir = await tempDir();
  await writeArtifact(artifactsDir, "2026-06-03T145551114Z-artifacts.json", artifact());

  const original = await artifactReviewsToRawTelemetryBatch({
    artifactsDir,
    deploymentId: "gemini-agent-main",
    agentVersion: "0.1.0",
    batchId: "batch_backfill_original_test",
  });
  const correction = await artifactReviewsToRawTelemetryBatch({
    artifactsDir,
    deploymentId: "gemini-agent-main",
    agentVersion: "0.1.0",
    batchId: "batch_backfill_correction_test",
    correctionVersion: "media-v1",
  });
  const repeated = await artifactReviewsToRawTelemetryBatch({
    artifactsDir,
    deploymentId: "gemini-agent-main",
    agentVersion: "0.1.0",
    batchId: "batch_backfill_correction_repeat_test",
    correctionVersion: "media-v1",
  });
  const nextVersion = await artifactReviewsToRawTelemetryBatch({
    artifactsDir,
    deploymentId: "gemini-agent-main",
    agentVersion: "0.1.0",
    batchId: "batch_backfill_correction_next_test",
    correctionVersion: "media-v2",
  });

  assert.equal(correction.events[0].command, "artifact-review-backfill-correction");
  assert.match(correction.events[0].event_id, /^artifact_correction_[a-f0-9]{24}$/);
  assert.notEqual(correction.events[0].event_id, original.events[0].event_id);
  assert.equal(correction.events[0].event_id.includes(original.events[0].event_id), false);
  assert.equal(repeated.events[0].event_id, correction.events[0].event_id);
  assert.notEqual(nextVersion.events[0].event_id, correction.events[0].event_id);
  assert.equal(correction.events[0].metadata.backfill_source, "artifact_review_json_correction");
  assert.equal(correction.events[0].metadata.correction_for_event_id, original.events[0].event_id);
  assert.equal(correction.events[0].metadata.correction_version, "media-v1");
  assert.equal(correction.events[0].metadata.correction_reason, "media_manifest_enrichment");
  assert.doesNotThrow(() => normalizeRawTelemetryBatch(correction));

  const legacy = normalizeTelemetryBatch(correction);
  assert.equal(legacy.events[0].command, "artifact-review-backfill-correction");
  assert.equal(legacy.events[0].metadata.correction_for_event_id, original.events[0].event_id);
  assert.equal(legacy.events[0].metadata.correction_version, "media-v1");
});

test("artifactReviewsToRawTelemetryBatch does not stat source paths outside the project root", async () => {
  const projectRoot = await tempDir();
  const outsideRoot = await tempDir();
  const artifactsDir = join(projectRoot, ".gemini-agent", "artifacts");
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(join(outsideRoot, "outside.png"), "outside bytes");
  await writeArtifact(artifactsDir, "2026-06-03T145551114Z-artifacts.json", artifact({
    metadata: {
      model: "gemini-3.5-flash",
      generated_at: "2026-06-03T14:55:51.114Z",
      sources: [`../${outsideRoot.split("/").at(-1)}/outside.png`],
      omitted_sources: [],
    },
  }));

  const batch = await artifactReviewsToRawTelemetryBatch({
    artifactsDir,
    deploymentId: "gemini-agent-main",
    agentVersion: "0.1.0",
    batchId: "batch_backfill_outside_media_test",
  });

  assert.deepEqual(batch.events[0].media_manifest, [{
    basename: "outside.png",
    mime_type: "image/png",
  }]);
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
