# Telemetry Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local `gemini-agent telemetry summary [--global] [--json]` command that turns existing telemetry queue files into safe product analytics.

**Architecture:** Create a focused `src/telemetry-summary.mjs` module that loads the local/global telemetry context, scans queue files incrementally, aggregates counts and usage, builds rule-based recommendations, and formats JSON or human text. Keep `src/cli.mjs` limited to argument parsing and command routing. Reuse existing telemetry config, queue path, state, snapshot, schema, and credential masking helpers.

**Tech Stack:** Node.js ESM, `node:test`, existing telemetry queue/config/schema modules, no network calls, no Gemini calls.

---

## File Structure

- Create `src/telemetry-summary.mjs`
  - Owns summary generation, queue file walking, event tolerance, aggregation, sanitization, recommendation rules, and text formatting.
  - Reads one telemetry event file at a time with an async generator. It must not build an array of all queue events.
- Create `test/telemetry-summary.test.mjs`
  - Unit-level coverage for empty summaries, queue aggregation, sanitization, invalid files, bounded output, and global scope.
- Modify `src/cli.mjs`
  - Add usage line, parse `telemetry summary [--global] [--json]`, call the summary module, and print text or JSON.
- Modify `test/cli.test.mjs`
  - Add CLI coverage for text output, JSON output, global scope, missing config errors, and no raw prompt/response leakage.
- Modify `README.md`
  - Add summary command example and update scheduler examples to include `--batch-size 1`.
- Modify `test/package.test.mjs`
  - Extend the public markdown test or add a README-specific assertion for the new `--batch-size 1` example if the existing check does not catch it.

## Task 1: Summary Module Baseline

**Files:**
- Create: `test/telemetry-summary.test.mjs`
- Create: `src/telemetry-summary.mjs`

- [ ] **Step 1: Write failing tests for missing config and empty enabled queue**

Create `test/telemetry-summary.test.mjs` with these imports and helpers:

```js
import assert from "node:assert/strict";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { saveTelemetryConfig } from "../src/telemetry-config.mjs";
import { runTelemetrySummary } from "../src/telemetry-summary.mjs";

const TOKEN_ENV = "GEMINI_AGENT_TELEMETRY_TOKEN";

async function temporaryWorkspace() {
  return mkdtemp(join(tmpdir(), "gemini-agent-telemetry-summary-"));
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

test("runTelemetrySummary rejects when telemetry is not enabled", async () => {
  const cwd = await temporaryWorkspace();

  await assert.rejects(
    runTelemetrySummary({ cwd, scope: "local" }),
    /Telemetry is not enabled/,
  );
});

test("runTelemetrySummary returns a zero summary for an enabled empty queue without creating queue dirs", async () => {
  const cwd = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });

  const result = await runTelemetrySummary({
    cwd,
    scope: "local",
    now: new Date("2026-06-04T10:00:00.000Z"),
  });

  assert.equal(result.scope, "local");
  assert.equal(result.storage_cwd, cwd);
  assert.equal(result.generated_at, "2026-06-04T10:00:00.000Z");
  assert.deepEqual(result.event_counts, {
    total: 0,
    pending: 0,
    inflight: 0,
    sent: 0,
    failed: 0,
    quarantine: 0,
    invalid: 0,
  });
  assert.equal(result.usage.total_tokens, 0);
  assert.equal(result.raw_content.prompt_events, 0);
  assert.deepEqual(result.top_projects, []);
  assert.deepEqual(result.top_commands, []);
  assert.equal(await pathExists(join(cwd, ".gemini-agent/telemetry/queue")), false);
});
```

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
node --test test/telemetry-summary.test.mjs
```

Expected: FAIL because `../src/telemetry-summary.mjs` does not exist.

- [ ] **Step 3: Create minimal summary module**

Create `src/telemetry-summary.mjs`:

```js
import { loadTelemetryConfigContext } from "./telemetry-config.mjs";
import {
  loadTelemetryQueueSnapshot,
  loadTelemetryState,
} from "./telemetry-queue.mjs";

const QUEUE_STATES = ["pending", "inflight", "sent", "failed", "quarantine"];

function zeroCounts() {
  return {
    total: 0,
    pending: 0,
    inflight: 0,
    sent: 0,
    failed: 0,
    quarantine: 0,
    invalid: 0,
  };
}

