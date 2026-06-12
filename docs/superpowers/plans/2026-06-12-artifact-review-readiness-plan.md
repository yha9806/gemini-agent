# Artifact Review Readiness Plan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `gemini-agent telemetry artifact-review readiness-plan` so operators get one aggregate decision for blocked, collect-more-samples, or ready-for-limited-routing.

**Architecture:** Add one focused readiness module that composes existing telemetry summary, quality-gate, coverage-plan, doctor, and raw-preflight outputs. Keep privacy safety by projecting only whitelisted aggregate fields, then expose the module through the existing CLI telemetry artifact-review command family.

**Tech Stack:** Node.js ESM, `node:test`, existing telemetry queue/config modules, existing CLI parser helpers.

---

## File Structure

- Create `src/telemetry-artifact-review-readiness-plan.mjs`: pure report builder, async runner, and text formatter.
- Create `test/telemetry-artifact-review-readiness-plan.test.mjs`: module-level TDD tests for status rules, raw governance, structured-response diagnostics, whitelist shape, and leakage protection.
- Modify `src/cli.mjs`: import readiness module, parse `readiness-plan` arguments, add route and help text.
- Modify `test/cli.test.mjs`: CLI text, JSON, global scope, and argument validation tests.
- Modify `README.md`: document the new command, privacy boundary, and non-routing behavior.
- Modify `test/package.test.mjs`: README command and behavior assertions.

Do not modify `src/artifact-review.mjs`, `src/gemini-client.mjs`, or routing policy in this implementation. A2 readiness uses existing artifact-review structured retry and scorecard metadata; it does not change Gemini calls.

## Task 1: Module Tests For Readiness Decisions

**Files:**
- Create: `test/telemetry-artifact-review-readiness-plan.test.mjs`
- Later implementation: `src/telemetry-artifact-review-readiness-plan.mjs`

- [ ] **Step 1: Write failing module tests**

Create `test/telemetry-artifact-review-readiness-plan.test.mjs` with these tests:

```js
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { saveTelemetryConfig } from "../src/telemetry-config.mjs";
import {
  artifactReviewReadinessPlanToText,
  buildArtifactReviewReadinessPlan,
  runArtifactReviewReadinessPlan,
} from "../src/telemetry-artifact-review-readiness-plan.mjs";

const PRIVATE_TEXT = "raw prompt /home/example Authorization: Bearer secret-token evt_private private.png batch_private";

function scorecard({
  eventCount = 0,
  scorecardEventCount = 0,
  coverage = null,
  fieldCoverage = coverage,
} = {}) {
  return {
    event_count: eventCount,
    scorecard_event_count: scorecardEventCount,
    coverage_rate: coverage,
    field_coverage_min: fieldCoverage,
    weakest_field: fieldCoverage === null ? null : {
      field: "accessibility_score",
      event_count: eventCount,
      scored_event_count: scorecardEventCount,
      coverage_rate: fieldCoverage,
    },
    target_coverage_rate: 0.8,
    events_needed_for_target: eventCount > 0
      ? Math.max(0, Math.ceil(eventCount * 0.8) - scorecardEventCount)
      : null,
  };
}

function coveragePlan(overrides = {}) {
  return {
    ok: true,
    scope: "local",
    generated_at: "2026-06-12T00:00:00.000Z",
    command: "artifact-review",
    plan: {
      status: "ready_for_more_collection",
      reasons: ["production_scorecard_coverage_low", "active_quick_low_sample"],
    },
    production_scorecard: scorecard({
      eventCount: 160,
      scorecardEventCount: 10,
      coverage: 0.0625,
      fieldCoverage: 0.0625,
    }),
    validation_scorecard: {
      ...scorecard({
        eventCount: 5,
        scorecardEventCount: 3,
        coverage: 0.6,
        fieldCoverage: 0.6,
      }),
      events_needed_for_target: undefined,
    },
    active_quick_collection: {
      active_budget_cohorts: [
        {
          budget_cohort: "2048",
          event_count: 4,
          success_count: 4,
          error_count: 0,
          error_rate: 0,
          additional_events_needed: 6,
          low_confidence: true,
        },
      ],
      target_events_per_cohort: 10,
      additional_events_needed: 6,
      active_error_rate: 0,
      low_confidence: true,
    },
    latency_guard: {
      status: "within_budget",
      p95_ms: 14055,
      budget_ms: 15000,
      near_budget: true,
    },
    historical_risks: [],
    next_actions: [],
    limitations: [],
    ...overrides,
  };
}

function summary(overrides = {}) {
  return {
    scope: "local",
    generated_at: "2026-06-12T00:00:00.000Z",
    structured_response: {
      event_count: 30,
      missing_json_envelope_count: 1,
      missing_json_envelope_rate: 0.0333,
      retry_event_count: 0,
      retry_scheduled_count: 0,
      retry_recovered_count: 0,
      retry_recovery_rate: null,
      top_commands: [
        {
          command: "artifact-review",
          event_count: 4,
          missing_json_envelope_count: 1,
          retry_event_count: 0,
          retry_recovered_count: 0,
        },
      ],
    },
    private_raw: PRIVATE_TEXT,
    ...overrides,
  };
}

function doctor(overrides = {}) {
  return {
    ok: true,
    scope: "local",
    delivery: {
      status: "flush_ready",
      pending_events: 9,
      failed_events: 0,
      quarantine_events: 0,
      recommended_action: "Run telemetry flush --dry-run, then telemetry flush --batch-size 1.",
    },
    queue: {
      pending: { count: 9, bytes: 494396 },
      failed: { count: 0, bytes: 0 },
      quarantine: { count: 0, bytes: 0 },
    },
    small_flush_safe: true,
    recommended_action: "Run telemetry flush --dry-run, then telemetry flush --batch-size 1.",
    checks: {
      config_valid: { ok: true },
      config_enabled: { ok: true },
      token_env_valid: { ok: true },
      token_env_present: { ok: true },
      endpoint_valid: { ok: true },
    },
    endpoint_check: { ok: true, status: 200 },
    storage_cwd: "/home/example",
    ...overrides,
  };
}

function rawPreflight(overrides = {}) {
  return {
    ok: true,
    scope: "local",
    pending: { total_count: 9, total_bytes: 494396 },
    batch: {
      batch_size: 9,
      would_send_count: 9,
      batch_bytes: 494396,
      exceeds_max_bytes: false,
      excluded_by_batch_size_count: 0,
      preview_error: null,
    },
    risk: {
      file_count: 9,
      sensitive_signal_count: 9,
      sensitive_scan_truncated_count: 2,
      credential_like_prompt_count: 2,
      path_like_prompt_count: 2,
      phone_like_prompt_count: 3,
      phone_like_response_count: 2,
    },
    next_command: "gemini-agent telemetry flush --dry-run --batch-size 9",
    limitations: [],
    ...overrides,
  };
}

test("readiness plan returns collect_more_samples for current A2-shaped data", () => {
  const report = buildArtifactReviewReadinessPlan({
    summary: summary(),
    coveragePlan: coveragePlan(),
    doctor: doctor(),
    rawPreflight: rawPreflight(),
  });

  assert.equal(report.ok, true);
  assert.equal(report.command, "artifact-review");
  assert.equal(report.readiness.status, "collect_more_samples");
  assert.equal(report.routing_recommendation.limited_routing_allowed, false);
  assert.equal(report.routing_recommendation.production_sampling_allowed, true);
  assert.equal(report.routing_recommendation.additional_quick_samples_needed, 6);
  assert.deepEqual(report.routing_recommendation.recommended_budget_cohorts, ["2048"]);
  assert.ok(report.readiness.reasons.includes("active_quick_low_sample"));
  assert.ok(report.readiness.reasons.includes("production_scorecard_coverage_low"));
  assert.ok(report.readiness.reasons.includes("structured_response_unrecovered_json_envelope"));
  assert.ok(report.readiness.reasons.includes("raw_pending_sensitive_signals"));
  assert.ok(report.readiness.reasons.includes("generation_latency_near_budget"));
  assert.doesNotMatch(JSON.stringify(report), /raw prompt|Authorization|Bearer|evt_private|private\.png|batch_private|\/home\/example/);
});

test("readiness plan blocks unsafe active quick reliability", () => {
  const report = buildArtifactReviewReadinessPlan({
    summary: summary({ structured_response: { event_count: 0, top_commands: [] } }),
    coveragePlan: coveragePlan({
      active_quick_collection: {
        active_budget_cohorts: [
          {
            budget_cohort: "2048",
            event_count: 10,
            success_count: 9,
            error_count: 1,
            error_rate: 0.1,
            additional_events_needed: 0,
            low_confidence: false,
          },
        ],
        target_events_per_cohort: 10,
        additional_events_needed: 0,
        active_error_rate: 0.1,
        low_confidence: false,
      },
    }),
    doctor: doctor({ queue: { pending: { count: 0 }, failed: { count: 0 }, quarantine: { count: 0 } } }),
    rawPreflight: rawPreflight({
      pending: { total_count: 0, total_bytes: 0 },
      batch: { would_send_count: 0 },
      risk: { sensitive_signal_count: 0 },
    }),
  });

  assert.equal(report.readiness.status, "blocked");
  assert.ok(report.readiness.reasons.includes("active_quick_error_rate_high"));
  assert.equal(report.routing_recommendation.production_sampling_allowed, false);
});

test("readiness plan requires production scorecard coverage even with healthy validation", () => {
  const report = buildArtifactReviewReadinessPlan({
    summary: summary({
      structured_response: {
        event_count: 4,
        missing_json_envelope_count: 0,
        retry_event_count: 1,
        retry_recovered_count: 1,
        retry_recovery_rate: 1,
        top_commands: [],
      },
    }),
    coveragePlan: coveragePlan({
      validation_scorecard: {
        ...scorecard({ eventCount: 5, scorecardEventCount: 5, coverage: 1, fieldCoverage: 1 }),
        events_needed_for_target: undefined,
      },
      active_quick_collection: {
        active_budget_cohorts: [
          {
            budget_cohort: "2048",
            event_count: 10,
            success_count: 10,
            error_count: 0,
            error_rate: 0,
            additional_events_needed: 0,
            low_confidence: false,
          },
        ],
        target_events_per_cohort: 10,
        additional_events_needed: 0,
        active_error_rate: 0,
        low_confidence: false,
      },
      latency_guard: {
        status: "within_budget",
        p95_ms: 12000,
        budget_ms: 15000,
        near_budget: false,
      },
    }),
    doctor: doctor({ queue: { pending: { count: 0 }, failed: { count: 0 }, quarantine: { count: 0 } } }),
    rawPreflight: rawPreflight({
      pending: { total_count: 0, total_bytes: 0 },
      batch: { would_send_count: 0 },
      risk: { sensitive_signal_count: 0 },
    }),
  });

  assert.equal(report.readiness.status, "collect_more_samples");
  assert.ok(report.readiness.reasons.includes("production_scorecard_coverage_low"));
  assert.equal(report.routing_recommendation.limited_routing_allowed, false);
});

test("readiness plan becomes ready only when every hard gate passes", () => {
  const report = buildArtifactReviewReadinessPlan({
    summary: summary({
      structured_response: {
        event_count: 12,
        missing_json_envelope_count: 0,
        missing_json_envelope_rate: 0,
        retry_event_count: 1,
        retry_scheduled_count: 1,
        retry_recovered_count: 1,
        retry_recovery_rate: 1,
        top_commands: [],
      },
    }),
    coveragePlan: coveragePlan({
      production_scorecard: scorecard({ eventCount: 20, scorecardEventCount: 18, coverage: 0.9, fieldCoverage: 0.85 }),
      validation_scorecard: {
        ...scorecard({ eventCount: 5, scorecardEventCount: 5, coverage: 1, fieldCoverage: 1 }),
        events_needed_for_target: undefined,
      },
      active_quick_collection: {
        active_budget_cohorts: [
          {
            budget_cohort: "2048",
            event_count: 12,
            success_count: 12,
            error_count: 0,
            error_rate: 0,
            additional_events_needed: 0,
            low_confidence: false,
          },
        ],
        target_events_per_cohort: 10,
        additional_events_needed: 0,
        active_error_rate: 0,
        low_confidence: false,
      },
      latency_guard: {
        status: "within_budget",
        p95_ms: 12000,
        budget_ms: 15000,
        near_budget: false,
      },
    }),
    doctor: doctor({ queue: { pending: { count: 0 }, failed: { count: 0 }, quarantine: { count: 0 } }, small_flush_safe: false }),
    rawPreflight: rawPreflight({
      pending: { total_count: 0, total_bytes: 0 },
      batch: { would_send_count: 0 },
      risk: { sensitive_signal_count: 0 },
    }),
  });

  assert.equal(report.readiness.status, "ready_for_limited_routing");
  assert.deepEqual(report.readiness.reasons, ["artifact_review_ready_for_limited_routing"]);
  assert.equal(report.routing_recommendation.limited_routing_allowed, true);
  assert.equal(report.routing_recommendation.production_sampling_allowed, true);
});

test("readiness plan text uses aggregate fields only", () => {
  const report = buildArtifactReviewReadinessPlan({
    summary: summary(),
    coveragePlan: coveragePlan(),
    doctor: doctor(),
    rawPreflight: rawPreflight(),
  });
  const text = artifactReviewReadinessPlanToText(report);

  assert.match(text, /Artifact-review readiness plan: collect_more_samples/);
  assert.match(text, /Limited routing: no/);
  assert.match(text, /Production sampling: yes/);
  assert.match(text, /collect 6 more quick 2048 samples/);
  assert.doesNotMatch(text, /raw prompt|Authorization|Bearer|evt_private|private\.png|batch_private|\/home\/example/);
});

test("runArtifactReviewReadinessPlan degrades when endpoint diagnostics fail", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-readiness-runner-"));
  try {
    await saveTelemetryConfig({
      cwd,
      endpoint: "http://127.0.0.1:8787/ingest",
      tokenEnv: "GEMINI_AGENT_TELEMETRY_TOKEN",
      deploymentId: "gemini-agent-main",
    });

    const report = await runArtifactReviewReadinessPlan({
      cwd,
      env: { GEMINI_AGENT_TELEMETRY_TOKEN: "local-token" },
      fetchImpl: async () => {
        throw new Error("offline");
      },
      doctorTimeoutMs: 25,
      now: new Date("2026-06-12T00:00:00.000Z"),
    });

    assert.equal(report.ok, true);
    assert.equal(report.readiness.status, "collect_more_samples");
    assert.equal(report.raw_governance.failed_count, 0);
    assert.equal(report.routing_recommendation.limited_routing_allowed, false);
    assert.doesNotMatch(JSON.stringify(report), new RegExp(cwd.replaceAll("/", "\\/")));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the failing module test**

Run:

```bash
node --test test/telemetry-artifact-review-readiness-plan.test.mjs
```

Expected: FAIL with `Cannot find module '../src/telemetry-artifact-review-readiness-plan.mjs'`.

- [ ] **Step 3: Commit the failing test**

```bash
git add test/telemetry-artifact-review-readiness-plan.test.mjs
git commit -m "test readiness plan decisions"
```

## Task 2: Implement The Readiness Report Module

**Files:**
- Create: `src/telemetry-artifact-review-readiness-plan.mjs`
- Modify only if needed by tests: `test/telemetry-artifact-review-readiness-plan.test.mjs`

- [ ] **Step 1: Add module imports and constants**

Create `src/telemetry-artifact-review-readiness-plan.mjs`:

```js
import { buildArtifactReviewCoveragePlan } from "./telemetry-artifact-review-coverage-plan.mjs";
import { buildArtifactReviewQualityGate } from "./telemetry-artifact-review-quality-gate.mjs";
import { runTelemetryDoctor } from "./telemetry-doctor.mjs";
import { runTelemetryRawPreflight } from "./telemetry-raw-preflight.mjs";
import { runTelemetrySummary } from "./telemetry-summary.mjs";

