import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createPartFromText } from "@google/genai";
import { generateDesignJson } from "./gemini-client.mjs";
import { GeminiDesignBriefSchema, normalizeDesignBrief } from "./design-schemas.mjs";
import { createDesignRun, writeDesignJson } from "./design-run-store.mjs";
import { resolveDesignModels } from "./design-model-router.mjs";

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function markdownList(items) {
  if (!items.length) return ["- None specified"];
  return items.map((item) => `- ${item}`);
}

export function buildDesignBriefPrompt({ inputText, runId }) {
  return [
    "Create a structured design brief for gemini-agent.",
    `Run id: ${runId}`,
    "Return JSON only. Keep implementation guidance concise and actionable.",
    "Include goal, target_user, screens, visual_direction, design_system tokens, accessibility, responsive_requirements, acceptance_criteria, implementation_risks, and metadata.",
    "",
    inputText.trim(),
  ].join("\n");
}

export function designBriefToMarkdown(brief) {
  return [
    `# Design Brief: ${brief.goal}`,
    "",
    `Target user: ${brief.target_user}`,
    "",
    "## Screens",
    ...markdownList(brief.screens.map((screen) => `${screen.id}: ${screen.purpose}`)),
    "",
    "## Visual Direction",
    ...markdownList(brief.visual_direction),
    "",
    "## Design System",
    ...markdownList(brief.design_system.tokens.map((token) => `${token.name}: ${token.value}`)),
    "",
    "## Accessibility",
    ...markdownList(brief.accessibility),
    "",
    "## Responsive Requirements",
    ...markdownList(brief.responsive_requirements),
    "",
    "## Acceptance Criteria",
    ...markdownList(brief.acceptance_criteria),
    "",
    "## Implementation Risks",
    ...markdownList(brief.implementation_risks),
    "",
  ].join("\n");
}

export async function runDesignBrief({
  cwd = process.cwd(),
  inputText,
  apiKey,
  env = process.env,
  now = new Date(),
  random = Math.random,
  generate,
  telemetry,
  allowFakeResponse = false,
} = {}) {
  if (!inputText || !inputText.trim()) throw new Error("design brief input is empty.");

  const run = await createDesignRun({ cwd, now, random });
  const models = resolveDesignModels({ env });
  const prompt = buildDesignBriefPrompt({ inputText, runId: run.runId });
  const telemetryMetadata = plainObject(telemetry?.metadata);
  const generated = generate
    ? await generate({
      apiKey,
      prompt,
      runId: run.runId,
      model: models.design_model,
      env,
      responseSchema: GeminiDesignBriefSchema,
      normalize: normalizeDesignBrief,
      telemetry,
    })
    : await generateDesignJson({
      apiKey,
      model: models.design_model,
      prompt,
      contents: createPartFromText(prompt),
      responseSchema: GeminiDesignBriefSchema,
      normalize: normalizeDesignBrief,
      env,
      allowFakeResponse,
      telemetry: telemetry ? {
        ...telemetry,
        command: "design-brief",
        metadata: {
          ...telemetryMetadata,
          design_stage: "brief",
          actual_model: models.design_model,
        },
      } : telemetry,
    });

  const generatedMetadata = plainObject(generated?.metadata);
  const brief = normalizeDesignBrief({
    ...generated,
    run_id: run.runId,
    metadata: {
      ...generatedMetadata,
      model: models.design_model,
      generated_at: generatedMetadata.generated_at ?? now.toISOString(),
    },
  });

  const briefJsonPath = await writeDesignJson({ runDir: run.dir, relativePath: "brief.json", value: brief });
  const generatedJsonPath = await writeDesignJson({
    runDir: run.dir,
    relativePath: "brief.generated.json",
    value: generated,
  });
  const designMarkdownPath = join(run.dir, "DESIGN.md");
  await writeFile(designMarkdownPath, designBriefToMarkdown(brief));

  return {
    run,
    brief,
    artifacts: {
      brief_json: briefJsonPath,
      generated_json: generatedJsonPath,
      design_markdown: designMarkdownPath,
    },
  };
}
