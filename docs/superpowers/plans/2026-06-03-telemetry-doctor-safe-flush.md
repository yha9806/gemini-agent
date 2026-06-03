# Telemetry Doctor And Safe Flush Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Phase 1 from the roadmap: `telemetry doctor`, flush dry-run and bounded flush controls, and local quarantine support for bad telemetry events.

**Architecture:** Keep queue mutations in `src/telemetry-queue.mjs`, sender-specific preview and size enforcement in `src/telemetry-sender.mjs`, and CLI parsing/routing in `src/cli.mjs`. Add a focused `src/telemetry-doctor.mjs` module so doctor checks are testable without spawning the CLI.

**Tech Stack:** Node.js ESM, `node:test`, local filesystem queue, Fetch API, existing telemetry schemas and config helpers.

---

## Scope Check

This plan implements only Phase 1 of [the roadmap spec](../specs/2026-06-03-telemetry-reliability-and-agent-roadmap-design.md). Backfill dedupe, raw governance, product analytics reports, and multimodal visual diff are separate phases and should not be mixed into this implementation.

## File Structure

- Modify `src/telemetry-queue.mjs`
  - Add `quarantine` queue directory.
  - Add queue snapshot/count helpers for doctor output.
  - Add `quarantineTelemetryEvent()` for moving a pending event into a local dead-letter directory with a reason file.
  - Add `peekTelemetryEvents()` for dry-run and max-byte planning without moving files.

- Modify `src/telemetry-sender.mjs`
  - Refactor raw batch construction so both preview and flush can build a candidate batch.
  - Add `previewTelemetryFlush()`.
  - Extend `flushTelemetryQueue()` with `dryRun`, `maxBytes`, and existing `batchSize`.

- Create `src/telemetry-doctor.mjs`
  - Load config and queue snapshot.
  - Check token env presence without throwing.
  - Validate endpoint shape.
  - Perform a best-effort non-raw health request derived from the ingest endpoint.
  - Return checks, recommendations, and small-flush safety.

- Modify `src/cli.mjs`
  - Add usage lines for `doctor`, flush options, and `quarantine`.
  - Add parsers for flush and quarantine options.
  - Route `telemetry doctor`, `telemetry flush --dry-run --batch-size --max-bytes`, and `telemetry quarantine`.

- Modify tests:
  - `test/telemetry-queue.test.mjs`
  - `test/telemetry-sender.test.mjs`
  - `test/cli.test.mjs`
  - Create `test/telemetry-doctor.test.mjs`

## Task 1: Queue Snapshot, Peek, And Quarantine Primitives

**Files:**
- Modify: `src/telemetry-queue.mjs`
- Test: `test/telemetry-queue.test.mjs`

- [ ] **Step 1: Write failing queue tests**

`test/telemetry-queue.test.mjs` already imports `readFile` from `node:fs/promises`, so only extend the telemetry queue import.

Extend the existing import from `../src/telemetry-queue.mjs` with:

```js
  loadTelemetryQueueSnapshot,
  peekTelemetryEvents,
  quarantineTelemetryEvent,
```

Add these tests near the existing queue movement tests:

```js
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
```

- [ ] **Step 2: Run queue tests and verify they fail**

Run:

```bash
node --test test/telemetry-queue.test.mjs
```

Expected: FAIL because `loadTelemetryQueueSnapshot`, `peekTelemetryEvents`, and `quarantineTelemetryEvent` are not exported.

- [ ] **Step 3: Implement queue primitives**

In `src/telemetry-queue.mjs`, update `telemetryQueueDirs()` to include quarantine:

```js
    quarantine: join(queue, "quarantine"),
```

Update `ensureQueueDirs()` so it creates the quarantine directory:

```js
  for (const dir of [
    dirs.root,
    dirs.queue,
    dirs.pending,
    dirs.inflight,
    dirs.sent,
    dirs.failed,
    dirs.quarantine,
    dirs.tmp,
  ]) {
    await secureMkdir(dir);
  }
```

