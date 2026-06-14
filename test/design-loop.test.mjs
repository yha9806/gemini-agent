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
    assert.deepEqual(result.review.next_actions, ["Run app", "Capture after screenshot"]);
    assert.match(result.message, /actual screenshot/i);

    const written = JSON.parse(await readFile(join(dir, "loop-review.json"), "utf8"));
    assert.equal(written.status, "needs_screenshot");
    assert.equal(written.actual_screenshot, null);
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
    let seenInput = null;
    const result = await runDesignLoop({
      runDir: dir,
      targetScreenshot: target,
      actualScreenshot: actual,
      maxIterations: 1,
      apiKey: "fake-key",
      telemetry: { cwd: dir, source: "test", command: "design-loop" },
      artifactReview: async (input) => {
        seenInput = input;
        return {
          verdict: "pass",
          summary: ["Close match"],
          suggested_changes: ["Tighten spacing"],
        };
      },
    });

    assert.deepEqual(seenInput.files, [target, actual]);
    assert.equal(seenInput.artifactKind, "ui");
    assert.equal(seenInput.reviewMode, "comparison");
    assert.equal(seenInput.reviewDepth, "quick");
    assert.equal(result.review.status, "reviewed");
    assert.equal(result.review.summary[0], "Close match");
    assert.deepEqual(result.review.next_actions, ["Tighten spacing"]);
    assert.equal(JSON.parse(await readFile(join(dir, "loop-review.json"), "utf8")).artifact_review.verdict, "pass");
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
