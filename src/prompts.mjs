import { renderPolicy } from "./policies.mjs";

const GATE_INSTRUCTIONS = {
  plan_critique: "Review the implementation plan before code is written. Focus on missing constraints, risky assumptions, dependency choices, and test gaps.",
  patch_precheck: "Review the intended patch scope before edits. Focus on blast radius, safer sequencing, and files that should be read first.",
  diff_review: "Review the provided git diff after edits. Focus on regressions, missing tests, unsafe claims, data handling, and commit readiness.",
  research_brief: "Produce a concise sourced research brief. Focus on official or primary sources and distinguish facts from inferences.",
  ask: "Answer the user request directly and concisely.",
};

function renderSources(sources) {
  const normalized = Array.isArray(sources) ? sources.map(String).filter(Boolean) : [];
  if (normalized.length === 0) return "- No explicit sources provided.";
  return normalized.map((source) => `- ${source}`).join("\n");
}

function normalizeArtifactKind(artifactKind) {
  const kind = String(artifactKind ?? "").trim().toLowerCase();
  const artifactTypes = {
    ui: "design",
    architecture: "diagram",
    image: "image",
    design: "design",
    diagram: "diagram",
    research: "research",
    pdf: "pdf",
  };

  return artifactTypes[kind] ?? "image";
}

export function buildGatePrompt({ gate, input, policy = null }) {
  const instruction = GATE_INSTRUCTIONS[gate];
  if (!instruction) throw new Error(`Unknown gate: ${gate}`);

  return [
    "You are Gemini acting as a second-opinion reviewer for Codex.",
    `Gate: ${gate}`,
    "",
    instruction,
    "",
    "Project policy:",
    renderPolicy(policy),
    "",
    "Return only JSON with this exact shape:",
    JSON.stringify({
      verdict: "pass | caution | block",
      top_risks: ["string"],
      missing_tests: ["string"],
      unsafe_claims: ["string"],
      suggested_changes: ["string"],
      notes: ["string"],
    }, null, 2),
    "",
    "Input:",
    input,
  ].join("\n");
}

export function buildContextPackPrompt({ input, sources = [], policy = null }) {
  if (!String(input || "").trim()) throw new Error("Context input is empty.");

  return [
    "You are Gemini acting as a context pack coprocessor for Codex.",
    "",
    "Create a compact context pack from the provided project material. Codex remains the execution authority; recommend actions but do not claim commands were run or files were edited.",
    "",
    "Project policy:",
    renderPolicy(policy),
    "",
    "Sources:",
    renderSources(sources),
    "",
    "Return only JSON with this exact shape:",
    JSON.stringify({
      kind: "context_pack",
      source_summary: ["string"],
      project_facts: ["string"],
      relevant_files: [
        {
          path: "string",
          why_relevant: "string",
        },
      ],
      open_questions: ["string"],
      risks: ["string"],
      recommended_codex_actions: ["string"],
      limitations: ["string"],
      metadata: {
        model: "string",
        generated_at: "ISO-8601 string",
        sources: ["string"],
        omitted_sources: ["string"],
      },
    }, null, 2),
    "",
    "Context input:",
    input,
  ].join("\n");
}

export function buildArtifactReviewPrompt({
  artifactKind = "image",
  reviewMode = "single",
  reviewDepth = "standard",
  sources = [],
  policy = null,
}) {
  const artifactType = normalizeArtifactKind(artifactKind);
  const mode = String(reviewMode ?? "").trim().toLowerCase() === "comparison" ? "comparison" : "single";
  const depth = String(reviewDepth ?? "").trim().toLowerCase() === "quick" ? "quick" : "standard";
  const reviewInstruction = mode === "comparison"
    ? "Compare the attached artifacts in source order. Focus on visual changes, regressions, hierarchy shifts, accessibility concerns, implementation-relevant differences, and uncertainty."
    : "Analyze the attached or referenced artifact and produce a structured artifact review. Focus on details Codex can use for implementation, design, research, or follow-up questions.";
  const depthInstruction = depth === "quick"
    ? [
      "Quick review budget:",
      "- Keep the same JSON shape and include every required field.",
      "- Keep each array to at most two concise strings.",
      "- Prioritize summary, concrete risks, implementation actions, and numeric design_scorecard values.",
      "- Avoid explanatory prose, duplicate observations, and broad background context.",
    ].join("\n")
    : "Standard review budget: provide enough concise detail for Codex to act safely.";

  return [
    "You are Gemini acting as an artifact review coprocessor for Codex.",
    `Artifact kind: ${artifactKind}`,
    `Review mode: ${mode}`,
    `Review depth: ${depth}`,
    `Use artifact_type exactly: ${artifactType}`,
    "",
    reviewInstruction,
    depthInstruction,
    "Design scorecard rubric:",
    "- For visual, UI, design, screenshot, or comparison artifacts, you must provide all six design_scorecard numeric fields as integers from 0-100 whenever visible evidence exists.",
    "- accessibility_score must be based on visible contrast, readability, text density, target size, state visibility, and focus or keyboard cues.",
    "- Only use null for a score when the artifact itself does not provide enough visible evidence for that dimension.",
    "- If any score is null, explain why in limitations or risks_or_ambiguities.",
    "",
    "Project policy:",
    renderPolicy(policy),
    "",
    "Sources:",
    renderSources(sources),
    "",
    "Return only JSON with this exact shape:",
    JSON.stringify({
      kind: "artifact_review",
      artifact_type: artifactType,
      summary: ["string"],
      important_details: ["string"],
      design_or_research_findings: ["string"],
      implementation_hints_for_codex: ["string"],
      risks_or_ambiguities: ["string"],
      questions_for_user: ["string"],
      limitations: ["string"],
      design_scorecard: {
        overall_score: "integer 0-100 or null",
        visual_hierarchy_score: "integer 0-100 or null",
        clarity_score: "integer 0-100 or null",
        accessibility_score: "integer 0-100 or null",
        consistency_score: "integer 0-100 or null",
        implementation_readiness_score: "integer 0-100 or null",
        strengths: ["string"],
        issues: ["string"],
        recommended_actions: ["string"],
      },
      metadata: {
        model: "string",
        generated_at: "ISO-8601 string",
        sources: ["string"],
        omitted_sources: ["string"],
      },
    }, null, 2),
  ].join("\n");
}
