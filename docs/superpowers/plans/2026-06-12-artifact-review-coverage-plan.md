# Artifact Review Coverage Plan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement and verify `gemini-agent telemetry artifact-review coverage-plan` so telemetry separates production and validation artifact-review scorecard coverage and recommends whether to expand real Gemini multimodal routing.

**Architecture:** Extend `telemetry summary` with validation-only artifact-review aggregate sections while preserving the existing product-adjusted production sections. Add a focused `telemetry-artifact-review-coverage-plan` module that consumes summary plus the existing quality gate, emits only whitelisted aggregate fields, and renders text/JSON output. Wire the command into the CLI beside `telemetry artifact-review quality-gate` and document the production-versus-validation safety boundary.

**Tech Stack:** Node.js ES modules, `node:test`, existing telemetry queue/summary helpers, existing CLI integration tests, README/package documentation tests, `gemini-agent diff-review`.

---

## File Map

- Modify `src/telemetry-summary.mjs`: add validation-only artifact-review quality/depth accumulators and expose `artifact_review_validation_quality` plus `artifact_review_validation_depths`.
- Modify `test/telemetry-summary.test.mjs`: prove validation artifact-review telemetry is aggregated separately and existing production-adjusted sections stay unchanged.
- Create `src/telemetry-artifact-review-coverage-plan.mjs`: build strict aggregate JSON, status/reasons, sample deficits, latency guard, text rendering, and `runArtifactReviewCoveragePlan`.
- Create `test/telemetry-artifact-review-coverage-plan.test.mjs`: unit tests for cold start, validation-versus-production separation, active cohort deficits, latency guard, ready path, and leak resistance.
- Modify `src/cli.mjs`: import the new module, parse `coverage-plan` options, add nested telemetry route, and render text/JSON.
- Modify `test/cli.test.mjs`: cover CLI text/JSON output and argument rejection.
- Modify `README.md`: add command examples and safety notes.
- Modify `test/package.test.mjs`: assert README coverage for the new command and validation boundary.

## Task 1: Summary Validation Artifact-Review Aggregates

**Files:**
- Modify: `src/telemetry-summary.mjs`
- Modify: `test/telemetry-summary.test.mjs`

- [ ] **Step 1: Write the failing summary test**

Add this test after the existing `runTelemetrySummary excludes validation events from product multimodal and artifact-review analytics` test in `test/telemetry-summary.test.mjs`:

```js
test("runTelemetrySummary exposes validation artifact-review aggregates separately", async () => {
  const cwd = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });

  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(57, {
      command: "artifact-review",
      status: "success",
      latency_ms: 10_000,
      payload: {
        prompt_truncated: false,
        response_truncated: false,
        multimodal: [{ mime_type: "image/png", byte_size: 1000, media_kind: "design" }],
      },
      economics: { input_tokens: 2000, output_tokens: 300, total_tokens: 2300 },
      metadata: {
        telemetry_purpose: "production",
        artifact_review_depth: "quick",
        artifact_review_max_output_tokens: 2048,
        design_scorecard: {
          overall_score: 80,
          visual_hierarchy_score: 81,
          clarity_score: 82,
          accessibility_score: 83,
          consistency_score: 84,
          implementation_readiness_score: 85,
        },
      },
    }),
  });
  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(58, {
      command: "artifact-review",
      status: "success",
      latency_ms: 11_000,
      payload: {
        prompt_truncated: false,
        response_truncated: false,
        multimodal: [{ mime_type: "image/png", byte_size: 1000, media_kind: "design" }],
      },
      economics: { input_tokens: 2100, output_tokens: 320, total_tokens: 2420 },
      metadata: {
        telemetry_purpose: "validation",
        artifact_review_depth: "quick",
        artifact_review_max_output_tokens: 2048,
        design_scorecard: {
          overall_score: 95,
          visual_hierarchy_score: 94,
          clarity_score: 93,
          accessibility_score: 92,
          consistency_score: 91,
          implementation_readiness_score: 90,
        },
      },
    }),
  });

  const summary = await runTelemetrySummary({ cwd, scope: "local" });
  const serialized = JSON.stringify(summary);

  assert.equal(summary.artifact_review_quality.event_count, 1);
  assert.equal(summary.artifact_review_quality.scorecard_event_count, 1);
  assert.equal(summary.artifact_review_quality.avg_overall_score, 80);
  assert.equal(summary.artifact_review_depths.event_count, 1);
  assert.equal(summary.artifact_review_depths.top_budget_cohorts[0].budget_cohort, "2048");

  assert.equal(summary.artifact_review_validation_quality.event_count, 1);
  assert.equal(summary.artifact_review_validation_quality.scorecard_event_count, 1);
  assert.equal(summary.artifact_review_validation_quality.avg_overall_score, 95);
  assert.equal(summary.artifact_review_validation_quality.avg_implementation_readiness_score, 90);
  assert.equal(summary.artifact_review_validation_quality.scorecard_field_coverage[0].coverage_rate, 1);
  assert.equal(summary.artifact_review_validation_depths.event_count, 1);
  assert.equal(summary.artifact_review_validation_depths.top_depths[0].review_depth, "quick");
  assert.equal(summary.artifact_review_validation_depths.top_budget_cohorts[0].budget_cohort, "2048");
  assert.equal(summary.artifact_review_validation_depths.top_budget_cohorts[0].avg_overall_score, 95);

  assert.doesNotMatch(serialized, /evt_000057|evt_000058|\/Users\/example|Authorization: Bearer|private-design/);
});
```

- [ ] **Step 2: Verify RED**

Run:

```bash
node --test test/telemetry-summary.test.mjs --test-name-pattern "validation artifact-review aggregates separately"
```

Expected: FAIL because `summary.artifact_review_validation_quality` is undefined.

- [ ] **Step 3: Refactor summary accumulators for production and validation**

In `src/telemetry-summary.mjs`, add these helpers near `createDesignScoreSums()`:

