import { Buffer } from "node:buffer";
import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { normalizeTelemetryCommandAlias } from "./telemetry-command-normalization.mjs";
import { loadTelemetryConfigContext } from "./telemetry-config.mjs";
import { isValidationTelemetryEvent } from "./telemetry-purpose.mjs";
import { maskCredentialText, normalizeTelemetryEvent } from "./telemetry-schemas.mjs";
import { telemetryQueueDirs } from "./telemetry-queue.mjs";

const QUEUE_STATES = ["pending", "inflight", "sent", "failed", "quarantine"];
const DEFAULT_INPUT_PRICE_PER_MILLION = 1.5;
const DEFAULT_OUTPUT_PRICE_PER_MILLION = 9;
const DEFAULT_MODEL = "gemini-3.5-flash";
const USAGE_NOT_APPLICABLE_COMMANDS = new Set([
  "artifact-review-backfill",
  "artifact-review-backfill-correction",
  "telemetry validate",
  "telemetry-validate",
]);
const CONTEXT_PACK_MODES = new Set(["auto", "explicit", "none"]);
const FRESH_INPUT_MODES = new Set(["none", "stdin", "file", "diff", "smart-diff", "text", "mixed"]);

function zeroStatusCounts() {
  return {
    event_count: 0,
    success_count: 0,
    error_count: 0,
    unknown_count: 0,
  };
}

function zeroEconomics() {
  return {
    event_count: 0,
    success_count: 0,
    error_count: 0,
    unknown_count: 0,
    events_with_usage: 0,
    events_missing_usage: 0,
    usage_applicable_event_count: 0,
    usage_not_applicable_event_count: 0,
    usage_applicable_missing_count: 0,
    suspected_test_fixture_event_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    codex_tokens_saved_estimate: 0,
    product_adjusted_events_with_usage: 0,
    product_adjusted_input_tokens: 0,
    product_adjusted_output_tokens: 0,
    product_adjusted_total_tokens: 0,
    product_adjusted_codex_tokens_saved_estimate: 0,
    events_with_input_bytes: 0,
    input_bytes_total: 0,
    input_bytes_max: 0,
    events_with_input_limit_bytes: 0,
    input_limit_bytes_max: 0,
    input_limit_hit_count: 0,
    gate_event_count: 0,
    context_pack_reused_event_count: 0,
    auto_context_pack_event_count: 0,
    explicit_context_pack_event_count: 0,
    no_context_pack_event_count: 0,
    unknown_context_pack_mode_event_count: 0,
    has_fresh_input_count: 0,
    context_pack_preflight_warning_count: 0,
    smart_diff_event_count: 0,
    smart_diff_context_pack_bootstrapped_count: 0,
  };
}

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

function safeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function safeMetadataInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safePositiveMetadataInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function nullableRatio(numerator, denominator, digits = 6) {
  if (denominator <= 0) return null;
  return Number((numerator / denominator).toFixed(digits));
}

function nullableAverage(total, count, digits = 2) {
  if (count <= 0) return null;
  return Number((total / count).toFixed(digits));
}

function roundCost(value) {
  return Number(value.toFixed(6));
}

function sanitizeDimension(value, fallback = "unknown") {
  const text = `${value ?? ""}`.replace(/[\0-\x1F\x7F]/g, " ").trim();
  const masked = maskCredentialText(text || fallback);
  return masked.length > 120 ? `${masked.slice(0, 117)}...` : masked;
}

function canonicalCommand(value) {
  return normalizeTelemetryCommandAlias(sanitizeDimension(value).toLowerCase().replaceAll("_", "-"));
}

function safeContextPackMode(value) {
  const mode = typeof value === "string" ? value.trim().toLowerCase() : "";
  return CONTEXT_PACK_MODES.has(mode) ? mode : "unknown";
}

function safeFreshInputMode(value) {
  const mode = typeof value === "string" ? value.trim().toLowerCase() : "";
  return FRESH_INPUT_MODES.has(mode) ? mode : "unknown";
}

