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

export function buildArtifactReviewPrompt({ artifactKind = "image", sources = [], policy = null }) {
  return [
    "You are Gemini acting as an artifact review coprocessor for Codex.",
    `Artifact kind: ${artifactKind}`,
    "",
    "Analyze the attached or referenced artifact and produce a structured artifact review. Focus on details Codex can use for implementation, design, research, or follow-up questions.",
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
      artifact_type: "image | pdf | design | diagram | research",
      summary: ["string"],
      important_details: ["string"],
      design_or_research_findings: ["string"],
      implementation_hints_for_codex: ["string"],
      risks_or_ambiguities: ["string"],
      questions_for_user: ["string"],
      limitations: ["string"],
      metadata: {
        model: "string",
        generated_at: "ISO-8601 string",
        sources: ["string"],
        omitted_sources: ["string"],
      },
    }, null, 2),
  ].join("\n");
}