```js
function createArtifactReviewQualityAccumulator() {
  return {
    event_count: 0,
    success_count: 0,
    error_count: 0,
    scorecard_event_count: 0,
    scores: createDesignScoreSums(),
  };
}
```

In `createAccumulator`, replace the inline `artifactReviewQuality` object and add validation maps:

```js
    artifactReviewQuality: createArtifactReviewQualityAccumulator(),
    artifactReviewValidationQuality: createArtifactReviewQualityAccumulator(),
    artifactReviewQualityCommands: new Map(),
    artifactReviewValidationQualityCommands: new Map(),
    artifactReviewDepths: new Map(),
    artifactReviewValidationDepths: new Map(),
    artifactReviewBudgetCohorts: new Map(),
    artifactReviewValidationBudgetCohorts: new Map(),
```

Replace `addArtifactReviewDepthEvent(accumulator, event, status)` with a parameterized helper and wrappers:

```js
function addArtifactReviewDepthEventTo({ depths, budgetCohorts }, event, status) {
  const command = artifactReviewQualityCommand(event.command);
  if (!command) return;
  const depth = safeArtifactReviewDepth(event.metadata?.artifact_review_depth);
  const maxOutputTokens = safeMaxOutputTokens(event.metadata?.artifact_review_max_output_tokens);
  const item = depths.get(depth) ?? createArtifactReviewDepthItem(depth);
  item.event_count += 1;
  if (status === "success") item.success_count += 1;
  else if (status === "error") item.error_count += 1;
  else item.unknown_count += 1;

  const scores = designScorecardFromMetadata(event.metadata);
  if (scores) {
    item.scorecard_event_count += 1;
    addDesignScores(item.scores, scores);
  }
  if (Number.isInteger(event.latency_ms) && event.latency_ms >= 0) {
    item.latencyValues.push(event.latency_ms);
  }
  addUsageToAggregate(item.usage, event.economics);

  if (maxOutputTokens !== null) {
    item.maxOutputTokenSum += maxOutputTokens;
    item.maxOutputTokenCount += 1;
  }
  depths.set(depth, item);

  const cohort = artifactReviewBudgetCohort(depth, maxOutputTokens);
  const cohortKey = `${depth}\0${cohort.budgetCohort}`;
  const cohortItem = budgetCohorts.get(cohortKey)
    ?? createArtifactReviewBudgetCohortItem(depth, cohort.budgetCohort, cohort.publicMaxOutputTokens);
  cohortItem.event_count += 1;
  if (status === "success") cohortItem.success_count += 1;
  else if (status === "error") cohortItem.error_count += 1;
  else cohortItem.unknown_count += 1;
  if (scores) {
    cohortItem.scorecard_event_count += 1;
    addDesignScores(cohortItem.scores, scores);
  }
  if (Number.isInteger(event.latency_ms) && event.latency_ms >= 0) {
    cohortItem.latencyValues.push(event.latency_ms);
  }
  addUsageToAggregate(cohortItem.usage, event.economics);
  budgetCohorts.set(cohortKey, cohortItem);
}

function addArtifactReviewDepthEvent(accumulator, event, status) {
  addArtifactReviewDepthEventTo({
    depths: accumulator.artifactReviewDepths,
    budgetCohorts: accumulator.artifactReviewBudgetCohorts,
  }, event, status);
}

function addArtifactReviewValidationDepthEvent(accumulator, event, status) {
  addArtifactReviewDepthEventTo({
    depths: accumulator.artifactReviewValidationDepths,
    budgetCohorts: accumulator.artifactReviewValidationBudgetCohorts,
  }, event, status);
}
```

Replace `addArtifactReviewQualityEvent(accumulator, event, status)` with a parameterized helper and wrappers:

```js
function addArtifactReviewQualityEventTo({ quality, commands }, event, status) {
  const command = artifactReviewQualityCommand(event.command);
  if (!command) return;
  quality.event_count += 1;
  if (status === "success") quality.success_count += 1;
  else if (status === "error") quality.error_count += 1;

  const scores = designScorecardFromMetadata(event.metadata);
  if (scores) {
    quality.scorecard_event_count += 1;
    addDesignScores(quality.scores, scores);
  }
  updateArtifactReviewQualityCommand(commands, command, status, scores);
}

function addArtifactReviewQualityEvent(accumulator, event, status) {
  addArtifactReviewQualityEventTo({
    quality: accumulator.artifactReviewQuality,
    commands: accumulator.artifactReviewQualityCommands,
  }, event, status);
}

function addArtifactReviewValidationQualityEvent(accumulator, event, status) {
  addArtifactReviewQualityEventTo({
    quality: accumulator.artifactReviewValidationQuality,
    commands: accumulator.artifactReviewValidationQualityCommands,
  }, event, status);
}
```

In `addEvent`, replace the current artifact-review block:

```js
  if (!validation && isPaletteSplitEvent(event)) addPaletteSplitEvent(accumulator, event, status);
  if (!validation) {
    addArtifactReviewQualityEvent(accumulator, event, status);
    addArtifactReviewDepthEvent(accumulator, event, status);
  }
```

with:

```js
  if (!validation && isPaletteSplitEvent(event)) addPaletteSplitEvent(accumulator, event, status);
  if (validation) {
    addArtifactReviewValidationQualityEvent(accumulator, event, status);
    addArtifactReviewValidationDepthEvent(accumulator, event, status);
  } else {
    addArtifactReviewQualityEvent(accumulator, event, status);
    addArtifactReviewDepthEvent(accumulator, event, status);
  }
```

In `runTelemetrySummary`, build and return validation summaries beside existing production summaries:

