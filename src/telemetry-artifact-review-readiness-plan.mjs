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

const RAW_SENSITIVE_SIGNAL_FIELDS = [
  "credential_like_prompt_events",
  "credential_like_response_events",
  "credential_scan_truncated_events",
  "email_like_prompt_events",
  "email_like_response_events",
  "path_like_prompt_events",
  "path_like_response_events",
  "phone_like_prompt_events",
  "phone_like_response_events",
  "sensitive_scan_truncated_events",
];

const RAW_RISK_COUNT_FIELDS = [
  "file_count",
  "event_count",
  "invalid_file_count",
  "skipped_file_count",
  "prompt_events",
  "response_events",
  "prompt_bytes",
  "response_bytes",
  "truncated_prompt_events",
  "truncated_response_events",
  "multimodal_events",
  "media_item_count",
  ...RAW_SENSITIVE_SIGNAL_FIELDS,
];

const SAFE_DOCTOR_ACTIONS = new Set([
  "Inspect failed reasons, fix token/endpoint/config, then retry with bounded flush.",
  "Run telemetry quarantine inspect --json, then telemetry quarantine retry --reason <reason> --dry-run before --write for receiver-policy fixes, or telemetry quarantine archive --reason <reason> --dry-run before --write for resolved cases.",
  "Run telemetry flush --dry-run, then telemetry flush --batch-size 1.",
  "Fix telemetry config/token/endpoint before flushing pending events.",
  "No pending, inflight, failed, or quarantined telemetry events.",
  "Fix the telemetry token environment variable name.",
  "Fix the telemetry endpoint URL.",
  "Fix the telemetry config.",
  "Enable telemetry before flushing.",
  "Set the configured telemetry token environment variable.",
  "No pending telemetry events to flush.",
]);

function nonnegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function ratio(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return Number((numerator / denominator).toFixed(4));
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatPercent(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "n/a";
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

function safeField(value) {
  const text = `${value ?? ""}`.trim();
  return /^[A-Za-z0-9_]{1,64}$/.test(text) ? text : "unknown";
}

function safeLatencyStatus(value) {
  const text = `${value ?? ""}`.trim();
  if (text === "within_budget" || text === "over_budget" || text === "low_sample") return text;
  return "unknown";
}

function safeGeneratedAt(value) {
  if (typeof value !== "string") return new Date(0).toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

function safeDoctorAction(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return SAFE_DOCTOR_ACTIONS.has(text) ? text : null;
}

function safePreviewError(value) {
  if (value === null || value === undefined || value === "") return null;
  const text = `${value}`.trim();
  if (text === "") return null;
  return /^[a-z0-9_]{1,96}$/.test(text) ? text : "unknown";
}

function previewErrorComplete(value) {
  return value === null || /^[a-z0-9_]{1,96}$/.test(`${value ?? ""}`.trim());
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonnegativeFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function doctorCounterComplete(doctor, queueName, deliveryName) {
  const queue = plainObject(doctor?.queue) ? doctor.queue : {};
  const delivery = plainObject(doctor?.delivery) ? doctor.delivery : {};
  return nonnegativeFiniteNumber(queue?.[queueName]?.count)
    || nonnegativeFiniteNumber(delivery?.[deliveryName]);
}

function doctorComplete(doctor) {
  return plainObject(doctor)
    && doctor.ok === true
    && doctorCounterComplete(doctor, "pending", "pending_events")
    && doctorCounterComplete(doctor, "inflight", "inflight_events")
    && doctorCounterComplete(doctor, "failed", "failed_events")
    && doctorCounterComplete(doctor, "quarantine", "quarantine_events");
}

function rawPreflightComplete(rawPreflight) {
  return plainObject(rawPreflight)
    && rawPreflight.ok === true
    && plainObject(rawPreflight.pending)
    && plainObject(rawPreflight.batch)
    && plainObject(rawPreflight.risk)
    && nonnegativeFiniteNumber(rawPreflight.pending.total_count)
    && nonnegativeFiniteNumber(rawPreflight.batch.would_send_count)
    && nonnegativeFiniteNumber(rawPreflight.batch.excluded_by_batch_size_count)
    && typeof rawPreflight.batch.exceeds_max_bytes === "boolean"
    && Object.hasOwn(rawPreflight.batch, "preview_error")
    && previewErrorComplete(rawPreflight.batch.preview_error)
    && RAW_RISK_COUNT_FIELDS.every((field) => nonnegativeFiniteNumber(rawPreflight.risk[field]));
}

function rawPreflightIncomplete(rawPreflight) {
  return plainObject(rawPreflight) && rawPreflight.ok === true && !rawPreflightComplete(rawPreflight);
}

function cloneScorecard(section = {}) {
  const weakest = section?.weakest_field && typeof section.weakest_field === "object"
    ? {
      field: safeField(section.weakest_field.field),
      event_count: nonnegativeInteger(section.weakest_field.event_count),
      scored_event_count: nonnegativeInteger(section.weakest_field.scored_event_count),
      coverage_rate: nullableNumber(section.weakest_field.coverage_rate),
    }
    : null;
  const result = {
    event_count: nonnegativeInteger(section?.event_count),
    scorecard_event_count: nonnegativeInteger(section?.scorecard_event_count),
    coverage_rate: nullableNumber(section?.coverage_rate),
    field_coverage_min: nullableNumber(section?.field_coverage_min),
    weakest_field: weakest,
    target_coverage_rate: nullableNumber(section?.target_coverage_rate) ?? SCORECARD_TARGET_COVERAGE,
  };
  if (
    section
    && typeof section === "object"
    && Object.hasOwn(section, "events_needed_for_target")
    && section.events_needed_for_target !== undefined
  ) {
    result.events_needed_for_target = section.events_needed_for_target === null
      ? null
      : nonnegativeInteger(section.events_needed_for_target);
  }
  return result;
}

function cloneActiveQuick(section = {}) {
  const cohorts = Array.isArray(section?.active_budget_cohorts)
    ? section.active_budget_cohorts.map((cohort) => {
      const eventCount = nonnegativeInteger(cohort?.event_count);
      const successCount = nonnegativeInteger(cohort?.success_count);
      const errorCount = nonnegativeInteger(cohort?.error_count);
      return {
        budget_cohort: safeBudgetCohort(cohort?.budget_cohort),
        event_count: eventCount,
        success_count: successCount,
        error_count: errorCount,
        error_rate: nullableNumber(cohort?.error_rate) ?? ratio(errorCount, successCount + errorCount),
        additional_events_needed: nonnegativeInteger(cohort?.additional_events_needed),
        low_confidence: cohort?.low_confidence === true,
      };
    })
    : [];
  const additionalNeeded = Object.hasOwn(section ?? {}, "additional_events_needed")
    ? nonnegativeInteger(section.additional_events_needed)
    : cohorts.reduce((sum, cohort) => sum + cohort.additional_events_needed, 0);
  const totalSuccess = cohorts.reduce((sum, cohort) => sum + cohort.success_count, 0);
  const totalError = cohorts.reduce((sum, cohort) => sum + cohort.error_count, 0);
  const activeErrorRate = nullableNumber(section?.active_error_rate) ?? ratio(totalError, totalSuccess + totalError);
  const lowConfidence = cohorts.length === 0
    ? true
    : section?.low_confidence === undefined
      ? cohorts.some((cohort) => cohort.low_confidence)
      : section.low_confidence === true;
  return {
    active_budget_cohorts: cohorts,
    target_events_per_cohort: nonnegativeInteger(section?.target_events_per_cohort)
      || ACTIVE_QUICK_TARGET_EVENTS_PER_COHORT,
    additional_events_needed: additionalNeeded,
    active_error_rate: activeErrorRate,
    low_confidence: lowConfidence,
  };
}

function cloneLatency(section = {}) {
  const p95 = nullableNumber(section?.p95_ms);
  const budget = nullableNumber(section?.budget_ms) ?? 15_000;
  return {
    status: safeLatencyStatus(section?.status),
    p95_ms: p95,
    budget_ms: budget,
    near_budget: section?.near_budget === true
      || (p95 !== null && budget > 0 && p95 >= budget * LATENCY_NEAR_BUDGET_RATIO),
  };
}

function structuredResponseSection(summary = {}) {
  const source = plainObject(summary?.production_structured_response)
    ? summary.production_structured_response
    : summary?.structured_response;
  const structured = source
    && typeof source === "object"
    && !Array.isArray(source)
    ? source
    : {};
  const topCommands = Array.isArray(structured.top_commands) ? structured.top_commands : [];
  const topRetryCommands = Array.isArray(structured.top_retry_commands) ? structured.top_retry_commands : [];
  const artifactRow = topCommands.find((row) => row?.command === "artifact-review") ?? null;
  const artifactRetryRow = topRetryCommands.find((row) => row?.command === "artifact-review") ?? null;
  const rowSelected = artifactRow !== null;
  const eventCount = rowSelected ? nonnegativeInteger(artifactRow.event_count) : 0;
  const missingCount = rowSelected ? nonnegativeInteger(artifactRow.missing_json_envelope_count) : 0;
  const retryEventCount = nonnegativeInteger(artifactRetryRow?.retry_event_count);
  const retryScheduledCount = nonnegativeInteger(artifactRetryRow?.retry_scheduled_count);
  const retryRecoveredCount = nonnegativeInteger(artifactRetryRow?.retry_recovered_count);
  const missingJsonEnvelopeRetryRecoveredCount = nonnegativeInteger(
    artifactRetryRow?.missing_json_envelope_retry_recovered_count,
  );
  const unrecoveredJsonEnvelope = missingCount > missingJsonEnvelopeRetryRecoveredCount
    || retryScheduledCount > retryRecoveredCount;
  return {
    event_count: eventCount,
    missing_json_envelope_count: missingCount,
    missing_json_envelope_rate: nullableNumber(
      rowSelected ? artifactRow.missing_json_envelope_rate : null,
    ) ?? ratio(missingCount, eventCount),
    retry_event_count: retryEventCount,
    retry_scheduled_count: retryScheduledCount,
    retry_recovered_count: retryRecoveredCount,
    missing_json_envelope_retry_event_count: nonnegativeInteger(
      artifactRetryRow?.missing_json_envelope_retry_event_count,
    ),
    missing_json_envelope_retry_scheduled_count: nonnegativeInteger(
      artifactRetryRow?.missing_json_envelope_retry_scheduled_count,
    ),
    missing_json_envelope_retry_recovered_count: missingJsonEnvelopeRetryRecoveredCount,
    retry_recovery_rate: artifactRetryRow
      ? nullableNumber(artifactRetryRow.retry_recovery_rate)
        ?? (retryScheduledCount > 0 ? Math.min(1, ratio(retryRecoveredCount, retryScheduledCount)) : null)
      : null,
    diagnosis: unrecoveredJsonEnvelope ? "unrecovered_json_envelope" : "none",
    recovery_action: unrecoveredJsonEnvelope ? "verify_artifact_review_json_retry_recovery" : "none",
    affected_command: "artifact-review",
  };
}

function rawSensitiveSignalCount(risk = {}) {
  return RAW_SENSITIVE_SIGNAL_FIELDS.reduce((sum, field) => sum + nonnegativeInteger(risk?.[field]), 0);
}

function rawGovernanceSection({ doctor = null, rawPreflight = null } = {}) {
  const queue = plainObject(doctor?.queue) ? doctor.queue : {};
  const delivery = plainObject(doctor?.delivery) ? doctor.delivery : {};
  const pending = plainObject(rawPreflight?.pending) ? rawPreflight.pending : {};
  const batch = plainObject(rawPreflight?.batch) ? rawPreflight.batch : {};
  const risk = plainObject(rawPreflight?.risk) ? rawPreflight.risk : {};
  const preflightComplete = rawPreflightComplete(rawPreflight);
  const excludedCount = nonnegativeInteger(batch.excluded_by_batch_size_count);
  const previewError = safePreviewError(batch.preview_error);
  const invalidFileCount = nonnegativeInteger(risk.invalid_file_count);
  const skippedFileCount = nonnegativeInteger(risk.skipped_file_count);
  const selectedCount = Math.max(
    nonnegativeInteger(batch.would_send_count),
    nonnegativeInteger(risk.file_count),
    nonnegativeInteger(risk.event_count),
  );
  const pendingCount = Math.max(
    nonnegativeInteger(queue.pending?.count),
    nonnegativeInteger(delivery.pending_events),
    nonnegativeInteger(pending.total_count),
    selectedCount,
  );
  const preflightPartial = preflightComplete
    && (excludedCount > 0 || nonnegativeInteger(pending.total_count) > selectedCount);
  return {
    pending_count: pendingCount,
    inflight_count: Math.max(
      nonnegativeInteger(queue.inflight?.count),
      nonnegativeInteger(delivery.inflight_events),
    ),
    failed_count: Math.max(
      nonnegativeInteger(queue.failed?.count),
      nonnegativeInteger(delivery.failed_events),
    ),
    quarantine_count: Math.max(
      nonnegativeInteger(queue.quarantine?.count),
      nonnegativeInteger(delivery.quarantine_events),
    ),
    small_flush_safe: doctor?.small_flush_safe === true,
    preflight_available: preflightComplete,
    preflight_incomplete: rawPreflightIncomplete(rawPreflight),
    preflight_partial: preflightPartial,
    preflight_selected_count: selectedCount,
    sensitive_signal_count: rawSensitiveSignalCount(risk),
    preflight_preview_error: previewError,
    exceeds_max_bytes: batch.exceeds_max_bytes === true,
    invalid_file_count: invalidFileCount,
    skipped_file_count: skippedFileCount,
    recommended_action: safeDoctorAction(doctor?.recommended_action ?? delivery.recommended_action),
  };
}

function endpointDiagnosticsHealthy(doctor) {
  return plainObject(doctor)
    && plainObject(doctor.endpoint_check)
    && doctor.endpoint_check.ok === true;
}

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
  if (
    production.event_count > 0
    && (production.scorecard_event_count === 0 || production.coverage_rate === 0)
  ) {
    blocked.push("production_scorecard_coverage_zero");
  }
  if (raw.inflight_count > 0) blocked.push("raw_inflight_events_present");
  if (raw.failed_count > 0) blocked.push("raw_failed_events_present");
  if (raw.quarantine_count > 0) blocked.push("raw_quarantine_events_present");
  if (doctor && doctor.ok === false) blocked.push("telemetry_delivery_unhealthy");

  if (doctor === null) blocked.push("telemetry_doctor_unavailable");
  if (doctor !== null && !doctorComplete(doctor)) blocked.push("telemetry_doctor_incomplete");
  if (doctor !== null && !endpointDiagnosticsHealthy(doctor)) {
    blocked.push("telemetry_endpoint_unhealthy");
  }
  if (raw.preflight_incomplete) blocked.push("raw_preflight_incomplete");
  if (!raw.preflight_available && !raw.preflight_incomplete) {
    blocked.push("raw_preflight_unavailable");
  }
  if (raw.preflight_partial) blocked.push("raw_preflight_partial");
  if (raw.preflight_preview_error !== null) blocked.push("raw_preflight_preview_error");
  if (raw.exceeds_max_bytes) blocked.push("raw_preflight_exceeds_max_bytes");
  if (raw.invalid_file_count > 0) blocked.push("raw_preflight_invalid_files");
  if (raw.skipped_file_count > 0) blocked.push("raw_preflight_skipped_files");
  if (quick.low_confidence || quick.additional_events_needed > 0) {
    collect.push("active_quick_low_sample");
  }
  if (production.coverage_rate === null || production.coverage_rate < SCORECARD_TARGET_COVERAGE) {
    collect.push("production_scorecard_coverage_low");
  }
  if (production.field_coverage_min === null || production.field_coverage_min < SCORECARD_TARGET_COVERAGE) {
    collect.push("production_scorecard_field_coverage_low");
  }
  if (latency.near_budget) collect.push("generation_latency_near_budget");
  if (structured.diagnosis === "unrecovered_json_envelope") {
    collect.push("structured_response_unrecovered_json_envelope");
  }
  if (raw.pending_count > 0 && raw.sensitive_signal_count > 0) {
    blocked.push("raw_pending_sensitive_signals");
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

function statusFor({ blocked, production, quick, latency, structured, raw, doctor }) {
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
  const structuredReady = structured.diagnosis !== "unrecovered_json_envelope";
  const rawReady = raw.failed_count === 0
    && raw.inflight_count === 0
    && raw.quarantine_count === 0
    && raw.preflight_available
    && !raw.preflight_partial
    && raw.preflight_preview_error === null
    && raw.exceeds_max_bytes === false
    && raw.invalid_file_count === 0
    && raw.skipped_file_count === 0
    && (raw.pending_count === 0 || raw.sensitive_signal_count === 0);
  const deliveryReady = doctorComplete(doctor) && doctor.ok === true && endpointDiagnosticsHealthy(doctor);
  if (scorecardReady && quickReady && latencyReady && structuredReady && rawReady && deliveryReady) {
    return "ready_for_limited_routing";
  }
  return "collect_more_samples";
}

function routingRecommendation({ status, quick }) {
  const activeCohorts = quick.active_budget_cohorts.length
    ? [...new Set(quick.active_budget_cohorts.map((cohort) => cohort.budget_cohort))]
    : [ACTIVE_QUICK_DEFAULT_BUDGET];
  return {
    limited_routing_allowed: status === "ready_for_limited_routing",
    production_sampling_allowed: status !== "blocked",
    additional_quick_samples_needed: quick.additional_events_needed,
    recommended_review_depth: "quick",
    recommended_budget_cohorts: activeCohorts,
  };
}

function nextActionsFor({ status, reasons, quick, structured, raw, latency, production }) {
  const actions = [];
  const cohort = quick.active_budget_cohorts[0]?.budget_cohort ?? ACTIVE_QUICK_DEFAULT_BUDGET;
  if (status === "ready_for_limited_routing") {
    return [
      "Allow limited artifact-review routing with standard fallback and continued readiness monitoring.",
    ];
  }
  if (status === "blocked") {
    actions.push("Do not expand artifact-review routing until blocked readiness reasons are resolved.");
  }
  if (quick.additional_events_needed > 0) {
    actions.push(`Collect ${formatNumber(quick.additional_events_needed)} more quick ${cohort} production samples before limited routing.`);
  } else if (quick.low_confidence) {
    actions.push(`Collect more active quick ${cohort} production samples before limited routing.`);
  }
  if (production.coverage_rate === null || production.coverage_rate < SCORECARD_TARGET_COVERAGE) {
    actions.push("Require numeric design scorecards on new production artifact-review runs.");
  }
  if (structured.diagnosis === "unrecovered_json_envelope") {
    actions.push("Verify artifact-review structured JSON retry recovery before wider routing.");
  }
  if (
    reasons.includes("telemetry_doctor_unavailable")
    || reasons.includes("telemetry_doctor_incomplete")
  ) {
    actions.push("Run telemetry doctor to refresh complete delivery diagnostics before limited routing.");
  }
  if (reasons.includes("telemetry_endpoint_unhealthy")) {
    actions.push("Run telemetry doctor and restore healthy endpoint diagnostics before limited routing.");
  }
  if (
    reasons.includes("raw_preflight_unavailable")
    || reasons.includes("raw_preflight_incomplete")
  ) {
    actions.push("Run raw telemetry preflight with pending, batch, and risk summaries before limited routing.");
  }
  if (reasons.includes("raw_preflight_partial")) {
    actions.push("Run raw preflight over the remaining pending telemetry before limited routing.");
  }
  if (
    reasons.includes("raw_preflight_preview_error")
    || reasons.includes("raw_preflight_exceeds_max_bytes")
    || reasons.includes("raw_preflight_invalid_files")
    || reasons.includes("raw_preflight_skipped_files")
  ) {
    actions.push("Resolve raw preflight preview errors, invalid or skipped files, and size limits before limited routing.");
  }
  if (reasons.includes("raw_inflight_events_present")) {
    actions.push("Wait for in-flight raw telemetry delivery to settle before limited routing.");
  }
  if (raw.pending_count > 0 || raw.failed_count > 0 || raw.quarantine_count > 0) {
    actions.push("Run raw telemetry preflight, then use reveal/export/delete/prune or small-batch flush workflows before broad routing.");
  }
  if (latency.status === "over_budget" || latency.near_budget) {
    actions.push(`Watch artifact-review generation latency; p95 is ${latency.p95_ms === null ? "n/a" : `${formatNumber(latency.p95_ms)} ms`} against a ${formatNumber(latency.budget_ms)} ms budget.`);
  }
  return actions.length ? actions : ["Keep collecting aggregate artifact-review telemetry."];
}

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
    generated_at: safeGeneratedAt(summary?.generated_at),
    command: "artifact-review",
    readiness: { status, reasons },
    production_scorecard: production,
    validation_scorecard: validation,
    active_quick_collection: quick,
    structured_response: structured,
    latency_guard: latency,
    raw_governance: raw,
    routing_recommendation: routingRecommendation({ status, quick }),
    next_actions: nextActionsFor({ status, reasons, quick, structured, raw, latency, production }),
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
  doctorTimeoutMs = 3000,
} = {}) {
  const summary = await runTelemetrySummary({
    cwd,
    home,
    scope,
    now,
    topLimit,
    requiredStructuredResponseCommands: ["artifact-review"],
  });
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
  const cohorts = routing.recommended_budget_cohorts.length
    ? routing.recommended_budget_cohorts
    : [ACTIVE_QUICK_DEFAULT_BUDGET];
  const cohort = cohorts[0];
  const lines = [
    `Artifact-review readiness plan: ${report.readiness.status}`,
    `- Readiness reasons: ${report.readiness.reasons.join(", ")}`,
    `- Limited routing: ${routing.limited_routing_allowed ? "yes" : "no"}`,
    `- Production sampling: ${routing.production_sampling_allowed ? "yes" : "no"}${routing.additional_quick_samples_needed > 0 ? `, collect ${formatNumber(routing.additional_quick_samples_needed)} more quick ${cohort} samples` : ""}`,
    `- Production scorecard coverage: ${formatPercent(report.production_scorecard.coverage_rate)} (${formatNumber(report.production_scorecard.scorecard_event_count)} of ${formatNumber(report.production_scorecard.event_count)})`,
    `- Structured response: ${formatNumber(report.structured_response.missing_json_envelope_count)} missing JSON-envelope events, ${formatNumber(report.structured_response.missing_json_envelope_retry_recovered_count)} JSON-envelope recovered`,
    `- Raw governance: ${formatNumber(report.raw_governance.pending_count)} pending, ${formatNumber(report.raw_governance.inflight_count)} in-flight, ${formatNumber(report.raw_governance.failed_count)} failed, ${formatNumber(report.raw_governance.quarantine_count)} quarantined`,
    `- Latency: ${report.latency_guard.status}, p95 ${report.latency_guard.p95_ms === null ? "n/a" : `${formatNumber(report.latency_guard.p95_ms)} ms`}, budget ${formatNumber(report.latency_guard.budget_ms)} ms${report.latency_guard.near_budget ? ", near budget" : ""}`,
  ];
  if (quick.active_budget_cohorts.length > 0) {
    const label = quick.active_budget_cohorts.map((row) => row.budget_cohort).join("/");
    const eventCount = quick.active_budget_cohorts.reduce((sum, row) => sum + row.event_count, 0);
    lines.push(`- Active quick cohort: ${label} at ${formatPercent(quick.active_error_rate)} error (${formatNumber(eventCount)} events)`);
  }
  for (const action of report.next_actions) lines.push(`- Next action: ${action}`);
  lines.push("Limitations:");
  for (const limitation of report.limitations) lines.push(`- ${limitation}`);
  return lines.join("\n");
}
