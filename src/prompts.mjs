import { renderPolicy } from "./policies.mjs";

const GATE_INSTRUCTIONS = {
  plan_critique: "Review the implementation plan before code is written. Focus on missing constraints, risky assumptions, dependency choices, and test gaps.",
  patch_precheck: "Review the intended patch scope before edits. Focus on blast radius, safer sequencing, and files that should be read first.",
  diff_review: "Review the provided git diff after edits. Focus on regressions, missing tests, unsafe claims, data handling, and commit readiness.",
  research_brief: "Produce a concise sourced research brief. Focus on official or primary sources and distinguish facts from inferences.",
  ask: "Answer the user request directly and concisely.",
};

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
