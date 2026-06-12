import assert from "node:assert/strict";
import test from "node:test";
import {
  artifactReviewQualityGateToText,
  buildArtifactReviewQualityGate,
} from "../src/telemetry-artifact-review-quality-gate.mjs";

const PRIVATE_TEXT = "private prompt /Users/example Authorization: Bearer secret-token evt_private media.png";

function summary(overrides = {}) {
  return {
    scope: "local",
    storage_cwd: "/tmp/private-storage",
    generated_at: "2026-06-12T00:00:00.000Z",
    event_counts: { total: 0 },
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
    "generation_latency",
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

test("quality gate reports high generation latency but prioritizes scorecard coverage first", () => {
  const gate = buildArtifactReviewQualityGate(summary({
    event_counts: { total: 26 },
    artifact_review_quality: {
      event_count: 20,
      scorecard_event_count: 2,
      avg_overall_score: 58,
      avg_implementation_readiness_score: 38,
      scorecard_field_coverage: [
        { field: "overall_score", events: 20, scored_events: 2, coverage: 0.1 },
        { field: "accessibility_score", events: 20, scored_events: 1, coverage: 0.05 },
      ],
      top_commands: [],
    },
    artifact_review_depths: {
      event_count: 12,
      known_depth_event_count: 12,
      top_depths: [
        {
          review_depth: "quick",
          event_count: 12,
          success_count: 12,
          error_count: 0,
          p95_latency_ms: 20000,
          total_tokens: 24000,
          scorecard_event_count: 2,
        },
      ],
      top_budget_cohorts: [
        {
          review_depth: "quick",
          budget_cohort: "2048",
          event_count: 12,
          success_count: 12,
          error_count: 0,
          p95_latency_ms: 20000,
          total_tokens: 24000,
          scorecard_event_count: 2,
        },
      ],
    },
    latency_stages: {
      stage_count: 12,
      top_stages: [
        {
          stage: "gemini_generation",
          event_count: 6,
          p50_ms: 16000,
          p95_ms: 21000,
          max_ms: 22000,
          top_commands: [
            { command: "artifact-review", event_count: 6, p50_ms: 16000, p95_ms: 21000, max_ms: 22000 },
          ],
        },
        {
          stage: "pre_gemini_total",
          event_count: 6,
          p50_ms: 10,
          p95_ms: 25,
          max_ms: 25,
          top_commands: [
            { command: "artifact-review", event_count: 6, p50_ms: 10, p95_ms: 25, max_ms: 25 },
          ],
        },
      ],
    },
  }));

  assert.equal(gate.readiness.status, "caution");
  assert.ok(gate.readiness.reasons.includes("generation_latency_over_budget"));
  assert.equal(gate.generation_latency.status, "over_budget");
  assert.equal(gate.generation_latency.event_count, 6);
  assert.equal(gate.generation_latency.p95_ms, 21000);
  assert.equal(gate.generation_latency.pre_gemini_p95_ms, 25);
  assert.ok(gate.next_actions.some((item) => /Raise scorecard coverage before prompt\/schema slimming/i.test(item)));
  assert.equal(gate.next_actions.some((item) => /Start prompt\/schema slimming/i.test(item)), false);
});

test("quality gate recommends prompt/schema latency work after scorecard coverage is healthy", () => {
  const gate = buildArtifactReviewQualityGate(summary({
    event_counts: { total: 30 },
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
      event_count: 12,
      known_depth_event_count: 12,
      top_depths: [
        {
          review_depth: "quick",
          event_count: 12,
          success_count: 12,
          error_count: 0,
          p95_latency_ms: 20000,
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
          p95_latency_ms: 20000,
          total_tokens: 24000,
          scorecard_event_count: 11,
        },
      ],
    },
    latency_stages: {
      stage_count: 6,
      top_stages: [
        {
          stage: "gemini_generation",
          event_count: 6,
          p50_ms: 16000,
          p95_ms: 21000,
          max_ms: 22000,
          top_commands: [
            { command: "artifact-review", event_count: 6, p50_ms: 16000, p95_ms: 21000, max_ms: 22000 },
          ],
        },
      ],
    },
  }));

  assert.equal(gate.readiness.status, "caution");
  assert.deepEqual(gate.readiness.reasons, ["generation_latency_over_budget"]);
  assert.equal(gate.generation_latency.status, "over_budget");
  assert.ok(gate.next_actions.some((item) => /Start prompt\/schema slimming/i.test(item)));
  assert.equal(gate.next_actions.some((item) => /Raise scorecard coverage before prompt\/schema slimming/i.test(item)), false);
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
          event_count: 7,
          success_count: 3,
          error_count: 4,
          p95_latency_ms: 12217,
          total_tokens: 21924,
          scorecard_event_count: 1,
        },
      ],
      top_budget_cohorts: [
        {
          review_depth: "quick",
          budget_cohort: "2048",
          event_count: 5,
          success_count: 3,
          error_count: 2,
          p95_latency_ms: 12383,
          total_tokens: 15000,
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
  assert.equal(gate.quick_depth.error_rate, 0.5714);
  assert.equal(gate.quick_depth.active_error_rate, 0.4);
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

test("quality gate treats non-active quick budget cohort failures as historical risk", () => {
  const gate = buildArtifactReviewQualityGate(summary({
    event_counts: { total: 36 },
    artifact_review_quality: {
      event_count: 18,
      scorecard_event_count: 16,
      avg_overall_score: 82,
      avg_implementation_readiness_score: 78,
      scorecard_field_coverage: [
        { field: "overall_score", events: 18, scored_events: 16, coverage: 0.8889 },
        { field: "accessibility_score", events: 18, scored_events: 15, coverage: 0.8333 },
      ],
      top_commands: [],
    },
    artifact_review_depths: {
      event_count: 18,
      known_depth_event_count: 18,
      top_depths: [
        {
          review_depth: "quick",
          event_count: 18,
          success_count: 16,
          error_count: 2,
          p95_latency_ms: 12217,
          total_tokens: 42924,
          scorecard_event_count: 16,
        },
      ],
      top_budget_cohorts: [
        {
          review_depth: "quick",
          budget_cohort: "2048",
          max_output_tokens: 2048,
          event_count: 16,
          success_count: 16,
          error_count: 0,
          p95_latency_ms: 9000,
          total_tokens: 36000,
          scorecard_event_count: 16,
        },
        {
          review_depth: "quick",
          budget_cohort: "768",
          max_output_tokens: 768,
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

  assert.equal(gate.readiness.status, "ready");
  assert.deepEqual(gate.readiness.reasons, ["quick_depth_ready"]);
  assert.equal(gate.quick_depth.active_budget_cohort.budget_cohort, "2048");
  assert.equal(gate.quick_depth.active_budget_cohort.error_rate, 0);
  assert.equal(gate.quick_depth.historical_risky_budget_cohorts.length, 1);
  assert.equal(gate.quick_depth.historical_risky_budget_cohorts[0].budget_cohort, "768");
  assert.ok(gate.next_actions.some((item) => /current 2048 quick budget cohort/i.test(item)));
  assert.ok(gate.next_actions.some((item) => /historical 768 quick budget cohort/i.test(item)));
});

test("quality gate treats quick single and quick comparison budgets as active cohorts", () => {
  const gate = buildArtifactReviewQualityGate(summary({
    event_counts: { total: 35 },
    artifact_review_quality: {
      event_count: 20,
      scorecard_event_count: 18,
      avg_overall_score: 82,
      avg_implementation_readiness_score: 79,
      scorecard_field_coverage: [
        { field: "overall_score", events: 20, scored_events: 18, coverage: 0.9 },
        { field: "accessibility_score", events: 20, scored_events: 17, coverage: 0.85 },
      ],
      top_commands: [],
    },
    artifact_review_depths: {
      event_count: 15,
      known_depth_event_count: 15,
      top_depths: [
        {
          review_depth: "quick",
          event_count: 15,
          success_count: 13,
          error_count: 2,
          p95_latency_ms: 12217,
          total_tokens: 36000,
          scorecard_event_count: 13,
        },
      ],
      top_budget_cohorts: [
        {
          review_depth: "quick",
          budget_cohort: "2048",
          max_output_tokens: 2048,
          event_count: 10,
          success_count: 10,
          error_count: 0,
          p95_latency_ms: 9000,
          total_tokens: 22000,
          scorecard_event_count: 10,
        },
        {
          review_depth: "quick",
          budget_cohort: "4096",
          max_output_tokens: 4096,
          event_count: 3,
          success_count: 3,
          error_count: 0,
          p95_latency_ms: 12000,
          total_tokens: 9000,
          scorecard_event_count: 3,
        },
        {
          review_depth: "quick",
          budget_cohort: "768",
          max_output_tokens: 768,
          event_count: 2,
          success_count: 0,
          error_count: 2,
          p95_latency_ms: 12217,
          total_tokens: 5000,
          scorecard_event_count: 0,
        },
      ],
    },
  }));

  assert.equal(gate.readiness.status, "caution");
  assert.ok(gate.readiness.reasons.includes("quick_budget_cohort_low_confidence"));
  assert.equal(gate.quick_depth.active_event_count, 13);
  assert.equal(gate.quick_depth.active_error_rate, 0);
  assert.deepEqual(
    gate.quick_depth.active_budget_cohorts.map((cohort) => cohort.budget_cohort),
    ["2048", "4096"],
  );
  assert.equal(gate.quick_depth.historical_risky_budget_cohorts.length, 1);
  assert.equal(gate.quick_depth.historical_risky_budget_cohorts[0].budget_cohort, "768");
  assert.ok(gate.next_actions.some((item) => /current 2048\/4096 quick budget cohorts/i.test(item)));
  assert.ok(gate.next_actions.some((item) => /historical 768 quick budget cohort/i.test(item)));
});

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
        {
          review_depth: "quick",
          event_count: 1,
          success_count: 1,
          error_count: 0,
          p95_latency_ms: 1000,
          total_tokens: 100,
        },
      ],
      top_budget_cohorts: [],
    },
  }));
  const text = artifactReviewQualityGateToText(gate);
  assert.match(text, /Artifact-review quality gate: caution/);
  assert.match(text, /Quick depth:/);
  assert.match(text, /Active quick budget cohort:/);
  assert.match(text, /Scorecard coverage:/);
  assert.doesNotMatch(text, /private prompt|Authorization|Bearer|evt_|\/Users\/|media\.png/);
});
