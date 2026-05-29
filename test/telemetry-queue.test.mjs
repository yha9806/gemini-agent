import assert from "node:assert/strict";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  appendTelemetryEvent,
  claimTelemetryBatch,
  completeTelemetryBatch,
  failTelemetryBatch,
  loadTelemetryState,
  pruneSentTelemetry,
  telemetryQueueDirs,
  withTelemetryQueueLock,
} from "../src/telemetry-queue.mjs";

const TELEMETRY_ROOT = ".gemini-agent/telemetry";
const LARGE_QUEUE_LIMIT = 10 * 1024 * 1024;

async function temporaryWorkspace() {
  return mkdtemp(join(tmpdir(), "gemini-agent-telemetry-queue-"));
}

function modeBits(stats) {
  return stats.mode & 0o777;
}

function telemetryEvent(index, overrides = {}) {
  const suffix = `${index}`.padStart(6, "0");
  return {
    schema_version: 1,
    event_id: `evt_${suffix}`,
    trace_id: `trace_${suffix}`,
    deployment_id: "dep_test",
    project_id: "gemini-agent",
    source: "cli",
    command: "ask",
    model: "gemini-3.5-flash",
    prompt: `prompt ${suffix}`,
    response: `response ${suffix}`,
    status: "success",
    error_type: null,
    latency_ms: index,
    created_at: "2026-05-29T09:00:00.000Z",
    payload: { prompt_truncated: false, response_truncated: false, multimodal: [] },
    ...overrides,
  };
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function regularFileNames(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function regularFilePaths(dir) {
  return (await regularFileNames(dir)).map((name) => join(dir, name));
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readPendingEvents(cwd) {
  const { pending } = telemetryQueueDirs(cwd);
  const paths = await regularFilePaths(pending);
  return Promise.all(paths.map((path) => readJson(path)));
}

async function sumFileBytes(paths) {
  const stats = await Promise.all(paths.map((path) => stat(path)));
  return stats.reduce((sum, item) => sum + item.size, 0);
}

async function waitUntil(predicate) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("timed out waiting for condition");
}

test("loadTelemetryState returns defaults and append writes one secure pending event", async () => {
  const cwd = await temporaryWorkspace();
  const dirs = telemetryQueueDirs(cwd);

  assert.equal(dirs.root, join(cwd, TELEMETRY_ROOT));
  assert.equal(dirs.queue, join(cwd, TELEMETRY_ROOT, "queue"));
  assert.equal(dirs.pending, join(dirs.queue, "pending"));
  assert.equal(dirs.inflight, join(dirs.queue, "inflight"));
  assert.equal(dirs.sent, join(dirs.queue, "sent"));
  assert.equal(dirs.tmp, join(dirs.queue, "tmp"));
  assert.equal(dirs.lock, join(dirs.queue, "lock"));
  assert.equal(dirs.state, join(dirs.queue, "state.json"));

  const defaultState = await loadTelemetryState({ cwd });
  assert.equal(defaultState.queue_bytes, 0);
  assert.equal(defaultState.dropped_old_count, 0);

  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(1, {
      prompt: "Authorization: Bearer abc.def.ghi",
      response: "GEMINI_API_KEY=AIzaSyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    }),
    maxQueueBytes: LARGE_QUEUE_LIMIT,
  });

  for (const dir of [dirs.root, dirs.queue, dirs.pending, dirs.inflight, dirs.sent, dirs.tmp]) {
    assert.equal(modeBits(await stat(dir)), 0o700, dir);
  }

  const pendingFiles = await regularFilePaths(dirs.pending);
  assert.equal(pendingFiles.length, 1);
  assert.equal(modeBits(await stat(pendingFiles[0])), 0o600);

  const savedEvent = await readJson(pendingFiles[0]);
  assert.equal(savedEvent.event_id, "evt_000001");
  assert.equal(savedEvent.prompt, "Authorization: [MASKED]");
  assert.equal(savedEvent.response, "GEMINI_API_KEY=[MASKED]");

  const state = await loadTelemetryState({ cwd });
  assert.equal(state.queue_bytes, (await stat(pendingFiles[0])).size);
  assert.equal(state.dropped_old_count, 0);
  assert.equal(modeBits(await stat(dirs.state)), 0o600);
});

test("claim, complete, and fail move queue files safely", async () => {
  const cwd = await temporaryWorkspace();
  const dirs = telemetryQueueDirs(cwd);
  const completedAt = new Date("2026-05-29T12:00:00.000Z");

  for (const index of [0, 1, 2]) {
    await appendTelemetryEvent({ cwd, event: telemetryEvent(index), maxQueueBytes: LARGE_QUEUE_LIMIT });
  }

  const queuedBeforeClaimBytes = await sumFileBytes(await regularFilePaths(dirs.pending));
  assert.equal((await loadTelemetryState({ cwd })).queue_bytes, queuedBeforeClaimBytes);

  const batch = await claimTelemetryBatch({ cwd, batchSize: 2, now: completedAt });
  assert.match(batch.batchId, /^batch_/);
  assert.equal(batch.batchDir, join(dirs.inflight, batch.batchId));
  assert.deepEqual(batch.events.map((event) => event.event_id), ["evt_000000", "evt_000001"]);
  assert.equal((await regularFileNames(batch.batchDir)).length, 2);
  assert.deepEqual((await readPendingEvents(cwd)).map((event) => event.event_id), ["evt_000002"]);

  const pendingBytes = await sumFileBytes(await regularFilePaths(dirs.pending));
  assert.equal((await loadTelemetryState({ cwd })).queue_bytes, pendingBytes);

  await completeTelemetryBatch({ cwd, batchId: batch.batchId, now: completedAt });
  assert.equal(await pathExists(batch.batchDir), false);
  const sentDir = join(dirs.sent, "2026-05-29");
  assert.equal(modeBits(await stat(sentDir)), 0o700);
  const sentFiles = await regularFilePaths(sentDir);
  assert.equal(sentFiles.length, 2);
  assert.equal(modeBits(await stat(sentFiles[0])), 0o600);

  const failedBatch = await claimTelemetryBatch({ cwd, batchSize: 1, now: completedAt });
  assert.deepEqual(failedBatch.events.map((event) => event.event_id), ["evt_000002"]);
  assert.equal((await regularFileNames(failedBatch.batchDir)).length, 1);

  await failTelemetryBatch({ cwd, batchId: failedBatch.batchId });
  assert.equal(await pathExists(failedBatch.batchDir), false);
  assert.deepEqual((await readPendingEvents(cwd)).map((event) => event.event_id), ["evt_000002"]);
});

test("lock prevents concurrent flush claims", async () => {
  const cwd = await temporaryWorkspace();
  const dirs = telemetryQueueDirs(cwd);
  await appendTelemetryEvent({ cwd, event: telemetryEvent(1), maxQueueBytes: LARGE_QUEUE_LIMIT });

  let releaseLock;
  let enteredLock = false;
  const holder = withTelemetryQueueLock({ cwd, staleMs: 10_000, retries: 0 }, async () => {
    enteredLock = true;
    await new Promise((resolve) => {
      releaseLock = resolve;
    });
  });

  await waitUntil(async () => enteredLock && await pathExists(dirs.lock));

  await assert.rejects(
    () => claimTelemetryBatch({ cwd, batchSize: 1, now: new Date("2026-05-29T12:00:00.000Z") }),
    /lock/i,
  );
  assert.equal((await regularFileNames(dirs.pending)).length, 1);

  releaseLock();
  await holder;
  assert.equal(await pathExists(dirs.lock), false);
});

test("stale lock can be reclaimed", async () => {
  const cwd = await temporaryWorkspace();
  const dirs = telemetryQueueDirs(cwd);
  await mkdir(dirs.queue, { recursive: true, mode: 0o700 });
  await chmod(dirs.queue, 0o700);
  await writeFile(dirs.lock, `${JSON.stringify({ token: "stale-token" })}\n`, { mode: 0o600 });
  await chmod(dirs.lock, 0o600);
  const old = new Date(Date.now() - 60_000);
  await utimes(dirs.lock, old, old);

  const result = await withTelemetryQueueLock({ cwd, staleMs: 1, retries: 0 }, async () => {
    assert.equal(modeBits(await stat(dirs.lock)), 0o600);
    return "reclaimed";
  });

  assert.equal(result, "reclaimed");
  assert.equal(await pathExists(dirs.lock), false);
});

test("append drops oldest pending files above max queue bytes and tracks drop counters", async () => {
  const cwd = await temporaryWorkspace();
  const dirs = telemetryQueueDirs(cwd);

  await appendTelemetryEvent({ cwd, event: telemetryEvent(0), maxQueueBytes: LARGE_QUEUE_LIMIT });
  await appendTelemetryEvent({ cwd, event: telemetryEvent(1), maxQueueBytes: LARGE_QUEUE_LIMIT });

  const firstTwoFiles = await regularFilePaths(dirs.pending);
  const firstTwoBytes = await sumFileBytes(firstTwoFiles);
  await utimes(firstTwoFiles[0], new Date("2020-01-01T00:00:00.000Z"), new Date("2020-01-01T00:00:00.000Z"));
  await utimes(firstTwoFiles[1], new Date("2020-01-01T00:01:00.000Z"), new Date("2020-01-01T00:01:00.000Z"));

  await appendTelemetryEvent({ cwd, event: telemetryEvent(2), maxQueueBytes: firstTwoBytes });

  const remainingEvents = await readPendingEvents(cwd);
  assert.deepEqual(remainingEvents.map((event) => event.event_id), ["evt_000001", "evt_000002"]);

  const remainingFiles = await regularFilePaths(dirs.pending);
  const state = await loadTelemetryState({ cwd });
  assert.equal(state.queue_bytes, await sumFileBytes(remainingFiles));
  assert.equal(state.dropped_old_count, 1);
});

test("pruneSentTelemetry removes old sent files", async () => {
  const cwd = await temporaryWorkspace();
  const dirs = telemetryQueueDirs(cwd);
  const oldDay = new Date("2026-05-20T12:00:00.000Z");
  const recentDay = new Date("2026-05-28T12:00:00.000Z");
  const pruneNow = new Date("2026-05-29T12:00:00.000Z");

  await appendTelemetryEvent({ cwd, event: telemetryEvent(0), maxQueueBytes: LARGE_QUEUE_LIMIT });
  const oldBatch = await claimTelemetryBatch({ cwd, batchSize: 1, now: oldDay });
  await completeTelemetryBatch({ cwd, batchId: oldBatch.batchId, now: oldDay });

  await appendTelemetryEvent({ cwd, event: telemetryEvent(1), maxQueueBytes: LARGE_QUEUE_LIMIT });
  const recentBatch = await claimTelemetryBatch({ cwd, batchSize: 1, now: recentDay });
  await completeTelemetryBatch({ cwd, batchId: recentBatch.batchId, now: recentDay });

  const removed = await pruneSentTelemetry({
    cwd,
    now: pruneNow,
    keepDays: 7,
    maxSentBytes: LARGE_QUEUE_LIMIT,
  });

  assert.equal(removed, 1);
  assert.equal(await pathExists(join(dirs.sent, "2026-05-20")), false);
  assert.equal((await regularFileNames(join(dirs.sent, "2026-05-28"))).length, 1);
});
