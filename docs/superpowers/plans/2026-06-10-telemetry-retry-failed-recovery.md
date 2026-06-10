# Telemetry Retry Failed Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a privacy-safe `gemini-agent telemetry retry-failed` command that previews and restores explicitly selected failed telemetry events back to `pending`.

**Architecture:** Extend `src/telemetry-queue.mjs` with a focused queue recovery helper that scans failed batches by sanitized reason and moves matching event files under the existing queue lock in write mode. Extend `src/cli.mjs` with argument parsing, write-mode telemetry preflight, help text, and aggregate-only JSON output. Cover the helper with queue tests and the CLI with command-level tests.

**Tech Stack:** Node.js ESM, `node:test`, existing telemetry queue/config modules, filesystem queue directories, existing CLI executable under `bin/gemini-agent`.

---

## File Structure

- Modify `src/telemetry-queue.mjs`
  - Add public `retryFailedTelemetryEvents`.
  - Add private failed-batch scan/move helpers near existing failed-batch summary functions.
  - Reuse `safeFailureReason`, `failedBatchDirectories`, `failedBatchReason`, `regularFiles`, `pendingQueueBytes`, `loadStateFromPath`, `saveState`, `secureMkdir`, and `withTelemetryQueueLock`.
  - The existing module already imports `rename` and `rm`, defines `SECURE_FILE_MODE`, defines `sumFileSizes`, and returns `{ name, path, size, mtimeMs }` objects from `regularFiles`.

- Modify `src/cli.mjs`
  - Import `retryFailedTelemetryEvents`.
  - Add usage line for `telemetry retry-failed`.
  - Add `parseTelemetryRetryFailedOptions`.
  - Add `runTelemetryRetryFailed`.
  - Route `subcommand === "retry-failed"` inside `runTelemetry`.

- Modify `test/telemetry-queue.test.mjs`
  - Add tests for dry-run, write mode, partial recovery, unknown reason recovery, privacy-shaped return values, and lock contention.

- Modify `test/cli.test.mjs`
  - Add tests for CLI argument validation, dry-run output privacy, write-mode preflight, write-mode movement, and `--global` scope targeting.

---

## Task 1: Queue Helper Tests

**Files:**
- Modify: `test/telemetry-queue.test.mjs`

- [ ] **Step 1: Import the new helper in the test file**

Change the telemetry queue import near the top of `test/telemetry-queue.test.mjs` to include `retryFailedTelemetryEvents`:

```js
import {
  appendTelemetryEvent,
  appendTelemetryEventsIfNew,
  appendTelemetryEventIfNew,
  claimTelemetryBatch,
  completeTelemetryBatch,
  failTelemetryBatch,
  loadTelemetryQueueSnapshot,
  loadTelemetryState,
  peekTelemetryEvents,
  pruneSentTelemetry,
  quarantineTelemetryEvent,
  retryFailedTelemetryEvents,
  telemetryQueueDirs,
  withTelemetryQueueLock,
} from "../src/telemetry-queue.mjs";
```

- [ ] **Step 2: Add failed batch setup helpers**

Append these helpers after `readPendingEvents`:

```js
async function createFailedBatch(cwd, {
  start = 100,
  count = 1,
  reason = "http_403",
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
          multimodal: [{ mime_type: "image/png", file_name: `secret-${start + offset}.png` }],
        },
      }),
      maxQueueBytes: LARGE_QUEUE_LIMIT,
    });
  }
}
```

Ensure `rm` is imported from `node:fs/promises` at the top:

```js
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
```

- [ ] **Step 3: Add dry-run no-mutation test**

Append this test near the existing failure-batch tests:

```js
test("retryFailedTelemetryEvents dry-run reports matching failed batches without moving files", async () => {
  const cwd = await temporaryWorkspace();
  await appendEvents(cwd, 100, 2);
  await createFailedBatch(cwd, { start: 100, count: 2, reason: "http_403" });

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
```

- [ ] **Step 4: Add write-mode matching and state test**

Append:

```js
test("retryFailedTelemetryEvents write mode moves only matching reason events to pending", async () => {
  const cwd = await temporaryWorkspace();
  await appendEvents(cwd, 200, 2);
  await createFailedBatch(cwd, { start: 200, count: 2, reason: "http_403" });
  await appendEvents(cwd, 300, 1);
  await createFailedBatch(cwd, { start: 300, count: 1, reason: "unauthorized" });

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
```

