import { buildArtifactReviewQualityGate } from "./telemetry-artifact-review-quality-gate.mjs";
import { runTelemetrySummary } from "./telemetry-summary.mjs";

const SCORECARD_TARGET_COVERAGE = 0.8;
const ACTIVE_QUICK_TARGET_EVENTS_PER_COHORT = 10;
const ACTIVE_QUICK_MAX_ERROR_RATE = 0.05;
const LATENCY_NEAR_BUDGET_RATIO = 0.9;

const LIMITATIONS = [
  "Coverage plan uses aggregate local telemetry only; no prompt or response content, event ids, paths, or media file names are included.",
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
    additional_events_needed: activeBudgetCohorts.reduce(
      (sum, cohort) => sum + cohort.additional_events_needed,
      0,
    ),
    active_error_rate: nullableNumber(qualityGate?.quick_depth?.active_error_rate)
      ?? ratio(totalError, totalSuccess + totalError),
    low_confidence: activeBudgetCohorts.length > 0
      ? activeBudgetCohorts.some((cohort) => cohort.low_confidence)
      : true,
  };
}

function latencyGuard(qualityGate) {
  const latency = qualityGate?.generation_latency ?? {};
  const p95 = nullableNumber(latency.p95_ms);
  const budget = nullableNumber(latency.budget_ms) ?? 15_000;
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

function buildReasons({
  production,
  validation,
  quick,
  latency,
  qualityGate,
}) {
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
  const qualityReasons = Array.isArray(qualityGate?.readiness?.reasons)
    ? qualityGate.readiness.reasons
    : [];
  if (
    qualityReasons.includes("quick_depth_error_rate_high")
    || qualityReasons.includes("quick_budget_cohort_error_rate_high")
  ) {
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

function statusFor({
  production,
  quick,
  latency,
  reasons,
}) {
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

function nextActionsFor({
  status,
  production,
  validation,
  quick,
  latency,
  historical,
}) {
  if (status === "ready_for_limited_routing") {
    return [
      "Artifact-review is ready for limited routing expansion; keep standard fallback and monitor production scorecard coverage.",
    ];
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
  return actions.length
    ? actions
    : ["Keep collecting aggregate artifact-review telemetry before changing routing."];
}

export function buildArtifactReviewCoveragePlan(
  summary = {},
  qualityGate = buildArtifactReviewQualityGate(summary),
) {
  const production = scorecardSection(summary?.artifact_review_quality);
  const validation = validationScorecardSection(summary?.artifact_review_validation_quality);
  const quick = activeQuickCollection(qualityGate);
  const latency = latencyGuard(qualityGate);
  const historical = historicalRisks(qualityGate);
  const reasons = buildReasons({
    production,
    validation,
    quick,
    latency,
    qualityGate,
  });
  const status = statusFor({
    production,
    quick,
    latency,
    reasons,
  });
  return {
    ok: true,
    scope: summary?.scope === "global" ? "global" : "local",
    generated_at: typeof summary?.generated_at === "string"
      ? summary.generated_at
      : new Date(0).toISOString(),
    command: "artifact-review",
    plan: {
      status,
      reasons: status === "ready_for_limited_routing"
        ? ["production_artifact_review_ready"]
        : reasons,
    },
    production_scorecard: production,
    validation_scorecard: validation,
    active_quick_collection: quick,
    latency_guard: latency,
    historical_risks: historical,
    next_actions: nextActionsFor({
      status,
      production,
      validation,
      quick,
      latency,
      historical,
    }),
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
  const summary = await runTelemetrySummary({
    cwd,
    home,
    scope,
    now,
    topLimit,
  });
  return buildArtifactReviewCoveragePlan(summary, buildArtifactReviewQualityGate(summary));
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