const SCORECARD_TARGET_COVERAGE = 0.8;
const ACTIVE_QUICK_TARGET_EVENTS_PER_COHORT = 10;
const ACTIVE_QUICK_MAX_ERROR_RATE = 0.05;
const LATENCY_NEAR_BUDGET_RATIO = 0.9;
const ACTIVE_QUICK_DEFAULT_BUDGET = "2048";

const LIMITATIONS = [
  "Readiness plan uses aggregate local telemetry only; no raw prompts, responses, event ids, paths, or media file names are included.",
  "The command recommends sampling or routing posture but does not call Gemini, upload raw telemetry, or change routing.",
  "Validation coverage is calibration evidence only and cannot prove production readiness.",
  "Small-flush readiness is a delivery signal, not a privacy guarantee.",
];
```

- [ ] **Step 2: Add safe numeric and formatting helpers**

Append:

```js
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

function safeReason(value) {
  const text = `${value ?? ""}`.trim();
  return /^[a-z0-9_]{1,96}$/.test(text) ? text : "unknown_reason";
}

function uniqueReasons(reasons) {
  return [...new Set(reasons.map(safeReason).filter((reason) => reason !== "unknown_reason"))];
}

function safeBudgetCohort(value) {
  const text = `${value ?? ""}`.trim();
  if (/^\d{1,6}$/.test(text)) return text;
  if (text === "unknown" || text === "unbounded") return text;
  return "unknown";
}
```

- [ ] **Step 3: Add whitelisted projection helpers**

Append:

```js
function cloneScorecard(section = {}) {
  const weakest = section.weakest_field && typeof section.weakest_field === "object"
    ? {
        field: /^[A-Za-z0-9_]{1,64}$/.test(`${section.weakest_field.field ?? ""}`)
          ? `${section.weakest_field.field}`
          : "unknown",
        event_count: nonnegativeInteger(section.weakest_field.event_count),
        scored_event_count: nonnegativeInteger(section.weakest_field.scored_event_count),
        coverage_rate: nullableNumber(section.weakest_field.coverage_rate),
      }
    : null;
  const result = {
    event_count: nonnegativeInteger(section.event_count),
    scorecard_event_count: nonnegativeInteger(section.scorecard_event_count),
    coverage_rate: nullableNumber(section.coverage_rate),
    field_coverage_min: nullableNumber(section.field_coverage_min),
    weakest_field: weakest,
    target_coverage_rate: nullableNumber(section.target_coverage_rate) ?? SCORECARD_TARGET_COVERAGE,
  };
  if (Object.hasOwn(section, "events_needed_for_target")) {
    result.events_needed_for_target = section.events_needed_for_target === null
      ? null
      : nonnegativeInteger(section.events_needed_for_target);
  }
  return result;
}

