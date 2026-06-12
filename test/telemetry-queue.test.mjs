import assert from "node:assert/strict";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import {
  appendTelemetryEvent,
  appendTelemetryEventsIfNew,
  appendTelemetryEventIfNew,
  archiveFailedTelemetryEvents,
  archiveQuarantinedTelemetryEvents,
  claimTelemetryBatch,
  completeTelemetryBatch,
  failTelemetryBatch,
  inspectFailedTelemetryEvents,
  inspectQuarantinedTelemetryEvents,
  loadTelemetryQueueSnapshot,
  loadTelemetryState,
  peekTelemetryEvents,
  pruneSentTelemetry,
  quarantineTelemetryEvent,
  retryFailedTelemetryEvents,
  retryQuarantinedTelemetryEvents,
  telemetryQueueDirs,
  withTelemetryQueueLock,
} from "../src/telemetry-queue.mjs";

const TELEMETRY_ROOT = ".gemini-agent/telemetry";
const LARGE_QUEUE_LIMIT = 10 * 1024 * 1024;
const DEFAULT_STATE = {
  dropped_old_count: 0,
  dropped_memory_count: 0,
  queue_bytes: 0,
  sent_success_count: 0,
  sent_failure_count: 0,
  non_retryable_failure_count: 0,
  last_failure_reason: null,
  last_sent_at: null,
};

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

async function createFailedBatch(cwd, {
  count = 1,
  reason = "http_403",
  diagnostics,
  malformedReason = false,
  missingReason = false,
} = {}) {
  const batch = await claimTelemetryBatch({
    cwd,
    batchSize: count,
    now: new Date("2026-06-10T09:00:00.000Z"),
  });
  assert.ok(batch.batchId);
  await failTelemetryBatch({
    cwd,
    batchId: batch.batchId,
    retryable: false,
    reason,
    diagnostics,
  });
  const failedDir = join(telemetryQueueDirs(cwd).failed, batch.batchId);
  if (malformedReason) {
    await writeFile(join(failedDir, "reason.json"), "{not-json\n");
  }
  if (missingReason) {
    await rm(join(failedDir, "reason.json"), { force: true });
  }
  return { batchId: batch.batchId, failedDir, events: batch.events };
}

async function appendEvents(cwd, start, count) {
  for (let offset = 0; offset < count; offset += 1) {
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(start + offset, {
        prompt: `raw prompt ${start + offset}`,
        response: `raw response ${start + offset}`,
        payload: {
          prompt_truncated: false,
          response_truncated: false,
          multimodal: [{ mime_type: "image/png", basename: `secret-${start + offset}.png` }],
        },
      }),
      maxQueueBytes: LARGE_QUEUE_LIMIT,
    });
  }
}

function assertQuarantinedEventPath(dirs, eventPath) {
  const relativePath = relative(dirs.quarantine, eventPath);
  assert.match(relativePath, /^event_[a-f0-9]{16}(?:_[a-f0-9-]+)?\/event\.json$/);
}

async function sumFileBytes(paths) {
  const stats = await Promise.all(paths.map((path) => stat(path)));
  return stats.reduce((sum, item) => sum + item.size, 0);
}

async function waitUntil(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(5);
  }
  assert.fail("timed out waiting for condition");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 10_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
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

  assert.deepEqual(await loadTelemetryState({ cwd }), DEFAULT_STATE);

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
  assert.equal(state.dropped_memory_count, 0);
  assert.equal(state.sent_success_count, 0);
  assert.equal(state.sent_failure_count, 0);
  assert.equal(state.non_retryable_failure_count, 0);
  assert.equal(state.last_failure_reason, null);
  assert.equal(state.last_sent_at, null);
  assert.equal(modeBits(await stat(dirs.state)), 0o600);
});

test("append preserves existing non-queue state counters", async () => {
  const cwd = await temporaryWorkspace();
  const dirs = telemetryQueueDirs(cwd);
  await appendTelemetryEvent({ cwd, event: telemetryEvent(0), maxQueueBytes: LARGE_QUEUE_LIMIT });
  await writeFile(dirs.state, `${JSON.stringify({
    dropped_old_count: 1,
    dropped_memory_count: 2,
    queue_bytes: 0,
    sent_success_count: 3,
    sent_failure_count: 4,
    non_retryable_failure_count: 5,
    last_failure_reason: "unauthorized",
    last_sent_at: "2026-05-29T11:00:00.000Z",
  })}\n`);

  await appendTelemetryEvent({ cwd, event: telemetryEvent(1), maxQueueBytes: LARGE_QUEUE_LIMIT });

  const state = await loadTelemetryState({ cwd });
  assert.equal(state.dropped_old_count, 1);
  assert.equal(state.dropped_memory_count, 2);
  assert.equal(state.sent_success_count, 3);
  assert.equal(state.sent_failure_count, 4);
  assert.equal(state.non_retryable_failure_count, 5);
  assert.equal(state.last_failure_reason, "unauthorized");
  assert.equal(state.last_sent_at, "2026-05-29T11:00:00.000Z");
  assert.equal(state.queue_bytes, await sumFileBytes(await regularFilePaths(dirs.pending)));
});

test("appendTelemetryEventIfNew skips duplicate event ids already in the queue history", async () => {
  const cwd = await temporaryWorkspace();
  const event = telemetryEvent(7);

  const first = await appendTelemetryEventIfNew({
    cwd,
    event,
    maxQueueBytes: LARGE_QUEUE_LIMIT,
  });
  const pendingDuplicate = await appendTelemetryEventIfNew({
    cwd,
    event,
    maxQueueBytes: LARGE_QUEUE_LIMIT,
  });

  assert.equal(first.queued, true);
  assert.equal(first.event.event_id, "evt_000007");
  assert.equal(pendingDuplicate.queued, false);
  assert.equal(pendingDuplicate.event.event_id, event.event_id);
  assert.equal(pendingDuplicate.reason, "duplicate_event_id");
  assert.deepEqual((await readPendingEvents(cwd)).map((item) => item.event_id), ["evt_000007"]);

  const batch = await claimTelemetryBatch({
    cwd,
    batchSize: 1,
    now: new Date("2026-05-29T12:00:00.000Z"),
  });
  await completeTelemetryBatch({
    cwd,
    batchId: batch.batchId,
    now: new Date("2026-05-29T12:01:00.000Z"),
  });
  const sentDuplicate = await appendTelemetryEventIfNew({
    cwd,
    event,
    maxQueueBytes: LARGE_QUEUE_LIMIT,
  });

  assert.equal(sentDuplicate.queued, false);
  assert.equal(sentDuplicate.reason, "duplicate_event_id");
  assert.deepEqual(await readPendingEvents(cwd), []);
});

