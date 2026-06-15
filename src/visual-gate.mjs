import { runArtifactReview } from "./artifact-review.mjs";
import { captureGeminiTelemetry } from "./telemetry-capture.mjs";
import { classifyVisualGateRoute } from "./visual-gate-routing.mjs";
import { collectVisualGateSmoke } from "./visual-gate-smoke.mjs";
import {
  normalizeVisualGateResult,
  visualGateVerdictFromSignals,
} from "./visual-gate-schemas.mjs";

const BOUNDED_TEXT_LIMIT = 240;
const ISSUE_LIMIT = 4;
const ACTION_LIMIT = 4;
const LIMITATION_LIMIT = 4;
const SCORE_KEYS = [
  "overall_score",
  "visual_hierarchy_score",
  "clarity_score",
  "accessibility_score",
  "consistency_score",
  "implementation_readiness_score",
];

function screenshotsFromOptions({ targetScreenshot, actualScreenshot }) {
  const screenshots = [];
  if (targetScreenshot) screenshots.push({ role: "target", path: targetScreenshot });
  if (actualScreenshot) screenshots.push({ role: "actual", path: actualScreenshot });
  return screenshots;
}

function boundedText(value, limit = BOUNDED_TEXT_LIMIT) {
  return String(value ?? "").trim().slice(0, limit);
}

function boundedStringArray(value, limit) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => boundedText(item))
    .filter(Boolean)
    .slice(0, limit);
}

function safeScore(value) {
  return Number.isInteger(value) && value >= 0 && value <= 100 ? value : null;
}

function artifactScorecard(review) {
  const card = review?.design_scorecard;
  if (!card || typeof card !== "object" || Array.isArray(card)) return null;
  return Object.fromEntries(SCORE_KEYS.map((key) => [key, safeScore(card[key])]));
}

function issuesFromArtifactReview(review) {
  return boundedStringArray(review?.design_scorecard?.issues, ISSUE_LIMIT).map((summary) => ({
    category: "uncertain_visual_evidence",
    severity: "medium",
    summary,
    recommended_action: "Inspect the visual review issue and adjust the implementation or screenshot evidence.",
  }));
}

function nextActions({ verdict, artifactReview }) {
  const actions = boundedStringArray(artifactReview?.design_scorecard?.recommended_actions, ACTION_LIMIT);
  if (actions.length > 0) return actions;
  if (verdict === "block") return ["Fix the blocking visual issue and rerun visual gate."];
  if (verdict === "caution") return ["Review the visual caution before claiming the UI is complete."];
  return ["Proceed with normal verification."];
}

function limitationsFor({ smokeOnly, route, artifactReview }) {
  const limitations = boundedStringArray(artifactReview?.limitations, LIMITATION_LIMIT);
  if (smokeOnly) limitations.unshift("Smoke-only mode did not call Gemini.");
  if (!smokeOnly && route.routing === "skip") limitations.unshift("Visual gate routing skipped Gemini artifact review.");
  return limitations.slice(0, LIMITATION_LIMIT);
}

function smokeCheckCounts(checks) {
  const counts = {};
  for (const check of Array.isArray(checks) ? checks : []) {
    const status = check?.status;
    if (status === "pass" || status === "caution" || status === "block") {
      counts[status] = (counts[status] ?? 0) + 1;
    }
  }
  return counts;
}

function issueCategoryCounts(issues) {
  const counts = {};
  for (const issue of Array.isArray(issues) ? issues : []) {
    if (typeof issue?.category === "string" && issue.category) {
      counts[issue.category] = (counts[issue.category] ?? 0) + 1;
    }
  }
  return counts;
}

function reviewModeForScreenshots({ targetScreenshot, actualScreenshot }) {
  return targetScreenshot && actualScreenshot ? "comparison" : "single";
}

function postureFor({ smokeOnly, smokeStatus, route, targetScreenshot, actualScreenshot }) {
  if (smokeStatus === "block") return "blocked_before_gemini";
  if (smokeOnly || route.routing === "skip") return "smoke_only";
  return targetScreenshot && actualScreenshot ? "comparison_review" : "quick_review";
}

function visualGateTelemetryMetadata({
  route,
  posture,
  smoke,
  artifactReviewUsed,
  artifactReviewMode,
  artifactReviewDepth,
  fallbackUsed = false,
  issues = [],
  verdict = null,
  phase = "pre_gemini",
}) {
  const metadata = {
    phase,
    risk_level: route.risk_level,
    risk_reasons: route.risk_reasons,
    routing: route.routing,
    review_posture: posture,
    smoke_status: smoke.status,
    smoke_check_counts: smokeCheckCounts(smoke.checks),
    artifact_review_used: Boolean(artifactReviewUsed),
    artifact_review_mode: artifactReviewUsed ? artifactReviewMode : null,
    artifact_review_depth: artifactReviewUsed ? artifactReviewDepth : null,
    fallback_used: Boolean(fallbackUsed),
    issue_category_counts: issueCategoryCounts(issues),
  };
  if (verdict) metadata.verdict = verdict;
  return { visual_gate: metadata };
}

