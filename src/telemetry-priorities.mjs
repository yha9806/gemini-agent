import { runTelemetryEconomics } from "./telemetry-economics.mjs";
import { runTelemetrySummary } from "./telemetry-summary.mjs";

function assertPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer.`);
  }
}

function assertNonnegativeNumber(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a nonnegative number.`);
  }
}

function nullableRatio(numerator, denominator, digits = 6) {
  if (denominator <= 0) return null;
  return Number((numerator / denominator).toFixed(digits));
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatUsd(value) {
  return `$${value.toFixed(6)}`;
}

function formatPercent(value) {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function statusErrorRate(summary) {
  const total = summary.status_counts.success_count + summary.status_counts.error_count;
  return nullableRatio(summary.status_counts.error_count, total, 4);
}

function usageCoverage(economics) {
  return economics.totals.usage_coverage_rate;
}

function usageApplicableCoverage(economics) {
  if (Object.hasOwn(economics.totals, "usage_applicable_coverage_rate")) {
    return economics.totals.usage_applicable_coverage_rate;
  }
  return economics.totals.usage_coverage_rate;
}

function mediaCoverage(multimodal) {
  if (!multimodal || multimodal.item_count <= 0) {
    return {
      mime: null,
      byte_size: null,
      kind: null,
      min: null,
    };
  }
  const mime = nullableRatio(multimodal.media_items_with_mime, multimodal.item_count, 4);
  const byteSize = nullableRatio(multimodal.media_items_with_byte_size, multimodal.item_count, 4);
  const kind = nullableRatio(multimodal.media_items_with_kind, multimodal.item_count, 4);
  return {
    mime,
    byte_size: byteSize,
    kind,
    min: Math.min(mime ?? 1, byteSize ?? 1, kind ?? 1),
  };
}

function priority({
  kind,
  severity,
  score,
  title,
  action,
  evidence,
  command = null,
}) {
  return {
    kind,
    severity,
    score,
    title,
    action,
    evidence,
    ...(command ? { command } : {}),
  };
}

function reliabilityPriority(summary, errorRate) {
  if (errorRate === null || errorRate <= 0.2) return null;
  return priority({
    kind: "reliability",
    severity: errorRate >= 0.35 ? "critical" : "high",
    score: 100 + Math.min(50, Math.round(errorRate * 100)),
    title: "Reliability first: error rate is above 20%.",
    action: "Prioritize failing command diagnosis before expanding automation or routing more work to Gemini.",
    evidence: [
      `Error rate: ${formatPercent(errorRate)}`,
      `Errors: ${formatNumber(summary.status_counts.error_count)}`,
      `Known outcomes: ${formatNumber(summary.status_counts.success_count + summary.status_counts.error_count)}`,
    ],
  });
}

function deliveryPriority(summary) {
  const failed = summary.event_counts.failed;
  const pending = summary.event_counts.pending;
  const reason = summary.queue.last_failure_reason;
  if (reason !== "receiver_error" && reason !== "http_403" && !(pending >= 50 && failed > 0)) {
    return null;
  }
  const authBlocked = reason === "http_403";
  return priority({
    kind: "delivery",
    severity: authBlocked || failed >= 10 || pending >= 50 ? "high" : "medium",
    score: authBlocked ? 98 : 95,
    title: authBlocked
      ? "Delivery blocked: telemetry endpoint rejected authentication."
      : "Delivery diagnostics: queued telemetry has recent receiver failures.",
    action: authBlocked
      ? "Verify telemetry token and endpoint, then retry with batch-size 1."
      : "Run telemetry doctor and bounded raw preflight before flushing again.",
    evidence: [
      `Failed events: ${formatNumber(failed)}`,
      `Pending events: ${formatNumber(pending)}`,
      `Last failure reason: ${reason ?? "unknown"}`,
    ],
  });
}

function instrumentationPriority(summary, economics, multimodalCoverage) {
  const usage = usageApplicableCoverage(economics);
  const topUsageGap = economics.usage_gap_commands?.[0] ?? null;
  const reasons = [];
  if (usage !== null && usage < 0.8) {
    reasons.push(`Usage-applicable coverage: ${formatPercent(usage)}`);
    if (topUsageGap) {
      reasons.push(`Top usage gap: ${topUsageGap.command} missing ${formatNumber(topUsageGap.usage_applicable_missing_count)} usage-applicable events`);
    }
  }
  if (multimodalCoverage.min !== null && multimodalCoverage.min < 0.75) {
    reasons.push(`Multimodal metadata minimum coverage: ${formatPercent(multimodalCoverage.min)}`);
  }
  if (summary.invalid_events.count > 0) {
    reasons.push(`Invalid telemetry files: ${formatNumber(summary.invalid_events.count)}`);
  }
  if (reasons.length === 0) return null;
  return priority({
    kind: "instrumentation",
    severity: usage !== null && usage < 0.5 ? "high" : "medium",
    score: 88,
    title: "Improve telemetry instrumentation before making stronger product claims.",
    action: topUsageGap
      ? `Fix token usage capture for ${topUsageGap.command}; fill multimodal MIME, byte-size, and media-kind fields in capture paths.`
      : "Fill token usage and multimodal MIME, byte-size, and media-kind fields in capture paths.",
    evidence: reasons,
  });
}

function economicsPriority(economics) {
  const candidate = economics.top_commands.find((item) => (
    item.codex_tokens_saved_estimate >= 1_000_000
    && item.gemini_estimated_cost_usd <= 10
    && (item.success_rate ?? 0) >= 0.8
  ));
  if (!candidate) return null;
  return priority({
    kind: "economics",
    severity: "medium",
    score: 75,
    title: `Expand high-ROI Gemini workflow: ${candidate.command}.`,
    action: "Keep this route active and build product affordances that make it easier to call intentionally.",
    command: candidate.command,
    evidence: [
      `Estimated Codex tokens saved: ${formatNumber(candidate.codex_tokens_saved_estimate)}`,
      `Estimated Gemini cost: ${formatUsd(candidate.gemini_estimated_cost_usd)}`,
      `Success rate: ${formatPercent(candidate.success_rate)}`,
    ],
  });
}

function workflowPriority(economics) {
  const candidate = economics.top_commands.find((item) => (
    item.codex_tokens_saved_estimate > 0
    && item.gemini_tokens_per_codex_token_saved !== null
    && item.gemini_tokens_per_codex_token_saved > 2
  ));
  if (!candidate) return null;
  return priority({
    kind: "workflow",
    severity: "medium",
    score: 68,
    title: `Optimize Gemini routing for ${candidate.command}.`,
    action: "Reduce prompt size, narrow context packs, or route only the parts Gemini can handle cheaply.",
    command: candidate.command,
    evidence: [
      `Gemini tokens per estimated Codex token saved: ${candidate.gemini_tokens_per_codex_token_saved}`,
      `Estimated Codex tokens saved: ${formatNumber(candidate.codex_tokens_saved_estimate)}`,
    ],
  });
}

function multimodalPriority(summary, multimodalCoverage) {
  if (summary.multimodal.event_count < 5 || multimodalCoverage.min === null || multimodalCoverage.min < 0.75) {
    return null;
  }
  const topCommand = summary.multimodal.top_commands[0]?.command ?? "multimodal workflows";
  return priority({
    kind: "multimodal",
    severity: "medium",
    score: 60,
    title: "Deepen multimodal and design-review product surface.",
    action: "Add screenshot review, artifact comparison, visual diff, and design scorecard workflows around proven multimodal usage.",
    command: topCommand === "other" ? null : topCommand,
    evidence: [
      `Multimodal events: ${formatNumber(summary.multimodal.event_count)}`,
      `Media items: ${formatNumber(summary.multimodal.item_count)}`,
      `Metadata minimum coverage: ${formatPercent(multimodalCoverage.min)}`,
    ],
  });
}

function buildPriorities({ summary, economics }) {
  const errorRate = statusErrorRate(summary);
  const multimodal = mediaCoverage(summary.multimodal_adjusted ?? summary.multimodal);
  const rows = [
    reliabilityPriority(summary, errorRate),
    deliveryPriority(summary),
    instrumentationPriority(summary, economics, multimodal),
    economicsPriority(economics),
    workflowPriority(economics),
    multimodalPriority(summary, multimodal),
  ].filter(Boolean);

  return rows
    .sort((left, right) => (
      right.score - left.score
      || left.kind.localeCompare(right.kind)
      || left.title.localeCompare(right.title)
    ))
    .map((item, index) => ({ rank: index + 1, ...item }));
}

export async function runTelemetryPriorities({
  cwd = process.cwd(),
  home,
  scope = "auto",
  now = new Date(),
  topLimit = 10,
  inputPricePerMillion,
  outputPricePerMillion,
} = {}) {
  assertPositiveInteger(topLimit, "topLimit");
  if (inputPricePerMillion !== undefined) {
    assertNonnegativeNumber(inputPricePerMillion, "inputPricePerMillion");
  }
  if (outputPricePerMillion !== undefined) {
    assertNonnegativeNumber(outputPricePerMillion, "outputPricePerMillion");
  }

  const [summary, economics] = await Promise.all([
    runTelemetrySummary({
      cwd,
      home,
      scope,
      now,
      topLimit,
    }),
    runTelemetryEconomics({
      cwd,
      home,
      scope,
      now,
      topLimit,
      inputPricePerMillion,
      outputPricePerMillion,
    }),
  ]);
  const multimodal = mediaCoverage(summary.multimodal_adjusted ?? summary.multimodal);
  const priorities = buildPriorities({ summary, economics }).slice(0, topLimit);

  return {
    scope: summary.scope,
    storage_cwd: summary.storage_cwd,
    generated_at: now.toISOString(),
    pricing: economics.pricing,
    totals: {
      event_count: summary.event_counts.total,
      success_count: summary.status_counts.success_count,
      error_count: summary.status_counts.error_count,
      error_rate: statusErrorRate(summary),
      pending_count: summary.event_counts.pending,
      failed_count: summary.event_counts.failed,
      usage_coverage_rate: usageCoverage(economics),
      usage_applicable_coverage_rate: usageApplicableCoverage(economics),
      multimodal_event_count: summary.multimodal.event_count,
      multimodal_item_count: summary.multimodal.item_count,
      multimodal_metadata_coverage_min: multimodal.min,
      gemini_estimated_cost_usd: economics.totals.gemini_estimated_cost_usd,
      codex_tokens_saved_estimate: economics.totals.codex_tokens_saved_estimate,
    },
    priorities,
    limitations: [
      "Priorities are aggregate local telemetry heuristics, not a replacement for release-blocking tests or user research.",
      "Gemini cost and Codex token savings are estimates from captured usage metadata.",
      "No raw prompt, response text, event ids, batch ids, media file names, or per-event records are included.",
    ],
  };
}

function formatPriorityRows(rows) {
  if (rows.length === 0) return "None";
  return rows.map((item) => [
    `${item.rank}. [${item.severity}] ${item.title}`,
    `   Action: ${item.action}`,
    `   Evidence: ${item.evidence.join("; ")}`,
  ].join("\n")).join("\n");
}

export function formatTelemetryPrioritiesText(report) {
  return [
    "Telemetry Development Priorities",
    "",
    `Scope: ${report.scope}`,
    `Storage: ${report.storage_cwd}`,
    `Events: ${formatNumber(report.totals.event_count)} total, ${formatPercent(report.totals.error_rate)} error rate, ${formatNumber(report.totals.pending_count)} pending, ${formatNumber(report.totals.failed_count)} failed`,
    `Usage coverage: ${formatPercent(report.totals.usage_coverage_rate)}`,
    `Usage-applicable coverage: ${formatPercent(report.totals.usage_applicable_coverage_rate)}`,
    `Estimated Gemini cost: ${formatUsd(report.totals.gemini_estimated_cost_usd)}`,
    `Estimated Codex tokens saved: ${formatNumber(report.totals.codex_tokens_saved_estimate)}`,
    "",
    "Priorities:",
    formatPriorityRows(report.priorities),
    "",
    "Limitations:",
    ...report.limitations.map((item) => `- ${item}`),
    "",
  ].join("\n");
}