Add these helpers after `regularFiles()`. These helpers stat files and count paths; they do not parse event JSON, so doctor snapshots stay lightweight even when the queue is large.

```js
async function summarizeDirectory(dir, filter = () => true) {
  let count = 0;
  let bytes = 0;

  async function walk(path) {
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }

    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isFile()) {
        const itemStat = await stat(child);
        bytes += itemStat.size;
        if (filter({ name: entry.name, path: child })) count += 1;
      } else if (entry.isDirectory()) {
        await walk(child);
      }
    }
  }

  await walk(dir);
  return { count, bytes };
}

async function directorySummary(dir) {
  return summarizeDirectory(dir);
}

async function quarantineSummary(dir) {
  return summarizeDirectory(dir, (file) => file.name === "event.json");
}

function safeQuarantineEventDir(eventId) {
  if (typeof eventId !== "string" || !/^[A-Za-z0-9_.:-]+$/.test(eventId)) {
    throw new Error("Telemetry event id is invalid.");
  }
  return eventId.replaceAll(":", "_");
}
```

Add these exports before `claimTelemetryBatch()`:

```js
export async function loadTelemetryQueueSnapshot({ cwd = process.cwd() } = {}) {
  const dirs = await ensureQueueDirs(cwd);
  const [pending, inflight, sent, failed, quarantine] = await Promise.all([
    directorySummary(dirs.pending),
    directorySummary(dirs.inflight),
    directorySummary(dirs.sent),
    directorySummary(dirs.failed),
    quarantineSummary(dirs.quarantine),
  ]);
  return { pending, inflight, sent, failed, quarantine };
}

export async function peekTelemetryEvents({
  cwd = process.cwd(),
  batchSize,
} = {}) {
  assertPositiveInteger(batchSize, "batchSize");
  const dirs = await ensureQueueDirs(cwd);
  const files = (await regularFiles(dirs.pending)).slice(0, batchSize);
  const events = [];
  for (const file of files) {
    events.push(normalizeTelemetryEvent(await readJsonFile(file.path, "Telemetry queue event")));
  }
  return { files, events };
}

export async function quarantineTelemetryEvent({
  cwd = process.cwd(),
  eventId,
  reason,
  now = new Date(),
} = {}) {
  if (typeof eventId !== "string" || !eventId.trim()) {
    throw new Error("Telemetry event id is required.");
  }
  if (typeof reason !== "string" || !reason.trim()) {
    throw new Error("Telemetry quarantine reason is required.");
  }

  return withTelemetryQueueLock({ cwd }, async () => {
    const dirs = await ensureQueueDirs(cwd);
    const files = await regularFiles(dirs.pending);
    for (const file of files) {
      const event = normalizeTelemetryEvent(await readJsonFile(file.path, "Telemetry queue event"));
      if (event.event_id !== eventId) continue;

      const eventDir = join(dirs.quarantine, safeQuarantineEventDir(eventId));
      await secureMkdir(eventDir);
      const eventPath = join(eventDir, "event.json");
      const reasonPath = join(eventDir, "reason.json");
      await rename(file.path, eventPath);
      await chmod(eventPath, SECURE_FILE_MODE);
      await writeSecureJsonFile(cwd, reasonPath, {
        event_id: eventId,
        reason,
        quarantined_at: now.toISOString(),
      });

      const state = await loadStateFromPath(dirs.state);
      await saveState(cwd, {
        ...state,
        queue_bytes: await pendingQueueBytes(cwd),
        last_failure_reason: `quarantined:${reason}`,
      });

      return {
        quarantined: true,
        event_id: eventId,
        event_path: eventPath,
        reason_path: reasonPath,
      };
    }

    return { quarantined: false, event_id: eventId };
  });
}
```

- [ ] **Step 4: Run queue tests and verify they pass**

Run:

```bash
node --test test/telemetry-queue.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit queue primitives**

Run:

```bash
git add src/telemetry-queue.mjs test/telemetry-queue.test.mjs
git commit -m "feat: add telemetry quarantine queue primitives"
```

## Task 2: Flush Dry-Run, Batch Size, And Max Bytes

**Files:**
- Modify: `src/telemetry-sender.mjs`
- Test: `test/telemetry-sender.test.mjs`

- [ ] **Step 1: Write failing sender tests**

Extend the telemetry sender import in `test/telemetry-sender.test.mjs`:

```js
  previewTelemetryFlush,
```

Add these tests after the empty queue flush test:

```js
test("previewTelemetryFlush returns planned batch without moving files", async () => {
  const cwd = await temporaryWorkspace();
  await appendTelemetryEvent({ cwd, event: telemetryEvent(1) });
  await appendTelemetryEvent({ cwd, event: telemetryEvent(2) });

  const preview = await previewTelemetryFlush({
    cwd,
    batchSize: 1,
    now: NOW,
  });

  assert.equal(preview.ok, true);
  assert.equal(preview.dry_run, true);
  assert.equal(preview.would_send_count, 1);
  assert.deepEqual(preview.event_ids, ["evt_000001"]);
  assert.equal(Number.isInteger(preview.batch_bytes), true);
  assert.equal(preview.exceeds_max_bytes, false);
  assert.deepEqual((await readPendingEvents(cwd)).map((event) => event.event_id), [
    "evt_000001",
    "evt_000002",
  ]);
});

test("flushTelemetryQueue dry run does not send or move files", async () => {
  const cwd = await temporaryWorkspace();
  await appendTelemetryEvent({ cwd, event: telemetryEvent(1) });
  let called = false;

  const result = await flushTelemetryQueue({
    cwd,
    endpoint: ENDPOINT,
    token: TOKEN,
    dryRun: true,
    fetchImpl: async () => {
      called = true;
      throw new Error("fetch should not be called");
    },
    now: NOW,
  });

  assert.equal(result.dry_run, true);
  assert.equal(result.would_send_count, 1);
  assert.equal(called, false);
  assert.deepEqual((await readPendingEvents(cwd)).map((event) => event.event_id), ["evt_000001"]);
});

test("flushTelemetryQueue rejects oversized maxBytes before sending", async () => {
  const cwd = await temporaryWorkspace();
  await appendTelemetryEvent({ cwd, event: telemetryEvent(1) });
  let called = false;

  await assert.rejects(
    () => flushTelemetryQueue({
      cwd,
      endpoint: ENDPOINT,
      token: TOKEN,
      maxBytes: 10,
      fetchImpl: async () => {
        called = true;
        throw new Error("fetch should not be called");
      },
      now: NOW,
    }),
    /Telemetry batch exceeds maxBytes before send\./,
  );

  assert.equal(called, false);
  assert.deepEqual((await readPendingEvents(cwd)).map((event) => event.event_id), ["evt_000001"]);
});
```

- [ ] **Step 2: Run sender tests and verify they fail**

Run:

```bash
node --test test/telemetry-sender.test.mjs
```

Expected: FAIL because `previewTelemetryFlush`, `dryRun`, and `maxBytes` behavior do not exist.

- [ ] **Step 3: Implement sender preview and max-byte guard**

In `src/telemetry-sender.mjs`, extend the queue import:

```js
  peekTelemetryEvents,
```

Replace `rawBatchFromClaimed()` with these two helpers:

```js
function rawBatchFromEvents({ events, batchId, now }) {
  const rawEvents = events.map((event) => rawEventFromLegacy(event));
  const normalizedEvents = normalizeRawTelemetryBatch({
    schema_version: RAW_TELEMETRY_SCHEMA_VERSION,
    batch_id: batchId,
    deployment_id: events[0].deployment_id,
    agent_version: packageJson.version,
    generated_at: now.toISOString(),
    checksum: "sha256:pending",
    events: rawEvents,
  }).events;
  return normalizeRawTelemetryBatch({
    schema_version: RAW_TELEMETRY_SCHEMA_VERSION,
    batch_id: batchId,
    deployment_id: events[0].deployment_id,
    agent_version: packageJson.version,
    generated_at: now.toISOString(),
    checksum: checksumEvents(normalizedEvents),
    events: normalizedEvents,
  });
}