function statusOf(event) {
  if (event.status === "success" || event.status === "error") return event.status;
  return "unknown";
}

function updateStatus(target, status) {
  target.event_count += 1;
  if (status === "success") target.success_count += 1;
  else if (status === "error") target.error_count += 1;
  else target.unknown_count += 1;
}

function hasUsage(event) {
  return event.economics?.input_tokens != null
    || event.economics?.output_tokens != null
    || event.economics?.total_tokens != null;
}

function usageApplies(event) {
  return !isValidationTelemetryEvent(event)
    && !USAGE_NOT_APPLICABLE_COMMANDS.has(canonicalCommand(event.command));
}

function textByteLength(value) {
  return typeof value === "string" ? Buffer.byteLength(value, "utf8") : null;
}

function isSuspectedTestFixtureEvent(event) {
  // Historical tombstone filter: catches old local test fixtures that leaked into global telemetry.
  // It is intentionally narrow and only affects adjusted aggregate metrics, never raw event retention.
  return canonicalCommand(event.command) === "ask"
    && event.source === "cli"
    && event.project_id === "gemini-agent"
    && event.status === "success"
    && !hasUsage(event)
    && event.latency_ms <= 5
    && textByteLength(event.prompt) === 5
    && textByteLength(event.response) === 5;
}

function savingsEstimate(event, inputTokens) {
  const explicit = event.economics?.codex_tokens_saved_estimate;
  return Number.isInteger(explicit) && explicit >= 0 ? explicit : inputTokens;
}

function addGateInputEconomics(target, event) {
  const inputBytes = safeMetadataInteger(event.metadata?.input_bytes);
  if (inputBytes === null) return;
  target.events_with_input_bytes += 1;
  target.input_bytes_total += inputBytes;
  target.input_bytes_max = Math.max(target.input_bytes_max, inputBytes);

  const limitBytes = safePositiveMetadataInteger(event.metadata?.input_limit_bytes);
  if (limitBytes === null) return;
  target.events_with_input_limit_bytes += 1;
  target.input_limit_bytes_max = Math.max(target.input_limit_bytes_max, limitBytes);
  if (inputBytes >= limitBytes) target.input_limit_hit_count += 1;
}

function addContextLoopEconomics(target, event) {
  if (!event.metadata?.gate) return;
  const contextPackMode = safeContextPackMode(event.metadata?.context_pack_mode);
  const freshInputMode = safeFreshInputMode(event.metadata?.fresh_input_mode);
  const hasFreshInput = event.metadata?.has_fresh_input === true
    || !["none", "unknown"].includes(freshInputMode);
  const smartDiff = freshInputMode === "smart-diff" || event.metadata?.smart_diff_shortcut === true;
  const smartDiffContextPackBootstrapped = smartDiff
    && event.metadata?.smart_diff_context_pack_bootstrapped === true;

  target.gate_event_count += 1;
  if (contextPackMode === "auto" || contextPackMode === "explicit") {
    target.context_pack_reused_event_count += 1;
  }
  if (contextPackMode === "auto") target.auto_context_pack_event_count += 1;
  else if (contextPackMode === "explicit") target.explicit_context_pack_event_count += 1;
  else if (contextPackMode === "none") target.no_context_pack_event_count += 1;
  else target.unknown_context_pack_mode_event_count += 1;
  if (hasFreshInput) target.has_fresh_input_count += 1;
  if (event.metadata?.context_pack_preflight_warning === true) {
    target.context_pack_preflight_warning_count += 1;
  }
  if (smartDiff) target.smart_diff_event_count += 1;
  if (smartDiffContextPackBootstrapped) {
    target.smart_diff_context_pack_bootstrapped_count += 1;
  }
}

