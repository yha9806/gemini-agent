import { runTelemetrySummary } from "./telemetry-summary.mjs";

const QUICK_MIN_READY_EVENTS = 10;
const QUICK_MAX_READY_ERROR_RATE = 0.05;
const QUICK_MIN_BLOCK_EVENTS = 5;
const COHORT_MIN_CONFIDENCE_EVENTS = 10;
const SCORECARD_READY_COVERAGE = 0.8;

const LIMITATIONS = [
  "Quality gate uses aggregate local telemetry only; no raw prompts, responses, event ids, paths, or media file names are included.",
  "Codex remains responsible for routing, code changes, tests, commits, and final release decisions.",
  "Small sample cohorts are directional and should not be treated as statistically conclusive.",
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

function safeBudgetCohort(value) {
  const text = `${value ?? "unknown"}`.trim();
  if (/^\d{1,6}$/.test(text)) return text;
  if (text === "unbounded" || text === "unknown") return text;
  return "unknown";
}

function qualitySection(summary) {
  const quality = summary?.artifact_review_quality;
  if (!quality || typeof quality !== "object" || Array.isArray(quality)) {
    return {
      event_count: 0,
      scorecard_event_count: 0,
      coverage_rate: null,
      field_coverage_min: null,
      avg_overall_score: null,
      avg_implementation_readiness_score: null,
      weakest_field: null,
    };
  }

  const eventCount = nonnegativeInteger(quality.event_count);
  const scorecardEventCount = nonnegativeInteger(quality.scorecard_event_count);
  const coverageRate = ratio(scorecardEventCount, eventCount);
  const rows = Array.isArray(quality.scorecard_field_coverage)
    ? quality.scorecard_field_coverage
    : [];
  const normalizedRows = rows.map((row) => {
    const field = /^[A-Za-z0-9_]{1,64}$/.test(`${row?.field ?? ""}`) ? `${row.field}` : "unknown";
    const rowEventCount = nonnegativeInteger(row?.event_count ?? row?.events);
    const scoredEventCount = nonnegativeInteger(row?.scored_event_count ?? row?.scored_events);
    const rowCoverage = nullableNumber(row?.coverage_rate ?? row?.coverage);
    return {
      field,
      event_count: rowEventCount,
      scored_event_count: scoredEventCount,
      coverage_rate: rowCoverage === null ? ratio(scoredEventCount, rowEventCount) : Number(rowCoverage.toFixed(4)),
    };
  });
  const coverageRows = normalizedRows
    .filter((row) => row.coverage_rate !== null)
    .sort((left, right) => (
      left.coverage_rate - right.coverage_rate
      || right.event_count - left.event_count
      || left.field.localeCompare(right.field)
    ));
  const weakest = coverageRows[0] ?? null;

  return {
    event_count: eventCount,
    scorecard_event_count: scorecardEventCount,
    coverage_rate: coverageRate,
    field_coverage_min: weakest?.coverage_rate ?? null,
    avg_overall_score: nullableNumber(quality.avg_overall_score),
    avg_implementation_readiness_score: nullableNumber(quality.avg_implementation_readiness_score),
    weakest_field: weakest,
  };
}

function quickDepthRow(summary) {
  const rows = Array.isArray(summary?.artifact_review_depths?.top_depths)
    ? summary.artifact_review_depths.top_depths
    : [];
  return rows.find((row) => row?.review_depth === "quick") ?? null;
}

function quickBudgetCohorts(summary) {
  const rows = Array.isArray(summary?.artifact_review_depths?.top_budget_cohorts)
    ? summary.artifact_review_depths.top_budget_cohorts
    : [];
  return rows
    .filter((row) => row?.review_depth === "quick")
    .map((row) => {
      const eventCount = nonnegativeInteger(row.event_count);
      const successCount = nonnegativeInteger(row.success_count);
      const errorCount = nonnegativeInteger(row.error_count);
      return {
        budget_cohort: safeBudgetCohort(row.budget_cohort),
        event_count: eventCount,
        success_count: successCount,
        error_count: errorCount,
        error_rate: ratio(errorCount, successCount + errorCount),
        p95_latency_ms: nullableNumber(row.p95_latency_ms),
        total_tokens: nonnegativeInteger(row.total_tokens),
        low_confidence: eventCount < COHORT_MIN_CONFIDENCE_EVENTS,
      };
    })
    .sort((left, right) => (
      right.event_count - left.event_count
      || left.budget_cohort.localeCompare(right.budget_cohort)
    ));
}

function worstBudgetCohort(cohorts) {
  return [...cohorts]
    .filter((row) => row.error_rate !== null)
    .sort((left, right) => (
      right.error_rate - left.error_rate
      || right.event_count - left.event_count
      || left.budget_cohort.localeCompare(right.budget_cohort)
    ))[0] ?? null;
}

function quickDepthSection(summary) {
  const quick = quickDepthRow(summary);
  const eventCount = nonnegativeInteger(quick?.event_count);
  const successCount = nonnegativeInteger(quick?.success_count);
  const errorCount = nonnegativeInteger(quick?.error_count);
  const cohorts = quickBudgetCohorts(summary);
  const lowConfidence = eventCount < QUICK_MIN_READY_EVENTS
    || cohorts.some((cohort) => cohort.low_confidence);

  return {
    event_count: eventCount,
    success_count: successCount,
    error_count: errorCount,
    error_rate: ratio(errorCount, successCount + errorCount),
    p95_latency_ms: nullableNumber(quick?.p95_latency_ms),
    total_tokens: nonnegativeInteger(quick?.total_tokens),
    budget_cohorts: cohorts,
    worst_budget_cohort: worstBudgetCohort(cohorts),
    low_confidence: lowConfidence,
  };
}

function hasEnoughArtifactReviewData(summary, quick, scorecard) {
  const depthEvents = nonnegativeInteger(summary?.artifact_review_depths?.event_count);
  return depthEvents > 0 || quick.event_count > 0 || scorecard.event_count > 0;
}

function nextActionsFor({ status, reasons, quick, scorecard }) {
  const actions = [];
  if (status === "ready") {
    actions.push("Expand quick depth gradually while keeping standard artifact-review fallback available.");
    actions.push("Continue monitoring quick-depth latency, token usage, and scorecard coverage.");
    return actions;
  }
  if (reasons.includes("quick_depth_error_rate_high") || reasons.includes("quick_budget_cohort_error_rate_high")) {
    const cohort = quick.worst_budget_cohort?.budget_cohort ?? "unknown";
    actions.push(`Avoid expanding quick depth for the ${cohort} budget cohort until it has clean outcomes.`);
  }
  if (reasons.includes("quick_depth_low_sample") || reasons.includes("quick_budget_cohort_low_confidence")) {
    actions.push(`Collect at least ${formatNumber(QUICK_MIN_READY_EVENTS)} quick-depth events and ${formatNumber(COHORT_MIN_CONFIDENCE_EVENTS)} outcomes per active quick budget cohort before wider routing.`);
  }
  if (reasons.includes("scorecard_coverage_low") || reasons.includes("scorecard_field_coverage_low")) {
    actions.push("Capture numeric design scorecards for artifact-review runs before using visual quality metrics for product decisions.");
  }
  if (reasons.includes("insufficient_artifact_review_data")) {
    actions.push("Run more artifact-review validations with telemetry enabled before deciding routing policy.");
  }
  if (scorecard.avg_implementation_readiness_score !== null && scorecard.avg_implementation_readiness_score < 60) {
    actions.push("Calibrate artifact-review prompts and design scorecard rubric before expanding more visual tasks.");
  }
  return actions.length ? actions : ["Keep standard fallback and continue collecting aggregate artifact-review telemetry."];
}

export function buildArtifactReviewQualityGate(summary = {}) {
  const quick = quickDepthSection(summary);
  const scorecard = qualitySection(summary);
  const reasons = [];

  if (!hasEnoughArtifactReviewData(summary, quick, scorecard)) {
    reasons.push("insufficient_artifact_review_data");
  }
  if (quick.event_count > 0 && quick.event_count < QUICK_MIN_READY_EVENTS) {
    reasons.push("quick_depth_low_sample");
  }
  if (quick.error_rate !== null && quick.event_count >= QUICK_MIN_BLOCK_EVENTS && quick.error_rate >= QUICK_MAX_READY_ERROR_RATE) {
    reasons.push("quick_depth_error_rate_high");
  }
  if (quick.budget_cohorts.some((cohort) => cohort.low_confidence)) {
    reasons.push("quick_budget_cohort_low_confidence");
  }
  const worst = quick.worst_budget_cohort;
  if (worst && worst.error_count >= 2 && worst.error_rate !== null && worst.error_rate >= 0.5) {
    reasons.push("quick_budget_cohort_error_rate_high");
  }
  if (scorecard.event_count > 0 && (scorecard.coverage_rate === null || scorecard.coverage_rate < SCORECARD_READY_COVERAGE)) {
    reasons.push("scorecard_coverage_low");
  }
  if (scorecard.field_coverage_min !== null && scorecard.field_coverage_min < SCORECARD_READY_COVERAGE) {
    reasons.push("scorecard_field_coverage_low");
  }

  const blockedReasons = new Set(["quick_depth_error_rate_high", "quick_budget_cohort_error_rate_high"]);
  const ready = quick.event_count >= QUICK_MIN_READY_EVENTS
    && quick.error_rate !== null
    && quick.error_rate < QUICK_MAX_READY_ERROR_RATE
    && !quick.low_confidence
    && scorecard.coverage_rate !== null
    && scorecard.coverage_rate >= SCORECARD_READY_COVERAGE
    && scorecard.field_coverage_min !== null
    && scorecard.field_coverage_min >= SCORECARD_READY_COVERAGE;
  const status = reasons.some((reason) => blockedReasons.has(reason))
    ? "blocked"
    : ready
      ? "ready"
      : "caution";
  const readinessReasons = status === "ready" ? ["quick_depth_ready"] : [...new Set(reasons)];

  return {
    ok: true,
    scope: summary?.scope === "global" ? "global" : "local",
    generated_at: typeof summary?.generated_at === "string" ? summary.generated_at : new Date(0).toISOString(),
    command: "artifact-review",
    readiness: {
      status,
      reasons: readinessReasons,
    },
    quick_depth: quick,
    scorecard,
    next_actions: nextActionsFor({ status, reasons: readinessReasons, quick, scorecard }),
    limitations: LIMITATIONS,
  };
}

export async function runArtifactReviewQualityGate({
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
  return buildArtifactReviewQualityGate(summary);
}

export function artifactReviewQualityGateToText(gate) {
  const quick = gate.quick_depth;
  const scorecard = gate.scorecard;
  const worst = quick.worst_budget_cohort;
  const lines = [
    `Artifact-review quality gate: ${gate.readiness.status}`,
    `- Quick depth: ${formatNumber(quick.event_count)} events, ${formatPercent(quick.error_rate)} error, p95 ${quick.p95_latency_ms == null ? "n/a" : `${formatNumber(quick.p95_latency_ms)} ms`}, total tokens ${formatNumber(quick.total_tokens)}`,
  ];
  if (worst) {
    lines.push(`- Worst quick budget cohort: ${worst.budget_cohort} at ${formatPercent(worst.error_rate)} error rate (${formatNumber(worst.event_count)} events, ${formatNumber(worst.error_count)} error)`);
  } else {
    lines.push("- Worst quick budget cohort: n/a");
  }
  lines.push(`- Scorecard coverage: ${formatPercent(scorecard.coverage_rate)}`);
  if (scorecard.weakest_field) {
    lines.push(`- Weakest scorecard field: ${scorecard.weakest_field.field} ${formatPercent(scorecard.weakest_field.coverage_rate)} coverage`);
  }
  if (quick.low_confidence) {
    lines.push(`- Low confidence: quick samples or budget cohorts are below ${formatNumber(COHORT_MIN_CONFIDENCE_EVENTS)} known outcomes.`);
  }
  for (const action of gate.next_actions) {
    lines.push(`- Next action: ${action}`);
  }
  lines.push("Limitations:");
  for (const limitation of gate.limitations) {
    lines.push(`- ${limitation}`);
  }
  return lines.join("\n");
}
