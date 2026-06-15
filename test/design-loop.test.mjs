import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDesignLoop } from "../src/design-loop.mjs";

test("runDesignLoop exits resumable when actual screenshot is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "design-loop-"));
  try {
    await writeFile(join(dir, "brief.json"), JSON.stringify({ run_id: "20260614T120000000Z-abcdef" }));
    await writeFile(join(dir, "codex-tasks.md"), "# Codex Tasks\n- Run app\n- Capture after screenshot\n");
    const result = await runDesignLoop({ runDir: dir, maxIterations: 2 });
    assert.equal(result.review.status, "needs_screenshot");
    assert.equal(result.review.artifact_review, null);
    assert.equal(result.review.visual_gate, null);
    assert.deepEqual(result.review.next_actions, ["Run app", "Capture after screenshot"]);
    assert.match(result.message, /actual screenshot/i);

    const written = JSON.parse(await readFile(join(dir, "loop-review.json"), "utf8"));
    assert.equal(written.status, "needs_screenshot");
    assert.equal(written.actual_screenshot, null);
    assert.equal(written.visual_gate, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runDesignLoop compares target and actual screenshots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "design-loop-"));
  try {
    await writeFile(join(dir, "brief.json"), JSON.stringify({ run_id: "20260614T120000000Z-abcdef" }));
    const target = join(dir, "target.png");
    const actual = join(dir, "actual.png");
    await writeFile(target, "target");
    await writeFile(actual, "actual");
    let seenGateInput = null;
    const result = await runDesignLoop({
      runDir: dir,
      targetScreenshot: target,
      actualScreenshot: actual,
      maxIterations: 1,
      apiKey: "fake-key",
      telemetry: { cwd: dir, source: "test", command: "design-loop" },
      visualGate: async (input) => {
        seenGateInput = input;
        return {
          kind: "visual_review_gate",
          verdict: "caution",
          review_posture: "comparison_review",
          risk_level: "high",
          risk_reasons: ["design_implementation"],
          smoke: { status: "pass", checks: [] },
          artifact_review: {
            used: true,
            mode: "comparison",
            depth: "quick",
            fallback_used: false,
            scorecard: {
              overall_score: 72,
              visual_hierarchy_score: 76,
              clarity_score: 70,
              accessibility_score: 65,
              consistency_score: 74,
              implementation_readiness_score: 68,
            },
          },
          issues: [],
          next_actions: ["Tighten spacing"],
          limitations: [],
          metadata: {
            generated_at: "2026-06-15T00:00:00.000Z",
            artifact_review_readiness_status: "unknown",
            media_summary: [],
          },
        };
      },
    });

    assert.equal(seenGateInput.reviewMode, undefined);
    assert.equal(seenGateInput.targetScreenshot, target);
    assert.equal(seenGateInput.actualScreenshot, actual);
    assert.equal(seenGateInput.kind, "ui");
    assert.ok(seenGateInput.riskHints.includes("design-implementation"));
    assert.equal(result.review.status, "reviewed");
    assert.equal(result.review.visual_gate.verdict, "caution");
    assert.equal(result.review.summary[0], "Visual gate verdict: caution");
    assert.deepEqual(result.review.next_actions, ["Tighten spacing"]);
    assert.equal(JSON.parse(await readFile(join(dir, "loop-review.json"), "utf8")).visual_gate.verdict, "caution");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runDesignLoop validates maxIterations and target screenshot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "design-loop-"));
  try {
    await writeFile(join(dir, "brief.json"), JSON.stringify({ run_id: "20260614T120000000Z-abcdef" }));
    await assert.rejects(
      () => runDesignLoop({ runDir: dir, maxIterations: 4 }),
      /--max-iterations must be an integer between 1 and 3\./,
    );
    await assert.rejects(
      () => runDesignLoop({ runDir: dir, actualScreenshot: join(dir, "actual.png") }),
      /--target-screenshot is required when --actual-screenshot is provided\./,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
