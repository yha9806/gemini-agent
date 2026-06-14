import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { generateDesignJson } from "./gemini-client.mjs";
import {
  GeminiDesignHandoffSchema,
  normalizeDesignBrief,
  normalizeDesignHandoff,
} from "./design-schemas.mjs";
import { resolveDesignModels } from "./design-model-router.mjs";
import { writeDesignJson } from "./design-run-store.mjs";

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function markdownList(items, mapper = (item) => item) {
  if (!Array.isArray(items) || items.length === 0) return ["- None specified"];
  return items.map((item) => `- ${mapper(item)}`);
}

function normalizedSelectedCandidate(selectedCandidate) {
  if (selectedCandidate === null || selectedCandidate === undefined) return null;
  const value = String(selectedCandidate).trim();
  return value || null;
}

function screenSummary(brief) {
  if (!Array.isArray(brief?.screens) || brief.screens.length === 0) return "not specified";
  return brief.screens.map((screen) => `${screen.id}: ${screen.purpose}`).join("; ");
}

function tokenSummary(brief) {
  const tokens = Array.isArray(brief?.design_system?.tokens) ? brief.design_system.tokens : [];
  if (tokens.length === 0) return "not specified";
  return tokens.map((token) => `${token.name}=${token.value}`).join(", ");
}

function listSummary(values) {
  return Array.isArray(values) && values.length > 0 ? values.join(", ") : "not specified";
}

function tokenMarkdown(token) {
  return `${token.name}: ${token.value}`;
}

function buildDesignHandoffPrompt({ brief, selectedCandidate }) {
  return [
    "Create a Codex implementation handoff for this design run.",
    "Return JSON only. Keep tasks concrete, implementation-oriented, and scoped to the described design.",
    `Run id: ${brief?.run_id || "not specified"}`,
    `Selected candidate: ${selectedCandidate || "none"}`,
    `Goal: ${brief?.goal || "not specified"}`,
    `Target user: ${brief?.target_user || "not specified"}`,
    `Screens: ${screenSummary(brief)}`,
    `Visual direction: ${listSummary(brief?.visual_direction)}`,
    `Design tokens: ${tokenSummary(brief)}`,
    `Accessibility: ${listSummary(brief?.accessibility)}`,
    `Responsive requirements: ${listSummary(brief?.responsive_requirements)}`,
    `Acceptance criteria: ${listSummary(brief?.acceptance_criteria)}`,
    `Implementation risks: ${listSummary(brief?.implementation_risks)}`,
    "Include file hints, component tasks, style tokens, responsive tasks, asset tasks, verification, open questions, and risk notes.",
  ].join("\n");
}

export function handoffToMarkdown(handoff) {
  return [
    `# Codex Tasks: ${handoff.implementation_summary}`,
    "",
    `Run id: ${handoff.run_id}`,
    `Selected candidate: ${handoff.selected_candidate || "none"}`,
    "",
    "## Files",
    ...markdownList(handoff.file_hints),
    "",
    "## Component Tasks",
    ...markdownList(handoff.component_tasks),
    "",
    "## Style Tokens",
    ...markdownList(handoff.style_tokens, tokenMarkdown),
    "",
    "## Responsive Tasks",
    ...markdownList(handoff.responsive_tasks),
    "",
    "## Asset Tasks",
    ...markdownList(handoff.asset_tasks),
    "",
    "## Verification",
    ...markdownList(handoff.verification),
    "",
    "## Open Questions",
    ...markdownList(handoff.open_questions),
    "",
    "## Risk Notes",
    ...markdownList(handoff.risk_notes),
    "",
  ].join("\n");
}

export async function runDesignHandoff({
  runDir,
  apiKey,
  env = process.env,
  selectedCandidate = null,
  generate,
  telemetry,
  allowFakeResponse = false,
} = {}) {
  if (!runDir) throw new Error("runDir is required.");

  const resolvedRunDir = resolve(runDir);
  const brief = normalizeDesignBrief(JSON.parse(await readFile(join(resolvedRunDir, "brief.json"), "utf8")));
  const models = resolveDesignModels({ env });
  const selected = normalizedSelectedCandidate(selectedCandidate);
  const prompt = buildDesignHandoffPrompt({ brief, selectedCandidate: selected });
  const baseTelemetryMetadata = plainObject(telemetry?.metadata);
  const generated = generate
    ? await generate({
      apiKey,
      prompt,
      brief,
      selectedCandidate: selected,
      model: models.design_model,
      env,
      responseSchema: GeminiDesignHandoffSchema,
      telemetry,
    })
    : await generateDesignJson({
      apiKey,
      model: models.design_model,
      prompt,
      responseSchema: GeminiDesignHandoffSchema,
      normalize: normalizeDesignHandoff,
      env,
      allowFakeResponse,
      telemetry: telemetry ? {
        ...telemetry,
        command: "design-handoff",
        metadata: {
          ...baseTelemetryMetadata,
          design_stage: "handoff",
          actual_model: models.design_model,
        },
      } : telemetry,
    });

  const handoff = normalizeDesignHandoff({
    ...generated,
    run_id: brief.run_id,
    selected_candidate: selected,
  });

  const handoffPath = await writeDesignJson({
    runDir: resolvedRunDir,
    relativePath: "handoff.json",
    value: handoff,
  });
  const tasksPath = join(resolvedRunDir, "codex-tasks.md");
  await writeFile(tasksPath, handoffToMarkdown(handoff));

  return {
    handoff,
    artifacts: {
      handoff_json: handoffPath,
      codex_tasks: tasksPath,
    },
  };
}
