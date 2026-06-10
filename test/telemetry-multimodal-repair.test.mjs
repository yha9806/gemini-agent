import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendTelemetryEvent, telemetryQueueDirs } from "../src/telemetry-queue.mjs";
import {
  formatTelemetryMultimodalRepairMetadataText,
  formatTelemetryMultimodalRepairText,
  runTelemetryMultimodalRepairKind,
  runTelemetryMultimodalRepairMetadata,
} from "../src/telemetry-multimodal-repair.mjs";

async function temporaryWorkspace(prefix = "gemini-agent-telemetry-multimodal-repair-") {
  return mkdtemp(join(tmpdir(), prefix));
}

function telemetryEvent(index, overrides = {}) {
  const suffix = `${index}`.padStart(6, "0");
  return {
    schema_version: 1,
    event_id: `evt_repair_${suffix}`,
    trace_id: `trace_repair_${suffix}`,
    deployment_id: "dep_test",
    project_id: "gemini-agent",
    source: "cli",
    command: "gemini-artifact-review",
    model: "gemini-3.5-flash",
    prompt: `private repair prompt ${suffix}`,
    response: `private repair response ${suffix}`,
    status: "success",
    error_type: null,
    latency_ms: index,
    created_at: "2026-06-10T09:00:00.000Z",
    payload: { prompt_truncated: false, response_truncated: false, multimodal: [] },
    context: {
      cwd: "/Users/example/private/project",
      session_id: null,
      run_id: null,
      task_id: null,
      parent_codex_session: null,
    },
    outcome: {
      task_outcome: "unknown",
      user_acceptance: "unknown",
      accepted_files: [],
      modified_after_review: null,
      followup_required: null,
    },
    economics: {
      codex_tokens_saved_estimate: null,
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      latency_bucket: null,
      cost_bucket: null,
    },
    ...overrides,
  };
}

test("runTelemetryMultimodalRepairKind dry-runs aggregate-only media kind corrections", async () => {
  const cwd = await temporaryWorkspace();
  try {
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(1, {
        payload: {
          prompt_truncated: false,
          response_truncated: false,
          multimodal: [
            { mime_type: "IMAGE/PNG; charset=binary", byte_size: 10, basename: "private-screen.png" },
            { mime_type: "application/pdf; version=1.4", byte_size: 20, basename: "private-doc.pdf" },
            { mime_type: "text/plain", byte_size: 30, basename: "private-notes.txt" },
          ],
        },
      }),
    });
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(2, {
        command: "palette-split",
        payload: {
          prompt_truncated: false,
          response_truncated: false,
          multimodal: [
            { mime_type: "image/png", byte_size: 11, basename: "source.png", media_kind: "unknown" },
            { mime_type: "image/png", byte_size: 12, basename: "palette_mask.png", media_kind: "unknown" },
          ],
        },
      }),
    });

    const report = await runTelemetryMultimodalRepairKind({
      cwd,
      scope: "local",
      correctionVersion: "media-kind-v1",
      dryRun: true,
      now: new Date("2026-06-10T10:00:00.000Z"),
    });
    const text = formatTelemetryMultimodalRepairText(report);
    const serialized = `${JSON.stringify(report)}\n${text}`;

    assert.equal(report.dry_run, true);
    assert.equal(report.scanned_events, 2);
    assert.equal(report.repairable_events, 2);
    assert.equal(report.repairable_media_items, 5);
    assert.equal(report.queued_count, 0);
    assert.equal(report.preview.top_inferred_media_kind[0].media_kind, "image");
    assert.equal(report.preview.top_inferred_media_kind.some((item) => item.media_kind === "document"), true);
    assert.equal(report.preview.top_inferred_media_kind.some((item) => item.media_kind === "unknown"), true);
    assert.match(text, /Telemetry Multimodal Repair/);
    assert.doesNotMatch(serialized, /private repair prompt/);
    assert.doesNotMatch(serialized, /private repair response/);
    assert.doesNotMatch(serialized, /evt_repair_/);
    assert.doesNotMatch(serialized, /private-screen|private-doc|private-notes|\/Users\/example/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runTelemetryMultimodalRepairKind writes deterministic idempotent correction events", async () => {
  const cwd = await temporaryWorkspace();
  try {
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(10, {
        payload: {
          prompt_truncated: false,
          response_truncated: false,
          multimodal: [{ mime_type: "image/jpeg", byte_size: 10, basename: "private-photo.jpg" }],
        },
      }),
    });

    const first = await runTelemetryMultimodalRepairKind({
      cwd,
      scope: "local",
      correctionVersion: "media-kind-v1",
      dryRun: false,
      now: new Date("2026-06-10T10:00:00.000Z"),
    });
    const second = await runTelemetryMultimodalRepairKind({
      cwd,
      scope: "local",
      correctionVersion: "media-kind-v1",
      dryRun: false,
      now: new Date("2026-06-10T10:01:00.000Z"),
    });

    assert.equal(first.queued_count, 1);
    assert.equal(first.skipped_existing_count, 0);
    assert.equal(second.queued_count, 0);
    assert.equal(second.skipped_existing_count, 1);
    assert.equal(second.repairable_events, 0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runTelemetryMultimodalRepairKind reports invalid files and enforces repair limit", async () => {
  const cwd = await temporaryWorkspace();
  try {
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(20, {
        payload: {
          prompt_truncated: false,
          response_truncated: false,
          multimodal: [{ mime_type: "image/png", byte_size: 10 }],
        },
      }),
    });
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(21, {
        payload: {
          prompt_truncated: false,
          response_truncated: false,
          multimodal: [{ mime_type: "image/jpeg", byte_size: 20 }],
        },
      }),
    });
    await writeFile(join(telemetryQueueDirs(cwd).pending, "invalid.json"), "{not json}\n");

    const limited = await runTelemetryMultimodalRepairKind({
      cwd,
      scope: "local",
      correctionVersion: "media-kind-v1",
      limit: 1,
    });
    const exact = await runTelemetryMultimodalRepairKind({
      cwd,
      scope: "local",
      correctionVersion: "media-kind-v1",
      limit: 2,
    });

    assert.equal(limited.invalid_file_count, 1);
    assert.equal(limited.repairable_events, 1);
    assert.equal(limited.limited_count, 1);
    assert.equal(exact.invalid_file_count, 1);
    assert.equal(exact.repairable_events, 2);
    assert.equal(exact.limited_count, 0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runTelemetryMultimodalRepairKind enforces version and limit safety", async () => {
  await assert.rejects(
    () => runTelemetryMultimodalRepairKind({ correctionVersion: "bad/version" }),
    /correctionVersion must contain/,
  );
  await assert.rejects(
    () => runTelemetryMultimodalRepairKind({ correctionVersion: "media-kind-v1", limit: 0 }),
    /limit must be a positive integer/,
  );
});