test("appendTelemetryEventsIfNew deduplicates a batch against history and itself", async () => {
  const cwd = await temporaryWorkspace();
  await appendTelemetryEvent({ cwd, event: telemetryEvent(8), maxQueueBytes: LARGE_QUEUE_LIMIT });

  const result = await appendTelemetryEventsIfNew({
    cwd,
    events: [
      telemetryEvent(8),
      telemetryEvent(9),
      telemetryEvent(9),
      telemetryEvent(10),
    ],
    maxQueueBytes: LARGE_QUEUE_LIMIT,
  });

  assert.deepEqual(result.queued.map((event) => event.event_id), ["evt_000009", "evt_000010"]);
  assert.deepEqual(result.skipped.map((event) => event.event_id), ["evt_000008", "evt_000009"]);
  assert.deepEqual((await readPendingEvents(cwd)).map((event) => event.event_id), [
    "evt_000008",
    "evt_000009",
    "evt_000010",
  ]);
});

test("appendTelemetryEventsIfNew persists event ids after sent files are pruned", async () => {
  const cwd = await temporaryWorkspace();
  const dirs = telemetryQueueDirs(cwd);
  const sentDay = new Date("2026-05-20T12:00:00.000Z");

  const first = await appendTelemetryEventsIfNew({
    cwd,
    events: [telemetryEvent(11), telemetryEvent(12)],
    maxQueueBytes: LARGE_QUEUE_LIMIT,
  });
  assert.deepEqual(first.queued.map((event) => event.event_id), ["evt_000011", "evt_000012"]);

  const indexPath = join(dirs.queue, "event-index.json");
  const index = await readJson(indexPath);
  assert.equal(index.schema_version, 1);
  assert.deepEqual(index.event_ids, ["evt_000011", "evt_000012"]);
  assert.equal(modeBits(await stat(indexPath)), 0o600);

  const batch = await claimTelemetryBatch({ cwd, batchSize: 2, now: sentDay });
  await completeTelemetryBatch({ cwd, batchId: batch.batchId, now: sentDay });
  const removed = await pruneSentTelemetry({
    cwd,
    now: new Date("2026-05-29T12:00:00.000Z"),
    keepDays: 7,
    maxSentBytes: LARGE_QUEUE_LIMIT,
  });
  assert.equal(removed, 2);
  assert.equal(await pathExists(join(dirs.sent, "2026-05-20")), false);

  const duplicate = await appendTelemetryEventsIfNew({
    cwd,
    events: [telemetryEvent(11), telemetryEvent(12)],
    maxQueueBytes: LARGE_QUEUE_LIMIT,
  });

  assert.deepEqual(duplicate.queued, []);
  assert.deepEqual(duplicate.skipped.map((event) => event.event_id), ["evt_000011", "evt_000012"]);
  assert.deepEqual(await readPendingEvents(cwd), []);
});

test("appendTelemetryEventsIfNew rebuilds a corrupted event id index", async () => {
  const cwd = await temporaryWorkspace();
  const dirs = telemetryQueueDirs(cwd);
  await appendTelemetryEvent({ cwd, event: telemetryEvent(13), maxQueueBytes: LARGE_QUEUE_LIMIT });
  await writeFile(join(dirs.queue, "event-index.json"), "{bad json\n", { mode: 0o600 });

  const result = await appendTelemetryEventsIfNew({
    cwd,
    events: [telemetryEvent(13), telemetryEvent(14)],
    maxQueueBytes: LARGE_QUEUE_LIMIT,
  });

  assert.deepEqual(result.queued.map((event) => event.event_id), ["evt_000014"]);
  assert.deepEqual(result.skipped.map((event) => event.event_id), ["evt_000013"]);
  assert.deepEqual((await readPendingEvents(cwd)).map((event) => event.event_id), [
    "evt_000013",
    "evt_000014",
  ]);
  const rebuilt = await readJson(join(dirs.queue, "event-index.json"));
  assert.deepEqual(rebuilt.event_ids, ["evt_000013", "evt_000014"]);
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

test("peekTelemetryEvents reads pending events without moving them", async () => {
  const cwd = await temporaryWorkspace();
  await appendTelemetryEvent({ cwd, event: telemetryEvent(1) });
  await appendTelemetryEvent({ cwd, event: telemetryEvent(2) });

  const peeked = await peekTelemetryEvents({ cwd, batchSize: 1 });

  assert.deepEqual(peeked.events.map((event) => event.event_id), ["evt_000001"]);
  assert.equal(peeked.files.length, 1);
  assert.deepEqual((await readPendingEvents(cwd)).map((event) => event.event_id), [
    "evt_000001",
    "evt_000002",
  ]);
});

test("quarantineTelemetryEvent moves one pending event into quarantine with reason", async () => {
  const cwd = await temporaryWorkspace();
  await appendTelemetryEvent({ cwd, event: telemetryEvent(1) });
  await appendTelemetryEvent({ cwd, event: telemetryEvent(2) });

  const result = await quarantineTelemetryEvent({
    cwd,
    eventId: "evt_000001",
    reason: "bad payload",
    now: new Date("2026-06-03T12:00:00.000Z"),
  });

  assert.equal(result.quarantined, true);
  assert.equal(result.event_id, "evt_000001");
  assert.deepEqual((await readPendingEvents(cwd)).map((event) => event.event_id), ["evt_000002"]);

  const dirs = telemetryQueueDirs(cwd);
  const snapshot = await loadTelemetryQueueSnapshot({ cwd });
  assert.equal(snapshot.pending.count, 1);
  assert.equal(snapshot.quarantine.count, 1);

  const reason = JSON.parse(await readFile(result.reason_path, "utf8"));
  assert.equal(reason.event_id, "evt_000001");
  assert.equal(reason.reason, "bad payload");
  assert.equal(reason.quarantined_at, "2026-06-03T12:00:00.000Z");
  assert.equal(result.event_path.startsWith(dirs.quarantine), true);

  const state = await loadTelemetryState({ cwd });
  assert.equal(state.queue_bytes, await sumFileBytes(await regularFilePaths(dirs.pending)));
  assert.equal(state.last_failure_reason, "quarantined:bad payload");
});

test("quarantineTelemetryEvent returns false when event id is not pending", async () => {
  const cwd = await temporaryWorkspace();
  await appendTelemetryEvent({ cwd, event: telemetryEvent(3) });

  const result = await quarantineTelemetryEvent({
    cwd,
    eventId: "evt_missing",
    reason: "not present",
  });

  assert.deepEqual(result, { quarantined: false, event_id: "evt_missing" });
  assert.deepEqual((await readPendingEvents(cwd)).map((event) => event.event_id), ["evt_000003"]);
});

test("quarantineTelemetryEvent stores dot-segment event ids in safe hashed directories", async () => {
  const cwd = await temporaryWorkspace();
  const dirs = telemetryQueueDirs(cwd);
  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(1, { event_id: ".", trace_id: "trace_dot" }),
  });
  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(2, { event_id: "..", trace_id: "trace_dotdot" }),
  });

  const dot = await quarantineTelemetryEvent({ cwd, eventId: ".", reason: "dot" });
  const dotdot = await quarantineTelemetryEvent({ cwd, eventId: "..", reason: "dotdot" });

  assertQuarantinedEventPath(dirs, dot.event_path);
  assertQuarantinedEventPath(dirs, dotdot.event_path);
  assert.notEqual(dot.event_path, dotdot.event_path);
  assert.equal((await readJson(dot.event_path)).event_id, ".");
  assert.equal((await readJson(dotdot.event_path)).event_id, "..");

  const snapshot = await loadTelemetryQueueSnapshot({ cwd });
  assert.equal(snapshot.pending.count, 0);
  assert.equal(snapshot.quarantine.count, 2);
});

