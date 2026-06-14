import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runArtifactReview } from "./artifact-review.mjs";
import { normalizeDesignLoopReview } from "./design-schemas.mjs";
import { readDesignRunId, writeDesignJson } from "./design-run-store.mjs";

function validateMaxIterations(value) {
  if (!Number.isInteger(value) || value < 1 || value > 3) {
    throw new Error("--max-iterations must be an integer between 1 and 3.");
  }
}

function markdownTaskText(line) {
  const trimmed = String(line ?? "").trim();
  const match = trimmed.match(/^- \[[ xX]\]\s+(.+)$/u) ?? trimmed.match(/^- (.+)$/u);
  return match?.[1]?.trim() || null;
}

async function readNextActions(runDir) {
  const tasks = await readFile(join(runDir, "codex-tasks.md"), "utf8").catch(() => "");
  const actions = tasks
    .split(/\r?\n/u)
    .map(markdownTaskText)
    .filter(Boolean);
  if (actions.length > 0) return actions;
  return [
    "Run the target app or prototype.",
    "Capture the implemented UI screenshot.",
    "Resume with --actual-screenshot <path>.",
  ];
}

function artifactSummary(artifact) {
  if (Array.isArray(artifact?.summary)) return artifact.summary;
  if (Array.isArray(artifact?.notes)) return artifact.notes;
  return [];
}

function artifactNextActions(artifact) {
  for (const key of ["suggested_changes", "implementation_hints_for_codex"]) {
    if (Array.isArray(artifact?.[key])) return artifact[key];
  }
  return [];
}

export async function runDesignLoop({
  runDir,
  targetScreenshot = null,
  actualScreenshot = null,
  maxIterations = 2,
  apiKey,
  artifactReview,
  telemetry,
} = {}) {
  if (!runDir) throw new Error("runDir is required.");
  validateMaxIterations(maxIterations);

  const resolvedRunDir = resolve(runDir);
  const runId = await readDesignRunId(resolvedRunDir);

  if (!actualScreenshot) {
    const review = normalizeDesignLoopReview({
      kind: "design_loop_review",
      run_id: runId,
      iteration: 1,
      target_screenshot: targetScreenshot,
      actual_screenshot: null,
      status: "needs_screenshot",
      summary: ["Actual screenshot is required before target-vs-actual visual comparison."],
      next_actions: await readNextActions(resolvedRunDir),
      artifact_review: null,
    });
    const path = await writeDesignJson({ runDir: resolvedRunDir, relativePath: "loop-review.json", value: review });
    return {
      review,
      path,
      message: "Provide an actual screenshot with --actual-screenshot to resume design loop review.",
    };
  }

  if (!targetScreenshot) {
    throw new Error("--target-screenshot is required when --actual-screenshot is provided.");
  }

  const reviewInput = {
    apiKey,
    cwd: telemetry?.cwd || process.cwd(),
    file: targetScreenshot,
    files: [targetScreenshot, actualScreenshot],
    artifactKind: "ui",
    reviewMode: "comparison",
    reviewDepth: "quick",
    telemetry: telemetry ? {
      ...telemetry,
      command: telemetry.command || "design-loop",
    } : { cwd: process.cwd(), source: "cli", command: "design-loop" },
  };
  const artifact = artifactReview
    ? await artifactReview(reviewInput)
    : await runArtifactReview(reviewInput);

  const review = normalizeDesignLoopReview({
    kind: "design_loop_review",
    run_id: runId,
    iteration: 1,
    target_screenshot: targetScreenshot,
    actual_screenshot: actualScreenshot,
    status: "reviewed",
    summary: artifactSummary(artifact),
    next_actions: artifactNextActions(artifact),
    artifact_review: artifact,
  });
  const path = await writeDesignJson({ runDir: resolvedRunDir, relativePath: "loop-review.json", value: review });
  return {
    review,
    path,
    message: "Design loop review complete.",
  };
}