- [ ] **Step 5: Add partial recovery test**

Append:

```js
test("retryFailedTelemetryEvents partial write preserves reason metadata for remaining failed events", async () => {
  const cwd = await temporaryWorkspace();
  await appendEvents(cwd, 400, 3);
  const failedBatch = await createFailedBatch(cwd, { start: 400, count: 3, reason: "http_403" });

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
```

- [ ] **Step 6: Add non-matching and unknown reason tests**

Append:

```js
test("retryFailedTelemetryEvents ignores non-matching reasons", async () => {
  const cwd = await temporaryWorkspace();
  await appendEvents(cwd, 500, 1);
  await createFailedBatch(cwd, { start: 500, count: 1, reason: "unauthorized" });

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
  await createFailedBatch(cwd, { start: 600, count: 1, reason: "http_403", malformedReason: true });
  await appendEvents(cwd, 700, 1);
  await createFailedBatch(cwd, { start: 700, count: 1, reason: "unauthorized", missingReason: true });

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
```

- [ ] **Step 7: Add return-shape privacy test**

Append:

```js
test("retryFailedTelemetryEvents returns aggregate-only data", async () => {
  const cwd = await temporaryWorkspace();
  await appendEvents(cwd, 800, 1);
  await createFailedBatch(cwd, { start: 800, count: 1, reason: "http_403" });

  const result = await retryFailedTelemetryEvents({
    cwd,
    reason: "http_403",
    batchSize: 1,
    dryRun: true,
  });
  const serialized = JSON.stringify(result);

  assert.doesNotMatch(serialized, /evt_000800/);
  assert.doesNotMatch(serialized, /batch_/);
  assert.doesNotMatch(serialized, /raw prompt 800/);
  assert.doesNotMatch(serialized, /raw response 800/);
  assert.doesNotMatch(serialized, /secret-800\.png/);
  assert.doesNotMatch(serialized, /failed/);
  assert.doesNotMatch(serialized, /event_/);
});
```

- [ ] **Step 8: Add lock contention test**

Append:

```js
test("retryFailedTelemetryEvents write mode respects queue lock contention", async () => {
  const cwd = await temporaryWorkspace();
  await appendEvents(cwd, 900, 1);
  await createFailedBatch(cwd, { start: 900, count: 1, reason: "http_403" });

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
```

- [ ] **Step 9: Run queue tests and verify failure**

Run:

```bash
node --test test/telemetry-queue.test.mjs
```

Expected: FAIL because `retryFailedTelemetryEvents` is not exported from `src/telemetry-queue.mjs`.

---

## Task 2: Queue Helper Implementation

**Files:**
- Modify: `src/telemetry-queue.mjs`

- [ ] **Step 1: Add candidate helpers near `loadFailedTelemetryBatchSummaries`**

Insert these helpers before `export async function loadFailedTelemetryBatchSummaries`:

```js
function sanitizeRetryReason(value) {
  return safeFailureReason(value);
}

async function failedBatchEventFiles(batchDir) {
  return (await regularFiles(batchDir))
    .filter((file) => file.name !== "reason.json" && file.name.endsWith(".json"));
}

async function failedRetryCandidates(dirs, reason) {
  const sanitizedReason = sanitizeRetryReason(reason);
  const batchNames = await failedBatchDirectories(dirs.failed);
  const candidates = [];
  for (const batchName of batchNames) {
    const batchDir = join(dirs.failed, batchName);
    const batchReason = await failedBatchReason(batchDir);
    if (batchReason !== sanitizedReason) continue;
    const files = await failedBatchEventFiles(batchDir);
    if (files.length === 0) continue;
    candidates.push({
      batchDir,
      reason: batchReason,
      files,
      bytes: await sumFileSizes(files),
    });
  }
  return { reason: sanitizedReason, candidates };
}

function retryFailedNextCommand({ reason, write = false, batchSize = 1 }) {
  const mode = write ? "--write" : "--dry-run";
  return `gemini-agent telemetry retry-failed --reason ${reason} ${mode} --batch-size ${batchSize}`;
}

function summarizeRetryCandidates({
  reason,
  candidates,
  batchSize,
  dryRun,
  movedCount = 0,
  remainingCandidates = candidates,
}) {
  const allFiles = candidates.flatMap((candidate) => candidate.files);
  const selectedFiles = allFiles.slice(0, batchSize);
  const remainingFiles = remainingCandidates.flatMap((candidate) => candidate.files);
  return {
    ok: true,
    dry_run: dryRun,
    reason,
    matched_batch_count: candidates.length,
    would_move_count: selectedFiles.length,
    moved_count: movedCount,
    remaining_failed_count_for_reason: dryRun ? allFiles.length : remainingFiles.length,
    bytes: selectedFiles.reduce((sum, file) => sum + file.size, 0),
    next_command: dryRun
      ? retryFailedNextCommand({ reason, write: true, batchSize })
      : "gemini-agent telemetry flush --dry-run --batch-size 1",
  };
}
```

