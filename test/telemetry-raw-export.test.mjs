import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  appendTelemetryEvent,
  claimTelemetryBatch,
  completeTelemetryBatch,
  telemetryQueueDirs,
} from "../src/telemetry-queue.mjs";
import {
  formatTelemetryRawExportText,
  runTelemetryRawExport,
} from "../src/telemetry-raw-export.mjs";

const LARGE_QUEUE_LIMIT = 10 * 1024 * 1024;

async function temporaryWorkspace() {
  return mkdtemp(join(tmpdir(), "gemini-agent-raw-export-"));
}

function telemetryEvent(index, overrides = {}) {
  const suffix = `${index}`.padStart(6, "0");
  return {
    schema_version: 1,
    event_id: `evt_raw_export_${suffix}`,
    trace_id: `trace_raw_export_${suffix}`,
    deployment_id: "dep_raw_export",
    project_id: "gemini-agent",
    source: "cli",
    command: "ask",
    model: "gemini-3.5-flash",
    prompt: `prompt ${suffix}`,
    response: `response ${suffix}`,
    status: "success",
    error_type: null,
    latency_ms: 1,
    created_at: "2026-06-10T09:00:00.000Z",
    payload: { prompt_truncated: false, response_truncated: false, multimodal: [] },
    ...overrides,
  };
}

async function completeSentEvent(cwd, index, now) {
  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(index, {
      prompt: `sent raw prompt ${index}`,
      response: `sent raw response ${index}`,
    }),
    maxQueueBytes: LARGE_QUEUE_LIMIT,
  });
  const batch = await claimTelemetryBatch({ cwd, batchSize: 1, now });
  await completeTelemetryBatch({ cwd, batchId: batch.batchId, now });
}

test("runTelemetryRawExport writes confirmed pending raw events to JSONL without leaking stdout summary", async () => {
  const cwd = await temporaryWorkspace();
  const output = join(cwd, "exports", "pending.jsonl");
  await mkdir(join(cwd, "exports"), { recursive: true });
  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(1, {
      prompt: "export Authorization: Bearer secret-token",
      response: "export raw response should only be in file",
      payload: {
        prompt_truncated: false,
        response_truncated: false,
        multimodal: [{ basename: "private-export-screen.png", mime_type: "image/png", byte_size: 12 }],
      },
    }),
  });
  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(2, {
      prompt: "second raw prompt should remain out of summary",
      response: "second raw response should remain out of summary",
    }),
  });

  const report = await runTelemetryRawExport({
    cwd,
    scope: "local",
    state: "pending",
    output,
    limit: 1,
    confirmRawContent: true,
  });
  const summary = `${JSON.stringify(report)}\n${formatTelemetryRawExportText(report)}`;
  const lines = (await readFile(output, "utf8")).trim().split("\n");
  const exported = JSON.parse(lines[0]);

  assert.equal(report.ok, true);
  assert.equal(report.exported_count, 1);
  assert.equal(report.matched_count, 2);
  assert.equal(report.excluded_by_limit_count, 1);
  assert.equal(report.credential_like_prompt_events, 1);
  assert.equal(lines.length, 1);
  assert.match(exported.prompt, /Authorization: \[MASKED\]/);
  assert.match(exported.response, /export raw response should only be in file/);
  assert.equal((await readdir(telemetryQueueDirs(cwd).pending)).length, 2);
  assert.doesNotMatch(summary, /Authorization: \[MASKED\]|secret-token/);
  assert.doesNotMatch(summary, /export raw response should only be in file/);
  assert.doesNotMatch(summary, /evt_raw_export/);
  assert.doesNotMatch(summary, /private-export-screen/);
  assert.doesNotMatch(summary, /pending\.jsonl|queue\/pending/);
});

test("runTelemetryRawExport exports sent raw events deterministically", async () => {
  const cwd = await temporaryWorkspace();
  const output = join(cwd, "sent-export.jsonl");
  await completeSentEvent(cwd, 1, new Date("2026-06-09T12:00:00.000Z"));
  await completeSentEvent(cwd, 2, new Date("2026-06-08T12:00:00.000Z"));

  const report = await runTelemetryRawExport({
    cwd,
    scope: "local",
    state: "sent",
    output,
    limit: 2,
    confirmRawContent: true,
  });
  const events = (await readFile(output, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  assert.equal(report.exported_count, 2);
  assert.deepEqual(events.map((event) => event.event_id), [
    "evt_raw_export_000002",
    "evt_raw_export_000001",
  ]);
  assert.match(events[0].prompt, /sent raw prompt 2/);
});

test("runTelemetryRawExport counts invalid files without exposing filenames", async () => {
  const cwd = await temporaryWorkspace();
  const output = join(cwd, "invalid-export.jsonl");
  const dirs = telemetryQueueDirs(cwd);
  await mkdir(dirs.pending, { recursive: true });
  await writeFile(join(dirs.pending, "PRIVATE_API_KEY=secret.json"), "{bad json");

  const report = await runTelemetryRawExport({
    cwd,
    scope: "local",
    state: "pending",
    output,
    limit: 5,
    confirmRawContent: true,
  });
  const summary = JSON.stringify(report);

  assert.equal(report.exported_count, 0);
  assert.equal(report.invalid_file_count, 1);
  assert.equal(await readFile(output, "utf8"), "");
  assert.doesNotMatch(summary, /PRIVATE_API_KEY=secret|bad json|queue\/pending/);
});

test("runTelemetryRawExport rejects unconfirmed or unsafe output", async () => {
  const cwd = await temporaryWorkspace();
  const output = join(cwd, "export.jsonl");
  await appendTelemetryEvent({ cwd, event: telemetryEvent(1) });
  await writeFile(output, "existing\n");
  const dirs = telemetryQueueDirs(cwd);
  await mkdir(dirs.pending, { recursive: true });
  const queueOutput = join(dirs.pending, "export.jsonl");
  const linkDir = join(cwd, "queue-link");
  await symlink(dirs.pending, linkDir);

  await assert.rejects(
    () => runTelemetryRawExport({ cwd, scope: "local", state: "pending", output, limit: 1 }),
    /--confirm-raw-content is required/,
  );
  await assert.rejects(
    () => runTelemetryRawExport({ cwd, scope: "local", state: "pending", output, limit: 1, confirmRawContent: true }),
    /output file already exists/,
  );
  await assert.rejects(
    () => runTelemetryRawExport({ cwd, scope: "local", state: "pending", output: queueOutput, limit: 1, confirmRawContent: true }),
    /output path must not be inside telemetry queue storage/,
  );
  await assert.rejects(
    () => runTelemetryRawExport({ cwd, scope: "local", state: "pending", output: join(linkDir, "export.jsonl"), limit: 1, confirmRawContent: true }),
    /output path must not be inside telemetry queue storage/,
  );
  await assert.rejects(
    () => runTelemetryRawExport({ cwd, scope: "local", state: "failed", output: join(cwd, "failed.jsonl"), limit: 1, confirmRawContent: true }),
    /only supports pending or sent/,
  );
  await assert.rejects(
    () => runTelemetryRawExport({ cwd, scope: "local", state: "pending", output: join(cwd, "next.jsonl"), limit: 0, confirmRawContent: true }),
    /limit must be a positive integer/,
  );
});
