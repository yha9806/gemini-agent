# Telemetry Failed Governance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add privacy-safe local governance commands for inspecting and archiving live failed telemetry events.

**Architecture:** Extend `src/telemetry-queue.mjs` with allowlisted failed-event inspection and local archive movement under the existing queue lock. Extend `src/cli.mjs` with `telemetry failed inspect` and `telemetry failed archive`, keeping `archive` local-only and token-independent. Existing `telemetry doctor` will stop being blocked once failures move out of `queue/failed` because it already counts only live queue directories.

**Tech Stack:** Node.js ESM, `node:test`, filesystem queue under `.gemini-agent/telemetry/queue`, existing telemetry CLI helpers.

---

## File Structure

- Modify `src/telemetry-queue.mjs`
  - Add `resolvedFailed` queue directory.
  - Add safe failed-event descriptor helpers.
  - Export `inspectFailedTelemetryEvents`.
  - Export `archiveFailedTelemetryEvents`.
- Modify `src/cli.mjs`
  - Add usage lines for `telemetry failed inspect` and `telemetry failed archive`.
  - Add parser and runner for the `failed` command group.
  - Route `telemetry failed`.
- Modify `test/telemetry-queue.test.mjs`
  - Add queue-level inspect/archive tests.
- Modify `test/cli.test.mjs`
  - Add CLI inspect/archive tests.

## Task 1: Queue Inspect Helper

**Files:**
- Modify: `test/telemetry-queue.test.mjs`
- Modify: `src/telemetry-queue.mjs`

- [ ] **Step 1: Write failing inspect export/import test setup**

In `test/telemetry-queue.test.mjs`, add these imports to the existing telemetry queue import block:

```js
  archiveFailedTelemetryEvents,
  inspectFailedTelemetryEvents,
```

Add this test after the existing `retryFailedTelemetryEvents returns aggregate-only data` test:

```js
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
  assert.deepEqual(result.reason_counts, [
    { reason: "http_403", batch_count: 1, event_count: 2, bytes: result.reason_counts[0].bytes },
  ]);
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
```

- [ ] **Step 2: Run inspect test and verify RED**

Run:

```bash
node --test test/telemetry-queue.test.mjs --test-name-pattern "inspectFailedTelemetryEvents returns safe aggregate descriptors"
```

Expected: FAIL because `inspectFailedTelemetryEvents` is not exported.

- [ ] **Step 3: Implement minimal inspect helper**

In `src/telemetry-queue.mjs`, add `resolvedFailed` to `telemetryQueueDirs`:

```js
    resolvedFailed: join(queue, "resolved-failed"),
```

Add `dirs.resolvedFailed` to the `ensureQueueDirs` directory list.

Add helper functions near `retryFailedTelemetryEvents`:

```js
function safeDiagnosticLabel(value, maxLength = 80) {
  const raw = typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : "";
  const text = maskCredentialText(raw)
    .replace(/[\0-\x1F\x7F]/g, " ")
    .trim();
  if (!text) return "unknown";
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function safeCreatedDay(value) {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return utcDay(date);
}

function byteLength(value) {
  return typeof value === "string" ? Buffer.byteLength(value, "utf8") : 0;
}

function mediaItemCount(event) {
  const multimodal = event?.payload?.multimodal;
  return Array.isArray(multimodal) ? multimodal.length : 0;
}

async function readJsonOrNull(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

function failedEventDescriptor(event, reason) {
  const safeEvent = event && typeof event === "object" && !Array.isArray(event) ? event : {};
  return {
    reason,
    command: safeDiagnosticLabel(safeEvent.command),
    model: safeDiagnosticLabel(safeEvent.model),
    status: safeDiagnosticLabel(safeEvent.status),
    schema_version: safeDiagnosticLabel(safeEvent.schema_version),
    created_day: safeCreatedDay(safeEvent.created_at),
    prompt_bytes: byteLength(safeEvent.prompt),
    response_bytes: byteLength(safeEvent.response),
    media_item_count: mediaItemCount(safeEvent),
    retryable_hint: reason === "unauthorized" ? "fix_auth_then_retry_or_archive" : "retry_failed_or_archive",
  };
}

function aggregateReasonCounts(items) {
  const byReason = new Map();
  for (const item of items) {
    const current = byReason.get(item.reason) ?? {
      reason: item.reason,
      batch_count: 0,
      event_count: 0,
      bytes: 0,
    };
    current.batch_count += 1;
    current.event_count += item.files.length;
    current.bytes += item.bytes;
    byReason.set(item.reason, current);
  }
  return [...byReason.values()].sort((left, right) => {
    return right.event_count - left.event_count || left.reason.localeCompare(right.reason);
  });
}

export async function inspectFailedTelemetryEvents({
  cwd = process.cwd(),
  reason,
  limit = 20,
} = {}) {
  assertPositiveInteger(limit, "limit");
  const dirs = telemetryQueueDirs(cwd);
  const { reason: sanitizedReason, candidates } = reason == null
    ? { reason: null, candidates: await allFailedCandidates(dirs) }
    : await failedRetryCandidates(dirs, reason);
  const reasonCounts = aggregateReasonCounts(candidates);
  const descriptors = [];
  for (const candidate of candidates) {
    for (const file of candidate.files) {
      if (descriptors.length >= limit) break;
      descriptors.push(failedEventDescriptor(await readJsonOrNull(file.path), candidate.reason));
    }
    if (descriptors.length >= limit) break;
  }
  return {
    ok: true,
    reason_filter: sanitizedReason,
    failed_event_count: candidates.reduce((sum, item) => sum + item.files.length, 0),
    failed_batch_count: candidates.length,
    reason_counts: reasonCounts,
    events: descriptors,
  };
}
```

