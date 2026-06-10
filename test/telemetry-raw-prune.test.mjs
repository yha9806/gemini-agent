import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
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
  formatTelemetryRawPruneText,
  runTelemetryRawPrune,
} from "../src/telemetry-raw-prune.mjs";

const LARGE_QUEUE_LIMIT = 10 * 1024 * 1024;

async function temporaryWorkspace() {
  return mkdtemp(join(tmpdir(), "gemini-agent-raw-prune-"));
}

function telemetryEvent(index, overrides = {}) {
  const suffix = `${index}`.padStart(6, "0");
  return {
    schema_version: 1,
    event_id: `evt_raw_prune_${suffix}`,
    trace_id: `trace_raw_prune_${suffix}`,
    deployment_id: "dep_raw_prune",
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
      prompt: `secret raw prompt ${index}`,
      response: `secret raw response ${index}`,
    }),
    maxQueueBytes: LARGE_QUEUE_LIMIT,
  });
  const batch = await claimTelemetryBatch({ cwd, batchSize: 1, now });
  await completeTelemetryBatch({ cwd, batchId: batch.batchId, now });
}

async function sentFileCount(cwd, day) {
  try {
    return (await readdir(join(telemetryQueueDirs(cwd).sent, day))).length;
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
}

test("runTelemetryRawPrune dry-run previews old sent raw data without deleting or exposing content", async () => {
  const cwd = await temporaryWorkspace();
  await completeSentEvent(cwd, 1, new Date("2026-05-20T12:00:00.000Z"));
  await completeSentEvent(cwd, 2, new Date("2026-06-09T12:00:00.000Z"));
  const dirs = telemetryQueueDirs(cwd);
  await mkdir(join(dirs.sent, "2026-05-19"), { recursive: true });
  await writeFile(join(dirs.sent, "2026-05-19", "PRIVATE_API_KEY=secret.json"), "{}\n");

  const report = await runTelemetryRawPrune({
    cwd,
    scope: "local",
    state: "sent",
    keepDays: 7,
    dryRun: true,
    now: new Date("2026-06-10T12:00:00.000Z"),
  });
  const output = `${JSON.stringify(report)}\n${formatTelemetryRawPruneText(report)}`;

  assert.equal(report.ok, true);
  assert.equal(report.dry_run, true);
  assert.equal(report.state, "sent");
  assert.equal(report.would_delete_count, 2);
  assert.equal(report.deleted_count, 0);
  assert.equal(report.remaining_sent_count, 3);
  assert.equal(await sentFileCount(cwd, "2026-05-20"), 1);
  assert.equal(await sentFileCount(cwd, "2026-05-19"), 1);
  assert.doesNotMatch(output, /secret raw prompt/);
  assert.doesNotMatch(output, /secret raw response/);
  assert.doesNotMatch(output, /evt_raw_prune/);
  assert.doesNotMatch(output, /PRIVATE_API_KEY/);
  assert.doesNotMatch(output, /queue\/sent/);
});

test("runTelemetryRawPrune write deletes old sent raw data and leaves retained UTC days", async () => {
  const cwd = await temporaryWorkspace();
  await completeSentEvent(cwd, 1, new Date("2026-06-02T23:59:59.000Z"));
  await completeSentEvent(cwd, 2, new Date("2026-06-03T00:00:00.000Z"));
  await completeSentEvent(cwd, 3, new Date("2026-06-09T12:00:00.000Z"));

  const report = await runTelemetryRawPrune({
    cwd,
    scope: "local",
    state: "sent",
    keepDays: 7,
    dryRun: false,
    now: new Date("2026-06-10T12:00:00.000Z"),
  });

  assert.equal(report.dry_run, false);
  assert.equal(report.would_delete_count, 1);
  assert.equal(report.deleted_count, 1);
  assert.equal(await sentFileCount(cwd, "2026-06-02"), 0);
  assert.equal(await sentFileCount(cwd, "2026-06-03"), 1);
  assert.equal(await sentFileCount(cwd, "2026-06-09"), 1);
});

test("runTelemetryRawPrune applies keep-days before max-sent-bytes", async () => {
  const cwd = await temporaryWorkspace();
  await completeSentEvent(cwd, 1, new Date("2026-06-01T12:00:00.000Z"));
  await completeSentEvent(cwd, 2, new Date("2026-06-08T12:00:00.000Z"));
  await completeSentEvent(cwd, 3, new Date("2026-06-09T12:00:00.000Z"));

  const report = await runTelemetryRawPrune({
    cwd,
    scope: "local",
    state: "sent",
    keepDays: 7,
    maxSentBytes: 1,
    dryRun: true,
    now: new Date("2026-06-10T12:00:00.000Z"),
  });

  assert.equal(report.would_delete_count, 3);
  assert.equal(report.expired_delete_count, 1);
  assert.equal(report.bytes_limit_delete_count, 2);
  assert.equal(report.remaining_sent_count_after_prune, 0);
});

test("runTelemetryRawPrune rejects unsafe options", async () => {
  const cwd = await temporaryWorkspace();
  await assert.rejects(
    () => runTelemetryRawPrune({ cwd, scope: "local", state: "pending", keepDays: 7 }),
    /only supports --state sent/,
  );
  await assert.rejects(
    () => runTelemetryRawPrune({ cwd, scope: "local", state: "sent", keepDays: -1 }),
    /keepDays must be a nonnegative integer/,
  );
  await assert.rejects(
    () => runTelemetryRawPrune({ cwd, scope: "local", state: "sent", keepDays: 7, maxSentBytes: -1 }),
    /maxSentBytes must be a nonnegative integer/,
  );
});