function addEventEconomics(target, event) {
  const status = statusOf(event);
  updateStatus(target, status);
  addGateInputEconomics(target, event);
  addContextLoopEconomics(target, event);
  const applies = usageApplies(event);
  if (applies) target.usage_applicable_event_count += 1;
  else target.usage_not_applicable_event_count += 1;
  if (applies && isSuspectedTestFixtureEvent(event)) {
    target.suspected_test_fixture_event_count += 1;
  }
  if (!hasUsage(event)) {
    target.events_missing_usage += 1;
    if (applies) target.usage_applicable_missing_count += 1;
    return;
  }
  const inputTokens = safeInteger(event.economics?.input_tokens);
  const outputTokens = safeInteger(event.economics?.output_tokens);
  const totalTokens = safeInteger(event.economics?.total_tokens);
  target.events_with_usage += 1;
  target.input_tokens += inputTokens;
  target.output_tokens += outputTokens;
  target.total_tokens += totalTokens;
  target.codex_tokens_saved_estimate += savingsEstimate(event, inputTokens);
  if (applies) {
    target.product_adjusted_events_with_usage += 1;
    target.product_adjusted_input_tokens += inputTokens;
    target.product_adjusted_output_tokens += outputTokens;
    target.product_adjusted_total_tokens += totalTokens;
    target.product_adjusted_codex_tokens_saved_estimate += savingsEstimate(event, inputTokens);
  }
}

function eventFileForState(state, path) {
  const name = basename(path);
  if (state === "failed") return name !== "reason.json" && name.endsWith(".json");
  if (state === "quarantine") return name === "event.json";
  return name.endsWith(".json");
}

async function* walkFiles(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isFile()) {
      yield path;
    } else if (entry.isDirectory()) {
      yield* walkFiles(path);
    }
  }
}

async function readEventFile(path) {
  const raw = await readFile(path, "utf8");
  return normalizeTelemetryEvent(JSON.parse(raw));
}

function costFor({ inputTokens, outputTokens, inputPricePerMillion, outputPricePerMillion }) {
  return roundCost(
    (inputTokens / 1_000_000) * inputPricePerMillion
    + (outputTokens / 1_000_000) * outputPricePerMillion,
  );
}

function enrichEconomics(item, pricing) {
  const adjustedUsageApplicableEventCount = Math.max(
    0,
    item.usage_applicable_event_count - item.suspected_test_fixture_event_count,
  );
  const adjustedUsageApplicableMissingCount = Math.max(
    0,
    item.usage_applicable_missing_count - item.suspected_test_fixture_event_count,
  );
  return {
    ...item,
    usage_applicable_adjusted_event_count: adjustedUsageApplicableEventCount,
    usage_applicable_adjusted_missing_count: adjustedUsageApplicableMissingCount,
    gemini_estimated_cost_usd: costFor({
      inputTokens: item.input_tokens,
      outputTokens: item.output_tokens,
      inputPricePerMillion: pricing.input_price_per_million,
      outputPricePerMillion: pricing.output_price_per_million,
    }),
    product_adjusted_gemini_estimated_cost_usd: costFor({
      inputTokens: item.product_adjusted_input_tokens,
      outputTokens: item.product_adjusted_output_tokens,
      inputPricePerMillion: pricing.input_price_per_million,
      outputPricePerMillion: pricing.output_price_per_million,
    }),
    gemini_tokens_per_codex_token_saved: nullableRatio(
      item.total_tokens,
      item.codex_tokens_saved_estimate,
    ),
    product_adjusted_gemini_tokens_per_codex_token_saved: nullableRatio(
      item.product_adjusted_total_tokens,
      item.product_adjusted_codex_tokens_saved_estimate,
    ),
    input_bytes_avg: nullableAverage(item.input_bytes_total, item.events_with_input_bytes),
    input_limit_hit_rate: nullableRatio(
      item.input_limit_hit_count,
      item.events_with_input_limit_bytes,
      4,
    ),
    context_pack_reuse_rate: nullableRatio(
      item.context_pack_reused_event_count,
      item.gate_event_count,
      4,
    ),
    auto_context_pack_rate: nullableRatio(
      item.auto_context_pack_event_count,
      item.gate_event_count,
      4,
    ),
    context_pack_preflight_warning_rate: nullableRatio(
      item.context_pack_preflight_warning_count,
      item.gate_event_count,
      4,
    ),
    smart_diff_context_pack_bootstrap_rate: nullableRatio(
      item.smart_diff_context_pack_bootstrapped_count,
      item.smart_diff_event_count,
      4,
    ),
    usage_coverage_rate: nullableRatio(item.events_with_usage, item.event_count, 4),
    usage_applicable_coverage_rate: nullableRatio(
      item.usage_applicable_event_count - item.usage_applicable_missing_count,
      item.usage_applicable_event_count,
      4,
    ),
    usage_applicable_adjusted_coverage_rate: nullableRatio(
      adjustedUsageApplicableEventCount - adjustedUsageApplicableMissingCount,
      adjustedUsageApplicableEventCount,
      4,
    ),
    success_rate: nullableRatio(item.success_count, item.success_count + item.error_count, 4),
  };
}