Also add `allFailedCandidates(dirs)` next to `failedRetryCandidates`:

```js
async function allFailedCandidates(dirs) {
  const batchNames = await failedBatchDirectories(dirs.failed);
  const candidates = [];
  for (const batchName of batchNames) {
    const batchDir = join(dirs.failed, batchName);
    const files = await failedBatchEventFiles(batchDir);
    if (files.length === 0) continue;
    candidates.push({
      batchDir,
      reason: await failedBatchReason(batchDir),
      files,
      bytes: await sumFileSizes(files),
    });
  }
  return candidates;
}
```

- [ ] **Step 4: Run inspect test and verify GREEN**

Run:

```bash
node --test test/telemetry-queue.test.mjs --test-name-pattern "inspectFailedTelemetryEvents returns safe aggregate descriptors"
```

Expected: PASS.

## Task 2: Queue Archive Helper

**Files:**
- Modify: `test/telemetry-queue.test.mjs`
- Modify: `src/telemetry-queue.mjs`

- [ ] **Step 1: Write failing archive tests**

Add these tests after the inspect test:

```js
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
  assert.equal(resolvedFiles.filter((name) => name.endsWith(".json") && name !== "reason.json" && name !== "resolution.json").length, 1);
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
```

- [ ] **Step 2: Run archive tests and verify RED**

Run:

```bash
node --test test/telemetry-queue.test.mjs --test-name-pattern "archiveFailedTelemetryEvents"
```

Expected: FAIL because `archiveFailedTelemetryEvents` is not exported.

- [ ] **Step 3: Implement archive helper**

In `src/telemetry-queue.mjs`, add helpers near retry/archive functions:

```js
function resolvedFailedBucketName(now = new Date()) {
  return `resolved_${utcDay(now).replaceAll("-", "")}_${Date.now()}_${randomUUID()}`;
}

function safeResolutionNote(value) {
  if (value == null) return null;
  const text = safeDiagnosticLabel(value, 160);
  return text === "unknown" ? null : text;
}

function archiveNextCommand({ reason, write = false, batchSize = 1 }) {
  const mode = write ? "--write" : "--dry-run";
  return `gemini-agent telemetry failed archive --reason ${shellQuote(reason)} ${mode} --batch-size ${batchSize}`;
}

function summarizeArchiveCandidates({
  reason,
  candidates,
  batchSize,
  dryRun,
  archivedCount = 0,
  remainingCandidates = candidates,
  resolutionBucket = null,
}) {
  const allFiles = candidates.flatMap((candidate) => candidate.files);
  const selectedFiles = allFiles.slice(0, batchSize);
  const remainingFiles = remainingCandidates.flatMap((candidate) => candidate.files);
  return {
    ok: true,
    dry_run: dryRun,
    reason,
    matched_batch_count: candidates.length,
    would_archive_count: selectedFiles.length,
    archived_count: archivedCount,
    remaining_failed_count_for_reason: dryRun ? allFiles.length : remainingFiles.length,
    bytes: selectedFiles.reduce((sum, file) => sum + file.size, 0),
    resolution_bucket: resolutionBucket,
    next_command: dryRun
      ? archiveNextCommand({ reason, write: true, batchSize })
      : "gemini-agent telemetry doctor --json",
  };
}
```