function zeroUsage() {
  return {
    prompt_tokens: 0,
    response_tokens: 0,
    total_tokens: 0,
    estimated_codex_tokens_saved: 0,
    events_missing_usage: 0,
  };
}

function zeroRawContent() {
  return {
    prompt_events: 0,
    response_events: 0,
    truncated_prompt_events: 0,
    truncated_response_events: 0,
  };
}

function emptyDimensionSummary() {
  return [];
}

export async function runTelemetrySummary({
  cwd = process.cwd(),
  home,
  scope = "auto",
  now = new Date(),
  topLimit = 10,
  invalidSampleLimit = 20,
} = {}) {
  if (!Number.isInteger(topLimit) || topLimit <= 0) {
    throw new RangeError("topLimit must be a positive integer.");
  }
  if (!Number.isInteger(invalidSampleLimit) || invalidSampleLimit < 0) {
    throw new RangeError("invalidSampleLimit must be a nonnegative integer.");
  }

  const context = await loadTelemetryConfigContext({ cwd, home, scope });
  if (!context.config?.enabled) throw new Error("Telemetry is not enabled.");

  const [state, snapshot] = await Promise.all([
    loadTelemetryState({ cwd: context.storageCwd }),
    loadTelemetryQueueSnapshot({ cwd: context.storageCwd, createMissingDirs: false }),
  ]);
  const counts = zeroCounts();
  for (const queueState of QUEUE_STATES) {
    counts[queueState] = snapshot[queueState].count;
    counts.total += snapshot[queueState].count;
  }

  return {
    scope: context.scope,
    storage_cwd: context.storageCwd,
    generated_at: now.toISOString(),
    event_counts: counts,
    queue: {
      queue_bytes: state.queue_bytes,
      dropped_old_count: state.dropped_old_count,
      dropped_memory_count: state.dropped_memory_count,
      sent_success_count: state.sent_success_count,
      sent_failure_count: state.sent_failure_count,
      non_retryable_failure_count: state.non_retryable_failure_count,
      last_failure_reason: state.last_failure_reason,
      last_sent_at: state.last_sent_at,
    },
    usage: zeroUsage(),
    top_projects: emptyDimensionSummary(),
    top_commands: emptyDimensionSummary(),
    sources: emptyDimensionSummary(),
    models: emptyDimensionSummary(),
    raw_content: zeroRawContent(),
    invalid_events: {
      count: 0,
      samples: [],
    },
    recommendations: [],
    limitations: [
      "Local summary only includes telemetry files available on this machine.",
      "Codex token savings are estimated from Gemini prompt token usage, not measured from Codex billing.",
    ],
  };
}
```

- [ ] **Step 4: Run tests to verify GREEN**

Run:

```bash
node --test test/telemetry-summary.test.mjs
```

Expected: PASS for the two baseline tests.

- [ ] **Step 5: Commit baseline**

Run:

```bash
git add src/telemetry-summary.mjs test/telemetry-summary.test.mjs
git commit -m "feat: add telemetry summary baseline"
```

## Task 2: Queue Event Aggregation

**Files:**
- Modify: `test/telemetry-summary.test.mjs`
- Modify: `src/telemetry-summary.mjs`

- [ ] **Step 1: Add failing tests for queue states and aggregate dimensions**

Append these helpers to `test/telemetry-summary.test.mjs`:

```js
import {
  appendTelemetryEvent,
  claimTelemetryBatch,
  completeTelemetryBatch,
  failTelemetryBatch,
  quarantineTelemetryEvent,
} from "../src/telemetry-queue.mjs";

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
    created_at: "2026-06-04T09:00:00.000Z",
    payload: { prompt_truncated: false, response_truncated: false, multimodal: [] },
    context: {
      cwd: null,
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
```

Append this test:

```js
test("runTelemetrySummary aggregates pending sent failed quarantine dimensions and usage", async () => {
  const cwd = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });

  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(1, {
      project_id: "vulca-platform",
      command: "artifact-review",
      economics: {
        input_tokens: 100,
        output_tokens: 25,
        total_tokens: 125,
      },
    }),
  });
  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(2, {
      project_id: "gemini-agent",
      command: "context-pack",
      payload: { prompt_truncated: true, response_truncated: false, multimodal: [] },
      economics: {
        input_tokens: 50,
        output_tokens: 15,
        total_tokens: 65,
      },
    }),
  });
  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(3, {
      project_id: "vulca-platform",
      command: "artifact-review",
      status: "error",
      error_type: "APIError",
      economics: {
        input_tokens: 10,
        output_tokens: 0,
        total_tokens: 10,
      },
    }),
  });
  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(4, {
      project_id: "emoart-challenge",
      command: "artifact-review",
      source: "mcp",
    }),
  });

  const sentBatch = await claimTelemetryBatch({ cwd, batchSize: 1, now: new Date("2026-06-04T09:01:00.000Z") });
  await completeTelemetryBatch({ cwd, batchId: sentBatch.batchId, now: new Date("2026-06-04T09:02:00.000Z") });
  const failedBatch = await claimTelemetryBatch({ cwd, batchSize: 1, now: new Date("2026-06-04T09:03:00.000Z") });
  await failTelemetryBatch({
    cwd,
    batchId: failedBatch.batchId,
    reason: "receiver_error",
    retryable: false,
    now: new Date("2026-06-04T09:04:00.000Z"),
  });
  await quarantineTelemetryEvent({
    cwd,
    eventId: "evt_000003",
    reason: "manual review",
    now: new Date("2026-06-04T09:05:00.000Z"),
  });

  const result = await runTelemetrySummary({
    cwd,
    scope: "local",
    now: new Date("2026-06-04T10:00:00.000Z"),
  });

  assert.deepEqual(result.event_counts, {
    total: 4,
    pending: 1,
    inflight: 0,
    sent: 1,
    failed: 1,
    quarantine: 1,
    invalid: 0,
  });
  assert.deepEqual(result.usage, {
    prompt_tokens: 160,
    response_tokens: 40,
    total_tokens: 200,
    estimated_codex_tokens_saved: 160,
    events_missing_usage: 1,
  });
  assert.deepEqual(result.raw_content, {
    prompt_events: 4,
    response_events: 4,
    truncated_prompt_events: 1,
    truncated_response_events: 0,
  });
  assert.equal(result.top_projects[0].project_id, "vulca-platform");
  assert.equal(result.top_projects[0].event_count, 2);
  assert.equal(result.top_commands[0].command, "artifact-review");
  assert.equal(result.top_commands[0].event_count, 3);
  assert.deepEqual(result.models, [{ model: "gemini-3.5-flash", event_count: 4 }]);
});
```

- [ ] **Step 2: Run test to verify RED**

Run:

```bash
node --test test/telemetry-summary.test.mjs
```

Expected: FAIL because `runTelemetrySummary` only uses snapshot counts and does not parse event files.

- [ ] **Step 3: Implement queue file walking and aggregation**

Modify `src/telemetry-summary.mjs` with these imports:

```js
import { readFile, readdir } from "node:fs/promises";
import { basename, relative, join } from "node:path";
import { maskCredentialText, normalizeTelemetryEvent } from "./telemetry-schemas.mjs";
import { telemetryQueueDirs } from "./telemetry-queue.mjs";
```

Add helpers:

```js
function safeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function sanitizeDimension(value, fallback = "unknown") {
  const text = `${value ?? ""}`.replace(/[\0-\x1F\x7F]/g, " ").trim();
  const masked = maskCredentialText(text || fallback);
  return masked.length > 120 ? `${masked.slice(0, 117)}...` : masked;
}

