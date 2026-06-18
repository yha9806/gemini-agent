import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { normalizeDesignLoopReview } from "./design-schemas.mjs";
import { readDesignRunId, writeDesignJson } from "./design-run-store.mjs";
import { runVisualGate } from "./visual-gate.mjs";

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
    "Resume with --target-screenshot <path> --actual-screenshot <path>.",
  ];
}

function messageForGate(gate) {
  if (gate?.verdict === "block") {
    return "Design loop visual gate blocked; inspect loop-review.json.";
  }
  if (gate?.verdict === "caution") {
    return "Design loop review completed with visual cautions; inspect loop-review.json.";
  }
  if (gate?.artifact_review?.fallback_used === true) {
    return "Design loop visual gate used fallback evidence; inspect loop-review.json.";
  }
  return "Design loop review complete.";
}

export async function runDesignLoop({
  runDir,
  targetScreenshot = null,
  actualScreenshot = null,
  maxIterations = 2,
  apiKey,
  visualGate,
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
      visual_gate: null,
    });
    const path = await writeDesignJson({ runDir: resolvedRunDir, relativePath: "loop-review.json", value: review });
    return {
      review,
      path,
      message: "Provide target screenshot and actual screenshot with --target-screenshot and --actual-screenshot to resume design loop review.",
    };
  }

  if (!targetScreenshot) {
    throw new Error("--target-screenshot is required when --actual-screenshot is provided.");
  }

  const gateInput = {
    apiKey,
    cwd: telemetry?.cwd || process.cwd(),
    targetScreenshot,
    actualScreenshot,
    kind: "ui",
    riskHints: ["design-implementation"],
    telemetry: telemetry ? {
      ...telemetry,
      command: telemetry.command || "design-loop",
    } : { cwd: process.cwd(), source: "cli", command: "design-loop" },
  };
  const gate = visualGate
    ? await visualGate(gateInput)
    : await runVisualGate(gateInput);
  const nextActions = Array.isArray(gate?.next_actions) ? gate.next_actions : [];
  const artifact = gate?.artifact_review?.used ? {
    verdict: gate.verdict,
    summary: [`Visual gate verdict: ${gate.verdict}`],
    suggested_changes: nextActions,
  } : null;

  const review = normalizeDesignLoopReview({
    kind: "design_loop_review",
    run_id: runId,
    iteration: 1,
    target_screenshot: targetScreenshot,
    actual_screenshot: actualScreenshot,
    status: "reviewed",
    summary: [`Visual gate verdict: ${gate.verdict}`, ...nextActions.slice(0, 2)],
    next_actions: nextActions,
    artifact_review: artifact,
    visual_gate: gate,
  });
  const path = await writeDesignJson({ runDir: resolvedRunDir, relativePath: "loop-review.json", value: review });
  return {
    review,
    path,
    message: messageForGate(gate),
  };
}