test("quarantineTelemetryEvent does not overwrite safe-name collisions", async () => {
  const cwd = await temporaryWorkspace();
  const dirs = telemetryQueueDirs(cwd);
  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(1, { event_id: "a:b", trace_id: "trace_colon" }),
  });
  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(2, { event_id: "a_b", trace_id: "trace_underscore" }),
  });
  await appendTelemetryEvent({ cwd, event: telemetryEvent(3) });

  const colon = await quarantineTelemetryEvent({ cwd, eventId: "a:b", reason: "colon" });
  const underscore = await quarantineTelemetryEvent({
    cwd,
    eventId: "a_b",
    reason: "underscore",
  });

  assert.notEqual(colon.event_path, underscore.event_path);
  assertQuarantinedEventPath(dirs, colon.event_path);
  assertQuarantinedEventPath(dirs, underscore.event_path);
  assert.equal((await readJson(colon.event_path)).event_id, "a:b");
  assert.equal((await readJson(underscore.event_path)).event_id, "a_b");
  assert.deepEqual((await readPendingEvents(cwd)).map((event) => event.event_id), ["evt_000003"]);

  const snapshot = await loadTelemetryQueueSnapshot({ cwd });
  assert.equal(snapshot.pending.count, 1);
  assert.equal(snapshot.quarantine.count, 2);

  const state = await loadTelemetryState({ cwd });
  assert.equal(state.queue_bytes, await sumFileBytes(await regularFilePaths(dirs.pending)));
  assert.equal(state.last_failure_reason, "quarantined:underscore");
});

test("inspectQuarantinedTelemetryEvents returns safe aggregate descriptors", async () => {
  const cwd = await temporaryWorkspace();
  const event = await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(580, {
      event_id: "evt_private_quarantine_580",
      project_id: "vision\nAuthorization: Bearer secret-token",
      prompt: "raw prompt with cli-secret",
      response: "raw response with cli-secret",
      payload: {
        prompt_truncated: false,
        response_truncated: false,
        multimodal: [{ basename: "secret-580.png", byte_size: 123 }],
      },
      metadata: {
        attribution: { project_source: "workspace" },
      },
    }),
  });
  await quarantineTelemetryEvent({
    cwd,
    eventId: event.event_id,
    reason: "repeated_http_403\nAuthorization: Bearer secret-token",
    now: new Date("2026-06-11T12:00:00.000Z"),
  });

  const result = await inspectQuarantinedTelemetryEvents({ cwd, limit: 5 });
  const serialized = JSON.stringify(result);

  assert.equal(result.ok, true);
  assert.equal(result.quarantine_event_count, 1);
  assert.equal(result.quarantine_directory_count, 1);
  assert.equal(result.reason_counts.length, 1);
  assert.equal(result.reason_counts[0].reason, "repeated_http_403 Authorization: [MASKED]");
  assert.equal(result.reason_counts[0].event_count, 1);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].reason, "repeated_http_403 Authorization: [MASKED]");
  assert.equal(result.events[0].command, "ask");
  assert.equal(result.events[0].model, "gemini-3.5-flash");
  assert.equal(result.events[0].status, "success");
  assert.equal(result.events[0].schema_version, "1");
  assert.equal(result.events[0].created_day, "2026-05-29");
  assert.equal(result.events[0].project_id, "vision Authorization: [MASKED]");
  assert.equal(typeof result.events[0].event_id_hash, "string");
  assert.equal(typeof result.events[0].prompt_bytes, "number");
  assert.equal(typeof result.events[0].response_bytes, "number");
  assert.equal(result.events[0].media_item_count, 1);
  assert.deepEqual(result.events[0].payload_keys, ["prompt_truncated", "response_truncated", "multimodal"]);
  assert.deepEqual(result.events[0].metadata_keys, ["attribution"]);
  assert.equal(result.events[0].retryable_hint, "inspect_receiver_policy_before_retrying");

  assert.doesNotMatch(serialized, /evt_private_quarantine_580/);
  assert.doesNotMatch(serialized, /raw prompt/);
  assert.doesNotMatch(serialized, /raw response/);
  assert.doesNotMatch(serialized, /cli-secret/);
  assert.doesNotMatch(serialized, /secret-token/);
  assert.doesNotMatch(serialized, /secret-580\.png/);
  assert.doesNotMatch(serialized, /\.gemini-agent/);
  assert.doesNotMatch(serialized, /queue\/quarantine/);
});

test("archiveQuarantinedTelemetryEvents dry-run reports matching events without moving files", async () => {
  const cwd = await temporaryWorkspace();
  const first = await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(6411, {
      event_id: "evt_quarantine_archive_private_1",
      prompt: "private quarantined prompt 1",
      response: "private quarantined response 1",
    }),
  });
  const second = await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(6412, {
      event_id: "evt_quarantine_archive_private_2",
      prompt: "private quarantined prompt 2",
      response: "private quarantined response 2",
    }),
  });
  await quarantineTelemetryEvent({ cwd, eventId: first.event_id, reason: "http_403\nAuthorization: Bearer secret-token" });
  await quarantineTelemetryEvent({ cwd, eventId: second.event_id, reason: "different_reason" });

  const before = await loadTelemetryQueueSnapshot({ cwd });
  const result = await archiveQuarantinedTelemetryEvents({
    cwd,
    reason: "http_403 Authorization: Bearer secret-token",
    batchSize: 1,
    dryRun: true,
    note: "../unsafe note with token abc123",
  });
  const after = await loadTelemetryQueueSnapshot({ cwd });
  const serialized = JSON.stringify(result);

  assert.equal(result.ok, true);
  assert.equal(result.dry_run, true);
  assert.equal(result.reason, "http_403 Authorization: [MASKED]");
  assert.equal(result.matched_directory_count, 1);
  assert.equal(result.would_archive_count, 1);
  assert.equal(result.archived_count, 0);
  assert.equal(result.remaining_quarantine_count_for_reason, 1);
  assert.equal(result.resolution_bucket, null);
  assert.deepEqual(after, before);
  assert.doesNotMatch(serialized, /evt_quarantine_archive_private/);
  assert.doesNotMatch(serialized, /private quarantined prompt/);
  assert.doesNotMatch(serialized, /private quarantined response/);
  assert.doesNotMatch(serialized, /secret-token/);
  assert.doesNotMatch(serialized, /queue\/quarantine/);
});