function contextLoopGateCommands(commandRows, limit) {
  return [...commandRows]
    .filter((item) => item.gate_event_count > 0)
    .sort((left, right) => (
      right.gate_event_count - left.gate_event_count
      || right.context_pack_reused_event_count - left.context_pack_reused_event_count
      || left.command.localeCompare(right.command)
    ))
    .slice(0, limit)
    .map((item) => ({
      command: item.command,
      event_count: item.gate_event_count,
      context_pack_reused_event_count: item.context_pack_reused_event_count,
      context_pack_reuse_rate: item.context_pack_reuse_rate,
      auto_context_pack_event_count: item.auto_context_pack_event_count,
      auto_context_pack_rate: item.auto_context_pack_rate,
      explicit_context_pack_event_count: item.explicit_context_pack_event_count,
      no_context_pack_event_count: item.no_context_pack_event_count,
      unknown_context_pack_mode_event_count: item.unknown_context_pack_mode_event_count,
      has_fresh_input_count: item.has_fresh_input_count,
      context_pack_preflight_warning_count: item.context_pack_preflight_warning_count,
      context_pack_preflight_warning_rate: item.context_pack_preflight_warning_rate,
      smart_diff_event_count: item.smart_diff_event_count,
      smart_diff_context_pack_bootstrapped_count: item.smart_diff_context_pack_bootstrapped_count,
      smart_diff_context_pack_bootstrap_rate: item.smart_diff_context_pack_bootstrap_rate,
      events_with_input_bytes: item.events_with_input_bytes,
      input_bytes_total: item.input_bytes_total,
      input_bytes_avg: item.input_bytes_avg,
      input_bytes_max: item.input_bytes_max,
    }));
}

function topCommands(commandRows, limit) {
  return [...commandRows]
    .sort((left, right) => (
      right.codex_tokens_saved_estimate - left.codex_tokens_saved_estimate
      || right.total_tokens - left.total_tokens
      || left.command.localeCompare(right.command)
    ))
    .slice(0, limit);
}

function productAdjustedTopCommands(commandRows, limit) {
  return [...commandRows]
    .filter((item) => item.product_adjusted_events_with_usage > 0)
    .sort((left, right) => (
      right.product_adjusted_codex_tokens_saved_estimate
        - left.product_adjusted_codex_tokens_saved_estimate
      || right.product_adjusted_total_tokens - left.product_adjusted_total_tokens
      || left.command.localeCompare(right.command)
    ))
    .slice(0, limit);
}