function rawBatchFromClaimed({ claimed, now }) {
  return rawBatchFromEvents({
    events: claimed.events,
    batchId: claimed.batchId,
    now,
  });
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function previewBatchId(now) {
  const day = now.toISOString().slice(0, 10).replaceAll("-", "");
  return `batch_${day}_${now.getTime()}_00000000-0000-4000-8000-000000000000`;
}
```

Add this export before `flushTelemetryQueue()`:

```js
export async function previewTelemetryFlush({
  cwd = process.cwd(),
  now = new Date(),
  batchSize = 100,
  maxBytes,
} = {}) {
  assertPositiveInteger(batchSize, "batchSize");
  if (maxBytes !== undefined) assertPositiveInteger(maxBytes, "maxBytes");

  const peeked = await peekTelemetryEvents({ cwd, batchSize });
  if (peeked.events.length === 0) {
    return { ok: true, dry_run: true, would_send_count: 0 };
  }

  const batch = rawBatchFromEvents({
    events: peeked.events,
    batchId: previewBatchId(now),
    now,
  });
  const batchBytes = byteLength(batch);
  return {
    ok: true,
    dry_run: true,
    would_send_count: batch.events.length,
    event_ids: batch.events.map((event) => event.event_id),
    batch_bytes: batchBytes,
    exceeds_max_bytes: maxBytes !== undefined && batchBytes > maxBytes,
  };
}
```

Update the `flushTelemetryQueue()` signature:

```js
  batchSize = 100,
  dryRun = false,
  maxBytes,
```

Add this validation after `assertTelemetryToken(token);`:

```js
  if (dryRun) {
    return previewTelemetryFlush({ cwd, now, batchSize, maxBytes });
  }
  if (maxBytes !== undefined) {
    assertPositiveInteger(maxBytes, "maxBytes");
    const preview = await previewTelemetryFlush({ cwd, now, batchSize, maxBytes });
    if (preview.would_send_count > 0 && preview.exceeds_max_bytes) {
      throw new Error("Telemetry batch exceeds maxBytes before send.");
    }
  }
```

- [ ] **Step 4: Run sender tests and verify they pass**

Run:

```bash
node --test test/telemetry-sender.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit sender controls**

Run:

```bash
git add src/telemetry-sender.mjs test/telemetry-sender.test.mjs
git commit -m "feat: add safe telemetry flush preview"
```

## Task 3: Telemetry Doctor Module

**Files:**
- Create: `src/telemetry-doctor.mjs`
- Test: `test/telemetry-doctor.test.mjs`

- [ ] **Step 1: Write failing doctor tests**

Create `test/telemetry-doctor.test.mjs`:

```js
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { saveTelemetryConfig } from "../src/telemetry-config.mjs";
import { appendTelemetryEvent } from "../src/telemetry-queue.mjs";
import { runTelemetryDoctor } from "../src/telemetry-doctor.mjs";

const TOKEN_ENV = "GEMINI_AGENT_TELEMETRY_TOKEN";

async function temporaryWorkspace() {
  return mkdtemp(join(tmpdir(), "gemini-agent-telemetry-doctor-"));
}

function telemetryEvent(index) {
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
    created_at: "2026-06-03T09:00:00.000Z",
    payload: { prompt_truncated: false, response_truncated: false, multimodal: [] },
  };
}

test("runTelemetryDoctor reports disabled config without throwing", async () => {
  const cwd = await temporaryWorkspace();

  const result = await runTelemetryDoctor({
    cwd,
    env: {},
    fetchImpl: async () => {
      throw new Error("fetch should not be called");
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.config.enabled, false);
  assert.equal(result.checks.config_enabled.ok, false);
  assert.equal(result.checks.token_env_present.ok, false);
  assert.equal(result.small_flush_safe, false);
});

test("runTelemetryDoctor reports token, endpoint health, queue, and recommendation", async () => {
  const cwd = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });
  await appendTelemetryEvent({ cwd, event: telemetryEvent(1) });

  let requestedUrl;
  const result = await runTelemetryDoctor({
    cwd,
    env: { [TOKEN_ENV]: "telemetry-token" },
    fetchImpl: async (url) => {
      requestedUrl = `${url}`;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  });

  assert.equal(requestedUrl, "http://127.0.0.1:8787/health");
  assert.equal(result.ok, true);
  assert.equal(result.config.enabled, true);
  assert.equal(result.checks.token_env_present.ok, true);
  assert.equal(result.checks.endpoint_valid.ok, true);
  assert.equal(result.endpoint_check.ok, true);
  assert.equal(result.queue.pending.count, 1);
  assert.equal(result.small_flush_safe, true);
  assert.equal(result.recommended_action, "Run telemetry flush --dry-run, then telemetry flush --batch-size 1.");
});

test("runTelemetryDoctor treats health endpoint failure as diagnostic only", async () => {
  const cwd = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });
  await appendTelemetryEvent({ cwd, event: telemetryEvent(2) });

  const result = await runTelemetryDoctor({
    cwd,
    env: { [TOKEN_ENV]: "telemetry-token" },
    fetchImpl: async () => new Response("method not allowed", { status: 405 }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.endpoint_check.ok, false);
  assert.equal(result.endpoint_check.status, 405);
  assert.equal(result.small_flush_safe, true);
});
```

- [ ] **Step 2: Run doctor tests and verify they fail**

Run:

```bash
node --test test/telemetry-doctor.test.mjs
```

Expected: FAIL because `src/telemetry-doctor.mjs` does not exist.

- [ ] **Step 3: Implement doctor module**

Create `src/telemetry-doctor.mjs`:

```js
import { validateTelemetryEndpoint } from "./telemetry-config.mjs";
import { loadTelemetryConfigContext } from "./telemetry-config.mjs";
import { loadTelemetryQueueSnapshot, loadTelemetryState } from "./telemetry-queue.mjs";

function check(ok, message) {
  return { ok, message };
}

function healthUrlFromEndpoint(endpoint) {
  const url = validateTelemetryEndpoint(endpoint);
  if (/\/ingest\/?$/.test(url.pathname)) {
    url.pathname = url.pathname.replace(/\/ingest\/?$/, "/health");
  } else if (url.pathname.endsWith("/")) {
    url.pathname = `${url.pathname}health`;
  } else {
    url.pathname = `${url.pathname}/health`;
  }
  return url;
}

async function endpointHealthCheck({ endpoint, fetchImpl, timeoutMs }) {
  const url = healthUrlFromEndpoint(endpoint);
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(`Telemetry doctor endpoint check timed out after ${timeoutMs}ms.`));
  }, timeoutMs);
  try {
    const response = await fetchImpl(url.href, {
      method: "GET",
      signal: controller.signal,
    });
    return {
      ok: response.ok,
      url: url.href,
      status: response.status,
    };
  } catch (error) {
    return {
      ok: false,
      url: url.href,
      error: error instanceof Error ? error.message : `${error}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function recommendation({ enabled, tokenPresent, endpointValid, pendingCount, quarantineCount }) {
  if (!enabled) return "Enable telemetry before flushing.";
  if (!tokenPresent) return "Set the configured telemetry token environment variable.";
  if (!endpointValid) return "Fix the telemetry endpoint URL.";
  if (quarantineCount > 0) return "Review quarantined telemetry events before broad flushing.";
  if (pendingCount > 0) return "Run telemetry flush --dry-run, then telemetry flush --batch-size 1.";
  return "No pending telemetry events to flush.";
}

export async function runTelemetryDoctor({
  cwd = process.cwd(),
  scope = "auto",
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = 3000,
} = {}) {
  const context = await loadTelemetryConfigContext({ cwd, scope });
  const config = context.config ?? { enabled: false };
  const queue = await loadTelemetryQueueSnapshot({ cwd: context.storageCwd });
  const state = await loadTelemetryState({ cwd: context.storageCwd });
  const enabled = config.enabled === true;
  const tokenName = config.token_env;
  const tokenPresent = typeof tokenName === "string"
    && typeof env[tokenName] === "string"
    && env[tokenName].trim().length > 0;

  let endpointValid = false;
  let endpointError = null;
  try {
    if (config.endpoint) {
      validateTelemetryEndpoint(config.endpoint);
      endpointValid = true;
    }
  } catch (error) {
    endpointError = error instanceof Error ? error.message : `${error}`;
  }

  const endpointCheck = enabled && endpointValid
    ? await endpointHealthCheck({ endpoint: config.endpoint, fetchImpl, timeoutMs })
    : { ok: false, skipped: true, reason: "endpoint_not_configured" };

  const pendingCount = queue.pending.count;
  const quarantineCount = queue.quarantine.count;
  const smallFlushSafe = enabled && tokenPresent && endpointValid && pendingCount > 0;

  return {
    ok: enabled && endpointValid && tokenPresent,
    scope: context.scope,
    storage_cwd: context.storageCwd,
    config,
    queue,
    state,
    checks: {
      config_enabled: check(enabled, enabled ? "Telemetry is enabled." : "Telemetry is not enabled."),
      token_env_present: check(tokenPresent, tokenPresent ? `${tokenName} is set.` : "Telemetry token env is missing."),
      endpoint_valid: check(endpointValid, endpointValid ? "Telemetry endpoint is valid." : endpointError ?? "Telemetry endpoint is missing."),
    },
    endpoint_check: endpointCheck,
    small_flush_safe: smallFlushSafe,
    recommended_action: recommendation({
      enabled,
      tokenPresent,
      endpointValid,
      pendingCount,
      quarantineCount,
    }),
  };
}
```

- [ ] **Step 4: Run doctor tests and verify they pass**

Run:

```bash
node --test test/telemetry-doctor.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit doctor module**

Run:

```bash
git add src/telemetry-doctor.mjs test/telemetry-doctor.test.mjs
git commit -m "feat: add telemetry doctor checks"
```

## Task 4: CLI Integration For Doctor, Safe Flush, And Quarantine

**Files:**
- Modify: `src/cli.mjs`
- Test: `test/cli.test.mjs`

- [ ] **Step 1: Write failing CLI tests**

`test/cli.test.mjs` already imports `telemetryQueueDirs`, so no new top-level import is needed for these tests.

Add these CLI tests near existing telemetry CLI tests:

```js
test("telemetry doctor prints actionable global health without raw upload", async () => {
  const home = await mkdtemp(join(tmpdir(), "gemini-agent-cli-home-"));
  const project = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));
  let healthRequested = false;
  const receiver = await withTelemetryReceiver(async ({ request, response }) => {
    if (request.method === "GET" && request.url === "/health") {
      healthRequested = true;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    response.writeHead(500);
    response.end("unexpected");
  });

  try {
    await saveTelemetryConfig({
      cwd: project,
      home,
      scope: "global",
      endpoint: receiver.endpoint,
      tokenEnv: TELEMETRY_TOKEN_ENV,
      deploymentId: "gemini-agent-main",
    });
    await appendTelemetryEvent({ cwd: home, event: telemetryEvent(1) });

    const { stdout } = await execFileAsync(bin, ["telemetry", "doctor", "--global", "--json"], {
      cwd: project,
      env: { ...process.env, HOME: home, [TELEMETRY_TOKEN_ENV]: TELEMETRY_TOKEN },
    });

    const parsed = JSON.parse(stdout);
    assert.equal(parsed.scope, "global");
    assert.equal(parsed.storage_cwd, home);
    assert.equal(parsed.checks.token_env_present.ok, true);
    assert.equal(parsed.queue.pending.count, 1);
    assert.equal(parsed.small_flush_safe, true);
    assert.equal(healthRequested, true);
  } finally {
    await receiver.close();
  }
});

test("telemetry flush dry-run and batch-size do not send or move events", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));
  await saveTelemetryConfig({
    cwd: dir,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TELEMETRY_TOKEN_ENV,
  });
  await appendTelemetryEvent({ cwd: dir, event: telemetryEvent(1) });
  await appendTelemetryEvent({ cwd: dir, event: telemetryEvent(2) });

  const { stdout } = await execFileAsync(bin, [
    "telemetry",
    "flush",
    "--dry-run",
    "--batch-size",
    "1",
  ], {
    cwd: dir,
    env: { PATH: process.env.PATH, [TELEMETRY_TOKEN_ENV]: TELEMETRY_TOKEN },
  });

  const parsed = JSON.parse(stdout);
  assert.equal(parsed.dry_run, true);
  assert.equal(parsed.would_send_count, 1);
  assert.deepEqual(parsed.event_ids, ["evt_cli_1"]);
  const pending = await readdir(telemetryQueueDirs(dir).pending);
  assert.equal(pending.length, 2);
});

test("telemetry quarantine moves a pending event out of normal flush path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));
  await saveTelemetryConfig({
    cwd: dir,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TELEMETRY_TOKEN_ENV,
  });
  await appendTelemetryEvent({ cwd: dir, event: telemetryEvent(1) });

  const { stdout } = await execFileAsync(bin, [
    "telemetry",
    "quarantine",
    "--event-id",
    "evt_cli_1",
    "--reason",
    "bad payload",
  ], {
    cwd: dir,
    env: { PATH: process.env.PATH },
  });

  const parsed = JSON.parse(stdout);
  assert.equal(parsed.quarantined, true);
  assert.equal(parsed.event_id, "evt_cli_1");
  assert.equal((await readdir(telemetryQueueDirs(dir).pending)).length, 0);
  assert.equal((await readdir(telemetryQueueDirs(dir).quarantine)).length, 1);
});
```

- [ ] **Step 2: Run CLI tests and verify they fail**

Run:

```bash
node --test test/cli.test.mjs
```

Expected: FAIL with unknown telemetry commands/options.

- [ ] **Step 3: Implement CLI parsing and routing**

In `src/cli.mjs`, add imports:

```js
import { runTelemetryDoctor } from "./telemetry-doctor.mjs";
```

Extend the queue import:

```js
  quarantineTelemetryEvent,
```

Update usage lines:

```js
    "  gemini-agent telemetry doctor [--global] [--json]",
    "  gemini-agent telemetry flush [--global] [--dry-run] [--batch-size <n>] [--max-bytes <n>]",
    "  gemini-agent telemetry quarantine [--global] --event-id <id> --reason <reason>",
```

Add parsers near the telemetry option parsers:

```js
function parseTelemetryFlushOptions(args) {
  const options = { global: false, dryRun: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--global") {
      options.global = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--batch-size") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--batch-size requires a positive integer.");
      options.batchSize = positiveIntegerOption(value, "--batch-size");
      index += 1;
    } else if (arg === "--max-bytes") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--max-bytes requires a positive integer.");
      options.maxBytes = positiveIntegerOption(value, "--max-bytes");
      index += 1;
    } else {
      throw new Error(`Unknown telemetry flush argument: ${arg}`);
    }
  }
  return options;
}

function parseTelemetryDoctorOptions(args) {
  const options = { global: false, json: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--global") {
      options.global = true;
    } else if (arg === "--json") {
      options.json = true;
    } else {
      throw new Error(`Unknown telemetry doctor argument: ${arg}`);
    }
  }
  return options;
}

function parseTelemetryQuarantineOptions(args) {
  const options = { global: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--global") {
      options.global = true;
    } else if (arg === "--event-id") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--event-id requires an id.");
      options.eventId = value;
      index += 1;
    } else if (arg === "--reason") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--reason requires a value.");
      options.reason = value;
      index += 1;
    } else {
      throw new Error(`Unknown telemetry quarantine argument: ${arg}`);
    }
  }
  if (!options.eventId) throw new Error("--event-id is required.");
  if (!options.reason) throw new Error("--reason is required.");
  return options;
}
```

Replace `runTelemetryFlush()` with:

```js
async function runTelemetryFlush(args = []) {
  const options = parseTelemetryFlushOptions(args);
  const context = await loadTelemetryConfigContext({
    cwd: process.cwd(),
    scope: telemetryScope(options),
  });
  const config = context.config;
  if (!config?.enabled) throw new Error("Telemetry is not enabled.");
  if (config.level !== "raw") throw new Error("Only raw telemetry is supported.");
  const token = resolveTelemetryToken({ tokenEnv: config.token_env, env: process.env });
  const result = await flushTelemetryQueue({
    cwd: context.storageCwd,
    endpoint: config.endpoint,
    token,
    dryRun: options.dryRun,
    batchSize: options.batchSize,
    maxBytes: options.maxBytes,
  });
  output.write(`${JSON.stringify(result, null, 2)}\n`);
}
```

Add a helper:

```js
async function runTelemetryQuarantine(args = []) {
  const options = parseTelemetryQuarantineOptions(args);
  const context = await loadTelemetryConfigContext({
    cwd: process.cwd(),
    scope: telemetryScope(options),
  });
  const result = await quarantineTelemetryEvent({
    cwd: context.storageCwd,
    eventId: options.eventId,
    reason: options.reason,
  });
  output.write(`${JSON.stringify(result, null, 2)}\n`);
}
```

In `runTelemetry()`, add before status or before flush:

```js
  if (subcommand === "doctor") {
    const options = parseTelemetryDoctorOptions(subArgs);
    const result = await runTelemetryDoctor({
      cwd: process.cwd(),
      scope: telemetryScope(options),
      env: process.env,
    });
    output.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
```

Add the quarantine route:

```js
  if (subcommand === "quarantine") {
    await runTelemetryQuarantine(subArgs);
    return;
  }
```

- [ ] **Step 4: Run CLI tests and verify they pass**

Run:

```bash
node --test test/cli.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit CLI integration**

Run:

```bash
git add src/cli.mjs test/cli.test.mjs
git commit -m "feat: expose telemetry doctor and safe flush cli"
```

## Task 5: Final Verification And Live Local Safety Check

**Files:**
- Modify only if earlier tests reveal an implementation gap.

- [ ] **Step 1: Run targeted tests**

Run:

```bash
node --test test/telemetry-queue.test.mjs test/telemetry-sender.test.mjs test/telemetry-doctor.test.mjs test/cli.test.mjs
```

Expected: PASS.

- [ ] **Step 2: Run full test suite**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 3: Run global doctor without flushing**

Run:

```bash
./bin/gemini-agent telemetry doctor --global
```

Expected: JSON output with `scope`, `storage_cwd`, `checks`, `queue`, `state`, `endpoint_check`, `small_flush_safe`, and `recommended_action`. This command must not upload raw prompt/response data.

- [ ] **Step 4: Run global dry-run without flushing**

Run:

```bash
./bin/gemini-agent telemetry flush --global --dry-run --batch-size 1
```

Expected: JSON output with `dry_run: true`, `would_send_count` no greater than `1`, and unchanged pending queue count.

- [ ] **Step 5: Run Gemini diff review**

Run:

```bash
git diff | ./bin/gemini-agent diff-review --stdin
```

Expected: Gemini review returns `verdict` of `pass` or actionable `caution` items that are resolved before finishing.

- [ ] **Step 6: Commit any final fixes**

If Step 5 required fixes, commit them:

```bash
git add src/telemetry-queue.mjs src/telemetry-sender.mjs src/telemetry-doctor.mjs src/cli.mjs test/telemetry-queue.test.mjs test/telemetry-sender.test.mjs test/telemetry-doctor.test.mjs test/cli.test.mjs
git commit -m "fix: harden telemetry doctor safe flush"
```

If no fixes were needed, do not create an empty commit.

## Final Handoff

After all tasks pass, report:

- The commands added.
- Whether global doctor ran.
- Whether global dry-run ran.
- Test results.
- Gemini diff-review verdict.
- Current pending count, without performing a real flush unless the user explicitly approves it.