function createDimensionMap() {
  return new Map();
}

function updateDimension(map, key, status) {
  const safeKey = sanitizeDimension(key);
  const item = map.get(safeKey) ?? {
    key: safeKey,
    event_count: 0,
    success_count: 0,
    error_count: 0,
    unknown_count: 0,
  };
  item.event_count += 1;
  if (status === "success") item.success_count += 1;
  else if (status === "error") item.error_count += 1;
  else item.unknown_count += 1;
  map.set(safeKey, item);
}

function topDimension(map, keyName, limit) {
  return [...map.values()]
    .sort((left, right) => right.event_count - left.event_count || left.key.localeCompare(right.key))
    .slice(0, limit)
    .map((item) => ({
      [keyName]: item.key,
      event_count: item.event_count,
      success_count: item.success_count,
      error_count: item.error_count,
      unknown_count: item.unknown_count,
    }));
}

async function* walkFiles(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isFile()) {
      yield path;
    } else if (entry.isDirectory()) {
      yield* walkFiles(path);
    }
  }
}

function eventFileForState(state, path) {
  const name = basename(path);
  if (state === "failed") return name !== "reason.json" && name.endsWith(".json");
  if (state === "quarantine") return name === "event.json";
  return name.endsWith(".json");
}

async function readEventFile(path) {
  const raw = await readFile(path, "utf8");
  return normalizeTelemetryEvent(JSON.parse(raw));
}
```

Add an internal aggregator:

```js
function createAccumulator(topLimit, invalidSampleLimit) {
  return {
    topLimit,
    invalidSampleLimit,
    counts: zeroCounts(),
    usage: zeroUsage(),
    rawContent: zeroRawContent(),
    projects: createDimensionMap(),
    commands: createDimensionMap(),
    sources: createDimensionMap(),
    models: createDimensionMap(),
    invalidSamples: [],
  };
}

