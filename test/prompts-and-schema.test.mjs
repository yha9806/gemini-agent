import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGatePrompt } from "../src/prompts.mjs";
import { loadProjectPolicy, renderPolicy } from "../src/policies.mjs";
import { normalizeReview, parseJsonObject } from "../src/schemas.mjs";

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

test("parses prose-wrapped JSON object", () => {
  assert.deepEqual(parseJsonObject('Here is the review: {"verdict":"pass"} Thanks.'), { verdict: "pass" });
});

test("loads nearest project policy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-policy-"));
  await writeFile(join(dir, ".gemini-agent-policy.json"), JSON.stringify({ project: "x", rules: ["rule"] }));
  const policy = await loadProjectPolicy(dir);
  assert.equal(policy.project, "x");
  assert.deepEqual(policy.rules, ["rule"]);
});

test("renders partial inline policy with defaults", () => {
  const rendered = renderPolicy({ rules: [123] });
  assert.match(rendered, /Project: unknown/);
  assert.match(rendered, /Default content mode: diffs_and_summaries_only/);
  assert.match(rendered, /- 123/);
  assert.doesNotMatch(rendered, /undefined/);
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

test("builds gate prompt from partial policy without undefined values", () => {
  const prompt = buildGatePrompt({
    gate: "diff_review",
    input: "diff --git a/x b/x",
    policy: { project: "vulca", rules: ["rule"] },
  });
  assert.match(prompt, /Project: vulca/);
  assert.match(prompt, /Default content mode: diffs_and_summaries_only/);
  assert.doesNotMatch(prompt, /undefined/);
});