function usageGapCommands(commandRows, totals, limit) {
  return [...commandRows]
    .filter((item) => (
      item.usage_applicable_adjusted_event_count > 0
      && item.usage_applicable_adjusted_missing_count > 0
    ))
    .sort((left, right) => (
      right.usage_applicable_adjusted_missing_count - left.usage_applicable_adjusted_missing_count
      || left.command.localeCompare(right.command)
    ))
    .slice(0, limit)
    .map((item) => ({
      command: item.command,
      usage_applicable_event_count: item.usage_applicable_event_count,
      usage_applicable_missing_count: item.usage_applicable_missing_count,
      usage_applicable_coverage_rate: item.usage_applicable_coverage_rate,
      suspected_test_fixture_event_count: item.suspected_test_fixture_event_count,
      adjusted_usage_applicable_event_count: item.usage_applicable_adjusted_event_count,
      adjusted_usage_applicable_missing_count: item.usage_applicable_adjusted_missing_count,
      adjusted_usage_applicable_coverage_rate: item.usage_applicable_adjusted_coverage_rate,
      missing_share_of_total_applicable_gap: nullableRatio(
        item.usage_applicable_missing_count,
        totals.usage_applicable_missing_count,
        4,
      ),
      adjusted_missing_share_of_total_applicable_gap: nullableRatio(
        item.usage_applicable_adjusted_missing_count,
        totals.usage_applicable_adjusted_missing_count,
        4,
      ),
    }));
}

function gateInputCommands(commandRows, limit) {
  return [...commandRows]
    .filter((item) => item.events_with_input_bytes > 0)
    .sort((left, right) => (
      right.input_bytes_total - left.input_bytes_total
      || right.input_bytes_max - left.input_bytes_max
      || left.command.localeCompare(right.command)
    ))
    .slice(0, limit)
    .map((item) => ({
      command: item.command,
      events_with_input_bytes: item.events_with_input_bytes,
      input_bytes_total: item.input_bytes_total,
      input_bytes_avg: item.input_bytes_avg,
      input_bytes_max: item.input_bytes_max,
      events_with_input_limit_bytes: item.events_with_input_limit_bytes,
      input_limit_bytes_max: item.input_limit_bytes_max,
      input_limit_hit_count: item.input_limit_hit_count,
      input_limit_hit_rate: item.input_limit_hit_rate,
    }));
}

function recommendation(kind, message) {
  return { kind, message };
}

function buildRecommendations({ totals, topCommandRows, usageGapRows, gateInputRows }) {
  const recommendations = [];
  if (
    totals.usage_applicable_adjusted_event_count > 0
    && totals.usage_applicable_adjusted_coverage_rate !== null
    && totals.usage_applicable_adjusted_coverage_rate < 0.8
  ) {
    const topGap = usageGapRows[0];
    const gapSentence = topGap
      ? ` Top gap: ${topGap.command} has ${topGap.adjusted_usage_applicable_missing_count} missing usage-applicable events.`
      : "";
    recommendations.push(recommendation(
      "instrumentation",
      `Usage metadata coverage for Gemini runtime events is below 80%; improve token capture before making strong ROI claims.${gapSentence}`,
    ));
  }
  const highSavings = topCommandRows.find((item) => (
    item.codex_tokens_saved_estimate >= 1_000_000
    && item.gemini_estimated_cost_usd <= 10
    && (item.success_rate ?? 0) >= 0.8
  ));
  if (highSavings) {
    recommendations.push(recommendation(
      "economics",
      `${highSavings.command} shows high estimated Codex token savings at low Gemini cost; keep this workflow active.`,
    ));
  }
  const inefficient = topCommandRows.find((item) => (
    item.codex_tokens_saved_estimate > 0
    && item.gemini_tokens_per_codex_token_saved !== null
    && item.gemini_tokens_per_codex_token_saved > 2
  ));
  if (inefficient) {
    recommendations.push(recommendation(
      "workflow",
      `${inefficient.command} uses more than 2 Gemini tokens per estimated Codex token saved; review prompt size or routing.`,
    ));
  }
  const inputLimitHit = gateInputRows.find((item) => item.input_limit_hit_count > 0);
  if (inputLimitHit) {
    recommendations.push(recommendation(
      "workflow",
      `${inputLimitHit.command} hit its configured input limit in ${inputLimitHit.input_limit_hit_count} event${inputLimitHit.input_limit_hit_count === 1 ? "" : "s"}; use context-pack or narrower review input before raising limits.`,
    ));
  }
  return recommendations;
}