function addInvalid(accumulator, path, root) {
  accumulator.counts.invalid += 1;
  accumulator.counts.total += 1;
  if (accumulator.invalidSamples.length < accumulator.invalidSampleLimit) {
    accumulator.invalidSamples.push(relative(root, path));
  }
}

function addEvent(accumulator, state, event) {
  accumulator.counts[state] += 1;
  accumulator.counts.total += 1;
  const status = event.status === "success" || event.status === "error" ? event.status : "unknown";
  updateDimension(accumulator.projects, event.project_id, status);
  updateDimension(accumulator.commands, event.command, status);
  updateDimension(accumulator.sources, event.source, status);
  updateDimension(accumulator.models, event.model, status);

  if (event.prompt) accumulator.rawContent.prompt_events += 1;
  if (event.response) accumulator.rawContent.response_events += 1;
  if (event.payload?.prompt_truncated) accumulator.rawContent.truncated_prompt_events += 1;
  if (event.payload?.response_truncated) accumulator.rawContent.truncated_response_events += 1;

  const inputTokens = event.economics?.input_tokens;
  const outputTokens = event.economics?.output_tokens;
  const totalTokens = event.economics?.total_tokens;
  if (inputTokens == null && outputTokens == null && totalTokens == null) {
    accumulator.usage.events_missing_usage += 1;
    return;
  }
  accumulator.usage.prompt_tokens += safeInteger(inputTokens);
  accumulator.usage.response_tokens += safeInteger(outputTokens);
  accumulator.usage.total_tokens += safeInteger(totalTokens);
  accumulator.usage.estimated_codex_tokens_saved += safeInteger(inputTokens);
}
```

Replace snapshot count assignment in `runTelemetrySummary` with event walking:

```js
  const dirs = telemetryQueueDirs(context.storageCwd);
  const accumulator = createAccumulator(topLimit, invalidSampleLimit);
  for (const queueState of QUEUE_STATES) {
    for await (const path of walkFiles(dirs[queueState])) {
      if (!eventFileForState(queueState, path)) continue;
      try {
        addEvent(accumulator, queueState, await readEventFile(path));
      } catch {
        addInvalid(accumulator, path, dirs.root);
      }
    }
  }
```

Do not add an `events` array to the accumulator. The only data that should survive past each file read is aggregate counters, dimension maps, usage totals, raw-content counters, and bounded invalid samples.

Then map accumulator values into the returned object:

```js
    event_counts: accumulator.counts,
    usage: accumulator.usage,
    top_projects: topDimension(accumulator.projects, "project_id", topLimit),
    top_commands: topDimension(accumulator.commands, "command", topLimit),
    sources: topDimension(accumulator.sources, "source", topLimit),
    models: topDimension(accumulator.models, "model", topLimit),
    raw_content: accumulator.rawContent,
    invalid_events: {
      count: accumulator.counts.invalid,
      samples: accumulator.invalidSamples,
    },
```

Keep `loadTelemetryQueueSnapshot({ createMissingDirs: false })` for queue health bytes if useful, but event counts should come from parsed files so invalid events are visible.

- [ ] **Step 4: Run tests to verify GREEN**

Run:

```bash
node --test test/telemetry-summary.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit aggregation**