- [ ] **Step 2: Add the exported retry helper**

Insert after `loadFailedTelemetryBatchSummaries`:

```js
export async function retryFailedTelemetryEvents({
  cwd = process.cwd(),
  reason,
  batchSize = 1,
  dryRun = true,
  lock = {},
} = {}) {
  if (typeof reason !== "string" || !reason.trim()) {
    throw new Error("Telemetry failed retry reason is required.");
  }
  assertPositiveInteger(batchSize, "batchSize");
  if (typeof dryRun !== "boolean") {
    throw new TypeError("dryRun must be a boolean.");
  }
  if (lock == null || typeof lock !== "object" || Array.isArray(lock)) {
    throw new TypeError("lock must be an object.");
  }

  if (dryRun) {
    const dirs = telemetryQueueDirs(cwd);
    const { reason: sanitizedReason, candidates } = await failedRetryCandidates(dirs, reason);
    return summarizeRetryCandidates({
      reason: sanitizedReason,
      candidates,
      batchSize,
      dryRun: true,
    });
  }

  return withTelemetryQueueLock({ cwd, ...lock }, async () => {
    const dirs = await ensureQueueDirs(cwd);
    const { reason: sanitizedReason, candidates } = await failedRetryCandidates(dirs, reason);
    let remainingToMove = batchSize;
    let movedCount = 0;

    for (const candidate of candidates) {
      if (remainingToMove <= 0) break;
      const selected = candidate.files.slice(0, remainingToMove);
      for (const file of selected) {
        const destination = join(dirs.pending, file.name);
        await rename(file.path, destination);
        await chmod(destination, SECURE_FILE_MODE);
        movedCount += 1;
        remainingToMove -= 1;
      }
      const remainingFiles = await failedBatchEventFiles(candidate.batchDir);
      if (remainingFiles.length === 0) {
        await rm(candidate.batchDir, { recursive: true, force: true });
      }
    }

    const state = await loadStateFromPath(dirs.state);
    await saveState(cwd, {
      ...state,
      queue_bytes: await pendingQueueBytes(cwd),
    });

    const refreshed = await failedRetryCandidates(dirs, sanitizedReason);
    return summarizeRetryCandidates({
      reason: sanitizedReason,
      candidates,
      batchSize,
      dryRun: false,
      movedCount,
      remainingCandidates: refreshed.candidates,
    });
  });
}
```

- [ ] **Step 3: Run queue tests and verify pass**

Run:

```bash
node --test test/telemetry-queue.test.mjs
```

Expected: PASS.

- [ ] **Step 4: Commit queue helper**

Run:

```bash
git add src/telemetry-queue.mjs test/telemetry-queue.test.mjs
git commit -m "feat: add telemetry failed retry queue helper"
```

---

## Task 3: CLI Tests

**Files:**
- Modify: `test/cli.test.mjs`

- [ ] **Step 1: Import queue helpers needed by CLI tests**

Change the existing import from `../src/telemetry-queue.mjs` to:

```js
import {
  appendTelemetryEvent,
  claimTelemetryBatch,
  failTelemetryBatch,
  loadTelemetryQueueSnapshot,
  telemetryQueueDirs,
} from "../src/telemetry-queue.mjs";
```

- [ ] **Step 2: Add CLI failed batch setup helpers**

Append these helpers after `telemetryEvent`:

