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
  assert.deepEqual(review.design_scorecard, {
    overall_score: null,
    visual_hierarchy_score: null,
    clarity_score: null,
    accessibility_score: null,
    consistency_score: null,
    implementation_readiness_score: null,
    strengths: [],
    issues: [],
    recommended_actions: [],
  });
  assert.match(artifactReviewToPrettyJson(review), /artifact_review/);
});

test("normalizes artifact review design scorecard with bounded scores", () => {
  const review = normalizeArtifactReview({
    kind: "artifact_review",
    artifact_type: "design",
    summary: ["A checkout screen"],
    important_details: [],
    design_or_research_findings: [],
    implementation_hints_for_codex: [],
    risks_or_ambiguities: [],
    questions_for_user: [],
    limitations: [],
    design_scorecard: {
      overall_score: 82,
      visual_hierarchy_score: 90,
      clarity_score: 84,
      accessibility_score: 72,
      consistency_score: 80,
      implementation_readiness_score: 78,
      strengths: ["Primary action is prominent"],
      issues: ["Contrast should be checked"],
      recommended_actions: ["Increase secondary text contrast"],
    },
    metadata: {
      model: "gemini-3.5-flash",
      generated_at: "2026-05-28T12:00:00.000Z",
      sources: ["checkout.png"],
    },
  });

  assert.equal(review.design_scorecard.overall_score, 82);
  assert.deepEqual(review.design_scorecard.recommended_actions, ["Increase secondary text contrast"]);
});

test("rejects artifact review design scorecard scores outside 0-100", () => {
  assert.throws(
    () => normalizeArtifactReview({
      kind: "artifact_review",
      artifact_type: "design",
      summary: [],
      important_details: [],
      design_or_research_findings: [],
      implementation_hints_for_codex: [],
      risks_or_ambiguities: [],
      questions_for_user: [],
      limitations: [],
      design_scorecard: {
        overall_score: 101,
      },
      metadata: {
        model: "gemini-3.5-flash",
        generated_at: "2026-05-28T12:00:00.000Z",
        sources: [],
      },
    }),
    /Invalid artifact review JSON/,
  );
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
  assert.match(prompt, /design_scorecard/);
  assert.match(prompt, /overall_score/);
  assert.match(prompt, /0-100/);
  assert.match(prompt, /must provide all six design_scorecard numeric fields/i);
  assert.match(prompt, /accessibility_score must be based on visible contrast, readability, text density, target size, state visibility, and focus or keyboard cues/i);
  assert.match(prompt, /Only use null for a score when the artifact itself does not provide enough visible evidence/i);
  assert.match(prompt, /If any score is null, explain why in limitations or risks_or_ambiguities/i);
});

test("builds quick artifact review prompt with concise output budget instructions", () => {
  const prompt = buildArtifactReviewPrompt({
    artifactKind: "ui",
    reviewDepth: "quick",
    sources: ["design.png"],
    policy: null,
  });

  assert.match(prompt, /Review depth: quick/);
  assert.match(prompt, /Quick review budget/);
  assert.match(prompt, /at most two/i);
  assert.match(prompt, /Keep the same JSON shape/);
  assert.match(prompt, /design_scorecard/);
  assert.match(prompt, /overall_score/);
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