```js
  const artifactReviewQuality = buildArtifactReviewQualitySummary(accumulator, topLimit);
  const artifactReviewValidationQuality = buildArtifactReviewQualitySummary({
    artifactReviewQuality: accumulator.artifactReviewValidationQuality,
    artifactReviewQualityCommands: accumulator.artifactReviewValidationQualityCommands,
  }, topLimit);
  const artifactReviewDepths = buildArtifactReviewDepthsSummary(accumulator, topLimit);
  const artifactReviewValidationDepths = buildArtifactReviewDepthsSummary({
    artifactReviewDepths: accumulator.artifactReviewValidationDepths,
    artifactReviewBudgetCohorts: accumulator.artifactReviewValidationBudgetCohorts,
  }, topLimit);
```

and add these keys to the returned object:

```js
    artifact_review_quality: artifactReviewQuality,
    artifact_review_validation_quality: artifactReviewValidationQuality,
    artifact_review_depths: artifactReviewDepths,
    artifact_review_validation_depths: artifactReviewValidationDepths,
```

- [ ] **Step 4: Verify GREEN**

Run:

```bash
node --test test/telemetry-summary.test.mjs --test-name-pattern "validation artifact-review aggregates separately|excludes validation events from product multimodal"
```

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/telemetry-summary.mjs test/telemetry-summary.test.mjs
git commit -m "Expose validation artifact review telemetry aggregates"
```

## Task 2: Coverage Plan Core Module

**Files:**
- Create: `src/telemetry-artifact-review-coverage-plan.mjs`
- Create: `test/telemetry-artifact-review-coverage-plan.test.mjs`

- [ ] **Step 1: Write failing unit tests**

Create `test/telemetry-artifact-review-coverage-plan.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import {
  artifactReviewCoveragePlanToText,
  buildArtifactReviewCoveragePlan,
} from "../src/telemetry-artifact-review-coverage-plan.mjs";

const PRIVATE_TEXT = "raw prompt /Users/example Authorization: Bearer secret-token evt_private private.png";

function scorecard({
  eventCount = 0,
  scorecardEventCount = 0,
  coverage = null,
  fieldCoverage = coverage,
  overall = null,
  readiness = null,
} = {}) {
  return {
    event_count: eventCount,
    scorecard_event_count: scorecardEventCount,
    avg_overall_score: overall,
    avg_implementation_readiness_score: readiness,
    scorecard_field_coverage: fieldCoverage === null
      ? []
      : [
          { field: "overall_score", event_count: eventCount, scored_event_count: scorecardEventCount, coverage_rate: coverage },
          { field: "implementation_readiness_score", event_count: eventCount, scored_event_count: scorecardEventCount, coverage_rate: fieldCoverage },
        ],
    top_commands: [],
  };
}

function baseSummary(overrides = {}) {
  return {
    scope: "local",
    generated_at: "2026-06-12T00:00:00.000Z",
    event_counts: { total: 0 },
    artifact_review_quality: scorecard(),
    artifact_review_validation_quality: scorecard(),
    artifact_review_depths: {
      event_count: 0,
      known_depth_event_count: 0,
      top_depths: [],
      top_budget_cohorts: [],
    },
    artifact_review_validation_depths: {
      event_count: 0,
      known_depth_event_count: 0,
      top_depths: [],
      top_budget_cohorts: [],
    },
    ...overrides,
  };
}

function qualityGate(overrides = {}) {
  return {
    ok: true,
    scope: "local",
    generated_at: "2026-06-12T00:00:00.000Z",
    command: "artifact-review",
    readiness: { status: "caution", reasons: ["quick_depth_low_sample"] },
    quick_depth: {
      active_error_rate: 0,
      active_budget_cohorts: [
        {
          budget_cohort: "2048",
          event_count: 4,
          success_count: 4,
          error_count: 0,
          error_rate: 0,
          low_confidence: true,
        },
      ],
      historical_risky_budget_cohorts: [
        {
          budget_cohort: "768",
          event_count: 2,
          success_count: 0,
          error_count: 2,
          error_rate: 1,
          low_confidence: true,
        },
      ],
    },
    generation_latency: {
      status: "within_budget",
      event_count: 6,
      p95_ms: 14055,
      budget_ms: 15000,
      min_events: 5,
    },
    scorecard: {},
    next_actions: [],
    limitations: [],
    ...overrides,
  };
}

test("coverage plan returns caution for empty telemetry without leaking raw data", () => {
  const report = buildArtifactReviewCoveragePlan(baseSummary({
    private_raw: PRIVATE_TEXT,
    artifact_review_quality: undefined,
    artifact_review_validation_quality: undefined,
  }), qualityGate({
    quick_depth: { active_budget_cohorts: [], historical_risky_budget_cohorts: [] },
    generation_latency: { status: "unknown", p95_ms: null, budget_ms: 15000 },
  }));

  assert.equal(report.ok, true);
  assert.equal(report.command, "artifact-review");
  assert.equal(report.plan.status, "caution");
  assert.ok(report.plan.reasons.includes("insufficient_artifact_review_data"));
  assert.deepEqual(Object.keys(report).sort(), [
    "active_quick_collection",
    "command",
    "generated_at",
    "historical_risks",
    "latency_guard",
    "limitations",
    "next_actions",
    "ok",
    "plan",
    "production_scorecard",
    "scope",
    "validation_scorecard",
  ].sort());
  assert.doesNotMatch(JSON.stringify(report), /raw prompt|Authorization|Bearer|evt_private|private\.png|\/Users\/example/);
});