Export:

```js
export async function archiveFailedTelemetryEvents({
  cwd = process.cwd(),
  reason,
  batchSize = 1,
  dryRun = true,
  note = null,
  lock = {},
} = {}) {
  if (typeof reason !== "string" || !reason.trim()) {
    throw new Error("Telemetry failed archive reason is required.");
  }
  assertPositiveInteger(batchSize, "batchSize");
  if (typeof dryRun !== "boolean") throw new TypeError("dryRun must be a boolean.");
  if (lock == null || typeof lock !== "object" || Array.isArray(lock)) {
    throw new TypeError("lock must be an object.");
  }

  if (dryRun) {
    const dirs = telemetryQueueDirs(cwd);
    const { reason: sanitizedReason, candidates } = await failedRetryCandidates(dirs, reason);
    return summarizeArchiveCandidates({
      reason: sanitizedReason,
      candidates,
      batchSize,
      dryRun: true,
    });
  }

  return withTelemetryQueueLock({ cwd, ...lock }, async () => {
    const dirs = await ensureQueueDirs(cwd);
    const { reason: sanitizedReason, candidates } = await failedRetryCandidates(dirs, reason);
    const bucketName = resolvedFailedBucketName();
    const bucketDir = join(dirs.resolvedFailed, bucketName);
    let remainingToArchive = batchSize;
    let archivedCount = 0;

    if (candidates.some((candidate) => candidate.files.length > 0)) {
      await secureMkdir(bucketDir);
      await writeSecureJsonFile(cwd, join(bucketDir, "reason.json"), {
        reason: sanitizedReason,
      });
      await writeSecureJsonFile(cwd, join(bucketDir, "resolution.json"), {
        reason: sanitizedReason,
        note: safeResolutionNote(note),
        resolved_at: new Date().toISOString(),
        archived_count: 0,
      });
    }

    for (const candidate of candidates) {
      if (remainingToArchive <= 0) break;
      const selected = candidate.files.slice(0, remainingToArchive);
      for (const file of selected) {
        const destination = join(bucketDir, file.name);
        await rename(file.path, destination);
        await chmod(destination, SECURE_FILE_MODE);
        archivedCount += 1;
        remainingToArchive -= 1;
      }
      const remainingFiles = await failedBatchEventFiles(candidate.batchDir);
      if (remainingFiles.length === 0) {
        await rm(candidate.batchDir, { recursive: true, force: true });
      }
    }

    if (archivedCount > 0) {
      await writeSecureJsonFile(cwd, join(bucketDir, "resolution.json"), {
        reason: sanitizedReason,
        note: safeResolutionNote(note),
        resolved_at: new Date().toISOString(),
        archived_count: archivedCount,
      });
    }

    const state = await loadStateFromPath(dirs.state);
    await saveState(cwd, {
      ...state,
      queue_bytes: await pendingQueueBytes(cwd),
    });

    const refreshed = await failedRetryCandidates(dirs, sanitizedReason);
    return summarizeArchiveCandidates({
      reason: sanitizedReason,
      candidates,
      batchSize,
      dryRun: false,
      archivedCount,
      remainingCandidates: refreshed.candidates,
      resolutionBucket: archivedCount > 0 ? bucketName : null,
    });
  });
}
```

- [ ] **Step 4: Run archive tests and verify GREEN**

Run:

```bash
node --test test/telemetry-queue.test.mjs --test-name-pattern "archiveFailedTelemetryEvents"
```

Expected: PASS.

## Task 3: CLI Command Group

**Files:**
- Modify: `test/cli.test.mjs`
- Modify: `src/cli.mjs`

- [ ] **Step 1: Write failing CLI tests**

Add tests after the existing retry-failed CLI tests:

