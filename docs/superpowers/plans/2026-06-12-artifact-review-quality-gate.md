# Artifact Review Quality Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `gemini-agent telemetry artifact-review quality-gate` so local telemetry can produce a safe aggregate readiness decision for expanding `artifact-review` quick depth.

**Architecture:** Create a focused `src/telemetry-artifact-review-quality-gate.mjs` module that reuses `runTelemetrySummary`, normalizes only whitelisted aggregate fields, and renders JSON/text output. Wire it into `src/cli.mjs` as a nested telemetry subcommand and document it in README. No server, raw payload, or routing behavior changes are included.

**Tech Stack:** Node.js ES modules, `node:test`, existing telemetry summary helpers, existing CLI integration harness, existing README/package documentation tests.

---

## File Map

- Create `src/telemetry-artifact-review-quality-gate.mjs`: build strict aggregate quality-gate JSON, readiness reasons, cohort risk ranking, next actions, and text rendering.
- Create `test/telemetry-artifact-review-quality-gate.test.mjs`: unit tests for empty data, weak quick depth, low scorecard coverage, ready path, strict output shape, and raw leak resistance.
- Modify `src/cli.mjs`: add usage line, argument parser, and `telemetry artifact-review quality-gate` dispatch.
- Modify `test/cli.test.mjs`: cover text output, JSON output, global scope, and argument rejection through the CLI.
- Modify `README.md`: add command example and safety summary.
- Modify `test/package.test.mjs`: assert README documents the command and quality-gate behavior.

## Task 1: Core Quality Gate Module

**Files:**
- Create: `src/telemetry-artifact-review-quality-gate.mjs`
- Create: `test/telemetry-artifact-review-quality-gate.test.mjs`

- [ ] **Step 1: Write failing tests for empty and weak telemetry**

Create `test/telemetry-artifact-review-quality-gate.test.mjs` with:

```js
import assert from "node:assert/strict";
import test from "node:test";
import {
  artifactReviewQualityGateToText,
  buildArtifactReviewQualityGate,
} from "../src/telemetry-artifact-review-quality-gate.mjs";

const PRIVATE_TEXT = "private prompt /private/example Authorization: Bearer secret-token evt_private media.png";

function summary(overrides = {}) {
  return {
    scope: "local",
    storage_cwd: "/tmp/private-storage",
    generated_at: "2026-06-12T00:00:00.000Z",
    event_counts: { total: 0 },
    product_adjusted_event_count: 0,
    artifact_review_quality: {
      event_count: 0,
      scorecard_event_count: 0,
      avg_overall_score: null,
      avg_implementation_readiness_score: null,
      scorecard_field_coverage: [],
      top_commands: [],
    },
    artifact_review_depths: {
      event_count: 0,
      known_depth_event_count: 0,
      top_depths: [],
      top_budget_cohorts: [],
    },
    ...overrides,
  };
}

test("buildArtifactReviewQualityGate returns caution for empty telemetry without leaking raw data", () => {
  const gate = buildArtifactReviewQualityGate(summary({
    artifact_review_quality: undefined,
    artifact_review_depths: undefined,
    private_raw: PRIVATE_TEXT,
  }));

  assert.equal(gate.ok, true);
  assert.equal(gate.command, "artifact-review");
  assert.equal(gate.readiness.status, "caution");
  assert.ok(gate.readiness.reasons.includes("insufficient_artifact_review_data"));
  assert.equal(gate.quick_depth.event_count, 0);
  assert.equal(gate.quick_depth.worst_budget_cohort, null);
  assert.equal(gate.scorecard.coverage_rate, null);
  assert.deepEqual(Object.keys(gate).sort(), [
    "command",
    "generated_at",
    "limitations",
    "next_actions",
    "ok",
    "quick_depth",
    "readiness",
    "scope",
    "scorecard",
  ].sort());

  const serialized = JSON.stringify(gate);
  assert.doesNotMatch(serialized, /private prompt|Authorization|Bearer|evt_private|media\.png|\/Users\/example/);
});

test("quality gate flags risky quick depth budget cohort and weak scorecard coverage", () => {
  const gate = buildArtifactReviewQualityGate(summary({
    event_counts: { total: 20 },
    artifact_review_quality: {
      event_count: 20,
      scorecard_event_count: 2,
      avg_overall_score: 58,
      avg_implementation_readiness_score: 38,
      scorecard_field_coverage: [
        { field: "overall_score", events: 20, scored_events: 2, coverage: 0.1 },
        { field: "accessibility_score", events: 20, scored_events: 0, coverage: 0 },
      ],
      top_commands: [],
    },
    artifact_review_depths: {
      event_count: 8,
      known_depth_event_count: 8,
      top_depths: [
        {
          review_depth: "quick",
          event_count: 6,
          success_count: 4,
          error_count: 2,
          p95_latency_ms: 12217,
          total_tokens: 18924,
          scorecard_event_count: 1,
        },
      ],
      top_budget_cohorts: [
        {
          review_depth: "quick",
          budget_cohort: "2048",
          event_count: 4,
          success_count: 4,
          error_count: 0,
          p95_latency_ms: 12383,
          total_tokens: 12000,
          scorecard_event_count: 1,
        },
        {
          review_depth: "quick",
          budget_cohort: "768",
          event_count: 2,
          success_count: 0,
          error_count: 2,
          p95_latency_ms: 12217,
          total_tokens: 6924,
          scorecard_event_count: 0,
        },
      ],
    },
  }));

  assert.equal(gate.readiness.status, "blocked");
  assert.ok(gate.readiness.reasons.includes("quick_depth_error_rate_high"));
  assert.ok(gate.readiness.reasons.includes("scorecard_coverage_low"));
  assert.equal(gate.quick_depth.error_rate, 0.3333);
  assert.equal(gate.quick_depth.low_confidence, true);
  assert.deepEqual(gate.quick_depth.worst_budget_cohort, {
    budget_cohort: "768",
    event_count: 2,
    success_count: 0,
    error_count: 2,
    error_rate: 1,
    p95_latency_ms: 12217,
    total_tokens: 6924,
    low_confidence: true,
  });
  assert.equal(gate.scorecard.coverage_rate, 0.1);
  assert.equal(gate.scorecard.field_coverage_min, 0);
  assert.equal(gate.scorecard.weakest_field.field, "accessibility_score");
  assert.ok(gate.next_actions.some((item) => /Avoid expanding quick depth/i.test(item)));
  assert.ok(gate.next_actions.some((item) => /Capture numeric design scorecards/i.test(item)));
});
```

- [ ] **Step 2: Verify RED**

Run:

```bash
node --test test/telemetry-artifact-review-quality-gate.test.mjs
```

Expected: FAIL with module-not-found for `src/telemetry-artifact-review-quality-gate.mjs`.

- [ ] **Step 3: Implement minimal module**

Create `src/telemetry-artifact-review-quality-gate.mjs` with exported constants, `buildArtifactReviewQualityGate(summary)`, and `artifactReviewQualityGateToText(gate)`.

Implementation requirements:

- Use explicit object construction; never spread `summary`.
- Round rates to four decimals.
- Use these thresholds:

```js
const QUICK_MIN_READY_EVENTS = 10;
const QUICK_MAX_READY_ERROR_RATE = 0.05;
const COHORT_MIN_CONFIDENCE_EVENTS = 10;
const SCORECARD_READY_COVERAGE = 0.8;
```

- Normalize cohorts to only:

```js
{
  budget_cohort,
  event_count,
  success_count,
  error_count,
  error_rate,
  p95_latency_ms,
  total_tokens,
  low_confidence,
}
```