test("validation coverage cannot make low production coverage ready for routing", () => {
  const report = buildArtifactReviewCoveragePlan(baseSummary({
    artifact_review_quality: scorecard({
      eventCount: 160,
      scorecardEventCount: 10,
      coverage: 0.0625,
      fieldCoverage: 0.0625,
      overall: 58,
      readiness: 38,
    }),
    artifact_review_validation_quality: scorecard({
      eventCount: 5,
      scorecardEventCount: 5,
      coverage: 1,
      fieldCoverage: 1,
      overall: 90,
      readiness: 88,
    }),
  }), qualityGate());

  assert.equal(report.plan.status, "ready_for_more_collection");
  assert.ok(report.plan.reasons.includes("production_scorecard_coverage_low"));
  assert.ok(report.plan.reasons.includes("validation_scorecard_coverage_healthy"));
  assert.equal(report.production_scorecard.coverage_rate, 0.0625);
  assert.equal(report.production_scorecard.events_needed_for_target, 118);
  assert.equal(report.validation_scorecard.coverage_rate, 1);
  assert.equal(report.active_quick_collection.additional_events_needed, 6);
  assert.deepEqual(report.historical_risks[0], {
    budget_cohort: "768",
    event_count: 2,
    error_count: 2,
    error_rate: 1,
  });
  assert.ok(report.next_actions.some((item) => /production artifact-review runs/i.test(item)));
  assert.equal(report.next_actions.some((item) => /ready for limited routing/i.test(item)), false);
});

test("coverage plan blocks unsafe active quick reliability", () => {
  const report = buildArtifactReviewCoveragePlan(baseSummary({
    artifact_review_quality: scorecard({ eventCount: 20, scorecardEventCount: 20, coverage: 1, fieldCoverage: 1 }),
  }), qualityGate({
    readiness: { status: "blocked", reasons: ["quick_depth_error_rate_high"] },
    quick_depth: {
      active_error_rate: 0.5,
      active_budget_cohorts: [
        { budget_cohort: "2048", event_count: 10, success_count: 5, error_count: 5, error_rate: 0.5, low_confidence: false },
      ],
      historical_risky_budget_cohorts: [],
    },
  }));

  assert.equal(report.plan.status, "blocked");
  assert.ok(report.plan.reasons.includes("active_quick_reliability_unsafe"));
});

test("coverage plan reports near latency guard", () => {
  const report = buildArtifactReviewCoveragePlan(baseSummary({
    artifact_review_quality: scorecard({ eventCount: 30, scorecardEventCount: 12, coverage: 0.4, fieldCoverage: 0.4 }),
  }), qualityGate({
    generation_latency: { status: "within_budget", event_count: 6, p95_ms: 14055, budget_ms: 15000, min_events: 5 },
  }));

  assert.equal(report.latency_guard.status, "within_budget");
  assert.equal(report.latency_guard.near_budget, true);
  assert.ok(report.plan.reasons.includes("generation_latency_near_budget"));
  assert.ok(report.next_actions.some((item) => /latency/i.test(item)));
});

test("coverage plan becomes ready for limited routing only when production and reliability pass", () => {
  const report = buildArtifactReviewCoveragePlan(baseSummary({
    artifact_review_quality: scorecard({ eventCount: 20, scorecardEventCount: 18, coverage: 0.9, fieldCoverage: 0.85 }),
    artifact_review_validation_quality: scorecard({ eventCount: 4, scorecardEventCount: 4, coverage: 1, fieldCoverage: 1 }),
  }), qualityGate({
    readiness: { status: "ready", reasons: ["quick_depth_ready"] },
    quick_depth: {
      active_error_rate: 0,
      active_budget_cohorts: [
        { budget_cohort: "2048", event_count: 12, success_count: 12, error_count: 0, error_rate: 0, low_confidence: false },
      ],
      historical_risky_budget_cohorts: [],
    },
    generation_latency: { status: "within_budget", event_count: 6, p95_ms: 12000, budget_ms: 15000, min_events: 5 },
  }));

  assert.equal(report.plan.status, "ready_for_limited_routing");
  assert.deepEqual(report.plan.reasons, ["production_artifact_review_ready"]);
  assert.equal(report.active_quick_collection.additional_events_needed, 0);
  assert.ok(report.next_actions.some((item) => /ready for limited routing/i.test(item)));
});

test("coverage plan text uses aggregate fields only", () => {
  const report = buildArtifactReviewCoveragePlan(baseSummary({
    artifact_review_quality: scorecard({ eventCount: 160, scorecardEventCount: 10, coverage: 0.0625, fieldCoverage: 0.0625 }),
    artifact_review_validation_quality: scorecard({ eventCount: 5, scorecardEventCount: 5, coverage: 1, fieldCoverage: 1 }),
  }), qualityGate());
  const text = artifactReviewCoveragePlanToText(report);

  assert.match(text, /Artifact-review coverage plan: ready_for_more_collection/);
  assert.match(text, /Production scorecard coverage: 6\.3%/);
  assert.match(text, /Validation scorecard coverage: 100\.0%/);
  assert.doesNotMatch(text, /raw prompt|Authorization|Bearer|evt_private|private\.png|\/Users\/example/);
});
```

- [ ] **Step 2: Verify RED**

Run:

```bash
node --test test/telemetry-artifact-review-coverage-plan.test.mjs
```

Expected: FAIL with module-not-found for `src/telemetry-artifact-review-coverage-plan.mjs`.

- [ ] **Step 3: Implement the coverage plan module**

Create `src/telemetry-artifact-review-coverage-plan.mjs` with these exports:

```js
import { buildArtifactReviewQualityGate, runArtifactReviewQualityGate } from "./telemetry-artifact-review-quality-gate.mjs";
import { runTelemetrySummary } from "./telemetry-summary.mjs";

const SCORECARD_TARGET_COVERAGE = 0.8;
const ACTIVE_QUICK_TARGET_EVENTS_PER_COHORT = 10;
const ACTIVE_QUICK_MAX_ERROR_RATE = 0.05;
const LATENCY_NEAR_BUDGET_RATIO = 0.9;

const LIMITATIONS = [
  "Coverage plan uses aggregate local telemetry only; no raw prompts, responses, event ids, paths, or media file names are included.",
  "Validation coverage is calibration evidence only and cannot prove production readiness.",
  "Codex remains responsible for routing, code changes, tests, commits, and final release decisions.",
];

