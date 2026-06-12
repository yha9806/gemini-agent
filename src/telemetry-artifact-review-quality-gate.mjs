import {
  QUICK_ARTIFACT_REVIEW_MAX_OUTPUT_TOKENS,
  QUICK_COMPARISON_ARTIFACT_REVIEW_MAX_OUTPUT_TOKENS,
} from "./artifact-review.mjs";
import { runTelemetrySummary } from "./telemetry-summary.mjs";

const QUICK_MIN_READY_EVENTS = 10;
const QUICK_MAX_READY_ERROR_RATE = 0.05;
const QUICK_MIN_BLOCK_EVENTS = 5;
const COHORT_MIN_CONFIDENCE_EVENTS = 10;
const SCORECARD_READY_COVERAGE = 0.8;
const GENERATION_LATENCY_MIN_EVENTS = 5;
const GENERATION_LATENCY_BUDGET_MS = 15_000;
const ACTIVE_QUICK_BUDGET_COHORTS = [
  String(QUICK_ARTIFACT_REVIEW_MAX_OUTPUT_TOKENS),
  String(QUICK_COMPARISON_ARTIFACT_REVIEW_MAX_OUTPUT_TOKENS),
];
const ACTIVE_QUICK_BUDGET_COHORT_SET = new Set(ACTIVE_QUICK_BUDGET_COHORTS);
const ACTIVE_QUICK_BUDGET_LABEL = ACTIVE_QUICK_BUDGET_COHORTS.join("/");

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

function isRiskyBudgetCohort(cohort) {
  return cohort.error_count >= 2 && cohort.error_rate !== null && cohort.error_rate >= 0.5;
}

function activeQuickBudgetCohorts(cohorts) {
  return cohorts.filter((cohort) => ACTIVE_QUICK_BUDGET_COHORT_SET.has(cohort.budget_cohort));
}

function aggregateBudgetCohorts(cohorts) {
  if (!cohorts.length) return null;
  const eventCount = cohorts.reduce((total, cohort) => total + cohort.event_count, 0);
  const successCount = cohorts.reduce((total, cohort) => total + cohort.success_count, 0);
  const errorCount = cohorts.reduce((total, cohort) => total + cohort.error_count, 0);
  return {
    event_count: eventCount,
    success_count: successCount,
    error_count: errorCount,
    error_rate: ratio(errorCount, successCount + errorCount),
    low_confidence: cohorts.some((cohort) => cohort.low_confidence),
  };
}

function historicalRiskyBudgetCohorts(cohorts) {
  return cohorts.filter((cohort) => (
    !ACTIVE_QUICK_BUDGET_COHORT_SET.has(cohort.budget_cohort)
    && isRiskyBudgetCohort(cohort)
  ));
}

function quickDepthSection(summary) {
  const quick = quickDepthRow(summary);
  const eventCount = nonnegativeInteger(quick?.event_count);
  const successCount = nonnegativeInteger(quick?.success_count);
  const errorCount = nonnegativeInteger(quick?.error_count);
  const cohorts = quickBudgetCohorts(summary);
  const activeCohorts = activeQuickBudgetCohorts(cohorts);
  const activeAggregate = aggregateBudgetCohorts(activeCohorts);
  const activeEventCount = activeAggregate?.event_count ?? eventCount;
  const activeErrorRate = activeAggregate?.error_rate ?? ratio(errorCount, successCount + errorCount);
  const lowConfidence = activeAggregate
    ? activeAggregate.low_confidence
    : eventCount < QUICK_MIN_READY_EVENTS || cohorts.some((cohort) => cohort.low_confidence);

  return {
    event_count: eventCount,
    success_count: successCount,
    error_count: errorCount,
    error_rate: ratio(errorCount, successCount + errorCount),
    active_event_count: activeEventCount,
    active_error_rate: activeErrorRate,
    p95_latency_ms: nullableNumber(quick?.p95_latency_ms),
    total_tokens: nonnegativeInteger(quick?.total_tokens),
    budget_cohorts: cohorts,
    active_budget_cohort: activeCohorts[0] ?? null,
    active_budget_cohorts: activeCohorts,
    worst_budget_cohort: worstBudgetCohort(cohorts),
    historical_risky_budget_cohorts: historicalRiskyBudgetCohorts(cohorts),
    low_confidence: lowConfidence,
  };
}

function latencyStageCommand(summary, stage, command) {
  const stages = Array.isArray(summary?.latency_stages?.top_stages)
    ? summary.latency_stages.top_stages
    : [];
  const stageRow = stages.find((row) => row?.stage === stage);
  if (!stageRow || !Array.isArray(stageRow.top_commands)) return null;
  return stageRow.top_commands.find((row) => row?.command === command) ?? null;
}

