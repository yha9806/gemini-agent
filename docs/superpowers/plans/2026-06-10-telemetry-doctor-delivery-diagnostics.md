# Telemetry Doctor Delivery Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local-only `delivery` diagnostics object to `gemini-agent telemetry doctor` so operators can see pending, failed, non-retryable, and failed-reason delivery gaps without server admin access.

**Architecture:** Reuse existing telemetry queue storage. Add a safe failed-batch summary helper in `src/telemetry-queue.mjs`, then build a deterministic `delivery` object in `src/telemetry-doctor.mjs`. Keep raw prompts, responses, event ids, request payloads, media file names, and batch ids out of diagnostics.

**Tech Stack:** Node.js ESM, `node:test`, built-in filesystem APIs, existing telemetry queue/config modules.

---

## File Structure

- Modify: `test/telemetry-doctor.test.mjs`
  - Adds RED tests for delivery diagnostics, privacy boundary, and malformed failed reason handling.
- Modify: `src/telemetry-queue.mjs`
  - Adds `loadFailedTelemetryBatchSummaries()` and local helpers for safe failed-reason reading.
- Modify: `src/telemetry-doctor.mjs`
  - Adds delivery status, delivery recommendation, failed reason aggregation, and `delivery` in doctor JSON.
- No change: `src/cli.mjs`
  - Doctor already prints JSON, so new fields surface automatically.
- No change: server/API code
  - Server reconciliation is outside this slice.

---

### Task 1: RED Test For Delivery Totals And Privacy

**Files:**
- Modify: `test/telemetry-doctor.test.mjs`

- [ ] **Step 1: Write the failing test**

Add `claimTelemetryBatch` and `failTelemetryBatch` to the queue import:

```js
import {
  appendTelemetryEvent,
  claimTelemetryBatch,
  failTelemetryBatch,
} from "../src/telemetry-queue.mjs";
```

Append this test after `runTelemetryDoctor reports token, endpoint health, queue, and recommendation`:

```js
test("runTelemetryDoctor reports delivery diagnostics without raw content", async () => {
  const cwd = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });
  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(30, {
      event_id: "evt_private_failed",
      prompt: "private prompt text must not appear",
      response: "private response text must not appear",
    }),
  });
  await appendTelemetryEvent({ cwd, event: telemetryEvent(31) });

  const batch = await claimTelemetryBatch({
    cwd,
    batchSize: 1,
    now: new Date("2026-06-10T09:00:00.000Z"),
  });
  await failTelemetryBatch({
    cwd,
    batchId: batch.batchId,
    retryable: false,
    reason: "unauthorized",
  });

  const result = await runTelemetryDoctor({
    cwd,
    scope: "local",
    env: { [TOKEN_ENV]: "telemetry-token" },
    fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  });

  assert.equal(result.delivery.status, "blocked_by_non_retryable_failures");
  assert.equal(result.delivery.local_total_events, 2);
  assert.equal(result.delivery.sent_events, 0);
  assert.equal(result.delivery.pending_events, 1);
  assert.equal(result.delivery.inflight_events, 0);
  assert.equal(result.delivery.failed_events, 1);
  assert.equal(result.delivery.quarantine_events, 0);
  assert.equal(result.delivery.unsent_events, 2);
  assert.equal(result.delivery.sent_failure_count, 1);
  assert.equal(result.delivery.non_retryable_failure_count, 1);
  assert.equal(result.delivery.last_failure_reason, "unauthorized");
  assert.deepEqual(result.delivery.failed_reason_counts.map((item) => ({
    reason: item.reason,
    batch_count: item.batch_count,
    event_count: item.event_count,
  })), [
    {
      reason: "unauthorized",
      batch_count: 1,
      event_count: 1,
    },
  ]);
  assert.ok(result.delivery.failed_reason_counts[0].bytes > 0);
  assert.match(result.delivery.recommended_action, /Inspect failed reasons/);

  const serializedDelivery = JSON.stringify(result.delivery);
  assert.equal(serializedDelivery.includes("private prompt text must not appear"), false);
  assert.equal(serializedDelivery.includes("private response text must not appear"), false);
  assert.equal(serializedDelivery.includes("evt_private_failed"), false);
  assert.equal(serializedDelivery.includes(batch.batchId), false);
});
```

- [ ] **Step 2: Run the targeted test and verify it fails**

Run:

```bash
node --test test/telemetry-doctor.test.mjs
```

Expected: FAIL because `result.delivery` is undefined.

- [ ] **Step 3: Commit nothing**

Do not commit RED tests yet. Continue to Task 2 so both RED tests fail before implementation.

---

### Task 2: RED Test For Malformed Failed Reason Metadata

**Files:**
- Modify: `test/telemetry-doctor.test.mjs`

- [ ] **Step 1: Write the failing test**

Add `telemetryQueueDirs` to the queue import so the test can corrupt only `reason.json`:

```js
import {
  appendTelemetryEvent,
  claimTelemetryBatch,
  failTelemetryBatch,
  telemetryQueueDirs,
} from "../src/telemetry-queue.mjs";
```

Append this test after the Task 1 test:

```js
test("runTelemetryDoctor treats malformed failed reason as unknown", async () => {
  const cwd = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });
  await appendTelemetryEvent({ cwd, event: telemetryEvent(32) });
  const batch = await claimTelemetryBatch({
    cwd,
    batchSize: 1,
    now: new Date("2026-06-10T09:05:00.000Z"),
  });
  await failTelemetryBatch({
    cwd,
    batchId: batch.batchId,
    retryable: false,
    reason: "http_422",
  });
  await writeFile(
    join(telemetryQueueDirs(cwd).failed, batch.batchId, "reason.json"),
    "{ this is not valid json\n",
  );

  const result = await runTelemetryDoctor({
    cwd,
    scope: "local",
    env: { [TOKEN_ENV]: "telemetry-token" },
    fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  });

  assert.equal(result.delivery.status, "blocked_by_non_retryable_failures");
  assert.deepEqual(result.delivery.failed_reason_counts.map((item) => ({
    reason: item.reason,
    batch_count: item.batch_count,
    event_count: item.event_count,
  })), [
    {
      reason: "unknown",
      batch_count: 1,
      event_count: 1,
    },
  ]);
});
```

- [ ] **Step 2: Run the targeted test and verify it fails**

Run:

```bash
node --test test/telemetry-doctor.test.mjs
```

Expected: FAIL because `result.delivery` is undefined.

- [ ] **Step 3: Commit nothing**

Do not commit RED tests yet. Continue to Task 3.

---

### Task 3: Add Safe Failed Batch Summaries To Queue Module

**Files:**
- Modify: `src/telemetry-queue.mjs`

- [ ] **Step 1: Update imports**

Change the telemetry schema import at the top of `src/telemetry-queue.mjs` to include `maskCredentialText`:

```js
import {
  DEFAULT_MAX_QUEUE_BYTES,
  maskCredentialText,
  normalizeTelemetryEvent,
} from "./telemetry-schemas.mjs";
```

- [ ] **Step 2: Add safe reason helpers**

Add these helpers after `async function failedSummary(dir)`:

```js
function safeFailureReason(value) {
  const raw = typeof value === "string" ? value : "";
  const text = maskCredentialText(raw)
    .replace(/[\0-\x1F\x7F]/g, " ")
    .trim();
  if (!text) return "unknown";
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

async function failedBatchDirectories(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

async function failedBatchReason(batchDir) {
  let raw;
  try {
    raw = await readFile(join(batchDir, "reason.json"), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "unknown";
    throw error;
  }

  try {
    const parsed = JSON.parse(raw);
    return safeFailureReason(parsed?.reason);
  } catch {
    return "unknown";
  }
}
```

- [ ] **Step 3: Export failed batch summaries**

Add this exported function near `loadTelemetryQueueSnapshot`:

```js
export async function loadFailedTelemetryBatchSummaries({
  cwd = process.cwd(),
} = {}) {
  const dirs = telemetryQueueDirs(cwd);
  const batchNames = await failedBatchDirectories(dirs.failed);
  const summaries = [];
  for (const batchName of batchNames) {
    const batchDir = join(dirs.failed, batchName);
    const events = await failedSummary(batchDir);
    summaries.push({
      reason: await failedBatchReason(batchDir),
      event_count: events.count,
      bytes: events.bytes,
    });
  }
  return summaries;
}
```

- [ ] **Step 4: Run the targeted test and verify it still fails**

Run:

```bash
node --test test/telemetry-doctor.test.mjs
```

Expected: still FAIL because `src/telemetry-doctor.mjs` does not use the new helper yet.

---

### Task 4: Build Doctor Delivery Diagnostics

**Files:**
- Modify: `src/telemetry-doctor.mjs`

- [ ] **Step 1: Update imports**

Change imports at the top of `src/telemetry-doctor.mjs`:

```js
import { resolveTelemetryToken, validateTelemetryEndpoint } from "./telemetry-config.mjs";
import {
  loadFailedTelemetryBatchSummaries,
  loadTelemetryQueueSnapshot,
  loadTelemetryState,
} from "./telemetry-queue.mjs";
import {
  maskCredentialText,
  normalizeTelemetryConfig,
} from "./telemetry-schemas.mjs";
```

- [ ] **Step 2: Add delivery helper functions**

Add these helpers before `function recommendation(...)`:

```js
function safeDiagnosticLabel(value) {
  const raw = typeof value === "string" ? value : "";
  const text = maskCredentialText(raw)
    .replace(/[\0-\x1F\x7F]/g, " ")
    .trim();
  if (!text) return null;
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function aggregateFailedReasonCounts(failedBatches) {
  const byReason = new Map();
  for (const batch of failedBatches) {
    const safeReason = safeDiagnosticLabel(batch.reason);
    const reason = safeReason === null ? "unknown" : safeReason;
    const item = byReason.get(reason) || {
      reason,
      batch_count: 0,
      event_count: 0,
      bytes: 0,
    };
    item.batch_count += 1;
    item.event_count += batch.event_count;
    item.bytes += batch.bytes;
    byReason.set(reason, item);
  }
  return [...byReason.values()].sort((left, right) => (
    right.event_count - left.event_count
    || right.batch_count - left.batch_count
    || left.reason.localeCompare(right.reason)
  ));
}

function deliveryStatus({
  failedEvents,
  nonRetryableFailureCount,
  quarantineEvents,
  waitingEvents,
  flushReady,
}) {
  if (failedEvents > 0 || nonRetryableFailureCount > 0) {
    return "blocked_by_non_retryable_failures";
  }
  if (quarantineEvents > 0) return "quarantined_events_present";
  if (waitingEvents > 0 && flushReady) return "flush_ready";
  if (waitingEvents > 0) return "flush_blocked";
  return "delivered";
}

function deliveryRecommendedAction(status) {
  if (status === "blocked_by_non_retryable_failures") {
    return "Inspect failed reasons, fix token/endpoint/config, then retry with bounded flush.";
  }
  if (status === "quarantined_events_present") {
    return "Review quarantined telemetry events before broad flushing.";
  }
  if (status === "flush_ready") {
    return "Run telemetry flush --dry-run, then telemetry flush --batch-size 1.";
  }
  if (status === "flush_blocked") {
    return "Fix telemetry config/token/endpoint before flushing pending events.";
  }
  return "No pending, inflight, failed, or quarantined telemetry events.";
}

function buildDeliveryDiagnostics({
  queue,
  state,
  failedBatches,
  flushReady,
}) {
  const sentEvents = state.sent_success_count;
  const pendingEvents = queue.pending.count;
  const inflightEvents = queue.inflight.count;
  const failedEvents = queue.failed.count;
  const quarantineEvents = queue.quarantine.count;
  const waitingEvents = pendingEvents + inflightEvents;
  const unsentEvents = waitingEvents + failedEvents;
  const status = deliveryStatus({
    failedEvents,
    nonRetryableFailureCount: state.non_retryable_failure_count,
    quarantineEvents,
    waitingEvents,
    flushReady,
  });

  return {
    status,
    local_total_events: sentEvents + pendingEvents + inflightEvents + failedEvents + quarantineEvents,
    sent_events: sentEvents,
    pending_events: pendingEvents,
    inflight_events: inflightEvents,
    failed_events: failedEvents,
    quarantine_events: quarantineEvents,
    unsent_events: unsentEvents,
    sent_failure_count: state.sent_failure_count,
    non_retryable_failure_count: state.non_retryable_failure_count,
    last_failure_reason: safeDiagnosticLabel(state.last_failure_reason),
    failed_reason_counts: aggregateFailedReasonCounts(failedBatches),
    recommended_action: deliveryRecommendedAction(status),
  };
}
```

- [ ] **Step 3: Load failed summaries inside `runTelemetryDoctor`**

After loading `state`, add:

```js
  const failedBatches = await loadFailedTelemetryBatchSummaries({
    cwd: context.storageCwd,
  });
```

- [ ] **Step 4: Return `delivery` from `runTelemetryDoctor`**

In the returned object, add:

```js
    delivery: buildDeliveryDiagnostics({
      queue,
      state,
      failedBatches,
      flushReady: smallFlushSafe,
    }),
```

Place it near `queue` and `state` so JSON readers can find all local delivery fields together.

- [ ] **Step 5: Run the targeted test and verify it passes**

Run:

```bash
node --test test/telemetry-doctor.test.mjs
```

Expected: PASS.

---

### Task 5: Verify Full Suite And Commit Implementation

**Files:**
- Modify: `test/telemetry-doctor.test.mjs`
- Modify: `src/telemetry-queue.mjs`
- Modify: `src/telemetry-doctor.mjs`

- [ ] **Step 1: Run the full test suite**

Run:

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 2: Inspect the diff**

Run:

```bash
git diff -- test/telemetry-doctor.test.mjs src/telemetry-queue.mjs src/telemetry-doctor.mjs
```

Expected: diff only contains the RED tests and minimal delivery diagnostics implementation.

- [ ] **Step 3: Commit the implementation**

Run:

```bash
git add test/telemetry-doctor.test.mjs src/telemetry-queue.mjs src/telemetry-doctor.mjs
git commit -m "feat: add telemetry doctor delivery diagnostics"
```

Expected: commit succeeds.

---

## Self-Review

- Spec coverage: Tasks 1 and 2 cover delivery totals, privacy, malformed reason handling, and empty queue behavior remains covered by the existing doctor test.
- Type consistency: `delivery` fields use snake_case like existing telemetry JSON.
- Scope control: No server admin query, no raw reveal/export/delete, no `summary` output changes, and no CLI command parser changes.
- Verification: Targeted doctor tests run before implementation, then full `npm test` runs before commit.