```js
test("telemetry failed inspect prints aggregate-only JSON", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-cli-failed-inspect-"));
  try {
    await queueFailedCliEvents(cwd, { start: 50, count: 2, reason: "http_403" });

    const { stdout } = await execBin(["telemetry", "failed", "inspect", "--json"], { cwd });
    const parsed = JSON.parse(stdout);
    const serialized = JSON.stringify(parsed);

    assert.equal(parsed.ok, true);
    assert.equal(parsed.scope, "local");
    assert.equal(parsed.failed_event_count, 2);
    assert.equal(parsed.reason_counts[0].reason, "http_403");
    assert.equal(parsed.events.length, 2);
    assert.doesNotMatch(serialized, /evt_cli_retry_50/);
    assert.doesNotMatch(serialized, /batch_2026/);
    assert.doesNotMatch(serialized, /raw cli prompt/);
    assert.doesNotMatch(serialized, /raw cli response/);
    assert.doesNotMatch(serialized, /cli-secret/);
    assert.doesNotMatch(serialized, /queue\/failed/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("telemetry failed inspect filters and limits descriptors", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-cli-failed-inspect-filter-"));
  try {
    await queueFailedCliEvents(cwd, { start: 60, count: 2, reason: "http_403" });
    await queueFailedCliEvents(cwd, { start: 70, count: 1, reason: "unauthorized" });

    const { stdout } = await execBin([
      "telemetry",
      "failed",
      "inspect",
      "--reason",
      "http_403",
      "--limit",
      "1",
      "--json",
    ], { cwd });
    const parsed = JSON.parse(stdout);

    assert.equal(parsed.reason_filter, "http_403");
    assert.equal(parsed.failed_event_count, 2);
    assert.equal(parsed.events.length, 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("telemetry failed archive dry-run and write are local-only", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-cli-failed-archive-"));
  try {
    await saveTelemetryConfig({
      cwd,
      scope: "local",
      endpoint: "http://127.0.0.1:8787/ingest",
      tokenEnv: TELEMETRY_TOKEN_ENV,
      deploymentId: "dep_cli",
    });
    await queueFailedCliEvents(cwd, { start: 80, count: 2, reason: "http_403" });

    const dry = await execBin([
      "telemetry",
      "failed",
      "archive",
      "--reason",
      "http_403",
      "--dry-run",
      "--batch-size",
      "1",
    ], {
      cwd,
      env: { ...process.env, [TELEMETRY_TOKEN_ENV]: "" },
    });
    const dryParsed = JSON.parse(dry.stdout);
    assert.equal(dryParsed.dry_run, true);
    assert.equal(dryParsed.would_archive_count, 1);

    const written = await execBin([
      "telemetry",
      "failed",
      "archive",
      "--reason",
      "http_403",
      "--write",
      "--batch-size",
      "1",
      "--note",
      "../local cleanup",
    ], {
      cwd,
      env: { ...process.env, [TELEMETRY_TOKEN_ENV]: "" },
    });
    const parsed = JSON.parse(written.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.archived_count, 1);
    assert.match(parsed.resolution_bucket, /^resolved_/);

    const snapshot = await loadTelemetryQueueSnapshot({ cwd });
    assert.equal(snapshot.failed.count, 1);
    assert.equal(snapshot.pending.count, 0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("telemetry failed archive rejects invalid arguments", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-cli-failed-archive-args-"));
  try {
    await assert.rejects(
      () => execBin(["telemetry", "failed", "archive"], { cwd }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /--reason is required/);
        return true;
      },
    );
    await assert.rejects(
      () => execBin(["telemetry", "failed", "archive", "--reason", "http_403", "--dry-run", "--write"], { cwd }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /--dry-run and --write cannot be used together/);
        return true;
      },
    );
    await assert.rejects(
      () => execBin(["telemetry", "failed", "inspect", "--limit", "0"], { cwd }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /--limit requires a positive integer/);
        return true;
      },
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run CLI tests and verify RED**

Run:

```bash
node --test test/cli.test.mjs --test-name-pattern "telemetry failed"
```

Expected: FAIL because `telemetry failed` is not routed.

- [ ] **Step 3: Implement CLI parser and routing**

In `src/cli.mjs`, update the telemetry queue import:

```js
  archiveFailedTelemetryEvents,
  inspectFailedTelemetryEvents,
```

Add usage lines after retry-failed:

```js
    "  gemini-agent telemetry failed inspect [--global] [--reason <reason>] [--limit <n>] [--json]",
    "  gemini-agent telemetry failed archive [--global] --reason <reason> [--dry-run|--write] [--batch-size <n>] [--note <text>]",