export async function runTelemetryEconomics({
  cwd = process.cwd(),
  home,
  scope = "auto",
  now = new Date(),
  topLimit = 10,
  inputPricePerMillion = DEFAULT_INPUT_PRICE_PER_MILLION,
  outputPricePerMillion = DEFAULT_OUTPUT_PRICE_PER_MILLION,
} = {}) {
  assertPositiveInteger(topLimit, "topLimit");
  assertNonnegativeNumber(inputPricePerMillion, "inputPricePerMillion");
  assertNonnegativeNumber(outputPricePerMillion, "outputPricePerMillion");

  const context = await loadTelemetryConfigContext({ cwd, home, scope });
  if (!context.config?.enabled) throw new Error("Telemetry is not enabled.");

  const pricing = {
    model: DEFAULT_MODEL,
    input_price_per_million: inputPricePerMillion,
    output_price_per_million: outputPricePerMillion,
    currency: "USD",
    source: "default_gemini_api_pricing_observed_2026-06-10",
  };
  const dirs = telemetryQueueDirs(context.storageCwd);
  const totals = zeroEconomics();
  const commands = new Map();

  for (const queueState of QUEUE_STATES) {
    for await (const path of walkFiles(dirs[queueState])) {
      if (!eventFileForState(queueState, path)) continue;
      let event;
      try {
        event = await readEventFile(path);
      } catch (error) {
        if (error.code === "ENOENT") continue;
        continue;
      }
      addEventEconomics(totals, event);
      const command = canonicalCommand(event.command);
      const commandItem = commands.get(command) ?? { command, ...zeroEconomics() };
      addEventEconomics(commandItem, event);
      commands.set(command, commandItem);
    }
  }

  const enrichedTotals = enrichEconomics(totals, pricing);
  const enrichedCommandRows = [...commands.values()].map((item) => enrichEconomics(item, pricing));
  const commandRows = topCommands(enrichedCommandRows, topLimit);
  const productAdjustedCommandRows = productAdjustedTopCommands(enrichedCommandRows, topLimit);
  const usageGapRows = usageGapCommands(enrichedCommandRows, enrichedTotals, topLimit);
  const gateInputRows = gateInputCommands(enrichedCommandRows, topLimit);
  const contextLoop = {
    gate_event_count: enrichedTotals.gate_event_count,
    context_pack_reused_event_count: enrichedTotals.context_pack_reused_event_count,
    context_pack_reuse_rate: enrichedTotals.context_pack_reuse_rate,
    auto_context_pack_event_count: enrichedTotals.auto_context_pack_event_count,
    auto_context_pack_rate: enrichedTotals.auto_context_pack_rate,
    explicit_context_pack_event_count: enrichedTotals.explicit_context_pack_event_count,
    no_context_pack_event_count: enrichedTotals.no_context_pack_event_count,
    unknown_context_pack_mode_event_count: enrichedTotals.unknown_context_pack_mode_event_count,
    has_fresh_input_count: enrichedTotals.has_fresh_input_count,
    context_pack_preflight_warning_count: enrichedTotals.context_pack_preflight_warning_count,
    context_pack_preflight_warning_rate: enrichedTotals.context_pack_preflight_warning_rate,
    smart_diff_event_count: enrichedTotals.smart_diff_event_count,
    smart_diff_context_pack_bootstrapped_count: enrichedTotals.smart_diff_context_pack_bootstrapped_count,
    smart_diff_context_pack_bootstrap_rate: enrichedTotals.smart_diff_context_pack_bootstrap_rate,
    top_gate_commands: contextLoopGateCommands(enrichedCommandRows, topLimit),
  };

  return {
    scope: context.scope,
    storage_cwd: context.storageCwd,
    generated_at: now.toISOString(),
    pricing,
    totals: enrichedTotals,
    top_commands: commandRows,
    product_adjusted_top_commands: productAdjustedCommandRows,
    usage_gap_commands: usageGapRows,
    gate_input_commands: gateInputRows,
    context_loop: contextLoop,
    recommendations: buildRecommendations({
      totals: enrichedTotals,
      topCommandRows: commandRows,
      usageGapRows,
      gateInputRows,
    }),
    limitations: [
      "Gemini cost is estimated from configured per-million-token prices, not provider billing export.",
      "Codex token savings are estimates, not measured Codex billing savings.",
      "Gate input byte metrics require client telemetry metadata and are absent for older events.",
      "Local economics only include telemetry files available on this machine.",
    ],
  };
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

function formatCommandRows(rows) {
  if (rows.length === 0) return "None";
  return rows.map((item, index) => (
    `${index + 1}. ${item.command}: ${formatNumber(item.codex_tokens_saved_estimate)} estimated saved, ${formatUsd(item.gemini_estimated_cost_usd)} Gemini cost, ${formatPercent(item.usage_applicable_coverage_rate)} usage-applicable coverage`
  )).join("\n");
}

function formatUsageGapRows(rows) {
  if (rows.length === 0) return "None";
  return rows.map((item, index) => (
    item.suspected_test_fixture_event_count > 0
      ? `${index + 1}. ${item.command}: ${formatNumber(item.adjusted_usage_applicable_missing_count)} adjusted missing of ${formatNumber(item.adjusted_usage_applicable_event_count)} adjusted usage-applicable events, ${formatPercent(item.adjusted_usage_applicable_coverage_rate)} adjusted coverage, ${formatPercent(item.adjusted_missing_share_of_total_applicable_gap)} of adjusted missing usage gap, ${formatNumber(item.suspected_test_fixture_event_count)} suspected fixture`
      : `${index + 1}. ${item.command}: ${formatNumber(item.usage_applicable_missing_count)} missing of ${formatNumber(item.usage_applicable_event_count)} usage-applicable events, ${formatPercent(item.usage_applicable_coverage_rate)} coverage, ${formatPercent(item.missing_share_of_total_applicable_gap)} of missing usage gap`
  )).join("\n");
}

function formatGateInputRows(rows) {
  if (rows.length === 0) return "None";
  return rows.map((item, index) => (
    `${index + 1}. ${item.command}: ${formatNumber(item.events_with_input_bytes)} events, ${formatNumber(item.input_bytes_total)} bytes total, ${formatNumber(item.input_bytes_avg ?? 0)} avg, ${formatNumber(item.input_bytes_max)} max, ${formatPercent(item.input_limit_hit_rate)} at limit`
  )).join("\n");
}

function formatContextLoopRows(rows) {
  if (rows.length === 0) return "None";
  return rows.map((item, index) => (
    `${index + 1}. ${item.command}: ${formatNumber(item.event_count)} gate events, ${formatPercent(item.context_pack_reuse_rate)} context-pack reuse, ${formatPercent(item.auto_context_pack_rate)} auto, ${formatPercent(item.context_pack_preflight_warning_rate)} preflight warning, ${formatNumber(item.smart_diff_context_pack_bootstrapped_count ?? 0)} smart-diff bootstraps, ${formatNumber(item.input_bytes_avg ?? 0)} avg input bytes`
  )).join("\n");
}

export function formatTelemetryEconomicsText(report) {
  const recommendations = report.recommendations.length
    ? report.recommendations.map((item) => `- ${item.message}`).join("\n")
    : "- No economics recommendations yet; collect more usage-bearing events.";

  return [
    "Telemetry Economics",
    "",
    `Scope: ${report.scope}`,
    `Storage: ${report.storage_cwd}`,
    `Pricing: ${report.pricing.model} input ${formatUsd(report.pricing.input_price_per_million)} / 1M, output ${formatUsd(report.pricing.output_price_per_million)} / 1M (${report.pricing.currency})`,
    "",
    "Totals:",
    `- Events: ${formatNumber(report.totals.event_count)}`,
    `- Usage coverage: ${formatPercent(report.totals.usage_coverage_rate)}`,
    `- Usage-applicable coverage: ${formatPercent(report.totals.usage_applicable_coverage_rate)}`,
    `- Adjusted usage-applicable coverage: ${formatPercent(report.totals.usage_applicable_adjusted_coverage_rate)}`,
    `- Usage-applicable events: ${formatNumber(report.totals.usage_applicable_event_count)}`,
    `- Adjusted usage-applicable events: ${formatNumber(report.totals.usage_applicable_adjusted_event_count)}`,
    `- Usage not applicable events: ${formatNumber(report.totals.usage_not_applicable_event_count)}`,
    `- Suspected test fixture events: ${formatNumber(report.totals.suspected_test_fixture_event_count)}`,
    `- Gemini input tokens: ${formatNumber(report.totals.input_tokens)}`,
    `- Gemini output tokens: ${formatNumber(report.totals.output_tokens)}`,
    `- Gemini total tokens: ${formatNumber(report.totals.total_tokens)}`,
    `- Estimated Gemini cost: ${formatUsd(report.totals.gemini_estimated_cost_usd)}`,
    `- Estimated Codex tokens saved: ${formatNumber(report.totals.codex_tokens_saved_estimate)}`,
    `- Gemini tokens per estimated Codex token saved: ${report.totals.gemini_tokens_per_codex_token_saved ?? "n/a"}`,
    `- Product-adjusted Gemini cost: ${formatUsd(report.totals.product_adjusted_gemini_estimated_cost_usd)}`,
    `- Product-adjusted Codex tokens saved: ${formatNumber(report.totals.product_adjusted_codex_tokens_saved_estimate)}`,
    `- Product-adjusted Gemini tokens per estimated Codex token saved: ${report.totals.product_adjusted_gemini_tokens_per_codex_token_saved ?? "n/a"}`,
    `- Gate input byte events: ${formatNumber(report.totals.events_with_input_bytes)}`,
    `- Gate input total bytes: ${formatNumber(report.totals.input_bytes_total)}`,
    `- Gate input avg bytes: ${report.totals.input_bytes_avg === null ? "n/a" : formatNumber(report.totals.input_bytes_avg)}`,
    `- Gate input max bytes: ${formatNumber(report.totals.input_bytes_max)}`,
    `- Gate input limit hit rate: ${formatPercent(report.totals.input_limit_hit_rate)}`,
    "",
    "Top command economics:",
    formatCommandRows(report.top_commands),
    "",
    "Usage metadata gaps:",
    formatUsageGapRows(report.usage_gap_commands),
    "",
    "Gate input bytes:",
    formatGateInputRows(report.gate_input_commands),
    "",
    "Context loop:",
    `- Gate events: ${formatNumber(report.context_loop?.gate_event_count ?? 0)}`,
    `- Context-pack reuse rate: ${formatPercent(report.context_loop?.context_pack_reuse_rate ?? null)}`,
    `- Auto context-pack rate: ${formatPercent(report.context_loop?.auto_context_pack_rate ?? null)}`,
    `- Context-pack preflight warning rate: ${formatPercent(report.context_loop?.context_pack_preflight_warning_rate ?? null)}`,
    `- Smart-diff auto-bootstrap rate: ${formatPercent(report.context_loop?.smart_diff_context_pack_bootstrap_rate ?? null)}`,
    "Top context-loop gate commands:",
    formatContextLoopRows(report.context_loop?.top_gate_commands ?? []),
    "",
    "Recommendations:",
    recommendations,
    "",
    "Limitations:",
    ...report.limitations.map((item) => `- ${item}`),
    "",
  ].join("\n");
}