function generationLatencySection(summary) {
  const generation = latencyStageCommand(summary, "gemini_generation", "artifact-review");
  const preGemini = latencyStageCommand(summary, "pre_gemini_total", "artifact-review");
  const eventCount = nonnegativeInteger(generation?.event_count);
  const p95Ms = nullableNumber(generation?.p95_ms);
  let status = "unknown";
  if (eventCount > 0 && eventCount < GENERATION_LATENCY_MIN_EVENTS) {
    status = "low_sample";
  } else if (eventCount >= GENERATION_LATENCY_MIN_EVENTS && p95Ms !== null) {
    status = p95Ms >= GENERATION_LATENCY_BUDGET_MS ? "over_budget" : "within_budget";
  }
  return {
    status,
    event_count: eventCount,
    p95_ms: p95Ms,
    max_ms: nullableNumber(generation?.max_ms),
    budget_ms: GENERATION_LATENCY_BUDGET_MS,
    min_events: GENERATION_LATENCY_MIN_EVENTS,
    pre_gemini_p95_ms: nullableNumber(preGemini?.p95_ms),
  };
}

function hasEnoughArtifactReviewData(summary, quick, scorecard) {
  const depthEvents = nonnegativeInteger(summary?.artifact_review_depths?.event_count);
  return depthEvents > 0 || quick.event_count > 0 || scorecard.event_count > 0;
}