test("runTelemetryMultimodalRepairMetadata infers safe MIME and kind without fabricating byte size", async () => {
  const cwd = await temporaryWorkspace();
  try {
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(30, {
        payload: {
          prompt_truncated: false,
          response_truncated: false,
          multimodal: [
            { basename: "media-aaa111.PNG" },
            { basename: "media-bbb222.Jpeg", byte_size: 18, media_kind: "unknown" },
          ],
        },
      }),
    });
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(31, {
        payload: {
          prompt_truncated: false,
          response_truncated: false,
          multimodal: [{ basename: "media-ccc333.dat" }],
        },
      }),
    });

    const report = await runTelemetryMultimodalRepairMetadata({
      cwd,
      scope: "local",
      correctionVersion: "media-v2",
      dryRun: true,
      now: new Date("2026-06-10T10:00:00.000Z"),
    });
    const text = formatTelemetryMultimodalRepairMetadataText(report);
    const serialized = `${JSON.stringify(report)}\n${text}`;

    assert.equal(report.dry_run, true);
    assert.equal(report.scanned_events, 2);
    assert.equal(report.repairable_events, 1);
    assert.equal(report.repairable_media_items, 2);
    assert.equal(report.preview.top_inferred_media_mime[0].mime_type, "image/jpeg");
    assert.equal(report.preview.top_inferred_media_mime[0].item_count, 1);
    assert.equal(report.preview.top_inferred_media_mime.some((item) => item.mime_type === "image/png"), true);
    assert.equal(report.preview.missing_byte_size_items, 1);
    assert.match(text, /Telemetry Multimodal Metadata Repair/);
    assert.doesNotMatch(serialized, /private repair prompt/);
    assert.doesNotMatch(serialized, /private repair response/);
    assert.doesNotMatch(serialized, /evt_repair_/);
    assert.doesNotMatch(serialized, /media-aaa111|media-bbb222|media-ccc333/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runTelemetryMultimodalRepairMetadata writes idempotent metadata correction events", async () => {
  const cwd = await temporaryWorkspace();
  try {
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(40, {
        payload: {
          prompt_truncated: false,
          response_truncated: false,
          multimodal: [{ basename: "media-ddd444.png" }],
        },
      }),
    });

    const first = await runTelemetryMultimodalRepairMetadata({
      cwd,
      scope: "local",
      correctionVersion: "media-v2",
      dryRun: false,
      now: new Date("2026-06-10T10:00:00.000Z"),
    });
    const second = await runTelemetryMultimodalRepairMetadata({
      cwd,
      scope: "local",
      correctionVersion: "media-v2",
      dryRun: false,
      now: new Date("2026-06-10T10:01:00.000Z"),
    });

    assert.equal(first.queued_count, 1);
    assert.equal(first.skipped_existing_count, 0);
    assert.equal(second.queued_count, 0);
    assert.equal(second.skipped_existing_count, 1);
    assert.equal(second.repairable_events, 0);

    const files = await readdir(telemetryQueueDirs(cwd).pending);
    const events = await Promise.all(files.sort().map(async (file) => (
      JSON.parse(await readFile(join(telemetryQueueDirs(cwd).pending, file), "utf8"))
    )));
    const correction = events.find((event) => event.command === "artifact-review-backfill-correction");
    assert.equal(correction.metadata.correction_reason, "media_metadata_inference");
    assert.equal(correction.prompt, "Multimodal media metadata correction.");
    assert.deepEqual(correction.payload.multimodal, [
      { mime_type: "image/png", basename: "media-ddd444.png", media_kind: "image" },
    ]);
    assert.equal(Object.hasOwn(correction.payload.multimodal[0], "byte_size"), false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