- Choose the worst quick cohort by highest `error_rate`, then highest `event_count`, then lexical `budget_cohort`.
- Return `blocked` when quick error rate is at least 5% with at least 5 quick events, or the worst quick cohort has at least 2 errors and 50%+ error rate.
- Return `ready` only when quick events, quick error rate, quick cohort confidence, scorecard coverage, and scorecard field coverage pass thresholds.
- Otherwise return `caution`.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
node --test test/telemetry-artifact-review-quality-gate.test.mjs
```

Expected: PASS.

## Task 2: Ready Path, Text Output, and Strict Safety

**Files:**
- Modify: `test/telemetry-artifact-review-quality-gate.test.mjs`
- Modify: `src/telemetry-artifact-review-quality-gate.mjs`

- [ ] **Step 1: Add ready path and text tests**

Append tests:

```js
test("quality gate returns ready when quick depth and scorecard evidence are healthy", () => {
  const gate = buildArtifactReviewQualityGate(summary({
    event_counts: { total: 40 },
    artifact_review_quality: {
      event_count: 20,
      scorecard_event_count: 18,
      avg_overall_score: 82,
      avg_implementation_readiness_score: 81,
      scorecard_field_coverage: [
        { field: "overall_score", events: 20, scored_events: 18, coverage: 0.9 },
        { field: "accessibility_score", events: 20, scored_events: 17, coverage: 0.85 },
      ],
      top_commands: [],
    },
    artifact_review_depths: {
      event_count: 20,
      known_depth_event_count: 20,
      top_depths: [
        {
          review_depth: "quick",
          event_count: 12,
          success_count: 12,
          error_count: 0,
          p95_latency_ms: 9000,
          total_tokens: 24000,
          scorecard_event_count: 11,
        },
      ],
      top_budget_cohorts: [
        {
          review_depth: "quick",
          budget_cohort: "2048",
          event_count: 12,
          success_count: 12,
          error_count: 0,
          p95_latency_ms: 9000,
          total_tokens: 24000,
          scorecard_event_count: 11,
        },
      ],
    },
  }));

  assert.equal(gate.readiness.status, "ready");
  assert.deepEqual(gate.readiness.reasons, ["quick_depth_ready"]);
  assert.equal(gate.quick_depth.low_confidence, false);
  assert.equal(gate.scorecard.coverage_rate, 0.9);
  assert.ok(gate.next_actions.some((item) => /expand quick depth/i.test(item)));
});

test("artifactReviewQualityGateToText is aggregate-only and operator readable", () => {
  const gate = buildArtifactReviewQualityGate(summary({
    event_counts: { total: 1 },
    artifact_review_quality: {
      event_count: 1,
      scorecard_event_count: 0,
      avg_overall_score: null,
      avg_implementation_readiness_score: null,
      scorecard_field_coverage: [],
      top_commands: [],
    },
    artifact_review_depths: {
      event_count: 1,
      known_depth_event_count: 1,
      top_depths: [
        { review_depth: "quick", event_count: 1, success_count: 1, error_count: 0, p95_latency_ms: 1000, total_tokens: 100 },
      ],
      top_budget_cohorts: [],
    },
  }));
  const text = artifactReviewQualityGateToText(gate);
  assert.match(text, /Artifact-review quality gate: caution/);
  assert.match(text, /Quick depth:/);
  assert.match(text, /Scorecard coverage:/);
  assert.doesNotMatch(text, /private prompt|Authorization|Bearer|evt_|\/Users\/|media\.png/);
});
```

- [ ] **Step 2: Verify RED or partial GREEN**

Run:

```bash
node --test test/telemetry-artifact-review-quality-gate.test.mjs
```

Expected: FAIL until ready-path and text rendering are complete.

- [ ] **Step 3: Complete module behavior**

Update the module to pass ready-path and text rendering tests. Keep `limitations` fixed:

```js
[
  "Quality gate uses aggregate local telemetry only; no raw prompts, responses, event ids, paths, or media file names are included.",
  "Codex remains responsible for routing, code changes, tests, commits, and final release decisions.",
  "Small sample cohorts are directional and should not be treated as statistically conclusive.",
]
```

- [ ] **Step 4: Verify GREEN**

Run:

```bash
node --test test/telemetry-artifact-review-quality-gate.test.mjs
```

Expected: PASS.

## Task 3: CLI Integration

**Files:**
- Modify: `src/cli.mjs`
- Modify: `test/cli.test.mjs`

- [ ] **Step 1: Write failing CLI tests**

Add tests near telemetry report/priorities tests in `test/cli.test.mjs`:

```js
test("telemetry artifact-review quality-gate prints safe human output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-artifact-quality-"));
  await saveTelemetryConfig({ cwd: dir, endpoint: "http://127.0.0.1:8787/ingest", tokenEnv: TELEMETRY_TOKEN_ENV, deploymentId: "gemini-agent-main" });
  await appendTelemetryEvent({
    cwd: dir,
    event: telemetryEvent(9200, {
      command: "artifact-review",
      prompt: "private prompt /private/example Authorization: Bearer secret-token",
      response: "private response media.png",
      latency_ms: 12217,
      usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
      metadata: { artifact_review_depth: "quick", artifact_review_max_output_tokens: 768 },
    }),
  });

  const { stdout } = await execBin(["telemetry", "artifact-review", "quality-gate"], {
    cwd: dir,
    env: { ...process.env, HOME: CLI_TEST_HOME },
  });

  assert.match(stdout, /Artifact-review quality gate:/);
  assert.match(stdout, /Quick depth:/);
  assert.doesNotMatch(stdout, /private prompt|private response|\/Users\/example|secret-token|media\.png|evt_/);
});

