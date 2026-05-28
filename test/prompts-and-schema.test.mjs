import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGatePrompt } from "../src/prompts.mjs";
import { loadProjectPolicy } from "../src/policies.mjs";
import { normalizeReview } from "../src/schemas.mjs";

test("normalizes valid review JSON", () => {
  const review = normalizeReview({
    verdict: "caution",
    top_risks: ["risk"],
    missing_tests: [],
    unsafe_claims: [],
    suggested_changes: ["change"],
    notes: [],
  });
  assert.equal(review.verdict, "caution");
  assert.deepEqual(review.top_risks, ["risk"]);
});

test("rejects invalid verdicts", () => {
  assert.throws(() => normalizeReview({ verdict: "maybe" }), /Invalid review JSON/);
});

test("loads nearest project policy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-policy-"));
  await writeFile(join(dir, ".gemini-agent-policy.json"), JSON.stringify({ project: "x", rules: ["rule"] }));
  const policy = await loadProjectPolicy(dir);
  assert.equal(policy.project, "x");
  assert.deepEqual(policy.rules, ["rule"]);
});

test("builds gate prompt with policy and input", () => {
  const prompt = buildGatePrompt({
    gate: "diff_review",
    input: "diff --git a/x b/x",
    policy: { project: "vulca", rules: ["Never write AI output into human-confirmed fields."] },
  });
  assert.match(prompt, /diff_review/);
  assert.match(prompt, /Never write AI output/);
  assert.match(prompt, /diff --git/);
  assert.match(prompt, /verdict/);
});