Run:

```bash
git add src/telemetry-summary.mjs test/telemetry-summary.test.mjs
git commit -m "feat: aggregate telemetry summary events"
```

## Task 3: Safety, Recommendations, Text Formatting, and Global Scope

**Files:**
- Modify: `test/telemetry-summary.test.mjs`
- Modify: `src/telemetry-summary.mjs`

- [ ] **Step 1: Add failing tests for safety, invalid files, recommendations, text formatting, and global scope**

Append these tests:

```js
import { mkdir, writeFile } from "node:fs/promises";
import { telemetryQueueDirs } from "../src/telemetry-queue.mjs";
import { formatTelemetrySummaryText } from "../src/telemetry-summary.mjs";

test("runTelemetrySummary sanitizes metadata dimensions and never exposes raw prompt or response", async () => {
  const cwd = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });
  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(10, {
      project_id: "vulca\nAuthorization: Bearer secret-token",
      command: "artifact-review",
      prompt: "raw prompt with customer secret",
      response: "raw response with customer secret",
    }),
  });

  const summary = await runTelemetrySummary({ cwd, scope: "local" });
  const json = JSON.stringify(summary);
  const text = formatTelemetrySummaryText(summary);

  assert.doesNotMatch(json, /secret-token/);
  assert.doesNotMatch(json, /raw prompt with customer secret/);
  assert.doesNotMatch(json, /raw response with customer secret/);
  assert.doesNotMatch(text, /secret-token/);
  assert.doesNotMatch(text, /raw prompt with customer secret/);
  assert.doesNotMatch(text, /raw response with customer secret/);
  assert.match(text, /Telemetry Summary/);
});

test("runTelemetrySummary counts invalid files with bounded relative samples", async () => {
  const cwd = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });
  const dirs = telemetryQueueDirs(cwd);
  await mkdir(dirs.pending, { recursive: true });
  await writeFile(join(dirs.pending, "bad-a.json"), "{bad json");
  await writeFile(join(dirs.pending, "bad-b.json"), "{bad json");

  const summary = await runTelemetrySummary({
    cwd,
    scope: "local",
    invalidSampleLimit: 1,
  });

  assert.equal(summary.event_counts.invalid, 2);
  assert.equal(summary.invalid_events.count, 2);
  assert.equal(summary.invalid_events.samples.length, 1);
  assert.equal(summary.invalid_events.samples[0], "queue/pending/bad-a.json");
  assert.doesNotMatch(JSON.stringify(summary.invalid_events.samples), new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("runTelemetrySummary caps top dimensions and builds deterministic recommendations", async () => {
  const cwd = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });
  for (let index = 1; index <= 6; index += 1) {
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(index, {
        project_id: `project-${index}`,
        command: "artifact-review",
      }),
    });
  }

  const summary = await runTelemetrySummary({ cwd, scope: "local", topLimit: 3 });

  assert.equal(summary.top_projects.length, 3);
  assert.equal(summary.top_commands[0].command, "artifact-review");
  assert.match(summary.recommendations.map((item) => item.message).join("\n"), /multimodal\/design workflows/);
});

test("runTelemetrySummary keeps large queues bounded by topLimit", async () => {
  const cwd = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });
  for (let index = 1; index <= 250; index += 1) {
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(index, {
        project_id: `project-${index}`,
        command: index % 2 === 0 ? "context-pack" : "artifact-review",
      }),
    });
  }

  const summary = await runTelemetrySummary({ cwd, scope: "local", topLimit: 5 });

  assert.equal(summary.event_counts.total, 250);
  assert.equal(summary.top_projects.length, 5);
  assert.equal(summary.top_commands.length, 2);
  assert.equal(summary.invalid_events.samples.length, 0);
});

test("runTelemetrySummary supports global scope from a different cwd", async () => {
  const home = await temporaryWorkspace();
  const project = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd: project,
    home,
    scope: "global",
    endpoint: "https://vulca-api.onrender.com/api/v1/gemini-agent/telemetry/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });
  await appendTelemetryEvent({
    cwd: home,
    event: telemetryEvent(21, { project_id: "global-project", command: "context-pack" }),
  });

  const summary = await runTelemetrySummary({ cwd: project, home, scope: "global" });

  assert.equal(summary.scope, "global");
  assert.equal(summary.storage_cwd, home);
  assert.equal(summary.event_counts.total, 1);
  assert.equal(summary.top_projects[0].project_id, "global-project");
});
```

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
node --test test/telemetry-summary.test.mjs
```

Expected: FAIL because `formatTelemetrySummaryText` and recommendations are not implemented.

- [ ] **Step 3: Implement recommendations and text formatting**

Add these helpers to `src/telemetry-summary.mjs`:

```js
function successRate(item) {
  return item.event_count > 0 ? item.success_count / item.event_count : 0;
}