test("archiveQuarantinedTelemetryEvents write mode moves bounded events to resolved quarantine", async () => {
  const cwd = await temporaryWorkspace();
  const first = await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(6891, {
      event_id: "evt_quarantine_archive_write_private_1",
      prompt: "private archive write prompt 1",
    }),
  });
  const second = await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(6892, {
      event_id: "evt_quarantine_archive_write_private_2",
      prompt: "private archive write prompt 2",
    }),
  });
  await quarantineTelemetryEvent({ cwd, eventId: first.event_id, reason: "repeated_http_403_context_pack_payload" });
  await quarantineTelemetryEvent({ cwd, eventId: second.event_id, reason: "repeated_http_403_context_pack_payload" });

  const result = await archiveQuarantinedTelemetryEvents({
    cwd,
    reason: "repeated_http_403_context_pack_payload",
    batchSize: 1,
    dryRun: false,
    note: "../receiver policy confirmed",
  });

  assert.equal(result.ok, true);
  assert.equal(result.dry_run, false);
  assert.equal(result.would_archive_count, 1);
  assert.equal(result.archived_count, 1);
  assert.equal(result.remaining_quarantine_count_for_reason, 1);
  assert.match(result.resolution_bucket, /^resolved_\d{8}_\d+_[a-f0-9-]+$/);

  const dirs = telemetryQueueDirs(cwd);
  const resolvedDir = join(dirs.resolvedQuarantine, result.resolution_bucket);
  const resolvedEntries = await readdir(resolvedDir, { withFileTypes: true });
  const resolvedFiles = resolvedEntries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  const resolvedDirs = resolvedEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  assert.equal(resolvedFiles.includes("resolution.json"), true);
  assert.equal(resolvedDirs.filter((name) => name.startsWith("event_")).length, 1);

  const snapshot = await loadTelemetryQueueSnapshot({ cwd });
  assert.equal(snapshot.quarantine.count, 1);
  assert.equal(snapshot.pending.count, 0);

  const secondResult = await archiveQuarantinedTelemetryEvents({
    cwd,
    reason: "repeated_http_403_context_pack_payload",
    batchSize: 5,
    dryRun: false,
  });
  assert.equal(secondResult.archived_count, 1);
  assert.equal(secondResult.remaining_quarantine_count_for_reason, 0);

  const finalSnapshot = await loadTelemetryQueueSnapshot({ cwd });
  assert.equal(finalSnapshot.quarantine.count, 0);
});

test("retryQuarantinedTelemetryEvents dry-run reports matching events without moving files", async () => {
  const cwd = await temporaryWorkspace();
  const event = await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(7481, {
      event_id: "evt_quarantine_retry_private_1",
      prompt: "private quarantined retry prompt",
      response: "private quarantined retry response",
    }),
  });
  await quarantineTelemetryEvent({
    cwd,
    eventId: event.event_id,
    reason: "repeated_http_403\nAuthorization: Bearer secret-token",
  });

  const before = await loadTelemetryQueueSnapshot({ cwd });
  const result = await retryQuarantinedTelemetryEvents({
    cwd,
    reason: "repeated_http_403 Authorization: Bearer secret-token",
    batchSize: 1,
    dryRun: true,
  });
  const after = await loadTelemetryQueueSnapshot({ cwd });
  const serialized = JSON.stringify(result);

  assert.equal(result.ok, true);
  assert.equal(result.dry_run, true);
  assert.equal(result.reason, "repeated_http_403 Authorization: [MASKED]");
  assert.equal(result.matched_directory_count, 1);
  assert.equal(result.would_move_count, 1);
  assert.equal(result.moved_count, 0);
  assert.equal(result.remaining_quarantine_count_for_reason, 1);
  assert.deepEqual(after, before);
  assert.doesNotMatch(serialized, /evt_quarantine_retry_private/);
  assert.doesNotMatch(serialized, /private quarantined retry/);
  assert.doesNotMatch(serialized, /secret-token/);
  assert.doesNotMatch(serialized, /queue\/quarantine/);
});

test("retryQuarantinedTelemetryEvents write mode moves bounded events to pending", async () => {
  const cwd = await temporaryWorkspace();
  const first = await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(7591, {
      event_id: "evt_quarantine_retry_write_private_1",
      prompt: "private retry write prompt 1",
    }),
  });
  const second = await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(7592, {
      event_id: "evt_quarantine_retry_write_private_2",
      prompt: "private retry write prompt 2",
    }),
  });
  await quarantineTelemetryEvent({ cwd, eventId: first.event_id, reason: "repeated_http_403_context_pack_payload" });
  await quarantineTelemetryEvent({ cwd, eventId: second.event_id, reason: "repeated_http_403_context_pack_payload" });

  const result = await retryQuarantinedTelemetryEvents({
    cwd,
    reason: "repeated_http_403_context_pack_payload",
    batchSize: 1,
    dryRun: false,
  });

  assert.equal(result.ok, true);
  assert.equal(result.dry_run, false);
  assert.equal(result.would_move_count, 1);
  assert.equal(result.moved_count, 1);
  assert.equal(result.remaining_quarantine_count_for_reason, 1);
  assert.equal(result.next_command, "gemini-agent telemetry flush --dry-run --batch-size 1");

  const snapshot = await loadTelemetryQueueSnapshot({ cwd });
  assert.equal(snapshot.pending.count, 1);
  assert.equal(snapshot.quarantine.count, 1);

  const claimed = await claimTelemetryBatch({
    cwd,
    batchSize: 1,
    now: new Date("2026-06-12T00:00:00.000Z"),
  });
  assert.equal(claimed.events.length, 1);
  assert.equal(claimed.events[0].event_id, first.event_id);

  const secondResult = await retryQuarantinedTelemetryEvents({
    cwd,
    reason: "repeated_http_403_context_pack_payload",
    batchSize: 5,
    dryRun: false,
  });
  assert.equal(secondResult.moved_count, 1);
  assert.equal(secondResult.remaining_quarantine_count_for_reason, 0);

  const finalSnapshot = await loadTelemetryQueueSnapshot({ cwd });
  assert.equal(finalSnapshot.pending.count, 1);
  assert.equal(finalSnapshot.quarantine.count, 0);
});

