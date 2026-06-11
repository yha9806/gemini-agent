import { runTelemetryEconomics } from "./telemetry-economics.mjs";
import { buildPriorities } from "./telemetry-priorities.mjs";
import { runTelemetrySummary } from "./telemetry-summary.mjs";

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

function firstOrNull(rows) {
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

function compactEconomicsCommand(row) {
  if (!row) return null;
  return {
    command: row.command,
    event_count: row.event_count,
    success_rate: row.success_rate,
    gemini_estimated_cost_usd: row.gemini_estimated_cost_usd,
    codex_tokens_saved_estimate: row.codex_tokens_saved_estimate,
    gemini_tokens_per_codex_token_saved: row.gemini_tokens_per_codex_token_saved,
    usage_applicable_coverage_rate: row.usage_applicable_coverage_rate,
  };
}

function compactMultimodalCommand(row) {
  if (!row) return null;
  return {
    command: row.command,
    event_count: row.event_count,
    item_count: row.item_count,
    byte_count: row.byte_count,
    unknown_mime_items: row.unknown_mime_items,
    unknown_byte_size_items: row.unknown_byte_size_items,
    unknown_kind_items: row.unknown_kind_items,
  };
}

function compactGateCommand(row) {
  if (!row) return null;
  return {
    command: row.command,
    event_count: row.event_count,
    context_pack_reuse_rate: row.context_pack_reuse_rate,
    auto_context_pack_rate: row.auto_context_pack_rate,
    context_pack_preflight_warning_rate: row.context_pack_preflight_warning_rate,
    input_bytes_avg: row.input_bytes_avg,
    input_bytes_max: row.input_bytes_max,
  };
}

function compactDimensionRows(rows, key) {
  return Array.isArray(rows)
    ? rows.map((row) => ({
      [key]: row[key],
      event_count: row.event_count,
      success_count: row.success_count,
      error_count: row.error_count,
      unknown_count: row.unknown_count,
    }))
    : [];
}

function metadataCoverage(multimodal) {
  if (!multimodal || multimodal.item_count <= 0) return null;
  const mime = nullableRatio(multimodal.media_items_with_mime, multimodal.item_count, 4);
  const byteSize = nullableRatio(multimodal.media_items_with_byte_size, multimodal.item_count, 4);
  const kind = nullableRatio(multimodal.media_items_with_kind, multimodal.item_count, 4);
  return Math.min(mime ?? 1, byteSize ?? 1, kind ?? 1);
}

function errorRate(summary) {
  return nullableRatio(
    summary.status_counts.error_count,
    summary.status_counts.success_count + summary.status_counts.error_count,
    4,
  );
}

function executiveSummary({ summary, priorities }) {
  const total = summary.event_counts.total;
  if (total === 0) {
    return {
      status: "empty",
      headline: "No telemetry events available yet.",
      top_next_action: "Collect more telemetry before making product priority claims.",
    };
  }
  const rate = errorRate(summary);
  const deliveryNeedsAttention = summary.event_counts.pending > 0
    || summary.event_counts.failed > 0
    || summary.event_counts.quarantine > 0
    || summary.event_counts.invalid > 0;
  const reliabilityNeedsAttention = rate !== null && rate > 0.2;
  const topPriority = priorities[0] ?? null;
  const topPriorityNeedsAttention = topPriority
    ? ["critical", "high"].includes(topPriority.severity)
    : false;
  const needsAttention = deliveryNeedsAttention || reliabilityNeedsAttention || topPriorityNeedsAttention;
  const nextAction = !reliabilityNeedsAttention && deliveryNeedsAttention
    ? "Run telemetry doctor, then run telemetry flush --dry-run followed by telemetry flush --batch-size 1."
    : topPriority?.action ?? "Keep collecting telemetry and review the next report after more usage.";
  return {
    status: needsAttention ? "attention" : "healthy",
    headline: needsAttention
      ? "Telemetry needs attention before stronger product claims."
      : "Telemetry is healthy enough for product iteration decisions.",
    top_next_action: nextAction,
  };
}

export async function runTelemetryReport({
  cwd = process.cwd(),
  home,
  scope = "auto",
  now = new Date(),
  topLimit = 5,
  inputPricePerMillion,
  outputPricePerMillion,
} = {}) {
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
  const priorities = buildPriorities({ summary, economics }).slice(0, topLimit);
  const multimodal = summary.multimodal_adjusted ?? summary.multimodal;

  return {
    scope: summary.scope,
    generated_at: now.toISOString(),
    pricing: economics.pricing,
    executive_summary: executiveSummary({ summary, priorities }),
    health: {
      event_count: summary.event_counts.total,
      success_count: summary.status_counts.success_count,
      error_count: summary.status_counts.error_count,
      error_rate: errorRate(summary),
      pending_count: summary.event_counts.pending,
      failed_count: summary.event_counts.failed,
      quarantine_count: summary.event_counts.quarantine,
      invalid_count: summary.event_counts.invalid,
    },
    economics: {
      usage_applicable_adjusted_coverage_rate: economics.totals.usage_applicable_adjusted_coverage_rate,
      gemini_estimated_cost_usd: economics.totals.gemini_estimated_cost_usd,
      codex_tokens_saved_estimate: economics.totals.codex_tokens_saved_estimate,
      gemini_tokens_per_codex_token_saved: economics.totals.gemini_tokens_per_codex_token_saved,
      top_command: compactEconomicsCommand(firstOrNull(economics.top_commands)),
    },
    context_loop: {
      gate_event_count: economics.context_loop.gate_event_count,
      context_pack_reuse_rate: economics.context_loop.context_pack_reuse_rate,
      auto_context_pack_rate: economics.context_loop.auto_context_pack_rate,
      context_pack_preflight_warning_rate: economics.context_loop.context_pack_preflight_warning_rate,
      top_gate_command: compactGateCommand(firstOrNull(economics.context_loop.top_gate_commands)),
    },
    multimodal: {
      event_count: multimodal.event_count,
      event_share: nullableRatio(multimodal.event_count, summary.event_counts.total, 4),
      item_count: multimodal.item_count,
      byte_count: multimodal.byte_count,
      metadata_coverage_min: metadataCoverage(multimodal),
      applied_correction_event_count: multimodal.applied_correction_event_count ?? 0,
      top_command: compactMultimodalCommand(firstOrNull(multimodal.top_commands)),
    },
    attribution: {
      top_projects: compactDimensionRows(summary.top_projects, "project_id"),
      top_workspaces: compactDimensionRows(summary.top_workspaces, "workspace_id"),
      top_user_labels: compactDimensionRows(summary.top_user_labels, "user_label"),
      note: "Top attribution dimensions are capped by --top; workspace and user labels omit unknown or unsafe values.",
    },
    priorities,
    limitations: [
      "Product report fields are aggregate telemetry only; no raw prompt, response text, event ids, batch ids, paths, media file names, or per-event records are included.",
      "Gemini cost and Codex token savings are estimates from captured usage metadata.",
      "Reliability rates are telemetry observations and still depend on failure paths emitting telemetry.",
      "Multimodal adoption shows media-bearing workflow usage, not visual quality by itself.",
    ],
  };
}

function formatTopCommand(item) {
  if (!item) return "None";
  return item.command;
}

function formatTopPriority(priorities) {
  const item = priorities[0];
  if (!item) return "None";
  return `[${item.severity}] ${item.title} Action: ${item.action}`;
}

function formatDimensionRows(rows, key) {
  if (!rows.length) return "None";
  return rows.map((item) => (
    `${item[key]} ${formatNumber(item.event_count)} event${item.event_count === 1 ? "" : "s"}`
  )).join("; ");
}

export function formatTelemetryReportText(report) {
  return [
    "Telemetry Product Report",
    "",
    `Scope: ${report.scope}`,
    `Generated: ${report.generated_at}`,
    `Status: ${report.executive_summary.status}`,
    `Headline: ${report.executive_summary.headline}`,
    `Next action: ${report.executive_summary.top_next_action}`,
    "",
    "Health:",
    `- Events: ${formatNumber(report.health.event_count)}`,
    `- Error rate: ${formatPercent(report.health.error_rate)}`,
    `- Pending / failed / quarantined / invalid: ${formatNumber(report.health.pending_count)} / ${formatNumber(report.health.failed_count)} / ${formatNumber(report.health.quarantine_count)} / ${formatNumber(report.health.invalid_count)}`,
    "",
    "Economics:",
    `- Estimated Gemini cost: ${formatUsd(report.economics.gemini_estimated_cost_usd)}`,
    `- Estimated Codex tokens saved: ${formatNumber(report.economics.codex_tokens_saved_estimate)}`,
    `- Gemini tokens per estimated Codex token saved: ${report.economics.gemini_tokens_per_codex_token_saved ?? "n/a"}`,
    `- Adjusted usage-applicable coverage: ${formatPercent(report.economics.usage_applicable_adjusted_coverage_rate)}`,
    `- Top savings command: ${formatTopCommand(report.economics.top_command)}`,
    "",
    "Context reuse:",
    `- Gate events: ${formatNumber(report.context_loop.gate_event_count)}`,
    `- Context-pack reuse rate: ${formatPercent(report.context_loop.context_pack_reuse_rate)}`,
    `- Auto context-pack rate: ${formatPercent(report.context_loop.auto_context_pack_rate)}`,
    `- Preflight warning rate: ${formatPercent(report.context_loop.context_pack_preflight_warning_rate)}`,
    `- Top gate command: ${formatTopCommand(report.context_loop.top_gate_command)}`,
    "",
    "Multimodal adoption:",
    `- Events: ${formatNumber(report.multimodal.event_count)} (${formatPercent(report.multimodal.event_share)} of all telemetry)`,
    `- Media items: ${formatNumber(report.multimodal.item_count)}`,
    `- Media bytes: ${formatNumber(report.multimodal.byte_count)}`,
    `- Metadata minimum coverage: ${formatPercent(report.multimodal.metadata_coverage_min)}`,
    `- Top multimodal command: ${formatTopCommand(report.multimodal.top_command)}`,
    "",
    "Attribution:",
    `- Top projects: ${formatDimensionRows(report.attribution.top_projects, "project_id")}`,
    `- Top workspaces: ${formatDimensionRows(report.attribution.top_workspaces, "workspace_id")}`,
    `- Top user labels: ${formatDimensionRows(report.attribution.top_user_labels, "user_label")}`,
    `- Note: ${report.attribution.note}`,
    "",
    "Top priority:",
    formatTopPriority(report.priorities),
    "",
    "Limitations:",
    ...report.limitations.map((item) => `- ${item}`),
    "",
  ].join("\n");
}