function cloneActiveQuick(section = {}) {
  const cohorts = Array.isArray(section.active_budget_cohorts)
    ? section.active_budget_cohorts.map((cohort) => ({
        budget_cohort: safeBudgetCohort(cohort.budget_cohort),
        event_count: nonnegativeInteger(cohort.event_count),
        success_count: nonnegativeInteger(cohort.success_count),
        error_count: nonnegativeInteger(cohort.error_count),
        error_rate: nullableNumber(cohort.error_rate)
          ?? ratio(nonnegativeInteger(cohort.error_count), nonnegativeInteger(cohort.success_count) + nonnegativeInteger(cohort.error_count)),
        additional_events_needed: nonnegativeInteger(cohort.additional_events_needed),
        low_confidence: cohort.low_confidence === true,
      }))
    : [];
  return {
    active_budget_cohorts: cohorts,
    target_events_per_cohort: nonnegativeInteger(section.target_events_per_cohort) || ACTIVE_QUICK_TARGET_EVENTS_PER_COHORT,
    additional_events_needed: nonnegativeInteger(section.additional_events_needed),
    active_error_rate: nullableNumber(section.active_error_rate),
    low_confidence: section.low_confidence !== false,
  };
}

function cloneLatency(section = {}) {
  const p95 = nullableNumber(section.p95_ms);
  const budget = nullableNumber(section.budget_ms) ?? 15000;
  return {
    status: typeof section.status === "string" ? section.status : "unknown",
    p95_ms: p95,
    budget_ms: budget,
    near_budget: section.near_budget === true || (p95 !== null && budget > 0 && p95 >= budget * LATENCY_NEAR_BUDGET_RATIO),
  };
}
```

- [ ] **Step 4: Add structured-response and raw-governance projections**

Append:

```js
function structuredResponseSection(summary = {}) {
  const structured = summary.structured_response && typeof summary.structured_response === "object"
    ? summary.structured_response
    : {};
  const topCommands = Array.isArray(structured.top_commands) ? structured.top_commands : [];
  const artifactRow = topCommands.find((row) => row?.command === "artifact-review") ?? null;
  const missing = nonnegativeInteger(
    artifactRow?.missing_json_envelope_count ?? structured.missing_json_envelope_count,
  );
  const eventCount = nonnegativeInteger(artifactRow?.event_count ?? structured.event_count);
  const retryEventCount = nonnegativeInteger(artifactRow?.retry_event_count ?? structured.retry_event_count);
  const retryRecoveredCount = nonnegativeInteger(artifactRow?.retry_recovered_count ?? structured.retry_recovered_count);
  const retryScheduledCount = nonnegativeInteger(structured.retry_scheduled_count);
  return {
    event_count: eventCount,
    missing_json_envelope_count: missing,
    missing_json_envelope_rate: nullableNumber(structured.missing_json_envelope_rate) ?? ratio(missing, eventCount),
    retry_event_count: retryEventCount,
    retry_scheduled_count: retryScheduledCount,
    retry_recovered_count: retryRecoveredCount,
    retry_recovery_rate: nullableNumber(structured.retry_recovery_rate) ?? ratio(retryRecoveredCount, retryEventCount),
    affected_command: "artifact-review",
  };
}