function nonnegativeInteger(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function nullableNumber(value) {
  return Number.isFinite(value) ? Number(value) : null;
}

function ratio(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return Number((numerator / denominator).toFixed(4));
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatPercent(value) {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function safeField(value) {
  const text = `${value ?? ""}`.trim();
  return /^[A-Za-z0-9_]{1,64}$/.test(text) ? text : "unknown";
}

function normalizeWeakestField(rows = []) {
  const normalized = Array.isArray(rows)
    ? rows.map((row) => {
        const eventCount = nonnegativeInteger(row?.event_count ?? row?.events);
        const scoredEventCount = nonnegativeInteger(row?.scored_event_count ?? row?.scored_events);
        const coverage = nullableNumber(row?.coverage_rate ?? row?.coverage) ?? ratio(scoredEventCount, eventCount);
        return {
          field: safeField(row?.field),
          event_count: eventCount,
          scored_event_count: scoredEventCount,
          coverage_rate: coverage,
        };
      }).filter((row) => row.coverage_rate !== null)
    : [];
  return normalized.sort((left, right) => (
    left.coverage_rate - right.coverage_rate
    || right.event_count - left.event_count
    || left.field.localeCompare(right.field)
  ))[0] ?? null;
}

function scorecardSection(quality) {
  if (!quality || typeof quality !== "object" || Array.isArray(quality)) {
    return {
      event_count: 0,
      scorecard_event_count: 0,
      coverage_rate: null,
      field_coverage_min: null,
      weakest_field: null,
      target_coverage_rate: SCORECARD_TARGET_COVERAGE,
      events_needed_for_target: null,
    };
  }
  const eventCount = nonnegativeInteger(quality.event_count);
  const scorecardEventCount = nonnegativeInteger(quality.scorecard_event_count);
  const coverage = ratio(scorecardEventCount, eventCount);
  const weakest = normalizeWeakestField(quality.scorecard_field_coverage);
  const needed = eventCount > 0
    ? Math.max(0, Math.ceil(eventCount * SCORECARD_TARGET_COVERAGE) - scorecardEventCount)
    : null;
  return {
    event_count: eventCount,
    scorecard_event_count: scorecardEventCount,
    coverage_rate: coverage,
    field_coverage_min: weakest?.coverage_rate ?? null,
    weakest_field: weakest,
    target_coverage_rate: SCORECARD_TARGET_COVERAGE,
    events_needed_for_target: needed,
  };
}

function validationScorecardSection(quality) {
  const section = scorecardSection(quality);
  return {
    event_count: section.event_count,
    scorecard_event_count: section.scorecard_event_count,
    coverage_rate: section.coverage_rate,
    field_coverage_min: section.field_coverage_min,
    weakest_field: section.weakest_field,
    target_coverage_rate: section.target_coverage_rate,
  };
}

function safeBudgetCohort(value) {
  const text = `${value ?? "unknown"}`.trim();
  if (/^\d{1,6}$/.test(text)) return text;
  if (text === "unknown" || text === "unbounded") return text;
  return "unknown";
}

function activeQuickCollection(qualityGate) {
  const cohorts = Array.isArray(qualityGate?.quick_depth?.active_budget_cohorts)
    ? qualityGate.quick_depth.active_budget_cohorts
    : [];
  const activeBudgetCohorts = cohorts.map((cohort) => {
    const eventCount = nonnegativeInteger(cohort?.event_count);
    const successCount = nonnegativeInteger(cohort?.success_count);
    const errorCount = nonnegativeInteger(cohort?.error_count);
    return {
      budget_cohort: safeBudgetCohort(cohort?.budget_cohort),
      event_count: eventCount,
      success_count: successCount,
      error_count: errorCount,
      error_rate: nullableNumber(cohort?.error_rate) ?? ratio(errorCount, successCount + errorCount),
      additional_events_needed: Math.max(0, ACTIVE_QUICK_TARGET_EVENTS_PER_COHORT - eventCount),
      low_confidence: eventCount < ACTIVE_QUICK_TARGET_EVENTS_PER_COHORT,
    };
  });
  const totalSuccess = activeBudgetCohorts.reduce((sum, cohort) => sum + cohort.success_count, 0);
  const totalError = activeBudgetCohorts.reduce((sum, cohort) => sum + cohort.error_count, 0);
  return {
    active_budget_cohorts: activeBudgetCohorts,
    target_events_per_cohort: ACTIVE_QUICK_TARGET_EVENTS_PER_COHORT,
    additional_events_needed: activeBudgetCohorts.reduce((sum, cohort) => sum + cohort.additional_events_needed, 0),
    active_error_rate: nullableNumber(qualityGate?.quick_depth?.active_error_rate) ?? ratio(totalError, totalSuccess + totalError),
    low_confidence: activeBudgetCohorts.length > 0
      ? activeBudgetCohorts.some((cohort) => cohort.low_confidence)
      : true,
  };
}

function latencyGuard(qualityGate) {
  const latency = qualityGate?.generation_latency ?? {};
  const p95 = nullableNumber(latency.p95_ms);
  const budget = nullableNumber(latency.budget_ms) ?? 15000;
  return {
    status: typeof latency.status === "string" ? latency.status : "unknown",
    p95_ms: p95,
    budget_ms: budget,
    near_budget: p95 !== null && budget > 0 && p95 >= budget * LATENCY_NEAR_BUDGET_RATIO,
  };
}

function historicalRisks(qualityGate) {
  const rows = Array.isArray(qualityGate?.quick_depth?.historical_risky_budget_cohorts)
    ? qualityGate.quick_depth.historical_risky_budget_cohorts
    : [];
  return rows.map((row) => ({
    budget_cohort: safeBudgetCohort(row?.budget_cohort),
    event_count: nonnegativeInteger(row?.event_count),
    error_count: nonnegativeInteger(row?.error_count),
    error_rate: nullableNumber(row?.error_rate),
  }));
}

function buildReasons({ production, validation, quick, latency, qualityGate }) {
  const reasons = [];
  const hasAnyArtifactReviewData = production.event_count > 0
    || validation.event_count > 0
    || quick.active_budget_cohorts.length > 0;
  if (!hasAnyArtifactReviewData) reasons.push("insufficient_artifact_review_data");
  if (production.event_count > 0 && production.scorecard_event_count === 0) {
    reasons.push("production_scorecard_coverage_zero");
  } else if (
    production.event_count > 0
    && (production.coverage_rate === null || production.coverage_rate < SCORECARD_TARGET_COVERAGE)
  ) {
    reasons.push("production_scorecard_coverage_low");
  }
  if (production.field_coverage_min !== null && production.field_coverage_min < SCORECARD_TARGET_COVERAGE) {
    reasons.push("production_scorecard_field_coverage_low");
  }
  if (
    validation.event_count > 0
    && validation.coverage_rate !== null
    && validation.coverage_rate >= SCORECARD_TARGET_COVERAGE
    && validation.field_coverage_min !== null
    && validation.field_coverage_min >= SCORECARD_TARGET_COVERAGE
  ) {
    reasons.push("validation_scorecard_coverage_healthy");
  }
  const qualityReasons = Array.isArray(qualityGate?.readiness?.reasons) ? qualityGate.readiness.reasons : [];
  if (qualityReasons.includes("quick_depth_error_rate_high") || qualityReasons.includes("quick_budget_cohort_error_rate_high")) {
    reasons.push("active_quick_reliability_unsafe");
  }
  if (quick.low_confidence && quick.active_budget_cohorts.length > 0) {
    reasons.push("active_quick_low_sample");
  }
  if (latency.status === "over_budget") {
    reasons.push("generation_latency_over_budget");
  } else if (latency.near_budget) {
    reasons.push("generation_latency_near_budget");
  }
  return [...new Set(reasons)];
}

function statusFor({ production, quick, latency, reasons }) {
  if (
    reasons.includes("production_scorecard_coverage_zero")
    || reasons.includes("active_quick_reliability_unsafe")
    || reasons.includes("generation_latency_over_budget")
  ) {
    return "blocked";
  }
  const ready = production.coverage_rate !== null
    && production.coverage_rate >= SCORECARD_TARGET_COVERAGE
    && production.field_coverage_min !== null
    && production.field_coverage_min >= SCORECARD_TARGET_COVERAGE
    && quick.active_budget_cohorts.length > 0
    && !quick.low_confidence
    && quick.active_error_rate !== null
    && quick.active_error_rate < ACTIVE_QUICK_MAX_ERROR_RATE
    && latency.status === "within_budget"
    && !latency.near_budget;
  if (ready) return "ready_for_limited_routing";
  const cleanActiveQuick = quick.active_budget_cohorts.length > 0
    && quick.active_error_rate !== null
    && quick.active_error_rate < ACTIVE_QUICK_MAX_ERROR_RATE
    && !reasons.includes("generation_latency_over_budget");
  if (production.scorecard_event_count > 0 && cleanActiveQuick) return "ready_for_more_collection";
  return "caution";
}

function nextActionsFor({ status, production, validation, quick, latency, historical }) {
  if (status === "ready_for_limited_routing") {
    return ["Artifact-review is ready for limited routing expansion; keep standard fallback and monitor production scorecard coverage."];
  }
  const actions = [];
  if (production.event_count === 0) {
    actions.push("Run production artifact-review calls with telemetry enabled before deciding routing readiness.");
  } else if (production.coverage_rate === null || production.coverage_rate < SCORECARD_TARGET_COVERAGE) {
    actions.push(`Capture numeric design scorecards on production artifact-review runs; ${formatNumber(production.events_needed_for_target ?? 0)} current-denominator scorecards are needed for 80.0% coverage.`);
  }
  if (validation.coverage_rate !== null && validation.coverage_rate >= SCORECARD_TARGET_COVERAGE) {
    actions.push("Use validation scorecard coverage as calibration evidence only; do not treat it as production readiness.");
  }
  if (quick.additional_events_needed > 0 && quick.active_budget_cohorts.length > 0) {
    const labels = quick.active_budget_cohorts.map((cohort) => cohort.budget_cohort).join("/");
    actions.push(`Collect ${formatNumber(quick.additional_events_needed)} more active quick ${labels} production samples before wider routing.`);
  }
  if (historical.length > 0) {
    actions.push(`Keep historical ${historical[0].budget_cohort} quick budget failures visible, but judge current routing from active cohorts.`);
  }
  if (latency.status === "over_budget" || latency.near_budget) {
    actions.push(`Watch artifact-review Gemini generation latency; p95 is ${latency.p95_ms === null ? "n/a" : `${formatNumber(latency.p95_ms)} ms`} against a ${formatNumber(latency.budget_ms)} ms budget.`);
  }
  return actions.length ? actions : ["Keep collecting aggregate artifact-review telemetry before changing routing."];
}

export function buildArtifactReviewCoveragePlan(summary = {}, qualityGate = buildArtifactReviewQualityGate(summary)) {
  const production = scorecardSection(summary?.artifact_review_quality);
  const validation = validationScorecardSection(summary?.artifact_review_validation_quality);
  const quick = activeQuickCollection(qualityGate);
  const latency = latencyGuard(qualityGate);
  const historical = historicalRisks(qualityGate);
  const reasons = buildReasons({ production, validation, quick, latency, qualityGate });
  const status = statusFor({ production, quick, latency, reasons });
  return {
    ok: true,
    scope: summary?.scope === "global" ? "global" : "local",
    generated_at: typeof summary?.generated_at === "string" ? summary.generated_at : new Date(0).toISOString(),
    command: "artifact-review",
    plan: {
      status,
      reasons: status === "ready_for_limited_routing" ? ["production_artifact_review_ready"] : reasons,
    },
    production_scorecard: production,
    validation_scorecard: validation,
    active_quick_collection: quick,
    latency_guard: latency,
    historical_risks: historical,
    next_actions: nextActionsFor({ status, production, validation, quick, latency, historical }),
    limitations: LIMITATIONS,
  };
}

export async function runArtifactReviewCoveragePlan({
  cwd = process.cwd(),
  home,
  scope = "auto",
  now = new Date(),
  topLimit = 10,
} = {}) {
  const summary = await runTelemetrySummary({ cwd, home, scope, now, topLimit });
  const qualityGate = await runArtifactReviewQualityGate({ cwd, home, scope, now, topLimit });
  return buildArtifactReviewCoveragePlan(summary, qualityGate);
}

export function artifactReviewCoveragePlanToText(report) {
  const lines = [
    `Artifact-review coverage plan: ${report.plan.status}`,
    `- Production scorecard coverage: ${formatPercent(report.production_scorecard.coverage_rate)} (${formatNumber(report.production_scorecard.scorecard_event_count)} of ${formatNumber(report.production_scorecard.event_count)})`,
    `- Validation scorecard coverage: ${formatPercent(report.validation_scorecard.coverage_rate)} (${formatNumber(report.validation_scorecard.scorecard_event_count)} of ${formatNumber(report.validation_scorecard.event_count)})`,
    `- Active quick collection: ${formatNumber(report.active_quick_collection.additional_events_needed)} additional samples needed, active error ${formatPercent(report.active_quick_collection.active_error_rate)}`,
    `- Latency guard: ${report.latency_guard.status}, p95 ${report.latency_guard.p95_ms === null ? "n/a" : `${formatNumber(report.latency_guard.p95_ms)} ms`}, budget ${formatNumber(report.latency_guard.budget_ms)} ms${report.latency_guard.near_budget ? ", near budget" : ""}`,
  ];
  if (report.historical_risks.length > 0) {
    const risk = report.historical_risks[0];
    lines.push(`- Historical quick budget risk: ${risk.budget_cohort} at ${formatPercent(risk.error_rate)} error (${formatNumber(risk.error_count)} of ${formatNumber(risk.event_count)})`);
  }
  for (const action of report.next_actions) {
    lines.push(`- Next action: ${action}`);
  }
  lines.push("Limitations:");
  for (const limitation of report.limitations) {
    lines.push(`- ${limitation}`);
  }
  return lines.join("\n");
}
```

- [ ] **Step 4: Verify GREEN**

Run:

```bash
node --test test/telemetry-artifact-review-coverage-plan.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/telemetry-artifact-review-coverage-plan.mjs test/telemetry-artifact-review-coverage-plan.test.mjs
git commit -m "Add artifact review coverage plan report"
```

## Task 3: CLI Route

**Files:**
- Modify: `src/cli.mjs`
- Modify: `test/cli.test.mjs`

`test/cli.test.mjs` already imports `mkdtemp`, `tmpdir`, and `join`; the new tests can reuse those helpers without adding import lines.

- [ ] **Step 1: Write failing CLI tests**

Add tests near the `telemetry artifact-review quality-gate` CLI tests in `test/cli.test.mjs`:

```js
test("telemetry artifact-review coverage-plan outputs aggregate JSON", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-cli-coverage-plan-"));
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TELEMETRY_TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });
  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(501, {
      command: "artifact-review",
      status: "success",
      latency_ms: 12_000,
      metadata: {
        telemetry_purpose: "production",
        artifact_review_depth: "quick",
        artifact_review_max_output_tokens: 2048,
        design_scorecard: {
          overall_score: 80,
          visual_hierarchy_score: 81,
          clarity_score: 82,
          accessibility_score: 83,
          consistency_score: 84,
          implementation_readiness_score: 85,
        },
        latency_stages: {
          gemini_generation_ms: 12_000,
        },
      },
      economics: { input_tokens: 1000, output_tokens: 200, total_tokens: 1200 },
    }),
  });
  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(502, {
      command: "artifact-review",
      status: "success",
      metadata: {
        telemetry_purpose: "validation",
        artifact_review_depth: "quick",
        artifact_review_max_output_tokens: 2048,
        design_scorecard: {
          overall_score: 95,
          visual_hierarchy_score: 94,
          clarity_score: 93,
          accessibility_score: 92,
          consistency_score: 91,
          implementation_readiness_score: 90,
        },
      },
    }),
  });

  const { stdout, stderr } = await execBin(["telemetry", "artifact-review", "coverage-plan", "--json"], { cwd });
  const parsed = JSON.parse(stdout);

  assert.equal(stderr, "");
  assert.equal(parsed.command, "artifact-review");
  assert.equal(parsed.production_scorecard.event_count, 1);
  assert.equal(parsed.validation_scorecard.event_count, 1);
  assert.equal(parsed.validation_scorecard.coverage_rate, 1);
  assert.doesNotMatch(stdout, /evt_cli_501|evt_cli_502|Authorization|Bearer|private\.png/);
});