```js
async function queueFailedCliEvents(cwd, { start = 1, count = 1, reason = "http_403" } = {}) {
  for (let offset = 0; offset < count; offset += 1) {
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(`retry_${start + offset}`, {
        prompt: `raw cli prompt ${start + offset}`,
        response: `raw cli response ${start + offset}`,
        payload: {
          prompt_truncated: false,
          response_truncated: false,
          multimodal: [{ mime_type: "image/png", file_name: `cli-secret-${start + offset}.png` }],
        },
      }),
      maxQueueBytes: 10 * 1024 * 1024,
    });
  }
  const batch = await claimTelemetryBatch({
    cwd,
    batchSize: count,
    now: new Date("2026-06-10T10:00:00.000Z"),
  });
  await failTelemetryBatch({
    cwd,
    batchId: batch.batchId,
    retryable: false,
    reason,
  });
  return batch;
}
```

- [ ] **Step 3: Add dry-run CLI privacy test**

Append near other telemetry CLI tests:

```js
test("telemetry retry-failed dry-run prints aggregate-only preview", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-cli-retry-"));
  await saveTelemetryConfig({
    cwd,
    scope: "local",
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TELEMETRY_TOKEN_ENV,
    deploymentId: "dep_cli",
  });
  await queueFailedCliEvents(cwd, { start: 10, count: 2, reason: "http_403" });

  const { stdout } = await execBin(["telemetry", "retry-failed", "--reason", "http_403"], {
    cwd,
    env: { ...process.env, [TELEMETRY_TOKEN_ENV]: TELEMETRY_TOKEN },
  });
  const parsed = JSON.parse(stdout);
  const serialized = JSON.stringify(parsed);

  assert.equal(parsed.ok, true);
  assert.equal(parsed.dry_run, true);
  assert.equal(parsed.scope, "local");
  assert.equal(parsed.reason, "http_403");
  assert.equal(parsed.would_move_count, 1);
  assert.equal(parsed.moved_count, 0);
  assert.doesNotMatch(serialized, /evt_cli_retry_10/);
  assert.doesNotMatch(serialized, /batch_/);
  assert.doesNotMatch(serialized, /raw cli prompt/);
  assert.doesNotMatch(serialized, /raw cli response/);
  assert.doesNotMatch(serialized, /cli-secret/);
  await rm(cwd, { recursive: true, force: true });
});
```

- [ ] **Step 4: Add write-mode CLI movement and token preflight tests**

Append:

```js
test("telemetry retry-failed write mode requires token env before moving files", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-cli-retry-token-"));
  await saveTelemetryConfig({
    cwd,
    scope: "local",
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TELEMETRY_TOKEN_ENV,
    deploymentId: "dep_cli",
  });
  await queueFailedCliEvents(cwd, { start: 20, count: 1, reason: "http_403" });

  await assert.rejects(
    () => execBin(["telemetry", "retry-failed", "--reason", "http_403", "--write"], {
      cwd,
      env: { ...process.env, [TELEMETRY_TOKEN_ENV]: "" },
    }),
    /Command failed/,
  );

  const snapshot = await loadTelemetryQueueSnapshot({ cwd });
  assert.equal(snapshot.pending.count, 0);
  assert.equal(snapshot.failed.count, 1);
  await rm(cwd, { recursive: true, force: true });
});

test("telemetry retry-failed write mode moves bounded failed events to pending", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-cli-retry-write-"));
  await saveTelemetryConfig({
    cwd,
    scope: "local",
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TELEMETRY_TOKEN_ENV,
    deploymentId: "dep_cli",
  });
  await queueFailedCliEvents(cwd, { start: 30, count: 2, reason: "http_403" });

  const { stdout } = await execBin([
    "telemetry",
    "retry-failed",
    "--reason",
    "http_403",
    "--write",
    "--batch-size",
    "1",
  ], {
    cwd,
    env: { ...process.env, [TELEMETRY_TOKEN_ENV]: TELEMETRY_TOKEN },
  });

  const parsed = JSON.parse(stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.dry_run, false);
  assert.equal(parsed.moved_count, 1);
  assert.equal(parsed.remaining_failed_count_for_reason, 1);

  const snapshot = await loadTelemetryQueueSnapshot({ cwd });
  assert.equal(snapshot.pending.count, 1);
  assert.equal(snapshot.failed.count, 1);
  await rm(cwd, { recursive: true, force: true });
});
```

- [ ] **Step 5: Add argument validation and global scope tests**

Append:

