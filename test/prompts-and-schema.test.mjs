import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildArtifactReviewPrompt, buildContextPackPrompt, buildGatePrompt } from "../src/prompts.mjs";
import { loadProjectPolicy, renderPolicy } from "../src/policies.mjs";
import {
  artifactReviewToPrettyJson,
  contextPackToPrettyJson,
  normalizeArtifactReview,
  normalizeContextPack,
  normalizeReview,
  parseJsonObject,
} from "../src/schemas.mjs";

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

test("normalizes valid context pack JSON", () => {
  const pack = normalizeContextPack({
    kind: "context_pack",
    source_summary: ["CLI and MCP project"],
    project_facts: ["Runtime model is fixed"],
    relevant_files: [{ path: "src/cli.mjs", why_relevant: "CLI command routing" }],
    open_questions: [],
    risks: ["No artifact support yet"],
    recommended_codex_actions: ["Add tests first"],
    limitations: ["Only saw selected files"],
    metadata: {
      model: "gemini-3.5-flash",
      generated_at: "2026-05-28T12:00:00.000Z",
      sources: ["src/cli.mjs"],
    },
  });

  assert.equal(pack.kind, "context_pack");
  assert.equal(pack.relevant_files[0].path, "src/cli.mjs");
  assert.match(contextPackToPrettyJson(pack), /context_pack/);
});

test("normalizes valid artifact review JSON", () => {
  const review = normalizeArtifactReview({
    kind: "artifact_review",
    artifact_type: "image",
    summary: ["A dashboard screenshot"],
    important_details: ["Primary CTA is low contrast"],
    design_or_research_findings: ["Hierarchy needs work"],
    implementation_hints_for_codex: ["Use existing button component"],
    risks_or_ambiguities: ["Cannot inspect hover state"],
    questions_for_user: [],
    limitations: ["Single image only"],
    metadata: {
      model: "gemini-3.5-flash",
      generated_at: "2026-05-28T12:00:00.000Z",
      sources: ["design.png"],
    },
  });

  assert.equal(review.kind, "artifact_review");
  assert.equal(review.artifact_type, "image");
  assert.match(artifactReviewToPrettyJson(review), /artifact_review/);
});

test("builds context pack prompt with policy and source manifest", () => {
  const prompt = buildContextPackPrompt({
    input: "README says this is a Gemini review gate.",
    sources: ["README.md"],
    policy: { project: "gemini-agent", rules: ["Do not edit files from Gemini."] },
  });

  assert.match(prompt, /context pack/i);
  assert.match(prompt, /README\.md/);
  assert.match(prompt, /Do not edit files/);
  assert.match(prompt, /recommended_codex_actions/);
});

test("builds artifact review prompt with artifact kind and policy", () => {
  const prompt = buildArtifactReviewPrompt({
    artifactKind: "ui",
    sources: ["design.png"],
    policy: { project: "gemini-agent", rules: ["Keep Codex as execution authority."] },
  });

  assert.match(prompt, /artifact review/i);
  assert.match(prompt, /ui/);
  assert.match(prompt, /"artifact_type": "design"/);
  assert.doesNotMatch(prompt, /"artifact_type": "ui"/);
  assert.match(prompt, /design\.png/);
  assert.match(prompt, /implementation_hints_for_codex/);
});

test("builds comparison artifact review prompt for visual diff", () => {
  const prompt = buildArtifactReviewPrompt({
    artifactKind: "ui",
    reviewMode: "comparison",
    sources: ["before.png", "after.png"],
    policy: null,
  });

  assert.match(prompt, /Review mode: comparison/);
  assert.match(prompt, /Compare the attached artifacts in source order/);
  assert.match(prompt, /visual changes/);
  assert.match(prompt, /regressions/);
  assert.match(prompt, /before\.png/);
  assert.match(prompt, /after\.png/);
  assert.match(prompt, /"artifact_type": "design"/);
});

test("falls back unknown artifact review kinds to schema-safe image type", () => {
  const prompt = buildArtifactReviewPrompt({
    artifactKind: "wireframe",
    sources: [],
    policy: null,
  });

  assert.match(prompt, /wireframe/);
  assert.match(prompt, /"artifact_type": "image"/);
  assert.doesNotMatch(prompt, /"artifact_type": "wireframe"/);
});