function rawGovernanceSection({ doctor = null, rawPreflight = null } = {}) {
  const queue = doctor?.queue && typeof doctor.queue === "object" ? doctor.queue : {};
  const delivery = doctor?.delivery && typeof doctor.delivery === "object" ? doctor.delivery : {};
  const risk = rawPreflight?.risk && typeof rawPreflight.risk === "object" ? rawPreflight.risk : {};
  const pendingCount = nonnegativeInteger(queue.pending?.count ?? delivery.pending_events ?? rawPreflight?.pending?.total_count);
  const failedCount = nonnegativeInteger(queue.failed?.count ?? delivery.failed_events);
  const quarantineCount = nonnegativeInteger(queue.quarantine?.count ?? delivery.quarantine_events);
  const sensitiveSignalCount = nonnegativeInteger(risk.sensitive_signal_count);
  return {
    pending_count: pendingCount,
    failed_count: failedCount,
    quarantine_count: quarantineCount,
    small_flush_safe: doctor?.small_flush_safe === true,
    preflight_available: rawPreflight?.ok === true,
    preflight_selected_count: nonnegativeInteger(rawPreflight?.batch?.would_send_count ?? risk.file_count),
    sensitive_signal_count: sensitiveSignalCount,
    recommended_action: typeof doctor?.recommended_action === "string" && doctor.recommended_action.trim()
      ? doctor.recommended_action.trim()
      : null,
  };
}
```

- [ ] **Step 5: Add status and next-action logic**

Append:

```js
function buildReadinessReasons({
  production,
  validation,
  quick,
  latency,
  structured,
  raw,
  doctor,
}) {
  const blocked = [];
  const collect = [];

  if (quick.active_error_rate !== null && quick.active_error_rate >= ACTIVE_QUICK_MAX_ERROR_RATE) {
    blocked.push("active_quick_error_rate_high");
  }
  if (latency.status === "over_budget") blocked.push("generation_latency_over_budget");
  if (production.event_count > 0 && production.scorecard_event_count === 0) {
    blocked.push("production_scorecard_coverage_zero");
  }
  if (raw.failed_count > 0) blocked.push("raw_failed_events_present");
  if (raw.quarantine_count > 0) blocked.push("raw_quarantine_events_present");
  if (doctor && doctor.ok === false) blocked.push("telemetry_delivery_unhealthy");
  if (raw.pending_count > 0 && raw.sensitive_signal_count > 0) {
    blocked.push("raw_pending_sensitive_signals");
  }

  if (quick.low_confidence || quick.additional_events_needed > 0) collect.push("active_quick_low_sample");
  if (production.coverage_rate === null || production.coverage_rate < SCORECARD_TARGET_COVERAGE) {
    collect.push("production_scorecard_coverage_low");
  }
  if (production.field_coverage_min === null || production.field_coverage_min < SCORECARD_TARGET_COVERAGE) {
    collect.push("production_scorecard_field_coverage_low");
  }
  if (latency.near_budget) collect.push("generation_latency_near_budget");
  if (structured.missing_json_envelope_count > structured.retry_recovered_count) {
    collect.push("structured_response_unrecovered_json_envelope");
  }
  if (
    validation.coverage_rate !== null
    && production.coverage_rate !== null
    && validation.coverage_rate > production.coverage_rate
  ) {
    collect.push("validation_healthier_than_production");
  }

  return {
    blocked: uniqueReasons(blocked),
    collect: uniqueReasons(collect),
  };
}

function statusFor({ blocked, collect, production, quick, latency, structured, raw, doctor }) {
  if (blocked.length > 0) return "blocked";
  const scorecardReady = production.coverage_rate !== null
    && production.coverage_rate >= SCORECARD_TARGET_COVERAGE
    && production.field_coverage_min !== null
    && production.field_coverage_min >= SCORECARD_TARGET_COVERAGE;
  const quickReady = quick.active_budget_cohorts.length > 0
    && quick.additional_events_needed === 0
    && quick.low_confidence === false
    && quick.active_error_rate !== null
    && quick.active_error_rate < ACTIVE_QUICK_MAX_ERROR_RATE;
  const latencyReady = latency.status === "within_budget" && latency.near_budget === false;
  const structuredReady = structured.missing_json_envelope_count <= structured.retry_recovered_count;
  const rawReady = raw.failed_count === 0
    && raw.quarantine_count === 0
    && (raw.pending_count === 0 || (raw.preflight_available && raw.sensitive_signal_count === 0));
  const deliveryReady = !doctor || doctor.ok !== false;
  if (scorecardReady && quickReady && latencyReady && structuredReady && rawReady && deliveryReady) {
    return "ready_for_limited_routing";
  }
  if (collect.length > 0 || production.event_count === 0 || quick.active_budget_cohorts.length === 0) {
    return "collect_more_samples";
  }
  return "collect_more_samples";
}

function routingRecommendation({ status, quick }) {
  const activeCohorts = quick.active_budget_cohorts.length
    ? quick.active_budget_cohorts.map((cohort) => cohort.budget_cohort)
    : [ACTIVE_QUICK_DEFAULT_BUDGET];
  return {
    limited_routing_allowed: status === "ready_for_limited_routing",
    production_sampling_allowed: status !== "blocked",
    additional_quick_samples_needed: quick.additional_events_needed,
    recommended_review_depth: "quick",
    recommended_budget_cohorts: activeCohorts,
  };
}