function buildRecommendations({ topCommands, counts, queue, usage }) {
  const recommendations = [];
  const artifactReview = topCommands.find((item) => item.command === "artifact-review");
  if (artifactReview?.success_count >= 5 && successRate(artifactReview) >= 0.8) {
    recommendations.push({
      kind: "workflow",
      message: "artifact-review has enough successful use to keep prioritizing multimodal/design workflows.",
    });
  }
  const contextPack = topCommands.find((item) => item.command === "context-pack");
  if (contextPack?.success_count >= 5 && successRate(contextPack) >= 0.8) {
    recommendations.push({
      kind: "workflow",
      message: "context-pack has enough successful use to keep prioritizing large-context compression.",
    });
  }
  const errorCount = topCommands.reduce((sum, item) => sum + item.error_count, 0);
  if (counts.total > 0 && errorCount / counts.total > 0.2) {
    recommendations.push({
      kind: "reliability",
      message: "Error rate is above 20%; diagnose reliability before expanding automation.",
    });
  }
  if (counts.pending >= 50 && queue.last_failure_reason === "receiver_error") {
    recommendations.push({
      kind: "delivery",
      message: "Pending queue is high with receiver_error; keep bounded flushes and inspect the endpoint.",
    });
  }
  if (counts.total > 0 && usage.events_missing_usage / counts.total > 0.5) {
    recommendations.push({
      kind: "instrumentation",
      message: "Most events are missing usage metadata; validate Gemini client capture before drawing token-savings conclusions.",
    });
  }
  return recommendations;
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatTopRows(items, keyName) {
  if (items.length === 0) return "None";
  return items.map((item, index) => (
    `${index + 1}. ${item[keyName]}: ${item.event_count} events, ${item.success_count} success, ${item.error_count} error`
  )).join("\n");
}

export function formatTelemetrySummaryText(summary) {
  const successCount = summary.top_commands.reduce((sum, item) => sum + item.success_count, 0);
  const errorCount = summary.top_commands.reduce((sum, item) => sum + item.error_count, 0);
  const knownOutcomes = successCount + errorCount;
  const successRateText = knownOutcomes === 0 ? "n/a" : `${((successCount / knownOutcomes) * 100).toFixed(1)}%`;
  const recommendations = summary.recommendations.length
    ? summary.recommendations.map((item) => `- ${item.message}`).join("\n")
    : "- No recommendations yet; collect more events.";

  return [
    "Telemetry Summary",
    "",
    `Scope: ${summary.scope}`,
    `Storage: ${summary.storage_cwd}`,
    `Events: ${summary.event_counts.total} total, ${summary.event_counts.sent} sent, ${summary.event_counts.pending} pending, ${summary.event_counts.failed} failed, ${summary.event_counts.quarantine} quarantined, ${summary.event_counts.invalid} invalid`,
    "",
    "Top projects:",
    formatTopRows(summary.top_projects, "project_id"),
    "",
    "Top commands:",
    formatTopRows(summary.top_commands, "command"),
    "",
    "Reliability:",
    `- Success rate: ${successRateText}`,
    `- Last failure: ${summary.queue.last_failure_reason ?? "none"}`,
    "",
    "Usage:",
    `- Prompt tokens: ${formatNumber(summary.usage.prompt_tokens)}`,
    `- Response tokens: ${formatNumber(summary.usage.response_tokens)}`,
    `- Estimated Codex tokens saved: ${formatNumber(summary.usage.estimated_codex_tokens_saved)}`,
    "",
    "Recommendations:",
    recommendations,
    "",
  ].join("\n");
}
```

In `runTelemetrySummary`, build `topCommands` before returning and use it for recommendations:

```js
  const topProjects = topDimension(accumulator.projects, "project_id", topLimit);
  const topCommands = topDimension(accumulator.commands, "command", topLimit);
  const sources = topDimension(accumulator.sources, "source", topLimit);
  const models = topDimension(accumulator.models, "model", topLimit);
  const queue = {
    queue_bytes: state.queue_bytes,
    dropped_old_count: state.dropped_old_count,
    dropped_memory_count: state.dropped_memory_count,
    sent_success_count: state.sent_success_count,
    sent_failure_count: state.sent_failure_count,
    non_retryable_failure_count: state.non_retryable_failure_count,
    last_failure_reason: state.last_failure_reason,
    last_sent_at: state.last_sent_at,
  };
```

Return those variables:

```js
    queue,
    top_projects: topProjects,
    top_commands: topCommands,
    sources,
    models,
    recommendations: buildRecommendations({
      topCommands,
      counts: accumulator.counts,
      queue,
      usage: accumulator.usage,
    }),
```

- [ ] **Step 4: Run tests to verify GREEN**

Run:

```bash
node --test test/telemetry-summary.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit safety and formatting**

Run:

```bash
git add src/telemetry-summary.mjs test/telemetry-summary.test.mjs
git commit -m "feat: format safe telemetry summaries"
```

## Task 4: CLI Command and README

**Files:**
- Modify: `src/cli.mjs`
- Modify: `test/cli.test.mjs`
- Modify: `README.md`
- Modify: `test/package.test.mjs`

- [ ] **Step 1: Add failing CLI tests**

In `test/cli.test.mjs`, add `saveTelemetryConfig` and `appendTelemetryEvent` are already imported in the file. Append tests near the telemetry status tests:

```js
test("telemetry summary prints human summary without raw prompt or response", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));
  await saveTelemetryConfig({
    cwd: dir,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TELEMETRY_TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });
  await appendTelemetryEvent({
    cwd: dir,
    event: telemetryEvent(91, {
      project_id: "vulca-platform",
      command: "artifact-review",
      prompt: "raw prompt should not print",
      response: "raw response should not print",
    }),
  });

  const { stdout, stderr } = await execFileAsync(bin, ["telemetry", "summary"], {
    cwd: dir,
    env: { PATH: process.env.PATH },
  });

  assert.equal(stderr, "");
  assert.match(stdout, /Telemetry Summary/);
  assert.match(stdout, /vulca-platform/);
  assert.match(stdout, /artifact-review/);
  assert.doesNotMatch(stdout, /raw prompt should not print/);
  assert.doesNotMatch(stdout, /raw response should not print/);
});

test("telemetry summary --json prints stable JSON and supports global scope", async () => {
  const home = await mkdtemp(join(tmpdir(), "gemini-agent-cli-home-"));
  const project = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));
  await saveTelemetryConfig({
    cwd: project,
    home,
    scope: "global",
    endpoint: "https://vulca-api.onrender.com/api/v1/gemini-agent/telemetry/ingest",
    tokenEnv: TELEMETRY_TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });
  await appendTelemetryEvent({
    cwd: home,
    event: telemetryEvent(92, {
      project_id: "global-project",
      command: "context-pack",
    }),
  });

  const { stdout, stderr } = await execFileAsync(bin, ["telemetry", "summary", "--global", "--json"], {
    cwd: project,
    env: { ...process.env, HOME: home },
  });
  const parsed = JSON.parse(stdout);

  assert.equal(stderr, "");
  assert.equal(parsed.scope, "global");
  assert.equal(parsed.storage_cwd, home);
  assert.equal(parsed.event_counts.total, 1);
  assert.equal(parsed.top_projects[0].project_id, "global-project");
});
```

Add a README assertion to `test/package.test.mjs`:

```js
test("README documents telemetry summary and bounded scheduler examples", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  assert.match(readme, /telemetry summary --global/);
  assert.match(readme, /telemetry tick --global --batch-size 1/);
  assert.match(readme, /install-scheduler[\s\S]*--batch-size 1/);
});
```

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
node --test test/cli.test.mjs test/package.test.mjs
```

Expected: FAIL because the CLI does not know `telemetry summary` and README lacks the new examples.

- [ ] **Step 3: Wire CLI command**

Modify `src/cli.mjs` imports:

```js
import {
  formatTelemetrySummaryText,
  runTelemetrySummary,
} from "./telemetry-summary.mjs";
```

Add usage line after preview:

```js
"  gemini-agent telemetry summary [--global] [--json]",
```

Add parser near `parseTelemetryDoctorOptions`:

```js
function parseTelemetrySummaryOptions(args) {
  const options = {
    global: false,
    json: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--global") {
      options.global = true;
    } else if (arg === "--json") {
      options.json = true;
    } else {
      throw new Error(`Unknown telemetry summary argument: ${arg}`);
    }
  }

  return options;
}
```

Add command runner near `runTelemetryDoctorCommand`:

```js
async function runTelemetrySummaryCommand(args = []) {
  const options = parseTelemetrySummaryOptions(args);
  const summary = await runTelemetrySummary({
    cwd: process.cwd(),
    home: process.env.HOME,
    scope: telemetryScope(options),
  });
  if (options.json) {
    output.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  output.write(formatTelemetrySummaryText(summary));
}
```

Add routing in `runTelemetry` before `doctor`:

```js
  if (subcommand === "summary") {
    await runTelemetrySummaryCommand(subArgs);
    return;
  }
```

- [ ] **Step 4: Update README**

Modify the command block in `README.md`:

```bash
./bin/gemini-agent telemetry status --global
./bin/gemini-agent telemetry summary --global
./bin/gemini-agent telemetry summary --global --json
./bin/gemini-agent telemetry validate --global --endpoint http://127.0.0.1:8787/ingest --token-env GEMINI_AGENT_TELEMETRY_TOKEN --deployment-id gemini-agent-main --confirm-raw-content
./bin/gemini-agent telemetry flush --global
./bin/gemini-agent telemetry tick --global --batch-size 1
./bin/gemini-agent telemetry disable --global
./bin/gemini-agent telemetry purge --global
./bin/gemini-agent telemetry install-scheduler --global --target launchd --name gemini-agent-main --schedule daily@09:00 --batch-size 1 --env-file ~/.gemini-agent/telemetry.env --dry-run
```

Add one safety bullet:

```md
- `telemetry summary` reports aggregate usage and queue health; it does not print raw prompt or response text.
```

- [ ] **Step 5: Run tests to verify GREEN**

Run:

```bash
node --test test/telemetry-summary.test.mjs test/cli.test.mjs test/package.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit CLI and docs**

Run:

```bash
git add src/cli.mjs test/cli.test.mjs README.md test/package.test.mjs src/telemetry-summary.mjs test/telemetry-summary.test.mjs
git commit -m "feat: add telemetry summary cli"
```

## Task 5: Final Verification and Review

**Files:**
- No planned source edits unless verification finds a bug.

- [ ] **Step 1: Run full test suite**

Run:

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 2: Run whitespace check**

Run:

```bash
git diff --check
```

Expected: no output and exit code 0.

- [ ] **Step 3: Manually test current global summary**

Run:

```bash
./bin/gemini-agent telemetry summary --global
./bin/gemini-agent telemetry summary --global --json
```

Expected:
- Text output has `Telemetry Summary`.
- JSON parses with `JSON.parse`.
- Neither output contains raw prompt or response excerpts.
- The command does not require `GEMINI_AGENT_TELEMETRY_TOKEN`.

- [ ] **Step 4: Ask gemini-agent for diff review**

Run the available gemini-agent diff-review tool with this prompt:

```text
Review the current git diff before final handoff. Scope: telemetry summary CLI that reads local/global queue files, aggregates usage, formats safe text/JSON, and updates README scheduler examples. Focus on privacy leaks, raw prompt/response exposure, queue walking bugs, CLI parsing regressions, and missing tests.
```

Expected: review returns no blocking bug. If it reports a concrete bug, add a failing test, fix it, rerun targeted tests, and rerun `npm test`.

- [ ] **Step 5: Push main after all commits are green**

Run:

```bash
git status --short --branch
git push origin main
```

Expected:
- `main` is ahead only by verified commits before push.
- Push succeeds.
- Untracked `.DS_Store` and `.superpowers/` are still untracked and not included.