test("telemetry artifact-review coverage-plan outputs text", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-cli-coverage-plan-text-"));
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TELEMETRY_TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });

  const { stdout, stderr } = await execBin(["telemetry", "artifact-review", "coverage-plan"], { cwd });

  assert.equal(stderr, "");
  assert.match(stdout, /Artifact-review coverage plan:/);
  assert.match(stdout, /Production scorecard coverage:/);
  assert.match(stdout, /Validation scorecard coverage:/);
});

test("telemetry artifact-review coverage-plan rejects invalid arguments", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-cli-coverage-plan-args-"));
  await assert.rejects(
    () => execBin(["telemetry", "artifact-review", "coverage-plan", "--top", "0"], { cwd }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /--top requires a positive integer/);
      return true;
    },
  );
  await assert.rejects(
    () => execBin(["telemetry", "artifact-review", "coverage-plan", "--unknown"], { cwd }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Unknown telemetry artifact-review coverage-plan argument/);
      return true;
    },
  );
});
```

- [ ] **Step 2: Verify RED**

Run:

```bash
node --test --test-name-pattern "telemetry artifact-review coverage-plan" test/cli.test.mjs
```

Expected: FAIL because `coverage-plan` is not routed.

- [ ] **Step 3: Wire CLI imports, parser, command, and route**

In `src/cli.mjs`, add the import beside the quality-gate import:

```js
import {
  artifactReviewCoveragePlanToText,
  runArtifactReviewCoveragePlan,
} from "./telemetry-artifact-review-coverage-plan.mjs";
```

Add this usage line beside the quality-gate usage line:

```js
    "  gemini-agent telemetry artifact-review coverage-plan [--global] [--json] [--top <n>]",