```js
test("telemetry retry-failed rejects invalid arguments", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-cli-retry-args-"));
  await assert.rejects(
    () => execBin(["telemetry", "retry-failed"], { cwd }),
    /Command failed/,
  );
  await assert.rejects(
    () => execBin(["telemetry", "retry-failed", "--reason", "http_403", "--dry-run", "--write"], { cwd }),
    /Command failed/,
  );
  await assert.rejects(
    () => execBin(["telemetry", "retry-failed", "--reason", "http_403", "--batch-size", "0"], { cwd }),
    /Command failed/,
  );
  await rm(cwd, { recursive: true, force: true });
});

test("telemetry retry-failed --global targets home telemetry storage", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-cli-retry-global-cwd-"));
  const home = await mkdtemp(join(tmpdir(), "gemini-agent-cli-retry-global-home-"));
  await saveTelemetryConfig({
    cwd: home,
    scope: "local",
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TELEMETRY_TOKEN_ENV,
    deploymentId: "dep_cli",
  });
  await queueFailedCliEvents(home, { start: 40, count: 1, reason: "http_403" });

  const { stdout } = await execBin(["telemetry", "retry-failed", "--global", "--reason", "http_403"], {
    cwd,
    env: { ...process.env, HOME: home, [TELEMETRY_TOKEN_ENV]: TELEMETRY_TOKEN },
  });
  const parsed = JSON.parse(stdout);

  assert.equal(parsed.scope, "global");
  assert.equal(parsed.storage_cwd, home);
  assert.equal(parsed.would_move_count, 1);
  await rm(cwd, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});
```

- [ ] **Step 6: Run CLI tests and verify failure**

Run:

```bash
node --test test/cli.test.mjs
```

Expected: FAIL because `telemetry retry-failed` is not routed in `src/cli.mjs`.

---

## Task 4: CLI Implementation

**Files:**
- Modify: `src/cli.mjs`

- [ ] **Step 1: Import the queue helper**

Change the telemetry queue import to include `retryFailedTelemetryEvents`:

```js
import {
  appendTelemetryEvent,
  appendTelemetryEventsIfNew,
  loadTelemetryState,
  purgeTelemetryData,
  quarantineTelemetryEvent,
  retryFailedTelemetryEvents,
} from "./telemetry-queue.mjs";
```

- [ ] **Step 2: Add the usage line**

Add this line after the telemetry flush usage line:

```js
"  gemini-agent telemetry retry-failed [--global] --reason <reason> [--dry-run|--write] [--batch-size <n>]",
```

- [ ] **Step 3: Add parser function after `parseTelemetryFlushOptions`**

```js
function parseTelemetryRetryFailedOptions(args) {
  const options = {
    dryRun: true,
    global: false,
    batchSize: 1,
  };
  let sawDryRun = false;
  let sawWrite = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--global") {
      options.global = true;
    } else if (arg === "--dry-run") {
      sawDryRun = true;
      options.dryRun = true;
    } else if (arg === "--write") {
      sawWrite = true;
      options.dryRun = false;
    } else if (arg === "--reason") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--reason requires a reason.");
      options.reason = value;
      index += 1;
    } else if (arg === "--batch-size") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--batch-size requires a positive integer.");
      options.batchSize = positiveIntegerOption(value, "--batch-size");
      index += 1;
    } else {
      throw new Error(`Unknown telemetry retry-failed argument: ${arg}`);
    }
  }

  if (sawDryRun && sawWrite) throw new Error("--dry-run and --write cannot be used together.");
  if (!options.reason) throw new Error("--reason is required.");
  return options;
}
```

- [ ] **Step 4: Add runner function after `runTelemetryFlush`**

```js
async function runTelemetryRetryFailed(args = []) {
  const options = parseTelemetryRetryFailedOptions(args);
  const context = options.dryRun
    ? await requireTelemetryDryRunContext(options)
    : await requireEnabledTelemetryContextForOptions(options);

  if (!options.dryRun) {
    const token = resolveTelemetryToken({
      tokenEnv: context.config.token_env,
      env: process.env,
    });
    if (!token) {
      throw new Error(`${context.config.token_env} is not set.`);
    }
  }

  const result = await retryFailedTelemetryEvents({
    cwd: context.storageCwd,
    reason: options.reason,
    batchSize: options.batchSize,
    dryRun: options.dryRun,
  });
  output.write(`${JSON.stringify({
    scope: context.scope,
    storage_cwd: context.storageCwd,
    ...result,
  }, null, 2)}\n`);
}
```

