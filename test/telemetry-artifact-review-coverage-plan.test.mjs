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
          {
            field: "overall_score",
            event_count: eventCount,
            scored_event_count: scorecardEventCount,
            coverage_rate: coverage,
          },
          {
            field: "implementation_readiness_score",
            event_count: eventCount,
            scored_event_count: scorecardEventCount,
            coverage_rate: fieldCoverage,
          },
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
  assert.doesNotMatch(
    JSON.stringify(report),
    /raw prompt|Authorization|Bearer|evt_private|private\.png|\/Users\/example/,
  );
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

test("coverage plan uses routing artifact-review quality over historical backfill quality", () => {
  const report = buildArtifactReviewCoveragePlan(baseSummary({
    artifact_review_quality: scorecard({
      eventCount: 120,
      scorecardEventCount: 20,
      coverage: 0.1667,
      fieldCoverage: 0.1667,
      overall: 60,
      readiness: 45,
    }),
    artifact_review_routing_quality: scorecard({
      eventCount: 20,
      scorecardEventCount: 18,
      coverage: 0.9,
      fieldCoverage: 0.85,
      overall: 76,
      readiness: 74,
    }),
  }), qualityGate({
    readiness: { status: "ready", reasons: [] },
    quick_depth: {
      active_error_rate: 0,
      active_budget_cohorts: [
        {
          budget_cohort: "2048",
          event_count: 10,
          success_count: 10,
          error_count: 0,
          error_rate: 0,
          low_confidence: false,
        },
      ],
      historical_risky_budget_cohorts: [],
    },
    generation_latency: {
      status: "within_budget",
      event_count: 10,
      p95_ms: 12000,
      budget_ms: 15000,
      min_events: 5,
    },
  }));

  assert.equal(report.production_scorecard.event_count, 20);
  assert.equal(report.production_scorecard.scorecard_event_count, 18);
  assert.equal(report.production_scorecard.coverage_rate, 0.9);
  assert.equal(report.plan.reasons.includes("production_scorecard_coverage_low"), false);
  assert.equal(report.plan.status, "ready_for_limited_routing");
});

test("coverage plan blocks unsafe active quick reliability", () => {
  const report = buildArtifactReviewCoveragePlan(baseSummary({
    artifact_review_quality: scorecard({
      eventCount: 20,
      scorecardEventCount: 20,
      coverage: 1,
      fieldCoverage: 1,
    }),
  }), qualityGate({
    readiness: { status: "blocked", reasons: ["quick_depth_error_rate_high"] },
    quick_depth: {
      active_error_rate: 0.5,
      active_budget_cohorts: [
        {
          budget_cohort: "2048",
          event_count: 10,
          success_count: 5,
          error_count: 5,
          error_rate: 0.5,
          low_confidence: false,
        },
      ],
      historical_risky_budget_cohorts: [],
    },
  }));

  assert.equal(report.plan.status, "blocked");
  assert.ok(report.plan.reasons.includes("active_quick_reliability_unsafe"));
});

test("coverage plan reports near latency guard", () => {
  const report = buildArtifactReviewCoveragePlan(baseSummary({
    artifact_review_quality: scorecard({
      eventCount: 30,
      scorecardEventCount: 12,
      coverage: 0.4,
      fieldCoverage: 0.4,
    }),
  }), qualityGate({
    generation_latency: {
      status: "within_budget",
      event_count: 6,
      p95_ms: 14055,
      budget_ms: 15000,
      min_events: 5,
    },
  }));

  assert.equal(report.latency_guard.status, "within_budget");
  assert.equal(report.latency_guard.near_budget, true);
  assert.ok(report.plan.reasons.includes("generation_latency_near_budget"));
  assert.ok(report.next_actions.some((item) => /latency/i.test(item)));
});

test("coverage plan uses active quick latency for limited routing decisions", () => {
  const report = buildArtifactReviewCoveragePlan(baseSummary({
    artifact_review_routing_quality: scorecard({
      eventCount: 20,
      scorecardEventCount: 18,
      coverage: 0.9,
      fieldCoverage: 0.85,
    }),
  }), qualityGate({
    readiness: { status: "ready", reasons: [] },
    quick_depth: {
      active_error_rate: 0,
      active_budget_cohorts: [
        {
          budget_cohort: "2048",
          event_count: 10,
          success_count: 10,
          error_count: 0,
          error_rate: 0,
          p95_latency_ms: 12217,
          low_confidence: false,
        },
      ],
      historical_risky_budget_cohorts: [],
    },
    generation_latency: {
      status: "over_budget",
      event_count: 20,
      p95_ms: 15243,
      budget_ms: 15000,
      min_events: 5,
    },
  }));

  assert.equal(report.latency_guard.status, "within_budget");
  assert.equal(report.latency_guard.p95_ms, 12217);
  assert.equal(report.latency_guard.near_budget, false);
  assert.equal(report.plan.reasons.includes("generation_latency_over_budget"), false);
  assert.equal(report.plan.status, "ready_for_limited_routing");
});

test("coverage plan becomes ready for limited routing only when production and reliability pass", () => {
  const report = buildArtifactReviewCoveragePlan(baseSummary({
    artifact_review_quality: scorecard({
      eventCount: 20,
      scorecardEventCount: 18,
      coverage: 0.9,
      fieldCoverage: 0.85,
    }),
    artifact_review_validation_quality: scorecard({
      eventCount: 4,
      scorecardEventCount: 4,
      coverage: 1,
      fieldCoverage: 1,
    }),
  }), qualityGate({
    readiness: { status: "ready", reasons: ["quick_depth_ready"] },
    quick_depth: {
      active_error_rate: 0,
      active_budget_cohorts: [
        {
          budget_cohort: "2048",
          event_count: 12,
          success_count: 12,
          error_count: 0,
          error_rate: 0,
          low_confidence: false,
        },
      ],
      historical_risky_budget_cohorts: [],
    },
    generation_latency: {
      status: "within_budget",
      event_count: 6,
      p95_ms: 12000,
      budget_ms: 15000,
      min_events: 5,
    },
  }));

  assert.equal(report.plan.status, "ready_for_limited_routing");
  assert.deepEqual(report.plan.reasons, ["production_artifact_review_ready"]);
  assert.equal(report.active_quick_collection.additional_events_needed, 0);
  assert.ok(report.next_actions.some((item) => /ready for limited routing/i.test(item)));
});

test("coverage plan text uses aggregate fields only", () => {
  const report = buildArtifactReviewCoveragePlan(baseSummary({
    artifact_review_quality: scorecard({
      eventCount: 160,
      scorecardEventCount: 10,
      coverage: 0.0625,
      fieldCoverage: 0.0625,
    }),
    artifact_review_validation_quality: scorecard({
      eventCount: 5,
      scorecardEventCount: 5,
      coverage: 1,
      fieldCoverage: 1,
    }),
  }), qualityGate());
  const text = artifactReviewCoveragePlanToText(report);

  assert.match(text, /Artifact-review coverage plan: ready_for_more_collection/);
  assert.match(text, /Production scorecard coverage: 6\.3%/);
  assert.match(text, /Validation scorecard coverage: 100\.0%/);
  assert.doesNotMatch(text, /raw prompt|Authorization|Bearer|evt_private|private\.png|\/Users\/example/);
});