```

Add this parser beside `parseTelemetryArtifactReviewQualityGateOptions`:

```js
function parseTelemetryArtifactReviewCoveragePlanOptions(args) {
  const options = {
    global: false,
    json: false,
    topLimit: 10,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--global") {
      options.global = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--top") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--top requires a positive integer.");
      options.topLimit = positiveIntegerOption(value, "--top");
      index += 1;
    } else {
      throw new Error(`Unknown telemetry artifact-review coverage-plan argument: ${arg}`);
    }
  }

  return options;
}
```

Add this command runner beside `runTelemetryArtifactReviewQualityGateCommand`:

```js
async function runTelemetryArtifactReviewCoveragePlanCommand(args = []) {
  const options = parseTelemetryArtifactReviewCoveragePlanOptions(args);
  const report = await runArtifactReviewCoveragePlan({
    cwd: process.cwd(),
    scope: telemetryScope(options),
    topLimit: options.topLimit,
  });
  output.write(options.json
    ? `${JSON.stringify(report, null, 2)}\n`
    : `${artifactReviewCoveragePlanToText(report)}\n`);
}
```

Add this nested route before the existing quality-gate route:

```js
  if (subcommand === "artifact-review" && subArgs[0] === "coverage-plan") {
    await runTelemetryArtifactReviewCoveragePlanCommand(subArgs.slice(1));
    return;
  }
