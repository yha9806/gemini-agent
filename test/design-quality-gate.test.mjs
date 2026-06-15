import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runDesignCandidateQualityGate,
  scoreCandidateReview,
  selectCandidateFromQuality,
} from "../src/design-quality-gate.mjs";

const runId = "20260614T120000000Z-abcdef";

async function writeManifest(dir) {
  await mkdir(join(dir, "candidates"), { recursive: true });
  await writeFile(join(dir, "candidates", "candidate-a.png"), "a");
  await writeFile(join(dir, "candidates", "candidate-b.png"), "b");
  await writeFile(join(dir, "candidates", "manifest.json"), `${JSON.stringify({
    kind: "design_candidates",
    run_id: runId,
    candidates: [
      {
        id: "candidate-a",
        file: "candidate-a.png",
        model: "image-model",
        prompt_hash: "aaa",
        status: "success",
        image_size: null,
        aspect_ratio: null,
        warnings: [],
      },
      {
        id: "candidate-b",
        file: "candidate-b.png",
        model: "image-model",
        prompt_hash: "bbb",
        status: "success",
        image_size: null,
        aspect_ratio: null,
        warnings: [],
      },
    ],
  })}\n`);
}

function review(overrides = {}) {
  return {
    design_scorecard: {
      overall_score: 82,
      visual_hierarchy_score: 80,
      clarity_score: 84,
      accessibility_score: 78,
      consistency_score: 81,
      implementation_readiness_score: 79,
      strengths: ["Clear hierarchy"],
      issues: ["CTA contrast could be stronger"],
      recommended_actions: ["Increase CTA contrast"],
      ...overrides,
    },
  };
}

test("scoreCandidateReview maps scorecard to pass warn and fail statuses", () => {
  assert.deepEqual(scoreCandidateReview({ candidateId: "a", file: "a.png", review: review() }), {
    id: "a",
    file: "a.png",
    score: 81,
    status: "pass",
    strengths: ["Clear hierarchy"],
    issues: ["CTA contrast could be stronger"],
    recommended_actions: ["Increase CTA contrast"],
    warnings: [],
  });
  assert.equal(scoreCandidateReview({
    candidateId: "b",
    file: "b.png",
    review: review({ overall_score: 68 }),
  }).status, "warn");
  assert.equal(scoreCandidateReview({
    candidateId: "c",
    file: "c.png",
    review: review({ overall_score: 49 }),
  }).status, "fail");
});

test("runDesignCandidateQualityGate writes quality artifact and selects best pass", async () => {
  const dir = await mkdtemp(join(tmpdir(), "design-quality-"));
  try {
    await writeManifest(dir);
    const reviewed = [];
    const result = await runDesignCandidateQualityGate({
      runDir: dir,
      reviewCandidate: async ({ candidate }) => {
        reviewed.push(candidate.id);
        return candidate.id === "candidate-a"
          ? review({ overall_score: 66 })
          : review({ overall_score: 88 });
      },
    });

    assert.deepEqual(reviewed, ["candidate-a", "candidate-b"]);
    assert.equal(result.quality.selected_candidate, "candidate-b");
    assert.equal(result.quality.candidates[0].status, "warn");
    assert.equal(result.quality.candidates[1].status, "pass");
    const written = JSON.parse(await readFile(join(dir, "candidates", "quality.json"), "utf8"));
    assert.equal(written.kind, "design_candidate_quality");
    assert.equal(written.selected_candidate, "candidate-b");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("selectCandidateFromQuality preserves run when all candidates fail", () => {
  assert.equal(selectCandidateFromQuality({
    candidates: [
      { id: "candidate-a", score: 42, status: "fail" },
      { id: "candidate-b", score: 55, status: "fail" },
    ],
  }), null);
});
