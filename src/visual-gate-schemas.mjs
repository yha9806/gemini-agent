import { z } from "zod";

export const VISUAL_GATE_VERDICTS = ["pass", "caution", "block"];
export const VISUAL_GATE_REVIEW_POSTURES = [
  "smoke_only",
  "quick_review",
  "comparison_review",
  "standard_fallback",
  "blocked_before_gemini",
];
export const VISUAL_GATE_RISK_LEVELS = ["low", "medium", "high"];
export const VISUAL_GATE_ROUTINGS = ["required", "recommended", "skip"];
export const VISUAL_GATE_ISSUE_CATEGORIES = [
  "blank_or_missing_render",
  "layout_overflow",
  "responsive_breakage",
  "text_overflow_or_occlusion",
  "accessibility_contrast_or_readability",
  "chart_or_data_readability",
  "target_actual_drift",
  "missing_labels_or_context",
  "asset_rendering_failure",
  "interaction_state_gap",
  "uncertain_visual_evidence",
];

const HARD_BLOCK_CATEGORIES = new Set([
  "blank_or_missing_render",
  "layout_overflow",
  "text_overflow_or_occlusion",
  "target_actual_drift",
  "asset_rendering_failure",
]);

const NullableScore = z.number().int().min(0).max(100).nullable().default(null);

export const VisualGateScorecardZodSchema = z.object({
  overall_score: NullableScore,
  visual_hierarchy_score: NullableScore,
  clarity_score: NullableScore,
  accessibility_score: NullableScore,
  consistency_score: NullableScore,
  implementation_readiness_score: NullableScore,
});

export const VisualGateIssueZodSchema = z.object({
  category: z.enum(VISUAL_GATE_ISSUE_CATEGORIES),
  severity: z.enum(["low", "medium", "high"]),
  summary: z.string(),
  recommended_action: z.string(),
});

export const VisualGateSmokeCheckZodSchema = z.object({
  name: z.string(),
  status: z.enum(VISUAL_GATE_VERDICTS),
  evidence: z.string(),
});

export const VisualGateMediaSummaryZodSchema = z.object({
  role: z.enum(["target", "actual", "before", "after", "viewport"]),
  mime_type: z.string().nullable().default(null),
  byte_size: z.number().int().nonnegative().nullable().default(null),
  width: z.number().int().positive().nullable().default(null),
  height: z.number().int().positive().nullable().default(null),
  media_kind: z.enum(["screenshot", "design", "document", "image", "unknown"]).default("screenshot"),
}).strict();

export const VisualGateResultZodSchema = z.object({
  kind: z.literal("visual_review_gate"),
  verdict: z.enum(VISUAL_GATE_VERDICTS),
  review_posture: z.enum(VISUAL_GATE_REVIEW_POSTURES),
  risk_level: z.enum(VISUAL_GATE_RISK_LEVELS),
  risk_reasons: z.array(z.string()).default([]),
  smoke: z.object({
    status: z.enum(VISUAL_GATE_VERDICTS),
    checks: z.array(VisualGateSmokeCheckZodSchema).default([]),
  }),
  artifact_review: z.object({
    used: z.boolean(),
    mode: z.enum(["single", "comparison"]).nullable().default(null),
    depth: z.enum(["quick", "standard"]).nullable().default(null),
    fallback_used: z.boolean().default(false),
    scorecard: VisualGateScorecardZodSchema.nullable().default(null),
  }),
  issues: z.array(VisualGateIssueZodSchema).default([]),
  next_actions: z.array(z.string()).default([]),
  limitations: z.array(z.string()).default([]),
  metadata: z.object({
    generated_at: z.string(),
    artifact_review_readiness_status: z.enum(["ready", "collect_more_samples", "blocked", "unknown"]).default("unknown"),
    media_summary: z.array(VisualGateMediaSummaryZodSchema).default([]),
  }),
}).strict();

export function visualGateVerdictFromSignals({
  routing = "recommended",
  smokeStatus = "pass",
  scorecard = null,
  issues = [],
} = {}) {
  if (smokeStatus === "block") return "block";
  if (issues.some((issue) => HARD_BLOCK_CATEGORIES.has(issue.category) && issue.severity !== "low")) return "block";

  const readiness = scorecard?.implementation_readiness_score;
  if (routing === "required" && Number.isInteger(readiness) && readiness < 50) return "block";
  if (Number.isInteger(readiness) && readiness < 70) return "caution";
  const accessibility = scorecard?.accessibility_score;
  if (Number.isInteger(accessibility) && accessibility < 60) return "caution";
  if (smokeStatus === "caution") return "caution";
  if (issues.some((issue) => issue.severity === "medium" || issue.severity === "high")) return "caution";
  return "pass";
}

export function normalizeVisualGateResult(value) {
  const parsed = VisualGateResultZodSchema.safeParse(value);
  if (!parsed.success) {
    const message = parsed.error.issues?.map((issue) => issue.message).join("; ") || parsed.error.message;
    throw new Error(`Invalid visual gate JSON: ${message}`);
  }
  return parsed.data;
}

export function visualGateToPrettyJson(result) {
  return `${JSON.stringify(normalizeVisualGateResult(result), null, 2)}\n`;
}