test("peekTelemetryEvents respects the queue lock", async () => {
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
    () => peekTelemetryEvents({ cwd, batchSize: 1 }),
    /lock/i,
  );

  releaseLock();
  await holder;
  const peeked = await peekTelemetryEvents({ cwd, batchSize: 1 });
  assert.deepEqual(peeked.events.map((event) => event.event_id), ["evt_000001"]);
});

test("complete and fail update send state counters", async () => {
  const cwd = await temporaryWorkspace();
  const completedAt = new Date("2026-05-29T12:00:00.000Z");

  for (const index of [0, 1, 2]) {
    await appendTelemetryEvent({ cwd, event: telemetryEvent(index), maxQueueBytes: LARGE_QUEUE_LIMIT });
  }

  const successfulBatch = await claimTelemetryBatch({ cwd, batchSize: 2, now: completedAt });
  await completeTelemetryBatch({ cwd, batchId: successfulBatch.batchId, now: completedAt });

  const afterSuccess = await loadTelemetryState({ cwd });
  assert.equal(afterSuccess.sent_success_count, 2);
  assert.equal(afterSuccess.sent_failure_count, 0);
  assert.equal(afterSuccess.last_sent_at, completedAt.toISOString());

  const failedBatch = await claimTelemetryBatch({ cwd, batchSize: 1, now: completedAt });
  await failTelemetryBatch({ cwd, batchId: failedBatch.batchId });

  const afterFailure = await loadTelemetryState({ cwd });
  assert.equal(afterFailure.sent_success_count, 2);
  assert.equal(afterFailure.sent_failure_count, 1);
  assert.equal(afterFailure.last_sent_at, completedAt.toISOString());
  assert.equal(afterFailure.queue_bytes, await sumFileBytes(await regularFilePaths(telemetryQueueDirs(cwd).pending)));
});

test("complete clears stale failure reason after a later successful send", async () => {
  const cwd = await temporaryWorkspace();
  const failedAt = new Date("2026-05-29T12:00:00.000Z");
  const completedAt = new Date("2026-05-29T12:05:00.000Z");

  await appendTelemetryEvent({ cwd, event: telemetryEvent(1), maxQueueBytes: LARGE_QUEUE_LIMIT });

  const failedBatch = await claimTelemetryBatch({ cwd, batchSize: 1, now: failedAt });
  await failTelemetryBatch({
    cwd,
    batchId: failedBatch.batchId,
    reason: "receiver_error",
    retryable: true,
  });
  assert.equal((await loadTelemetryState({ cwd })).last_failure_reason, "receiver_error");

  const successfulBatch = await claimTelemetryBatch({ cwd, batchSize: 1, now: completedAt });
  await completeTelemetryBatch({ cwd, batchId: successfulBatch.batchId, now: completedAt });

  const state = await loadTelemetryState({ cwd });
  assert.equal(state.sent_success_count, 1);
  assert.equal(state.last_failure_reason, null);
});

test("complete preserves failure reason when no events are moved", async () => {
  const cwd = await temporaryWorkspace();
  const failedAt = new Date("2026-05-29T12:00:00.000Z");
  const completedAt = new Date("2026-05-29T12:05:00.000Z");

  await appendTelemetryEvent({ cwd, event: telemetryEvent(1), maxQueueBytes: LARGE_QUEUE_LIMIT });
  const failedBatch = await claimTelemetryBatch({ cwd, batchSize: 1, now: failedAt });
  await failTelemetryBatch({
    cwd,
    batchId: failedBatch.batchId,
    reason: "receiver_error",
    retryable: true,
  });

  const dirs = telemetryQueueDirs(cwd);
  await mkdir(join(dirs.inflight, "batch_empty"), { recursive: true });
  await completeTelemetryBatch({ cwd, batchId: "batch_empty", now: completedAt });

  const state = await loadTelemetryState({ cwd });
  assert.equal(state.sent_success_count, 0);
  assert.equal(state.last_failure_reason, "receiver_error");
});

test("loadTelemetryQueueSnapshot counts failed events without reason metadata", async () => {
  const cwd = await temporaryWorkspace();
  const failedAt = new Date("2026-05-29T12:00:00.000Z");
  await appendTelemetryEvent({ cwd, event: telemetryEvent(1), maxQueueBytes: LARGE_QUEUE_LIMIT });

  const failedBatch = await claimTelemetryBatch({ cwd, batchSize: 1, now: failedAt });
  await failTelemetryBatch({
    cwd,
    batchId: failedBatch.batchId,
    retryable: false,
    reason: "payload_too_large",
  });

  const failedDir = join(telemetryQueueDirs(cwd).failed, failedBatch.batchId);
  const failedFiles = await regularFileNames(failedDir);
  assert.equal(failedFiles.length, 2);
  const failedEventFile = failedFiles.find((name) => name.startsWith("event_"));
  assert.equal(typeof failedEventFile, "string");
  assert.equal(failedFiles.includes("reason.json"), true);
  const failedEventBytes = (await stat(join(failedDir, failedEventFile))).size;

  const snapshot = await loadTelemetryQueueSnapshot({ cwd });
  assert.equal(snapshot.pending.count, 0);
  assert.equal(snapshot.failed.count, 1);
  assert.equal(snapshot.failed.bytes, failedEventBytes);
});

test("retryFailedTelemetryEvents dry-run reports matching failed batches without moving files", async () => {
  const cwd = await temporaryWorkspace();
  await appendEvents(cwd, 100, 2);
  await createFailedBatch(cwd, { count: 2, reason: "http_403" });

  const before = await loadTelemetryQueueSnapshot({ cwd });
  const result = await retryFailedTelemetryEvents({
    cwd,
    reason: "http_403",
    batchSize: 5,
    dryRun: true,
  });
  const after = await loadTelemetryQueueSnapshot({ cwd });

  assert.equal(result.ok, true);
  assert.equal(result.dry_run, true);
  assert.equal(result.reason, "http_403");
  assert.equal(result.matched_batch_count, 1);
  assert.equal(result.would_move_count, 2);
  assert.equal(result.moved_count, 0);
  assert.equal(result.remaining_failed_count_for_reason, 2);
  assert.ok(result.bytes > 0);
  assert.deepEqual(after, before);
});

test("retryFailedTelemetryEvents write mode moves only matching reason events to pending", async () => {
  const cwd = await temporaryWorkspace();
  await appendEvents(cwd, 200, 2);
  await createFailedBatch(cwd, { count: 2, reason: "http_403" });
  await appendEvents(cwd, 300, 1);
  await createFailedBatch(cwd, { count: 1, reason: "unauthorized" });

  const result = await retryFailedTelemetryEvents({
    cwd,
    reason: "http_403",
    batchSize: 5,
    dryRun: false,
  });

  assert.equal(result.ok, true);
  assert.equal(result.dry_run, false);
  assert.equal(result.matched_batch_count, 1);
  assert.equal(result.would_move_count, 2);
  assert.equal(result.moved_count, 2);
  assert.equal(result.remaining_failed_count_for_reason, 0);

  const snapshot = await loadTelemetryQueueSnapshot({ cwd });
  assert.equal(snapshot.pending.count, 2);
  assert.equal(snapshot.failed.count, 1);

  const state = await loadTelemetryState({ cwd });
  assert.equal(state.queue_bytes, snapshot.pending.bytes);
  assert.equal(state.non_retryable_failure_count, 3);
  assert.equal(state.sent_failure_count, 3);
  assert.equal(state.last_failure_reason, "unauthorized");
});