function nextActionsFor({ status, quick, structured, raw, latency, production }) {
  const actions = [];
  const cohort = quick.active_budget_cohorts[0]?.budget_cohort ?? ACTIVE_QUICK_DEFAULT_BUDGET;
  if (status === "ready_for_limited_routing") {
    actions.push("Allow limited artifact-review routing with standard fallback and continued readiness monitoring.");
    return actions;
  }
  if (status === "blocked") {
    actions.push("Do not expand artifact-review routing until blocked readiness reasons are resolved.");
  }
  if (quick.additional_events_needed > 0) {
    actions.push(`Collect ${formatNumber(quick.additional_events_needed)} more quick ${cohort} production samples before limited routing.`);
  }
  if (production.coverage_rate === null || production.coverage_rate < SCORECARD_TARGET_COVERAGE) {
    actions.push("Require numeric design scorecards on new production artifact-review runs.");
  }
  if (structured.missing_json_envelope_count > structured.retry_recovered_count) {
    actions.push("Verify artifact-review structured JSON retry recovery before wider routing.");
  }
  if (raw.pending_count > 0) {
    actions.push("Run raw telemetry preflight, then use reveal/export/delete/prune or small-batch flush workflows before broad routing.");
  }
  if (latency.near_budget) {
    actions.push(`Watch artifact-review generation latency; p95 is ${formatNumber(latency.p95_ms)} ms against a ${formatNumber(latency.budget_ms)} ms budget.`);
  }
  return actions.length ? actions : ["Keep collecting aggregate artifact-review telemetry."];
}
```

- [ ] **Step 6: Add exported builder, runner, and formatter**

Append:

```js
export function buildArtifactReviewReadinessPlan({
  summary = {},
  qualityGate = null,
  coveragePlan = null,
  doctor = null,
  rawPreflight = null,
} = {}) {
  const gate = qualityGate ?? buildArtifactReviewQualityGate(summary);
  const coverage = coveragePlan ?? buildArtifactReviewCoveragePlan(summary, gate);
  const production = cloneScorecard(coverage.production_scorecard);
  const validation = cloneScorecard(coverage.validation_scorecard);
  const quick = cloneActiveQuick(coverage.active_quick_collection);
  const latency = cloneLatency(coverage.latency_guard);
  const structured = structuredResponseSection(summary);
  const raw = rawGovernanceSection({ doctor, rawPreflight });
  const reasonGroups = buildReadinessReasons({
    production,
    validation,
    quick,
    latency,
    structured,
    raw,
    doctor,
  });
  const status = statusFor({
    blocked: reasonGroups.blocked,
    collect: reasonGroups.collect,
    production,
    quick,
    latency,
    structured,
    raw,
    doctor,
  });
  const reasons = status === "ready_for_limited_routing"
    ? ["artifact_review_ready_for_limited_routing"]
    : uniqueReasons([...reasonGroups.blocked, ...reasonGroups.collect]);

  return {
    ok: true,
    scope: summary?.scope === "global" ? "global" : "local",
    generated_at: typeof summary?.generated_at === "string" ? summary.generated_at : new Date(0).toISOString(),
    command: "artifact-review",
    readiness: { status, reasons },
    production_scorecard: production,
    validation_scorecard: validation,
    active_quick_collection: quick,
    structured_response: structured,
    latency_guard: latency,
    raw_governance: raw,
    routing_recommendation: routingRecommendation({ status, quick }),
    next_actions: nextActionsFor({ status, quick, structured, raw, latency, production }),
    limitations: LIMITATIONS,
  };
}

export async function runArtifactReviewReadinessPlan({
  cwd = process.cwd(),
  home,
  scope = "auto",
  now = new Date(),
  topLimit = 10,
  env = process.env,
  fetchImpl = fetch,
  doctorTimeoutMs = 750,
} = {}) {
  const summary = await runTelemetrySummary({ cwd, home, scope, now, topLimit });
  const qualityGate = buildArtifactReviewQualityGate(summary);
  const coveragePlan = buildArtifactReviewCoveragePlan(summary, qualityGate);
  let doctor = null;
  let rawPreflight = null;
  try {
    doctor = await runTelemetryDoctor({
      cwd,
      home,
      scope,
      env,
      fetchImpl,
      timeoutMs: doctorTimeoutMs,
    });
  } catch {
    doctor = null;
  }
  try {
    rawPreflight = await runTelemetryRawPreflight({ cwd, home, scope, batchSize: 100, now });
  } catch {
    rawPreflight = null;
  }
  return buildArtifactReviewReadinessPlan({
    summary,
    qualityGate,
    coveragePlan,
    doctor,
    rawPreflight,
  });
}

