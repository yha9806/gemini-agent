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

function adjustedUsageApplicableCoverage(economics) {
  if (Object.hasOwn(economics.totals, "usage_applicable_adjusted_coverage_rate")) {
    return economics.totals.usage_applicable_adjusted_coverage_rate;
  }
  return usageApplicableCoverage(economics);
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

function commaJoin(items) {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

function weakMultimodalFieldNames(multimodalCoverage, threshold = 0.75) {
  return multimodalFieldGaps(multimodalCoverage, null, threshold)
    .map((item) => item.name);
}

function nonnegativeMetric(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

const MIN_LATENCY_STAGE_EVENTS = 5;

function latencyStageForCommand(summary, stage, command) {
  const stageRow = summary.latency_stages?.top_stages?.find((item) => item?.stage === stage);
  if (!stageRow) return null;
  const commandRow = Array.isArray(stageRow.top_commands)
    ? stageRow.top_commands.find((item) => item?.command === command)
    : null;
  if (!commandRow) return null;
  return {
    stage: stageRow,
    command: commandRow,
  };
}

function latencyStageContext(summary, candidate, p95) {
  const preGemini = latencyStageForCommand(summary, "pre_gemini_total", candidate.command);
  if (!preGemini || p95 <= 0) {
    return {
      action: `Profile ${candidate.command} latency before routing more Codex work through this path.`,
      evidence: [],
    };
  }
  if (nonnegativeMetric(preGemini.command.event_count) < MIN_LATENCY_STAGE_EVENTS) {
    return {
      action: `Profile ${candidate.command} latency before routing more Codex work through this path.`,
      evidence: [],
    };
  }
  const preGeminiP95 = nonnegativeMetric(preGemini.command.p95_ms);
  if (preGeminiP95 <= 0) {
    return {
      action: `Profile ${candidate.command} latency before routing more Codex work through this path.`,
      evidence: [],
    };
  }
  const share = nullableRatio(preGeminiP95, p95, 4);
  const action = share !== null && share < 0.2
    ? `Focus on Gemini generation latency for ${candidate.command}; pre-Gemini stages are a small share of observed p95.`
    : `Profile ${candidate.command} pre-Gemini media preparation and policy/prompt stages before routing more Codex work through this path.`;
  return {
    action,
    evidence: [
      `pre_gemini_total p95: ${formatNumber(preGeminiP95)} ms`,
      `pre-Gemini share of p95 latency: ${formatPercent(share)}`,
    ],
  };
}

const MULTIMODAL_FIELD_CONFIG = [
  { name: "MIME", key: "mime", missingKey: "unknown_mime_items", presentKey: "media_items_with_mime" },
  { name: "byte-size", key: "byte_size", missingKey: "unknown_byte_size_items", presentKey: "media_items_with_byte_size" },
  { name: "media-kind", key: "kind", missingKey: "unknown_kind_items", presentKey: "media_items_with_kind" },
];

const BACKFILL_MANIFEST_SOURCES = new Set([
  "artifact_media_manifest",
  "artifact_sources",
  "none",
  "unknown",
]);

function topMissingMultimodalCommand(multimodal, field) {
  const rows = Array.isArray(multimodal?.top_commands) ? multimodal.top_commands : [];
  return rows
    .map((item) => ({
      command: `${item?.command ?? "unknown"}`,
      missing: nonnegativeMetric(item?.[field.missingKey]),
      present: nonnegativeMetric(item?.[field.presentKey]),
      itemCount: nonnegativeMetric(item?.item_count),
    }))
    .filter((item) => item.missing > 0)
    .sort((left, right) => (
      right.missing - left.missing
      || left.command.localeCompare(right.command)
    ))[0] ?? null;
}

function multimodalFieldGaps(multimodalCoverage, multimodal, threshold = 0.75) {
  return MULTIMODAL_FIELD_CONFIG
    .map((item) => ({
      ...item,
      coverage: multimodalCoverage[item.key],
      topCommand: topMissingMultimodalCommand(multimodal, item),
    }))
    .filter((item) => item.coverage !== null && item.coverage < threshold);
}

function multimodalFillClause(multimodalCoverage) {
  const fields = weakMultimodalFieldNames(multimodalCoverage);
  return fields.length > 0
    ? `fill multimodal ${commaJoin(fields)} fields in capture paths`
    : null;
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
  const quarantine = summary.event_counts.quarantine;
  const reason = summary.queue.last_failure_reason;
  if (quarantine > 0) {
    return priority({
      kind: "delivery",
      severity: "high",
      score: 99,
      title: "Quarantined telemetry requires inspection before broad flushing.",
      action: "Run telemetry quarantine inspect --json, investigate receiver policy or payload class, then archive resolved events with telemetry quarantine archive --reason <reason> --dry-run before --write or retry with bounded flush.",
      evidence: [
        `Quarantined events: ${formatNumber(quarantine)}`,
        `Pending events: ${formatNumber(pending)}`,
        `Failed events: ${formatNumber(failed)}`,
      ],
    });
  }
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

function latencyPriority(summary) {
  const candidate = summary.latency?.top_commands?.find((item) => (
    nonnegativeMetric(item.event_count) >= 5
    && nonnegativeMetric(item.p95_ms) >= 10_000
  ));
  if (!candidate) return null;
  const p95 = nonnegativeMetric(candidate.p95_ms);
  const stageContext = latencyStageContext(summary, candidate, p95);
  return priority({
    kind: "latency",
    severity: p95 >= 30_000 ? "high" : "medium",
    score: p95 >= 30_000 ? 92 : 89,
    title: `Reduce slow Gemini route latency: ${candidate.command}.`,
    action: stageContext.action,
    command: candidate.command,
    evidence: [
      `p50 latency: ${formatNumber(nonnegativeMetric(candidate.p50_ms))} ms`,
      `p95 latency: ${formatNumber(p95)} ms`,
      `p99 latency: ${formatNumber(nonnegativeMetric(candidate.p99_ms))} ms`,
      `Max latency: ${formatNumber(nonnegativeMetric(candidate.max_ms))} ms`,
      `Latency events: ${formatNumber(nonnegativeMetric(candidate.event_count))}`,
      ...stageContext.evidence,
    ],
  });
}

function multimodalGapEvidence(gaps) {
  const evidence = [];
  for (const item of gaps) {
    if (!item.topCommand) continue;
    evidence.push(
      `Top adjusted multimodal ${item.name} gap: ${item.topCommand.command} missing ${formatNumber(item.topCommand.missing)} item${item.topCommand.missing === 1 ? "" : "s"}`,
    );
    if (item.name === "byte-size"
      && item.topCommand.command === "artifact-review-backfill"
      && item.topCommand.itemCount > 0) {
      evidence.push(
        `artifact-review-backfill byte-size known for ${formatNumber(item.topCommand.present)} of ${formatNumber(item.topCommand.itemCount)} adjusted media items`,
      );
    }
  }
  return evidence;
}

function plural(value, singular, pluralText = `${singular}s`) {
  return value === 1 ? singular : pluralText;
}

function safeBackfillManifestSource(value) {
  return BACKFILL_MANIFEST_SOURCES.has(value) ? value : "unknown";
}

function hasArtifactBackfillByteGap(gaps) {
  return gaps.some((item) => (
    item.name === "byte-size"
    && item.topCommand?.command === "artifact-review-backfill"
    && item.topCommand.missing > 0
  ));
}

function backfillManifestSourceEvidence(summary, gaps) {
  if (!hasArtifactBackfillByteGap(gaps)) return [];
  const rows = Array.isArray(summary.backfill?.media_manifest_sources)
    ? summary.backfill.media_manifest_sources
    : [];
  const parts = rows
    .map((item) => ({
      source: safeBackfillManifestSource(item?.media_manifest_source),
      events: nonnegativeMetric(item?.event_count),
      mediaItems: nonnegativeMetric(item?.media_item_count),
    }))
    .filter((item) => item.events > 0 || item.mediaItems > 0)
    .slice(0, 3)
    .map((item) => (
      `${item.source} ${formatNumber(item.events)} ${plural(item.events, "event")} / ${formatNumber(item.mediaItems)} media ${plural(item.mediaItems, "item")}`
    ));
  return parts.length > 0 ? [`Backfill media manifest sources: ${parts.join("; ")}`] : [];
}

function multimodalGapAction(gaps) {
  const actionable = gaps.filter((item) => item.topCommand);
  if (actionable.length === 0) return null;
  if (actionable.length === 1
    && actionable[0].name === "byte-size"
    && actionable[0].topCommand.command === "artifact-review-backfill") {
    return "Fix future artifact-review-backfill byte-size capture; rerun source-available correction backfills for recoverable historical events.";
  }
  const fields = commaJoin(actionable.map((item) => item.name));
  const commands = [...new Set(actionable.map((item) => item.topCommand.command))];
  return commands.length === 1
    ? `Fix multimodal ${fields} capture/backfill for ${commands[0]}.`
    : `Fix multimodal ${fields} capture/backfill for top gap commands.`;
}

function instrumentationPriority(summary, economics, multimodalCoverage, multimodal) {
  const usage = adjustedUsageApplicableCoverage(economics);
  const rawUsage = usageApplicableCoverage(economics);
  const suspectedFixtures = economics.totals.suspected_test_fixture_event_count ?? 0;
  const topUsageGap = economics.usage_gap_commands?.[0] ?? null;
  const usageWeak = usage !== null && usage < 0.8;
  const multimodalWeak = multimodalCoverage.min !== null && multimodalCoverage.min < 0.75;
  const multimodalClause = multimodalWeak ? multimodalFillClause(multimodalCoverage) : null;
  const multimodalGaps = multimodalWeak ? multimodalFieldGaps(multimodalCoverage, multimodal) : [];
  const specificMultimodalAction = multimodalGapAction(multimodalGaps);
  const reasons = [];
  if (usageWeak) {
    reasons.push(`Adjusted usage-applicable coverage: ${formatPercent(usage)}`);
    if (rawUsage !== null && rawUsage !== usage) {
      reasons.push(`Raw usage-applicable coverage: ${formatPercent(rawUsage)}`);
    }
    if (suspectedFixtures > 0) {
      reasons.push(`Suspected test fixture events excluded from adjusted coverage: ${formatNumber(suspectedFixtures)}`);
    }
    if (topUsageGap) {
      reasons.push(`Top adjusted usage gap: ${topUsageGap.command} missing ${formatNumber(topUsageGap.adjusted_usage_applicable_missing_count ?? topUsageGap.usage_applicable_missing_count)} usage-applicable event${(topUsageGap.adjusted_usage_applicable_missing_count ?? topUsageGap.usage_applicable_missing_count) === 1 ? "" : "s"}`);
    }
  }
  if (multimodalWeak) {
    reasons.push(`Multimodal metadata minimum coverage: ${formatPercent(multimodalCoverage.min)}`);
    reasons.push(...multimodalGapEvidence(multimodalGaps));
    reasons.push(...backfillManifestSourceEvidence(summary, multimodalGaps));
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
    action: usageWeak && topUsageGap
      ? `Fix token usage capture for ${topUsageGap.command}${multimodalClause ? `; ${multimodalClause}` : ""}.`
      : usageWeak
        ? "Fill token usage fields in capture paths."
        : multimodalWeak
          ? specificMultimodalAction ?? `${multimodalClause.charAt(0).toUpperCase()}${multimodalClause.slice(1)}.`
          : "Repair invalid telemetry files before making stronger product claims.",
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

function nullableMetricRatio(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function gateInputForCommand(economics, command) {
  const rows = Array.isArray(economics.gate_input_commands) ? economics.gate_input_commands : [];
  const row = rows.find((item) => item?.command === command);
  if (!row || nonnegativeMetric(row.events_with_input_bytes) <= 0) return null;
  return {
    eventsWithInputBytes: nonnegativeMetric(row.events_with_input_bytes),
    inputBytesAvg: nonnegativeMetric(row.input_bytes_avg),
    inputBytesMax: nonnegativeMetric(row.input_bytes_max),
    inputLimitHitCount: nonnegativeMetric(row.input_limit_hit_count),
    inputLimitHitRate: nullableMetricRatio(row.input_limit_hit_rate),
  };
}

function workflowPriority(economics) {
  const candidate = economics.top_commands.find((item) => (
    item.codex_tokens_saved_estimate > 0
    && item.gemini_tokens_per_codex_token_saved !== null
    && item.gemini_tokens_per_codex_token_saved > 2
  ));
  if (!candidate) return null;
  const gateInput = gateInputForCommand(economics, candidate.command);
  const gateInputEvidence = gateInput
    ? [
      `Gate input byte events: ${formatNumber(gateInput.eventsWithInputBytes)}`,
      `Average gate input bytes: ${formatNumber(gateInput.inputBytesAvg)}`,
      `Max gate input bytes: ${formatNumber(gateInput.inputBytesMax)}`,
      `Gate input limit hit rate: ${formatPercent(gateInput.inputLimitHitRate)}`,
    ]
    : [];
  return priority({
    kind: "workflow",
    severity: "medium",
    score: 68,
    title: `Optimize Gemini routing for ${candidate.command}.`,
    action: gateInput?.inputLimitHitCount > 0
      ? `Use context-pack or narrower review input before raising ${candidate.command} limits.`
      : "Reduce prompt size, narrow context packs, or route only the parts Gemini can handle cheaply.",
    command: candidate.command,
    evidence: [
      `Gemini tokens per estimated Codex token saved: ${candidate.gemini_tokens_per_codex_token_saved}`,
      `Estimated Codex tokens saved: ${formatNumber(candidate.codex_tokens_saved_estimate)}`,
      ...gateInputEvidence,
    ],
  });
}

function artifactReviewScorecardCoverage(summary) {
  const quality = summary.artifact_review_quality;
  if (!quality || nonnegativeMetric(quality.event_count) <= 0) return null;
  return nullableRatio(
    nonnegativeMetric(quality.scorecard_event_count),
    nonnegativeMetric(quality.event_count),
    4,
  );
}

function topArtifactReviewQualityCommand(summary) {
  const row = summary.artifact_review_quality?.top_commands?.[0];
  const command = typeof row?.command === "string" && row.command.trim()
    ? row.command
    : "artifact-review";
  return command === "other" ? null : command;
}

function contextPackReusePriority(economics) {
  const rows = Array.isArray(economics.context_loop?.top_gate_commands)
    ? economics.context_loop.top_gate_commands
    : [];
  const candidate = rows.find((item) => (
    nonnegativeMetric(item.event_count) >= 5
    && nonnegativeMetric(item.input_bytes_avg) > 1024
    && nullableMetricRatio(item.context_pack_reuse_rate) !== null
    && item.context_pack_reuse_rate < 0.5
  ));
  if (!candidate) return null;
  const reuseRate = nullableMetricRatio(candidate.context_pack_reuse_rate);
  const autoRate = nullableMetricRatio(candidate.auto_context_pack_rate);
  const smartDiffBootstrapRate = nullableMetricRatio(
    candidate.smart_diff_context_pack_bootstrap_rate,
  );
  const action = candidate.command === "diff-review"
    ? "Increase context-pack reuse for diff-review: use gemini-agent diff-review --smart-diff so missing project-root packs automatically bootstrap before review; manually refresh stale or unrelated packs with gemini-agent context-pack --bootstrap --write-artifact."
    : `Increase context-pack reuse for ${candidate.command}: run gemini-agent context-pack --bootstrap --write-artifact when the pack is missing or stale, then use gemini-agent ${candidate.command} --auto-context-pack with narrow --stdin or --diff input.`;
  return priority({
    kind: "workflow",
    severity: "medium",
    score: 70,
    title: `Increase context-pack reuse for ${candidate.command}.`,
    action,
    command: candidate.command,
    evidence: [
      `Gate events: ${formatNumber(nonnegativeMetric(candidate.event_count))}`,
      `Context-pack reuse rate: ${formatPercent(reuseRate)}`,
      `Auto context-pack rate: ${formatPercent(autoRate)}`,
      ...(smartDiffBootstrapRate === null ? [] : [
        `Smart-diff auto-bootstrap rate: ${formatPercent(smartDiffBootstrapRate)}`,
      ]),
      `Average gate input bytes: ${formatNumber(nonnegativeMetric(candidate.input_bytes_avg))}`,
      `Max gate input bytes: ${formatNumber(nonnegativeMetric(candidate.input_bytes_max))}`,
    ],
  });
}

function multimodalPriority(summary, multimodalCoverage) {
  if (summary.multimodal.event_count < 5 || multimodalCoverage.min === null || multimodalCoverage.min < 0.75) {
    return null;
  }
  const quality = summary.artifact_review_quality ?? {};
  const qualityEventCount = nonnegativeMetric(quality.event_count);
  const scorecardEventCount = nonnegativeMetric(quality.scorecard_event_count);
  const scorecardCoverage = artifactReviewScorecardCoverage(summary);
  const avgOverallScore = nullableMetricRatio(quality.avg_overall_score);
  if (qualityEventCount >= 5 && scorecardCoverage !== null && scorecardCoverage < 0.8) {
    return priority({
      kind: "multimodal",
      severity: "medium",
      score: 66,
      title: "Improve artifact-review design scorecard coverage.",
      action: "Capture numeric design scorecards for artifact-review runs before using visual quality metrics for product decisions.",
      command: topArtifactReviewQualityCommand(summary),
      evidence: [
        `Artifact-review quality events: ${formatNumber(qualityEventCount)}`,
        `Scorecard events: ${formatNumber(scorecardEventCount)}`,
        `Artifact-review scorecard coverage: ${formatPercent(scorecardCoverage)}`,
      ],
    });
  }
  if (qualityEventCount >= 5
    && scorecardCoverage !== null
    && scorecardCoverage >= 0.8
    && avgOverallScore !== null
    && avgOverallScore < 70) {
    return priority({
      kind: "multimodal",
      severity: "medium",
      score: 65,
      title: "Improve artifact-review design quality signals.",
      action: "Calibrate artifact-review prompts, design scorecard rubric, and screenshot review workflow before expanding more visual tasks.",
      command: topArtifactReviewQualityCommand(summary),
      evidence: [
        `Artifact-review quality events: ${formatNumber(qualityEventCount)}`,
        `Scorecard events: ${formatNumber(scorecardEventCount)}`,
        `Artifact-review scorecard coverage: ${formatPercent(scorecardCoverage)}`,
        `Average artifact-review overall score: ${avgOverallScore}`,
      ],
    });
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

const QUICK_DEPTH_MIN_EVENTS = 5;
const QUICK_DEPTH_MAX_ERROR_RATE = 0.2;

function artifactReviewDepthRow(summary, depth) {
  const rows = Array.isArray(summary.artifact_review_depths?.top_depths)
    ? summary.artifact_review_depths.top_depths
    : [];
  return rows.find((item) => item?.review_depth === depth) ?? null;
}

function knownErrorRate(row) {
  if (!row) return null;
  return nullableRatio(nonnegativeMetric(row.error_count), (
    nonnegativeMetric(row.success_count) + nonnegativeMetric(row.error_count)
  ), 4);
}

function artifactReviewDepthPriority(summary) {
  const quick = artifactReviewDepthRow(summary, "quick");
  if (!quick || nonnegativeMetric(quick.event_count) < QUICK_DEPTH_MIN_EVENTS) return null;
  const quickErrorRate = knownErrorRate(quick);
  if (quickErrorRate === null || quickErrorRate < QUICK_DEPTH_MAX_ERROR_RATE) return null;
  const standard = artifactReviewDepthRow(summary, "standard");
  const evidence = [
    `Quick depth events: ${formatNumber(nonnegativeMetric(quick.event_count))}`,
    `Quick depth error rate: ${formatPercent(quickErrorRate)}`,
  ];
  if (quick.p95_latency_ms !== null) {
    evidence.push(`Quick depth p95 latency: ${formatNumber(nonnegativeMetric(quick.p95_latency_ms))} ms`);
  }
  if (standard?.p95_latency_ms !== null && standard?.p95_latency_ms !== undefined) {
    evidence.push(`Standard depth p95 latency: ${formatNumber(nonnegativeMetric(standard.p95_latency_ms))} ms`);
  }
  if (nonnegativeMetric(quick.total_tokens) > 0) {
    evidence.push(`Quick depth total tokens: ${formatNumber(nonnegativeMetric(quick.total_tokens))}`);
  }
  return priority({
    kind: "multimodal",
    severity: "medium",
    score: 87,
    title: "Validate artifact-review quick depth before wider routing.",
    action: "Compare quick vs standard on success rate, p95 latency, token usage, and scorecards. Keep standard fallback until quick depth error rate is clearly lower.",
    command: "artifact-review",
    evidence,
  });
}

export function buildPriorities({ summary, economics }) {
  const errorRate = statusErrorRate(summary);
  const multimodalAggregate = summary.multimodal_adjusted ?? summary.multimodal;
  const multimodal = mediaCoverage(multimodalAggregate);
  const rows = [
    reliabilityPriority(summary, errorRate),
    deliveryPriority(summary),
    latencyPriority(summary),
    instrumentationPriority(summary, economics, multimodal, multimodalAggregate),
    economicsPriority(economics),
    contextPackReusePriority(economics),
    workflowPriority(economics),
    artifactReviewDepthPriority(summary),
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
      quarantine_count: summary.event_counts.quarantine,
      latency_p95_ms: summary.latency?.p95_ms ?? null,
      usage_coverage_rate: usageCoverage(economics),
      usage_applicable_coverage_rate: usageApplicableCoverage(economics),
      usage_applicable_adjusted_coverage_rate: adjustedUsageApplicableCoverage(economics),
      suspected_test_fixture_event_count: economics.totals.suspected_test_fixture_event_count ?? 0,
      multimodal_event_count: summary.multimodal.event_count,
      multimodal_item_count: summary.multimodal.item_count,
      multimodal_metadata_coverage_min: multimodal.min,
      artifact_review_quality_event_count: summary.artifact_review_quality?.event_count ?? 0,
      artifact_review_scorecard_event_count: summary.artifact_review_quality?.scorecard_event_count ?? 0,
      artifact_review_scorecard_coverage_rate: artifactReviewScorecardCoverage(summary),
      artifact_review_avg_overall_score: summary.artifact_review_quality?.avg_overall_score ?? null,
      artifact_review_depth_event_count: summary.artifact_review_depths?.event_count ?? 0,
      artifact_review_known_depth_event_count: summary.artifact_review_depths?.known_depth_event_count ?? 0,
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
    `Events: ${formatNumber(report.totals.event_count)} total, ${formatPercent(report.totals.error_rate)} error rate, ${formatNumber(report.totals.pending_count)} pending, ${formatNumber(report.totals.failed_count)} failed, ${formatNumber(report.totals.quarantine_count ?? 0)} quarantined`,
    `Latency p95: ${report.totals.latency_p95_ms == null ? "n/a" : `${formatNumber(report.totals.latency_p95_ms)} ms`}`,
    `Usage coverage: ${formatPercent(report.totals.usage_coverage_rate)}`,
    `Usage-applicable coverage: ${formatPercent(report.totals.usage_applicable_coverage_rate)}`,
    `Adjusted usage-applicable coverage: ${formatPercent(report.totals.usage_applicable_adjusted_coverage_rate)}`,
    `Suspected test fixture events: ${formatNumber(report.totals.suspected_test_fixture_event_count)}`,
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