test("retryFailedTelemetryEvents partial write preserves reason metadata for remaining failed events", async () => {
  const cwd = await temporaryWorkspace();
  await appendEvents(cwd, 400, 3);
  const failedBatch = await createFailedBatch(cwd, { count: 3, reason: "http_403" });

  const first = await retryFailedTelemetryEvents({
    cwd,
    reason: "http_403",
    batchSize: 2,
    dryRun: false,
  });

  assert.equal(first.moved_count, 2);
  assert.equal(first.remaining_failed_count_for_reason, 1);
  assert.equal(await pathExists(join(failedBatch.failedDir, "reason.json")), true);

  const second = await retryFailedTelemetryEvents({
    cwd,
    reason: "http_403",
    batchSize: 2,
    dryRun: false,
  });

  assert.equal(second.moved_count, 1);
  assert.equal(second.remaining_failed_count_for_reason, 0);
  assert.equal(await pathExists(failedBatch.failedDir), false);
});

test("retryFailedTelemetryEvents ignores non-matching reasons", async () => {
  const cwd = await temporaryWorkspace();
  await appendEvents(cwd, 500, 1);
  await createFailedBatch(cwd, { count: 1, reason: "unauthorized" });

  const result = await retryFailedTelemetryEvents({
    cwd,
    reason: "http_403",
    batchSize: 5,
    dryRun: false,
  });

  assert.equal(result.ok, true);
  assert.equal(result.matched_batch_count, 0);
  assert.equal(result.would_move_count, 0);
  assert.equal(result.moved_count, 0);
  const snapshot = await loadTelemetryQueueSnapshot({ cwd });
  assert.equal(snapshot.pending.count, 0);
  assert.equal(snapshot.failed.count, 1);
});

test("retryFailedTelemetryEvents can recover malformed and missing reason metadata as unknown", async () => {
  const cwd = await temporaryWorkspace();
  await appendEvents(cwd, 600, 1);
  await createFailedBatch(cwd, { count: 1, reason: "http_403", malformedReason: true });
  await appendEvents(cwd, 700, 1);
  await createFailedBatch(cwd, { count: 1, reason: "unauthorized", missingReason: true });

  const result = await retryFailedTelemetryEvents({
    cwd,
    reason: "unknown",
    batchSize: 10,
    dryRun: false,
  });

  assert.equal(result.ok, true);
  assert.equal(result.reason, "unknown");
  assert.equal(result.matched_batch_count, 2);
  assert.equal(result.moved_count, 2);
  const snapshot = await loadTelemetryQueueSnapshot({ cwd });
  assert.equal(snapshot.pending.count, 2);
  assert.equal(snapshot.failed.count, 0);
});

test("retryFailedTelemetryEvents ignores failed batches that contain no event files", async () => {
  const cwd = await temporaryWorkspace();
  const dirs = telemetryQueueDirs(cwd);
  const emptyBatchDir = join(dirs.failed, "batch_20260610_empty");
  await mkdir(emptyBatchDir, { recursive: true });
  await writeFile(join(emptyBatchDir, "reason.json"), `${JSON.stringify({
    batch_id: "batch_20260610_empty",
    reason: "http_403",
    retryable: false,
  })}\n`);

  const result = await retryFailedTelemetryEvents({
    cwd,
    reason: "http_403",
    batchSize: 5,
    dryRun: false,
  });

  assert.equal(result.ok, true);
  assert.equal(result.matched_batch_count, 0);
  assert.equal(result.would_move_count, 0);
  assert.equal(result.moved_count, 0);
  const snapshot = await loadTelemetryQueueSnapshot({ cwd });
  assert.equal(snapshot.pending.count, 0);
  assert.equal(snapshot.failed.count, 0);
});

test("retryFailedTelemetryEvents returns aggregate-only data", async () => {
  const cwd = await temporaryWorkspace();
  await appendEvents(cwd, 800, 1);
  await createFailedBatch(cwd, { count: 1, reason: "http_403" });

  const result = await retryFailedTelemetryEvents({
    cwd,
    reason: "http_403",
    batchSize: 1,
    dryRun: true,
  });
  const serialized = JSON.stringify(result);

  assert.doesNotMatch(serialized, /evt_000800/);
  assert.doesNotMatch(serialized, /batch_2026/);
  assert.doesNotMatch(serialized, /raw prompt 800/);
  assert.doesNotMatch(serialized, /raw response 800/);
  assert.doesNotMatch(serialized, /secret-800\.png/);
  assert.doesNotMatch(serialized, /\.gemini-agent/);
  assert.doesNotMatch(serialized, /queue\/failed/);
  assert.doesNotMatch(serialized, /event_[0-9]/);
});

test("inspectFailedTelemetryEvents returns safe aggregate descriptors", async () => {
  const cwd = await temporaryWorkspace();
  await appendEvents(cwd, 1000, 2);
  await createFailedBatch(cwd, { count: 2, reason: "http_403" });

  const result = await inspectFailedTelemetryEvents({
    cwd,
    limit: 5,
  });
  const serialized = JSON.stringify(result);

  assert.equal(result.ok, true);
  assert.equal(result.failed_event_count, 2);
  assert.equal(result.failed_batch_count, 1);
  assert.equal(result.reason_counts.length, 1);
  assert.equal(result.reason_counts[0].reason, "http_403");
  assert.equal(result.reason_counts[0].batch_count, 1);
  assert.equal(result.reason_counts[0].event_count, 2);
  assert.ok(result.reason_counts[0].bytes > 0);
  assert.equal(result.events.length, 2);
  assert.equal(result.events[0].reason, "http_403");
  assert.equal(result.events[0].command, "ask");
  assert.equal(result.events[0].model, "gemini-3.5-flash");
  assert.equal(result.events[0].status, "success");
  assert.equal(result.events[0].schema_version, "1");
  assert.equal(result.events[0].created_day, "2026-05-29");
  assert.equal(typeof result.events[0].prompt_bytes, "number");
  assert.equal(typeof result.events[0].response_bytes, "number");
  assert.equal(result.events[0].media_item_count, 1);
  assert.equal(result.events[0].retryable_hint, "retry_failed_or_archive");

  assert.doesNotMatch(serialized, /evt_001000/);
  assert.doesNotMatch(serialized, /batch_2026/);
  assert.doesNotMatch(serialized, /raw prompt 1000/);
  assert.doesNotMatch(serialized, /raw response 1000/);
  assert.doesNotMatch(serialized, /secret-1000\.png/);
  assert.doesNotMatch(serialized, /\.gemini-agent/);
  assert.doesNotMatch(serialized, /queue\/failed/);
  assert.doesNotMatch(serialized, /event_[0-9]/);
});