export function artifactReviewReadinessPlanToText(report) {
  const quick = report.active_quick_collection;
  const routing = report.routing_recommendation;
  const cohort = routing.recommended_budget_cohorts[0] ?? ACTIVE_QUICK_DEFAULT_BUDGET;
  const lines = [
    `Artifact-review readiness plan: ${report.readiness.status}`,
    `- Limited routing: ${routing.limited_routing_allowed ? "yes" : "no"}`,
    `- Production sampling: ${routing.production_sampling_allowed ? "yes" : "no"}${routing.additional_quick_samples_needed > 0 ? `, collect ${formatNumber(routing.additional_quick_samples_needed)} more quick ${cohort} samples` : ""}`,
    `- Production scorecard coverage: ${formatPercent(report.production_scorecard.coverage_rate)} (${formatNumber(report.production_scorecard.scorecard_event_count)} of ${formatNumber(report.production_scorecard.event_count)})`,
    `- Structured response: ${formatNumber(report.structured_response.missing_json_envelope_count)} missing JSON-envelope events, ${formatNumber(report.structured_response.retry_recovered_count)} recovered`,
    `- Raw governance: ${formatNumber(report.raw_governance.pending_count)} pending, ${formatNumber(report.raw_governance.failed_count)} failed, ${formatNumber(report.raw_governance.quarantine_count)} quarantined`,
    `- Latency: ${report.latency_guard.status}, p95 ${report.latency_guard.p95_ms === null ? "n/a" : `${formatNumber(report.latency_guard.p95_ms)} ms`}, budget ${formatNumber(report.latency_guard.budget_ms)} ms${report.latency_guard.near_budget ? ", near budget" : ""}`,
  ];
  if (quick.active_budget_cohorts.length > 0) {
    lines.push(`- Active quick cohort: ${quick.active_budget_cohorts.map((row) => row.budget_cohort).join("/")} at ${formatPercent(quick.active_error_rate)} error`);
  }
  for (const action of report.next_actions) lines.push(`- Next action: ${action}`);
  lines.push("Limitations:");
  for (const limitation of report.limitations) lines.push(`- ${limitation}`);
  return lines.join("\n");
}
```

- [ ] **Step 7: Run module tests**

Run:

```bash
node --test test/telemetry-artifact-review-readiness-plan.test.mjs
```

Expected: PASS.

- [ ] **Step 8: Commit module implementation**

```bash
git add src/telemetry-artifact-review-readiness-plan.mjs test/telemetry-artifact-review-readiness-plan.test.mjs
git commit -m "Add artifact review readiness plan report"
```

## Task 3: CLI Route

**Files:**
- Modify: `src/cli.mjs`
- Modify: `test/cli.test.mjs`

- [ ] **Step 1: Add failing CLI tests**

Append these tests near the existing artifact-review coverage-plan CLI tests in `test/cli.test.mjs`:

```js
test("telemetry artifact-review readiness-plan outputs aggregate JSON", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-cli-readiness-plan-"));
  try {
    await saveTelemetryConfig({
      cwd,
      endpoint: "http://127.0.0.1:8787/ingest",
      tokenEnv: TELEMETRY_TOKEN_ENV,
      deploymentId: "gemini-agent-main",
    });
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(601, {
        command: "artifact-review",
        status: "success",
        prompt: "private prompt /home/example Authorization: Bearer secret-token",
        response: "private response media.png",
        latency_ms: 12000,
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
          latency_stages_ms: { gemini_generation: 12000 },
        },
      }),
    });

    const { stdout, stderr } = await execBin(["telemetry", "artifact-review", "readiness-plan", "--json"], { cwd });
    const parsed = JSON.parse(stdout);

    assert.equal(stderr, "");
    assert.equal(parsed.command, "artifact-review");
    assert.equal(parsed.ok, true);
    assert.equal(parsed.readiness.status, "collect_more_samples");
    assert.deepEqual(Object.keys(parsed).sort(), [
      "active_quick_collection",
      "command",
      "generated_at",
      "latency_guard",
      "limitations",
      "next_actions",
      "ok",
      "production_scorecard",
      "raw_governance",
      "readiness",
      "routing_recommendation",
      "scope",
      "structured_response",
      "validation_scorecard",
    ].sort());
    assert.doesNotMatch(stdout, /private prompt|private response|\/home\/example|secret-token|media\.png|evt_cli_601/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("telemetry artifact-review readiness-plan outputs text", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-cli-readiness-plan-text-"));
  try {
    await saveTelemetryConfig({
      cwd,
      endpoint: "http://127.0.0.1:8787/ingest",
      tokenEnv: TELEMETRY_TOKEN_ENV,
      deploymentId: "gemini-agent-main",
    });

    const { stdout, stderr } = await execBin(["telemetry", "artifact-review", "readiness-plan"], { cwd });

    assert.equal(stderr, "");
    assert.match(stdout, /Artifact-review readiness plan:/);
    assert.match(stdout, /Limited routing:/);
    assert.match(stdout, /Production sampling:/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("telemetry artifact-review readiness-plan rejects invalid arguments", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-cli-readiness-plan-args-"));
  try {
    await assert.rejects(
      () => execBin(["telemetry", "artifact-review", "readiness-plan", "--top", "0"], { cwd }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /--top requires a positive integer/);
        return true;
      },
    );
    await assert.rejects(
      () => execBin(["telemetry", "artifact-review", "readiness-plan", "--unknown"], { cwd }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /Unknown telemetry artifact-review readiness-plan argument/);
        return true;
      },
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the failing CLI tests**

Run:

```bash
node --test test/cli.test.mjs --test-name-pattern "readiness-plan"
```

Expected: FAIL with unknown command or missing route.

- [ ] **Step 3: Import readiness module in `src/cli.mjs`**

Add near existing artifact-review telemetry imports:

```js
import {
  artifactReviewReadinessPlanToText,
  runArtifactReviewReadinessPlan,
} from "./telemetry-artifact-review-readiness-plan.mjs";
```

- [ ] **Step 4: Add help text**

In the usage list near the quality-gate and coverage-plan lines, add:

```js
"  gemini-agent telemetry artifact-review readiness-plan [--global] [--json] [--top <n>]",
```

- [ ] **Step 5: Add parser**

After `parseTelemetryArtifactReviewCoveragePlanOptions`, add:

```js
function parseTelemetryArtifactReviewReadinessPlanOptions(args) {
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
      throw new Error(`Unknown telemetry artifact-review readiness-plan argument: ${arg}`);
    }
  }

  return options;
}
```

- [ ] **Step 6: Add command runner**

Near `runTelemetryArtifactReviewCoveragePlanCommand`, add:

```js
async function runTelemetryArtifactReviewReadinessPlanCommand(args) {
  const options = parseTelemetryArtifactReviewReadinessPlanOptions(args);
  const report = await runArtifactReviewReadinessPlan({
    cwd: process.cwd(),
    scope: options.global ? "global" : "auto",
    topLimit: options.topLimit,
  });
  output.write(options.json
    ? `${JSON.stringify(report, null, 2)}\n`
    : `${artifactReviewReadinessPlanToText(report)}\n`);
}
```

- [ ] **Step 7: Add route**

In `runTelemetry`, before coverage-plan or beside it, add:

```js
if (subcommand === "artifact-review" && subArgs[0] === "readiness-plan") {
  await runTelemetryArtifactReviewReadinessPlanCommand(subArgs.slice(1));
  return;
}
```

- [ ] **Step 8: Run CLI tests**

Run:

```bash
node --test test/cli.test.mjs --test-name-pattern "readiness-plan"
```

Expected: PASS.

- [ ] **Step 9: Commit CLI route**

```bash
git add src/cli.mjs test/cli.test.mjs
git commit -m "Expose artifact review readiness plan CLI"
```

## Task 4: README And Package Tests

**Files:**
- Modify: `README.md`
- Modify: `test/package.test.mjs`

- [ ] **Step 1: Add failing README assertions**

In `test/package.test.mjs`, extend the README assertions near existing artifact-review telemetry command checks:

```js
assert.match(readme, /^\.\/bin\/gemini-agent telemetry artifact-review readiness-plan --global --json$/m);
assert.match(readme, /`telemetry artifact-review readiness-plan` combines coverage-plan, quality-gate, structured-response, latency, and raw-governance signals/);
assert.match(readme, /The readiness plan does not run artifact-review samples, upload raw telemetry, or change routing by itself/);
```

- [ ] **Step 2: Run failing package test**

Run:

```bash
node --test test/package.test.mjs
```

Expected: FAIL because README lacks the new command text.

- [ ] **Step 3: Update README command list**

Add near the existing artifact-review telemetry examples:

```md
./bin/gemini-agent telemetry artifact-review readiness-plan --global --json
```

- [ ] **Step 4: Update README behavior bullets**

Add near the existing artifact-review telemetry bullets:

```md
- `telemetry artifact-review readiness-plan` combines coverage-plan, quality-gate, structured-response, latency, and raw-governance signals into one aggregate blocked / collect-more-samples / ready-for-limited-routing decision.
- The readiness plan does not run artifact-review samples, upload raw telemetry, or change routing by itself; Codex remains responsible for execution and release decisions.
```

- [ ] **Step 5: Run package test**

Run:

```bash
node --test test/package.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit README updates**

```bash
git add README.md test/package.test.mjs
git commit -m "Document artifact review readiness plan"
```

## Task 5: Verification And Final Review

**Files:**
- No new files unless tests reveal an issue.

- [ ] **Step 1: Run targeted readiness tests**

Run:

```bash
node --test test/telemetry-artifact-review-readiness-plan.test.mjs
node --test test/cli.test.mjs --test-name-pattern "readiness-plan"
node --test test/package.test.mjs
```

Expected: all PASS.

- [ ] **Step 2: Run full test suite**

Run:

```bash
npm test
```

Expected: all tests PASS.

- [ ] **Step 3: Run whitespace check**

Run:

```bash
git diff --check
```

Expected: no output and exit code 0.

- [ ] **Step 4: Run live aggregate command**

Run:

```bash
./bin/gemini-agent telemetry artifact-review readiness-plan --global --json
```

Expected:

- JSON parses successfully.
- `command` is `artifact-review`.
- `readiness.status` is a conservative aggregate decision for the current global data; `blocked` is valid when endpoint, raw-governance, latency, structured-response, or other hard gates are unhealthy.
- `routing_recommendation.limited_routing_allowed` is `false`.
- Output does not include raw prompts, raw responses, local paths, event ids, media file names, or credential-shaped strings.

- [ ] **Step 5: Use gemini-agent diff-review**

Run:

```bash
git diff --staged --quiet || true
git diff HEAD | ./bin/gemini-agent diff-review --stdin
```

Expected: Gemini returns `verdict: pass` or only actionable issues that are fixed before completion.

- [ ] **Step 6: Commit any verification fixes**

If verification required fixes, commit them:

```bash
git add src/telemetry-artifact-review-readiness-plan.mjs src/cli.mjs test/telemetry-artifact-review-readiness-plan.test.mjs test/cli.test.mjs README.md test/package.test.mjs
git commit -m "Stabilize artifact review readiness plan"
```

If there are no fixes, do not create an empty commit.

## Self-Review Notes

- Spec coverage: The plan implements the command, status model, JSON/text output, sample collection recommendation, structured-response gate, raw governance gate, privacy boundary, CLI errors, README docs, and live command verification.
- Scope: The plan does not add an automatic sampler, automatic routing, raw flush execution, server API changes, frontend changes, new Gemini calls, schema changes, or budget changes.
- Type consistency: The plan consistently uses `buildArtifactReviewReadinessPlan`, `runArtifactReviewReadinessPlan`, and `artifactReviewReadinessPlanToText`.
- Privacy: Tests include hostile strings and strict output-shape checks.
- Execution gate: Implementation should start only after the user chooses subagent-driven or inline execution.