async function captureVisualGateTelemetry({
  cwd,
  telemetry,
  route,
  posture,
  smoke,
  result,
  artifactReviewUsed,
  artifactReviewMode,
  artifactReviewDepth,
  now,
}) {
  if (!telemetry) return;
  const capture = telemetry.capture ?? captureGeminiTelemetry;
  await capture({
    cwd,
    source: telemetry.source ?? "cli",
    command: telemetry.command ?? "visual-gate",
    prompt: "",
    response: "",
    status: "success",
    latencyMs: 0,
    now,
    outcome: { verdict: result.verdict },
    metadata: visualGateTelemetryMetadata({
      route,
      posture,
      smoke,
      artifactReviewUsed,
      artifactReviewMode,
      artifactReviewDepth,
      issues: result.issues,
      verdict: result.verdict,
      phase: "final",
    }),
  });
}

export async function runVisualGate({
  apiKey,
  cwd = process.cwd(),
  targetScreenshot = null,
  actualScreenshot = null,
  kind = "ui",
  riskHints = [],
  smokeOnly = false,
  artifactReview = runArtifactReview,
  telemetry = { cwd, source: "cli", command: "visual-gate" },
  now = new Date(),
  maxImageBytes,
  readDimensions,
} = {}) {
  const screenshots = screenshotsFromOptions({ targetScreenshot, actualScreenshot });
  const route = classifyVisualGateRoute({
    riskHints,
    traits: {
      hasTargetScreenshot: Boolean(targetScreenshot),
      hasActualScreenshot: Boolean(actualScreenshot),
      isVisualSurface: kind === "ui" || kind === "design",
    },
  });
  const smoke = await collectVisualGateSmoke({
    cwd,
    screenshots,
    ...(Number.isInteger(maxImageBytes) ? { maxImageBytes } : {}),
    ...(readDimensions ? { readDimensions } : {}),
  });
  const mode = reviewModeForScreenshots({ targetScreenshot, actualScreenshot });
  const depth = "quick";
  let posture = postureFor({
    smokeOnly,
    smokeStatus: smoke.status,
    route,
    targetScreenshot,
    actualScreenshot,
  });
  let review = null;
  let scorecard = null;
  let issues = [];

  if (!smokeOnly && smoke.status !== "block" && route.routing !== "skip") {
    review = await artifactReview({
      apiKey,
      cwd,
      file: screenshots[0]?.path,
      files: screenshots.map((item) => item.path),
      artifactKind: kind,
      reviewMode: mode,
      reviewDepth: depth,
      telemetry: telemetry ? {
        ...telemetry,
        command: telemetry.command || "visual-gate",
        metadata: {
          ...(telemetry.metadata && typeof telemetry.metadata === "object" ? telemetry.metadata : {}),
          ...visualGateTelemetryMetadata({
            route,
            posture,
            smoke,
            artifactReviewUsed: true,
            artifactReviewMode: mode,
            artifactReviewDepth: depth,
            issues,
          }),
        },
      } : telemetry,
    });
    scorecard = artifactScorecard(review);
    issues = issuesFromArtifactReview(review);
  }

  const verdict = visualGateVerdictFromSignals({
    routing: route.routing,
    smokeStatus: smoke.status,
    scorecard,
    issues,
  });
  const result = normalizeVisualGateResult({
    kind: "visual_review_gate",
    verdict,
    review_posture: posture,
    risk_level: route.risk_level,
    risk_reasons: route.risk_reasons,
    smoke: { status: smoke.status, checks: smoke.checks },
    artifact_review: {
      used: Boolean(review),
      mode: review ? mode : null,
      depth: review ? depth : null,
      fallback_used: false,
      scorecard,
    },
    issues,
    next_actions: nextActions({ verdict, artifactReview: review }),
    limitations: limitationsFor({ smokeOnly, route, artifactReview: review }),
    metadata: {
      generated_at: now.toISOString(),
      artifact_review_readiness_status: "unknown",
      media_summary: smoke.media_summary,
    },
  });

  await captureVisualGateTelemetry({
    cwd,
    telemetry,
    route,
    posture,
    smoke,
    result,
    artifactReviewUsed: Boolean(review),
    artifactReviewMode: review ? mode : null,
    artifactReviewDepth: review ? depth : null,
    now,
  });

  return result;
}