test("inspectFailedTelemetryEvents exposes sanitized receiver diagnostics", async () => {
  const cwd = await temporaryWorkspace();
  await appendEvents(cwd, 1050, 1);
  await createFailedBatch(cwd, {
    count: 1,
    reason: "receiver_waf_403",
    diagnostics: {
      http_status: 403,
      content_type: "text/html; charset=UTF-8",
      html_title: "Blocked\nAuthorization: Bearer secret-token",
      body_sha16: "abcdef1234567890",
      body_bytes: 221309,
      body_truncated: true,
      markers: ["render", "waf", "Authorization: Bearer secret-token"],
      unsafe_preview: "raw prompt 1050 secret-token",
      nested: { path: ".gemini-agent/telemetry/queue/failed" },
    },
  });

  const result = await inspectFailedTelemetryEvents({
    cwd,
    limit: 5,
  });
  const serialized = JSON.stringify(result);

  assert.equal(result.events.length, 1);
  assert.deepEqual(result.events[0].diagnostics, {
    http_status: 403,
    content_type: "text/html; charset=UTF-8",
    html_title: "Blocked Authorization: [MASKED]",
    body_sha16: "abcdef1234567890",
    body_bytes: 221309,
    body_truncated: true,
    markers: ["render", "waf", "Authorization: [MASKED]"],
  });
  assert.doesNotMatch(serialized, /raw prompt 1050/);
  assert.doesNotMatch(serialized, /secret-token/);
  assert.doesNotMatch(serialized, /\.gemini-agent/);
  assert.doesNotMatch(serialized, /queue\/failed/);
});

test("archiveFailedTelemetryEvents dry-run reports matching failures without moving files", async () => {
  const cwd = await temporaryWorkspace();
  await appendEvents(cwd, 1100, 2);
  await createFailedBatch(cwd, { count: 2, reason: "http_403" });

  const before = await loadTelemetryQueueSnapshot({ cwd });
  const result = await archiveFailedTelemetryEvents({
    cwd,
    reason: "http_403",
    batchSize: 1,
    dryRun: true,
    note: "../unsafe note with token abc123",
  });
  const after = await loadTelemetryQueueSnapshot({ cwd });

  assert.equal(result.ok, true);
  assert.equal(result.dry_run, true);
  assert.equal(result.reason, "http_403");
  assert.equal(result.would_archive_count, 1);
  assert.equal(result.archived_count, 0);
  assert.equal(result.remaining_failed_count_for_reason, 2);
  assert.equal(result.resolution_bucket, null);
  assert.deepEqual(after, before);
});

test("archiveFailedTelemetryEvents write mode moves bounded failures to resolved-failed", async () => {
  const cwd = await temporaryWorkspace();
  await appendEvents(cwd, 1200, 2);
  const failedBatch = await createFailedBatch(cwd, { count: 2, reason: "http_403" });

  const result = await archiveFailedTelemetryEvents({
    cwd,
    reason: "http_403",
    batchSize: 1,
    dryRun: false,
    note: "../local cleanup",
  });

  assert.equal(result.ok, true);
  assert.equal(result.dry_run, false);
  assert.equal(result.would_archive_count, 1);
  assert.equal(result.archived_count, 1);
  assert.equal(result.remaining_failed_count_for_reason, 1);
  assert.match(result.resolution_bucket, /^resolved_\d{8}_\d+_[a-f0-9-]+$/);

  const dirs = telemetryQueueDirs(cwd);
  const resolvedDir = join(dirs.resolvedFailed, result.resolution_bucket);
  const resolvedFiles = await regularFileNames(resolvedDir);
  assert.equal(resolvedFiles.includes("reason.json"), true);
  assert.equal(resolvedFiles.includes("resolution.json"), true);
  assert.equal(
    resolvedFiles.filter((name) => name.endsWith(".json") && name !== "reason.json" && name !== "resolution.json").length,
    1,
  );
  assert.equal(await pathExists(join(failedBatch.failedDir, "reason.json")), true);

  const snapshot = await loadTelemetryQueueSnapshot({ cwd });
  assert.equal(snapshot.pending.count, 0);
  assert.equal(snapshot.failed.count, 1);

  const second = await archiveFailedTelemetryEvents({
    cwd,
    reason: "http_403",
    batchSize: 5,
    dryRun: false,
  });
  assert.equal(second.archived_count, 1);
  assert.equal(second.remaining_failed_count_for_reason, 0);
  assert.equal(await pathExists(failedBatch.failedDir), false);

  const finalSnapshot = await loadTelemetryQueueSnapshot({ cwd });
  assert.equal(finalSnapshot.failed.count, 0);
  assert.equal(finalSnapshot.pending.count, 0);
});

test("archiveFailedTelemetryEvents handles unknown reasons and lock contention", async () => {
  const cwd = await temporaryWorkspace();
  await appendEvents(cwd, 1300, 1);
  await createFailedBatch(cwd, { count: 1, reason: "http_403", malformedReason: true });

  const dryRun = await archiveFailedTelemetryEvents({
    cwd,
    reason: "unknown",
    batchSize: 1,
    dryRun: true,
  });
  assert.equal(dryRun.would_archive_count, 1);

  await withTelemetryQueueLock({ cwd }, async () => {
    await assert.rejects(
      () => archiveFailedTelemetryEvents({
        cwd,
        reason: "unknown",
        batchSize: 1,
        dryRun: false,
        lock: { retries: 0, retryDelayMs: 0 },
      }),
      /Telemetry queue lock could not be acquired/,
    );
  });
});