function nextActionsFor({ status, reasons, quick, scorecard, generationLatency }) {
  const actions = [];
  const activeCohorts = Array.isArray(quick.active_budget_cohorts) ? quick.active_budget_cohorts : [];
  const activeLabel = activeCohorts.length
    ? activeCohorts.map((cohort) => cohort.budget_cohort).join("/")
    : ACTIVE_QUICK_BUDGET_LABEL;
  const activeCohortWord = activeCohorts.length > 1 ? "cohorts" : "cohort";
  const historicalRisk = quick.historical_risky_budget_cohorts?.[0] ?? null;
  if (status === "ready") {
    actions.push(`Expand quick depth gradually for the current ${activeLabel} quick budget ${activeCohortWord} while keeping standard artifact-review fallback available.`);
    if (historicalRisk) {
      actions.push(`Treat the historical ${historicalRisk.budget_cohort} quick budget cohort as non-active risk; do not route back to it without fresh validation.`);
    }
    actions.push("Continue monitoring quick-depth latency, token usage, and scorecard coverage.");
    return actions;
  }
  if (reasons.includes("quick_depth_error_rate_high") || reasons.includes("quick_budget_cohort_error_rate_high")) {
    const cohort = quick.active_budget_cohort?.budget_cohort ?? quick.worst_budget_cohort?.budget_cohort ?? "unknown";
    actions.push(`Avoid expanding quick depth for the ${cohort} budget cohort until it has clean outcomes.`);
  }
  if (historicalRisk) {
    actions.push(`Keep historical ${historicalRisk.budget_cohort} quick budget cohort failures visible, but judge current routing from the active ${activeLabel} quick budget ${activeCohortWord}.`);
  }
  if (reasons.includes("quick_depth_low_sample") || reasons.includes("quick_budget_cohort_low_confidence")) {
    actions.push(`Collect at least ${formatNumber(QUICK_MIN_READY_EVENTS)} quick-depth events and ${formatNumber(COHORT_MIN_CONFIDENCE_EVENTS)} outcomes per current ${activeLabel} quick budget ${activeCohortWord} before wider routing.`);
  }
  if (reasons.includes("scorecard_coverage_low") || reasons.includes("scorecard_field_coverage_low")) {
    actions.push("Capture numeric design scorecards for artifact-review runs before using visual quality metrics for product decisions.");
  }
  if (reasons.includes("generation_latency_over_budget")) {
    if (reasons.includes("scorecard_coverage_low") || reasons.includes("scorecard_field_coverage_low")) {
      actions.push(`Raise scorecard coverage before prompt/schema slimming; artifact-review Gemini generation p95 is ${formatNumber(generationLatency.p95_ms)} ms against a ${formatNumber(generationLatency.budget_ms)} ms budget.`);
    } else {
      actions.push(`Start prompt/schema slimming for artifact-review; Gemini generation p95 is ${formatNumber(generationLatency.p95_ms)} ms against a ${formatNumber(generationLatency.budget_ms)} ms budget.`);
    }
  }
  if (reasons.includes("generation_latency_low_sample")) {
    actions.push(`Collect at least ${formatNumber(GENERATION_LATENCY_MIN_EVENTS)} artifact-review Gemini generation latency samples before treating latency as ready.`);
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
  const generationLatency = generationLatencySection(summary);
  const reasons = [];

  if (!hasEnoughArtifactReviewData(summary, quick, scorecard)) {
    reasons.push("insufficient_artifact_review_data");
  }
  if (quick.active_event_count > 0 && quick.active_event_count < QUICK_MIN_READY_EVENTS) {
    reasons.push("quick_depth_low_sample");
  }
  if (
    quick.active_error_rate !== null
    && quick.active_event_count >= QUICK_MIN_BLOCK_EVENTS
    && quick.active_error_rate >= QUICK_MAX_READY_ERROR_RATE
  ) {
    reasons.push("quick_depth_error_rate_high");
  }
  const activeCohorts = Array.isArray(quick.active_budget_cohorts) ? quick.active_budget_cohorts : [];
  if (activeCohorts.length
    ? activeCohorts.some((cohort) => cohort.low_confidence)
    : quick.budget_cohorts.some((cohort) => cohort.low_confidence)) {
    reasons.push("quick_budget_cohort_low_confidence");
  }
  const activeWorst = worstBudgetCohort(Array.isArray(quick.active_budget_cohorts) ? quick.active_budget_cohorts : []);
  const worst = activeWorst ?? quick.worst_budget_cohort;
  if (worst && isRiskyBudgetCohort(worst)) {
    reasons.push("quick_budget_cohort_error_rate_high");
  }
  if (scorecard.event_count > 0 && (scorecard.coverage_rate === null || scorecard.coverage_rate < SCORECARD_READY_COVERAGE)) {
    reasons.push("scorecard_coverage_low");
  }
  if (scorecard.field_coverage_min !== null && scorecard.field_coverage_min < SCORECARD_READY_COVERAGE) {
    reasons.push("scorecard_field_coverage_low");
  }
  if (generationLatency.status === "over_budget") {
    reasons.push("generation_latency_over_budget");
  } else if (generationLatency.status === "low_sample") {
    reasons.push("generation_latency_low_sample");
  }

  const blockedReasons = new Set(["quick_depth_error_rate_high", "quick_budget_cohort_error_rate_high"]);
  const ready = quick.active_event_count >= QUICK_MIN_READY_EVENTS
    && quick.active_error_rate !== null
    && quick.active_error_rate < QUICK_MAX_READY_ERROR_RATE
    && !quick.low_confidence
    && scorecard.coverage_rate !== null
    && scorecard.coverage_rate >= SCORECARD_READY_COVERAGE
    && scorecard.field_coverage_min !== null
    && scorecard.field_coverage_min >= SCORECARD_READY_COVERAGE
    && generationLatency.status !== "over_budget"
    && generationLatency.status !== "low_sample";
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
    generation_latency: generationLatency,
    scorecard,
    next_actions: nextActionsFor({
      status,
      reasons: readinessReasons,
      quick,
      scorecard,
      generationLatency,
    }),
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
  const activeCohorts = Array.isArray(quick.active_budget_cohorts) ? quick.active_budget_cohorts : [];
  const activeLabel = activeCohorts.map((cohort) => cohort.budget_cohort).join("/");
  const activeEventCount = activeCohorts.reduce((total, cohort) => total + cohort.event_count, 0);
  const activeErrorCount = activeCohorts.reduce((total, cohort) => total + cohort.error_count, 0);
  const worst = quick.worst_budget_cohort;
  const historicalRisk = quick.historical_risky_budget_cohorts?.[0] ?? null;
  const lines = [
    `Artifact-review quality gate: ${gate.readiness.status}`,
    `- Quick depth: ${formatNumber(quick.event_count)} events, ${formatPercent(quick.error_rate)} error, p95 ${quick.p95_latency_ms == null ? "n/a" : `${formatNumber(quick.p95_latency_ms)} ms`}, total tokens ${formatNumber(quick.total_tokens)}`,
    activeCohorts.length
      ? `- Active quick budget cohort: ${activeLabel} at ${formatPercent(quick.active_error_rate)} error rate (${formatNumber(activeEventCount)} events, ${formatNumber(activeErrorCount)} error)`
      : "- Active quick budget cohort: n/a",
  ];
  const generationLatency = gate.generation_latency;
  lines.push(
    `- Gemini generation latency: ${generationLatency.status}, p95 ${generationLatency.p95_ms == null ? "n/a" : `${formatNumber(generationLatency.p95_ms)} ms`}, budget ${formatNumber(generationLatency.budget_ms)} ms, pre-Gemini p95 ${generationLatency.pre_gemini_p95_ms == null ? "n/a" : `${formatNumber(generationLatency.pre_gemini_p95_ms)} ms`}`,
  );
  if (historicalRisk) {
    lines.push(`- Historical quick budget cohort risk: ${historicalRisk.budget_cohort} at ${formatPercent(historicalRisk.error_rate)} error rate (${formatNumber(historicalRisk.event_count)} events, ${formatNumber(historicalRisk.error_count)} error)`);
  }
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