test("telemetry artifact-review quality-gate --json supports global scope", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-artifact-quality-json-"));
  await saveTelemetryConfig({ cwd: dir, global: true, endpoint: "http://127.0.0.1:8787/ingest", tokenEnv: TELEMETRY_TOKEN_ENV, deploymentId: "gemini-agent-main" });

  const { stdout } = await execBin(["telemetry", "artifact-review", "quality-gate", "--global", "--json"], {
    cwd: dir,
    env: { ...process.env, HOME: CLI_TEST_HOME },
  });

  const parsed = JSON.parse(stdout);
  assert.equal(parsed.scope, "global");
  assert.equal(parsed.command, "artifact-review");
  assert.equal(parsed.ok, true);
  assert.deepEqual(Object.keys(parsed).sort(), [
    "command",
    "generated_at",
    "limitations",
    "next_actions",
    "ok",
    "quick_depth",
    "readiness",
    "scope",
    "scorecard",
  ].sort());
  assert.doesNotMatch(stdout, new RegExp(home.replaceAll("/", "\\/")));
});

test("telemetry artifact-review quality-gate rejects invalid arguments", async () => {
  await assert.rejects(
    execBin(["telemetry", "artifact-review", "quality-gate", "--bad"], {
      env: { ...process.env, HOME: CLI_TEST_HOME },
    }),
    (error) => {
      assert.match(error.stderr, /Unknown telemetry artifact-review quality-gate argument/);
      return true;
    },
  );
});
```

- [ ] **Step 2: Verify RED**

Run:

```bash
node --test --test-name-pattern "telemetry artifact-review quality-gate" test/cli.test.mjs
```

Expected: FAIL because the nested command is not routed.

- [ ] **Step 3: Implement CLI route**

In `src/cli.mjs`:

- Import `artifactReviewQualityGateToText` and `runArtifactReviewQualityGate`.
- Add usage line:

```js
"  gemini-agent telemetry artifact-review quality-gate [--global] [--json] [--top <n>]",
```

- Add parser function:

```js
function parseTelemetryArtifactReviewQualityGateArgs(args = []) {
  const options = { global: false, json: false, top: 10 };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--global") options.global = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--top") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--top must be a positive integer.");
      options.top = parsePositiveInteger(value, "--top");
      index += 1;
    } else {
      throw new Error(`Unknown telemetry artifact-review quality-gate argument: ${arg}`);
    }
  }
  return options;
}
```

- Add command runner:

```js
async function runTelemetryArtifactReviewQualityGateCommand(args = []) {
  const options = parseTelemetryArtifactReviewQualityGateArgs(args);
  const gate = await runArtifactReviewQualityGate({
    cwd: process.cwd(),
    global: options.global,
    topLimit: options.top,
  });
  if (options.json) writeJson(gate);
  else process.stdout.write(`${artifactReviewQualityGateToText(gate)}\n`);
}
```

- Dispatch nested telemetry command:

```js
} else if (subcommand === "artifact-review" && subArgs[0] === "quality-gate") {
  await runTelemetryArtifactReviewQualityGateCommand(subArgs.slice(1));
```

- [ ] **Step 4: Verify GREEN**

Run:

```bash
node --test --test-name-pattern "telemetry artifact-review quality-gate" test/cli.test.mjs
```

Expected: PASS.

## Task 4: README And Package Tests

**Files:**
- Modify: `README.md`
- Modify: `test/package.test.mjs`

- [ ] **Step 1: Write failing README assertions**

In `test/package.test.mjs`, add:

```js
assert.match(readme, /^\.\/bin\/gemini-agent telemetry artifact-review quality-gate --global --json$/m);
assert.match(readme, /`telemetry artifact-review quality-gate` reports aggregate quick-depth readiness/);
```

- [ ] **Step 2: Verify RED**

Run:

```bash
node --test test/package.test.mjs --test-name-pattern "README documents telemetry summary"
```

Expected: FAIL until README is updated.

- [ ] **Step 3: Update README**

Add command example to the command block:

```bash
./bin/gemini-agent telemetry artifact-review quality-gate --global --json
```

Add safety bullet:

```md
- `telemetry artifact-review quality-gate` reports aggregate quick-depth readiness, risky budget cohorts, and design scorecard coverage without exposing raw prompts, raw responses, event ids, paths, or media file names.
```

- [ ] **Step 4: Verify GREEN**

Run:

```bash
node --test test/package.test.mjs --test-name-pattern "README documents telemetry summary"
```

Expected: PASS.

## Task 5: Full Verification And Review

**Files:**
- All changed files.

- [ ] **Step 1: Run targeted tests**

Run:

```bash
node --test test/telemetry-artifact-review-quality-gate.test.mjs
node --test --test-name-pattern "telemetry artifact-review quality-gate" test/cli.test.mjs
node --test test/package.test.mjs --test-name-pattern "README documents telemetry summary"
```

Expected: all PASS.

- [ ] **Step 2: Run whitespace and full tests**

Run:

```bash
git diff --check
npm test
```

Expected: `git diff --check` exits 0 and full test suite exits 0.

- [ ] **Step 3: Run Gemini diff review**

Run:

```bash
./bin/gemini-agent diff-review --auto-context-pack --diff
```

Expected: `verdict` is `pass` or only non-blocking cautions that are addressed or justified.

- [ ] **Step 4: Flush telemetry safely**

Run:

```bash
./bin/gemini-agent telemetry doctor --global --json
./bin/gemini-agent telemetry flush --global --dry-run --batch-size 1
./bin/gemini-agent telemetry flush --global --batch-size 1
./bin/gemini-agent telemetry doctor --global --json
```

Expected: final doctor reports no pending, failed, inflight, or quarantine events.

- [ ] **Step 5: Commit implementation**

Run:

```bash
git add README.md src/cli.mjs src/telemetry-artifact-review-quality-gate.mjs test/cli.test.mjs test/package.test.mjs test/telemetry-artifact-review-quality-gate.test.mjs
git commit -m "Add artifact review quality gate"
```

Expected: commit succeeds and tracked worktree is clean except unrelated pre-existing untracked files.

## Self-Review

- Spec coverage: command, data source, decision model, JSON/text output, privacy boundary, error handling, tests, and out-of-scope items are covered by tasks.
- No implementation relies on raw prompts, raw responses, server APIs, screenshot files, or artifact JSON files.
- The plan keeps output construction strict and aggregate-only.
- The implementation can ship independently before any automatic routing changes.