- [ ] **Step 5: Route the telemetry subcommand**

Inside `runTelemetry`, add after the `flush` branch:

```js
if (subcommand === "retry-failed") {
  await runTelemetryRetryFailed(subArgs);
  return;
}
```

- [ ] **Step 6: Run CLI tests and queue tests**

Run:

```bash
node --test test/telemetry-queue.test.mjs test/cli.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit CLI implementation**

Run:

```bash
git add src/cli.mjs test/cli.test.mjs
git commit -m "feat: add telemetry retry-failed cli"
```

---

## Task 5: Verification And Operational Recovery

**Files:**
- No code files required unless tests reveal issues.

- [ ] **Step 1: Run the targeted test suite**

Run:

```bash
node --test test/telemetry-queue.test.mjs test/cli.test.mjs
```

Expected: PASS.

- [ ] **Step 2: Run the full test suite**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 3: Run diff check**

Run:

```bash
git diff --check
```

Expected: no output.

- [ ] **Step 4: Preview historical `http_403` recovery**

Run:

```bash
./bin/gemini-agent telemetry retry-failed --global --reason http_403 --dry-run
```

Expected:

```json
{
  "scope": "global",
  "reason": "http_403",
  "dry_run": true,
  "matched_batch_count": 1,
  "would_move_count": 1,
  "moved_count": 0
}
```

The exact counts can differ if the queue has changed. The output must not include event ids, batch ids, raw prompt/response, media file names, or file paths.

- [ ] **Step 5: Recover a bounded `http_403` batch**

Run:

```bash
./bin/gemini-agent telemetry retry-failed --global --reason http_403 --write --batch-size 5
```

Expected: up to five events move from failed to pending. No events are sent by this command.

- [ ] **Step 6: Flush recovered events one at a time**

Run dry-run:

```bash
./bin/gemini-agent telemetry flush --global --dry-run --batch-size 1 --timeout-ms 20000
```

If safe, run:

```bash
./bin/gemini-agent telemetry flush --global --batch-size 1 --timeout-ms 20000
```

Repeat bounded flushes until pending is zero or a new failure appears.

- [ ] **Step 7: Preview and recover `unauthorized` only after `http_403` is clean**

Run:

```bash
./bin/gemini-agent telemetry retry-failed --global --reason unauthorized --dry-run
```

If doctor is healthy and the preview is expected:

```bash
./bin/gemini-agent telemetry retry-failed --global --reason unauthorized --write --batch-size 1
./bin/gemini-agent telemetry flush --global --dry-run --batch-size 1 --timeout-ms 20000
./bin/gemini-agent telemetry flush --global --batch-size 1 --timeout-ms 20000
```

- [ ] **Step 8: Verify global delivery health**

Run:

```bash
./bin/gemini-agent telemetry doctor --global
./bin/gemini-agent telemetry summary --global --json
```

Expected: pending is zero after flushes. Failed count should be lower, ideally zero if all recovered events were accepted.

- [ ] **Step 9: Gemini diff review**

Run:

```bash
git diff main...HEAD | ./bin/gemini-agent diff-review --model gemini-3.5-flash --stdin
```

Expected: `verdict` is `pass` or only low-risk comments that are either fixed or explicitly documented.

- [ ] **Step 10: Final commit if verification changed no code**

If operational recovery did not require code changes, no extra commit is required. If fixes were needed, commit them:

```bash
git add src/telemetry-queue.mjs src/cli.mjs test/telemetry-queue.test.mjs test/cli.test.mjs
git commit -m "fix: harden telemetry retry-failed recovery"
```

---

## Self-Review

- Spec coverage:
  - Dry-run default: Task 3 and Task 4.
  - Explicit write: Task 3 and Task 4.
  - Required reason matching: Task 1, Task 2, Task 3, Task 4.
  - Queue lock protection: Task 1 and Task 2.
  - Partial batch handling: Task 1 and Task 2.
  - No raw/event id output: Task 1, Task 3, Task 5.
  - Global scope: Task 3 and Task 4.
  - Operational recovery: Task 5.
- The plan keeps recovery separate from sending; only `telemetry flush` sends events.
- The plan uses existing queue/config helpers and avoids new storage formats.
- All code paths have targeted tests before implementation.