```

- [ ] **Step 4: Verify GREEN**

Run:

```bash
node --test --test-name-pattern "telemetry artifact-review coverage-plan" test/cli.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit Task 3**

```bash
git add src/cli.mjs test/cli.test.mjs
git commit -m "Expose artifact review coverage plan CLI"
```

## Task 4: Documentation

**Files:**
- Modify: `README.md`
- Modify: `test/package.test.mjs`

- [ ] **Step 1: Write failing README assertions**

In `test/package.test.mjs`, add these assertions to the README telemetry test:

```js
  assert.match(readme, /^\.\/bin\/gemini-agent telemetry artifact-review coverage-plan --global --json$/m);
  assert.match(readme, /`telemetry artifact-review coverage-plan` separates production scorecard coverage from validation scorecard coverage/);
  assert.match(readme, /Validation artifact-review coverage is calibration evidence only and cannot prove production routing readiness/);
```

- [ ] **Step 2: Verify RED**

Run:

```bash
node --test test/package.test.mjs --test-name-pattern "README documents telemetry summary"
```

Expected: FAIL because README does not document `coverage-plan`.

- [ ] **Step 3: Update README**

Add this command in the telemetry examples near quality-gate:

```text
./bin/gemini-agent telemetry artifact-review coverage-plan --global --json
```

Add these bullets near the quality-gate bullets:

```markdown
- `telemetry artifact-review coverage-plan` separates production scorecard coverage from validation scorecard coverage, reports active quick cohort sample gaps, keeps historical quick budget failures visible, and recommends whether to collect more production samples or expand limited routing without exposing raw prompts, raw responses, event ids, paths, or media file names.
- Validation artifact-review coverage is calibration evidence only and cannot prove production routing readiness; production readiness depends on production scorecard coverage, active quick cohort reliability, and Gemini generation latency.
```

- [ ] **Step 4: Verify GREEN**

Run:

```bash
node --test test/package.test.mjs --test-name-pattern "README documents telemetry summary"
```

Expected: PASS.

- [ ] **Step 5: Commit Task 4**

```bash
git add README.md test/package.test.mjs
git commit -m "Document artifact review coverage plan"
```

## Task 5: Final Verification And Review

**Files:**
- No source edits unless verification finds a real issue.

- [ ] **Step 1: Run targeted tests**

Run:

```bash
node --test test/telemetry-summary.test.mjs --test-name-pattern "validation artifact-review aggregates separately|excludes validation events from product multimodal"
node --test test/telemetry-artifact-review-coverage-plan.test.mjs
node --test --test-name-pattern "telemetry artifact-review coverage-plan" test/cli.test.mjs
node --test test/package.test.mjs --test-name-pattern "README documents telemetry summary"
```

Expected: all PASS.

- [ ] **Step 2: Run full suite and whitespace check**

Run:

```bash
npm test
git diff --check
```

Expected: full suite PASS and no whitespace errors.

- [ ] **Step 3: Exercise the real global command**

Run:

```bash
./bin/gemini-agent telemetry artifact-review coverage-plan --global --json
```

Expected: JSON parses, includes `production_scorecard`, `validation_scorecard`, `active_quick_collection`, `latency_guard`, and does not print raw prompt/response text, event ids, paths, or media file names.

- [ ] **Step 4: Run Gemini diff-review**

Run:

```bash
git diff main...HEAD > /tmp/gemini-agent-a1-coverage-plan.diff
./bin/gemini-agent diff-review --auto-context-pack --file /tmp/gemini-agent-a1-coverage-plan.diff --max-input-bytes 400000
```

Expected: `verdict` is `pass`, or any actionable findings are fixed with tests before continuing.

- [ ] **Step 5: Commit verification fixes if needed**

If verification requires edits, make the smallest fix, rerun the relevant targeted test and `npm test`, then commit:

```bash
git add <changed-files>
git commit -m "Harden artifact review coverage plan"
```

If no fixes are needed, do not create an empty commit.