```

Add parsers near `parseTelemetryRetryFailedOptions`:

```js
function parseTelemetryFailedInspectOptions(args) {
  const options = { global: false, json: false, limit: 20 };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--global") {
      options.global = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--reason") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--reason requires a reason.");
      options.reason = value;
      index += 1;
    } else if (arg === "--limit") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--limit requires a positive integer.");
      options.limit = positiveIntegerOption(value, "--limit");
      index += 1;
    } else {
      throw new Error(`Unknown telemetry failed inspect argument: ${arg}`);
    }
  }
  return options;
}

function parseTelemetryFailedArchiveOptions(args) {
  const options = { global: false, dryRun: true, batchSize: 1, note: null };
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
    } else if (arg === "--note") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--note requires text.");
      options.note = value;
      index += 1;
    } else {
      throw new Error(`Unknown telemetry failed archive argument: ${arg}`);
    }
  }
  if (sawDryRun && sawWrite) throw new Error("--dry-run and --write cannot be used together.");
  if (!options.reason) throw new Error("--reason is required.");
  return options;
}
```

Add runner:

```js
async function runTelemetryFailed(args = []) {
  const subcommand = args[0];
  const subArgs = args.slice(1);
  if (subcommand === "inspect") {
    const options = parseTelemetryFailedInspectOptions(subArgs);
    const context = await requireTelemetryDryRunContext(options);
    const result = await inspectFailedTelemetryEvents({
      cwd: context.storageCwd,
      reason: options.reason,
      limit: options.limit,
    });
    output.write(`${JSON.stringify({
      scope: context.scope,
      storage_cwd: context.storageCwd,
      ...result,
    }, null, 2)}\n`);
    return;
  }

  if (subcommand === "archive") {
    const options = parseTelemetryFailedArchiveOptions(subArgs);
    const context = await requireTelemetryDryRunContext(options);
    const result = await archiveFailedTelemetryEvents({
      cwd: context.storageCwd,
      reason: options.reason,
      batchSize: options.batchSize,
      dryRun: options.dryRun,
      note: options.note,
    });
    output.write(`${JSON.stringify({
      scope: context.scope,
      storage_cwd: context.storageCwd,
      ...result,
    }, null, 2)}\n`);
    return;
  }

  throw new Error("telemetry failed requires inspect or archive.");
}
```

Route it inside `runTelemetry`:

```js
  if (subcommand === "failed") {
    await runTelemetryFailed(subArgs);
    return;
  }
```

- [ ] **Step 4: Run CLI tests and verify GREEN**

Run:

```bash
node --test test/cli.test.mjs --test-name-pattern "telemetry failed"
```

Expected: PASS.

## Task 4: Integration Verification And Documentation Check

**Files:**
- Modify only if verification reveals a narrow issue.

- [ ] **Step 1: Run targeted telemetry tests**

Run:

```bash
node --test test/telemetry-queue.test.mjs test/cli.test.mjs
```

Expected: PASS.

- [ ] **Step 2: Run full suite**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 3: Run whitespace check**

Run:

```bash
git diff --check
```

Expected: no output and exit 0.

- [ ] **Step 4: Use gemini-agent diff-review**

Run:

```bash
git diff HEAD~1...HEAD | ./bin/gemini-agent diff-review --model gemini-3.5-flash --stdin
```

If the implementation spans multiple commits, review the full branch diff against the branch base:

```bash
git diff main...HEAD | ./bin/gemini-agent diff-review --model gemini-3.5-flash --stdin
```

Expected: `verdict: pass` or only non-blocking suggestions.

- [ ] **Step 5: Commit implementation**

Run:

```bash
git add src/telemetry-queue.mjs src/cli.mjs test/telemetry-queue.test.mjs test/cli.test.mjs
git commit -m "feat: add telemetry failed governance"
```

Expected: commit succeeds.

## Self-Review

- Spec coverage: inspect, archive, privacy boundary, token-independent archive, resolved-failed directory, doctor semantics, TDD tests, and verification are all mapped to tasks.
- Placeholder scan: no TBD/TODO/fill-in instructions remain.
- Type consistency: helper names are `inspectFailedTelemetryEvents` and `archiveFailedTelemetryEvents` throughout.
- Scope: this plan does not implement broad raw reveal/export/delete; it closes failed telemetry lifecycle first.