test("retryFailedTelemetryEvents write mode respects queue lock contention", async () => {
  const cwd = await temporaryWorkspace();
  await appendEvents(cwd, 900, 1);
  await createFailedBatch(cwd, { count: 1, reason: "http_403" });

  await withTelemetryQueueLock({ cwd }, async () => {
    await assert.rejects(
      () => retryFailedTelemetryEvents({
        cwd,
        reason: "http_403",
        batchSize: 1,
        dryRun: false,
        lock: { retries: 0, retryDelayMs: 0 },
      }),
      /Telemetry queue lock could not be acquired/,
    );
  });
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

test("lock rejects zero staleMs before mutating lock state", async () => {
  const cwd = await temporaryWorkspace();
  const dirs = telemetryQueueDirs(cwd);

  await assert.rejects(
    () => withTelemetryQueueLock({ cwd, staleMs: 0 }, async () => {
      assert.fail("lock callback should not run");
    }),
    /staleMs.*positive integer/,
  );
  assert.equal(await pathExists(dirs.queue), false);
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

test("stale lock guard can be reclaimed", async () => {
  const cwd = await temporaryWorkspace();
  const dirs = telemetryQueueDirs(cwd);
  const guardPath = join(dirs.queue, "lock.guard");
  await mkdir(dirs.queue, { recursive: true, mode: 0o700 });
  await chmod(dirs.queue, 0o700);
  await writeFile(dirs.lock, `${JSON.stringify({ token: "stale-lock-token" })}\n`, { mode: 0o600 });
  await chmod(dirs.lock, 0o600);
  await writeFile(guardPath, `${JSON.stringify({ token: "stale-guard-token" })}\n`, { mode: 0o600 });
  await chmod(guardPath, 0o600);
  const old = new Date(Date.now() - 60_000);
  await utimes(dirs.lock, old, old);
  await utimes(guardPath, old, old);

  const result = await withTelemetryQueueLock({ cwd, staleMs: 1, retries: 0 }, async () => {
    assert.equal(await pathExists(dirs.lock), true);
    assert.equal(await pathExists(guardPath), false);
    return "acquired";
  });

  assert.equal(result, "acquired");
  assert.equal(await pathExists(dirs.lock), false);
  assert.equal(await pathExists(guardPath), false);
});

test("stale lock reclaim preserves exclusivity across child processes", async () => {
  const cwd = await temporaryWorkspace();
  const dirs = telemetryQueueDirs(cwd);
  const probeDir = join(cwd, "probe");
  const readyDir = join(probeDir, "ready");
  const overlapDir = join(probeDir, "overlap");
  const activePath = join(probeDir, "active");
  const startPath = join(probeDir, "start");
  await mkdir(dirs.queue, { recursive: true, mode: 0o700 });
  await chmod(dirs.queue, 0o700);
  await mkdir(readyDir, { recursive: true, mode: 0o700 });
  await chmod(readyDir, 0o700);
  await mkdir(overlapDir, { recursive: true, mode: 0o700 });
  await chmod(overlapDir, 0o700);
  await writeFile(
    dirs.lock,
    `${JSON.stringify({ token: "stale-token", padding: "x".repeat(5 * 1024 * 1024) })}\n`,
    { mode: 0o600 },
  );
  await chmod(dirs.lock, 0o600);
  const old = new Date(Date.now() - 60_000);
  await utimes(dirs.lock, old, old);

  const childScript = `
    import { access, mkdir, open, unlink, writeFile } from "node:fs/promises";
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function exists(path) {
      try {
        await access(path);
        return true;
      } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
      }
    }
    const {
      PROBE_ACTIVE_PATH,
      PROBE_CWD,
      PROBE_INDEX,
      PROBE_MODULE_URL,
      PROBE_OVERLAP_DIR,
      PROBE_READY_DIR,
      PROBE_START_PATH,
    } = process.env;
    const { withTelemetryQueueLock: lock } = await import(PROBE_MODULE_URL);
    await mkdir(PROBE_READY_DIR, { recursive: true, mode: 0o700 });
    await mkdir(PROBE_OVERLAP_DIR, { recursive: true, mode: 0o700 });
    await writeFile(\`\${PROBE_READY_DIR}/\${PROBE_INDEX}\`, "ready\\n", { mode: 0o600 });
    while (!await exists(PROBE_START_PATH)) {
      await sleep(1);
    }
    await lock({ cwd: PROBE_CWD, staleMs: 1000, retries: 2000, retryDelayMs: 1 }, async () => {
      let handle;
      try {
        handle = await open(PROBE_ACTIVE_PATH, "wx", 0o600);
      } catch (error) {
        if (error.code === "EEXIST") {
          await writeFile(\`\${PROBE_OVERLAP_DIR}/\${PROBE_INDEX}\`, "overlap\\n", { mode: 0o600 });
          return;
        }
        throw error;
      }
      try {
        await handle.writeFile(\`\${PROBE_INDEX}\\n\`);
        await sleep(20);
      } finally {
        await handle.close();
        try {
          await unlink(PROBE_ACTIVE_PATH);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
    });
  `;
  const moduleUrl = new URL("../src/telemetry-queue.mjs", import.meta.url).href;
  const childCount = 40;
  const children = Array.from({ length: childCount }, (_, index) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", childScript], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PROBE_ACTIVE_PATH: activePath,
        PROBE_CWD: cwd,
        PROBE_INDEX: `${index}`,
        PROBE_MODULE_URL: moduleUrl,
        PROBE_OVERLAP_DIR: overlapDir,
        PROBE_READY_DIR: readyDir,
        PROBE_START_PATH: startPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { child, result: waitForChild(child) };
  });

  await waitUntil(async () => (await regularFileNames(readyDir)).length === childCount);
  await writeFile(startPath, "start\n", { mode: 0o600 });

  const results = await Promise.all(children.map(({ result }) => result));
  for (const result of results) {
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.equal(result.signal, null, result.stderr || result.stdout);
  }
  assert.deepEqual(await regularFileNames(overlapDir), []);
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

test("pruneSentTelemetry waits for the queue lock before mutating sent files", async () => {
  const cwd = await temporaryWorkspace();
  const dirs = telemetryQueueDirs(cwd);
  const oldDay = new Date("2026-05-20T12:00:00.000Z");
  const pruneNow = new Date("2026-05-29T12:00:00.000Z");
  const oldSentDir = join(dirs.sent, "2026-05-20");

  await appendTelemetryEvent({ cwd, event: telemetryEvent(0), maxQueueBytes: LARGE_QUEUE_LIMIT });
  const batch = await claimTelemetryBatch({ cwd, batchSize: 1, now: oldDay });
  await completeTelemetryBatch({ cwd, batchId: batch.batchId, now: oldDay });
  assert.equal(await pathExists(oldSentDir), true);

  let releaseLock;
  let enteredLock = false;
  const holder = withTelemetryQueueLock({ cwd, staleMs: 10_000, retries: 0 }, async () => {
    enteredLock = true;
    await new Promise((resolve) => {
      releaseLock = resolve;
    });
  });
  await waitUntil(async () => enteredLock && await pathExists(dirs.lock));

  let pruneSettled = false;
  const prune = pruneSentTelemetry({
    cwd,
    now: pruneNow,
    keepDays: 7,
    maxSentBytes: LARGE_QUEUE_LIMIT,
  }).then((removed) => {
    pruneSettled = true;
    return removed;
  });

  await sleep(75);
  assert.equal(pruneSettled, false);
  assert.equal(await pathExists(oldSentDir), true);

  releaseLock();
  await holder;
  assert.equal(await prune, 1);
  assert.equal(await pathExists(oldSentDir), false);
});
