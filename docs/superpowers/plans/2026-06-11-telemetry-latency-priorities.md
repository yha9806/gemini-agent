# Telemetry Latency Priorities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add local telemetry latency analytics so Gemini Agent can identify slow commands and rank latency reliability work.

**Architecture:** Gemini call paths already capture `latency_ms` through `captureGeminiTelemetry`; extend `telemetry-summary` with aggregate latency percentiles by command, then consume that field in `telemetry-priorities`. Keep output aggregate-only: no raw prompt, response, event ids, media filenames, or local paths.

**Tech Stack:** Node.js ESM, `node:test`, existing local queue telemetry helpers.

---

### Task 1: Add Latency Summary Aggregates

**Files:**
- Modify: `src/telemetry-summary.mjs`
- Test: `test/telemetry-summary.test.mjs`

- [ ] **Step 1: Write the failing test**

Add a test that appends successful and error events with `latency_ms`, then asserts:

```js
assert.deepEqual(summary.latency, {
  event_count: 5,
  p50_ms: 4000,
  p95_ms: 12000,
  p99_ms: 12000,
  max_ms: 12000,
  top_commands: [
    {
      command: "artifact-review",
      event_count: 3,
      p50_ms: 8000,
      p95_ms: 12000,
      p99_ms: 12000,
      max_ms: 12000,
    },
    {
      command: "diff-review",
      event_count: 2,
      p50_ms: 1200,
      p95_ms: 1800,
      p99_ms: 1800,
      max_ms: 1800,
    },
  ],
});
```

Also assert the enabled empty-queue summary returns:

```js
assert.deepEqual(result.latency, {
  event_count: 0,
  p50_ms: null,
  p95_ms: null,
  p99_ms: null,
  max_ms: null,
  top_commands: [],
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/telemetry-summary.test.mjs --test-name-pattern latency`

Expected: FAIL because `summary.latency` does not exist.

- [ ] **Step 3: Write minimal implementation**

In `src/telemetry-summary.mjs`, add an accumulator for nonnegative finite `event.latency_ms`, a guarded nearest-rank percentile helper that returns `null` for empty arrays, and `latency` output with aggregate percentiles plus top commands sorted by `p95_ms`, then `event_count`, then command.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/telemetry-summary.test.mjs --test-name-pattern latency`

Expected: PASS.

### Task 2: Rank Slow Commands In Priorities

**Files:**
- Modify: `src/telemetry-priorities.mjs`
- Test: `test/telemetry-priorities.test.mjs`

- [ ] **Step 1: Write the failing test**

Add a test that creates at least five slow `artifact-review` events and one high-ROI `diff-review` event, then asserts:

```js
assert.equal(report.priorities[0].kind, "latency");
assert.equal(report.priorities[0].command, "artifact-review");
assert.match(report.priorities[0].action, /Profile artifact-review latency/);
assert.ok(report.priorities[0].evidence.some((item) => item === "p95 latency: 12,000 ms"));
assert.ok(report.priorities[0].evidence.some((item) => item === "Latency events: 5"));
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/telemetry-priorities.test.mjs --test-name-pattern latency`

Expected: FAIL because no latency priority exists.

- [ ] **Step 3: Write minimal implementation**

In `src/telemetry-priorities.mjs`, add a `latencyPriority(summary)` heuristic:

```js
const candidate = summary.latency?.top_commands?.find((item) => (
  item.event_count >= 5 && item.p95_ms >= 10000
));
```

Return a `kind: "latency"` priority with severity `high` for p95 >= 30000, otherwise `medium`, and evidence for p50/p95/p99/max/event count. The initial documented heuristic is: at least 5 latency samples for a command and command p95 >= 10000 ms.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/telemetry-priorities.test.mjs --test-name-pattern latency`

Expected: PASS.

### Task 3: Document And Verify

**Files:**
- Modify: `README.md`
- Modify: `test/package.test.mjs`

- [ ] **Step 1: Write the failing documentation assertion**

Add assertions that README mentions latency percentiles and latency priorities.

- [ ] **Step 2: Run the package test to verify it fails**

Run: `node --test test/package.test.mjs`

Expected: FAIL until README is updated.

- [ ] **Step 3: Update README**

Document that `telemetry summary` exposes latency p50/p95/p99 and that `telemetry priorities` can recommend profiling slow Gemini routes. Document the initial threshold: at least 5 samples and p95 >= 10000 ms.

- [ ] **Step 4: Run targeted and full verification**

Run:

```bash
node --test test/telemetry-summary.test.mjs test/telemetry-priorities.test.mjs test/package.test.mjs
npm test
./bin/gemini-agent diff-review --auto-context-pack --diff
```

Expected: tests pass and Gemini review returns `verdict: pass`.
