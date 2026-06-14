import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { generateDesignJson } from "./gemini-client.mjs";
import {
  GeminiDesignPrototypeResponseSchema,
  normalizeDesignBrief,
  normalizeDesignPrototypeManifest,
} from "./design-schemas.mjs";
import { resolveDesignModels } from "./design-model-router.mjs";
import { assertPrototypeRelativePath, writePrototypeFiles } from "./design-run-store.mjs";

const TARGET_STACKS = new Set(["html", "react", "tailwind", "auto"]);

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function validatePrototypeTargetStack(targetStack) {
  if (!TARGET_STACKS.has(targetStack)) {
    throw new Error("--target-stack must be html, react, tailwind, or auto.");
  }
  return targetStack;
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

export function buildPrototypePrompt({ brief, targetStack, selectedCandidate = null }) {
  return [
    "Generate an isolated frontend prototype for user review.",
    "Return JSON only with a manifest and files. Do not modify or reference production source files.",
    "All generated file paths must be relative paths under prototype/ with no traversal.",
    `Target stack: ${targetStack}`,
    `Selected candidate: ${selectedCandidate || "none"}`,
    `Run id: ${brief?.run_id || "not specified"}`,
    `Goal: ${brief?.goal || "not specified"}`,
    `Target user: ${brief?.target_user || "not specified"}`,
    `Screens: ${screenSummary(brief)}`,
    `Visual direction: ${listSummary(brief?.visual_direction)}`,
    `Design tokens: ${tokenSummary(brief)}`,
    `Accessibility: ${listSummary(brief?.accessibility)}`,
    `Responsive requirements: ${listSummary(brief?.responsive_requirements)}`,
    `Acceptance criteria: ${listSummary(brief?.acceptance_criteria)}`,
    "Include a reviewable preview entry and concise review notes. Keep the output self-contained for review only.",
  ].join("\n");
}

function normalizeGeneratedPrototypeResponse(value) {
  const response = plainObject(value);
  if (!plainObject(response.manifest)) {
    throw new Error("Invalid design prototype response JSON: manifest is required.");
  }
  if (!Array.isArray(response.files)) {
    throw new Error("Invalid design prototype response JSON: files must be an array.");
  }
  return {
    manifest: response.manifest,
    files: response.files.map((file) => {
      const item = plainObject(file);
      if (typeof item.path !== "string" || typeof item.content !== "string") {
        throw new Error("Invalid design prototype response JSON: every file requires path and content strings.");
      }
      return { path: item.path, content: item.content };
    }),
  };
}

export async function runDesignPrototype({
  runDir,
  apiKey,
  env = process.env,
  targetStack = "html",
  selectedCandidate = null,
  generate,
  telemetry,
  allowFakeResponse = false,
} = {}) {
  if (!runDir) throw new Error("runDir is required.");
  validatePrototypeTargetStack(targetStack);

  const resolvedRunDir = resolve(runDir);
  const brief = normalizeDesignBrief(JSON.parse(await readFile(join(resolvedRunDir, "brief.json"), "utf8")));
  const models = resolveDesignModels({ env });
  const selected = normalizedSelectedCandidate(selectedCandidate);
  const prompt = buildPrototypePrompt({ brief, targetStack, selectedCandidate: selected });
  const baseTelemetryMetadata = plainObject(telemetry?.metadata);
  const generated = generate
    ? normalizeGeneratedPrototypeResponse(await generate({
      apiKey,
      prompt,
      brief,
      targetStack,
      selectedCandidate: selected,
      model: models.design_model,
      env,
      responseSchema: GeminiDesignPrototypeResponseSchema,
      telemetry,
    }))
    : await generateDesignJson({
      apiKey,
      model: models.design_model,
      prompt,
      responseSchema: GeminiDesignPrototypeResponseSchema,
      normalize: normalizeGeneratedPrototypeResponse,
      env,
      allowFakeResponse,
      telemetry: telemetry ? {
        ...telemetry,
        command: "design-prototype",
        metadata: {
          ...baseTelemetryMetadata,
          design_stage: "prototype",
          actual_model: models.design_model,
        },
      } : telemetry,
    });

  const manifest = normalizeDesignPrototypeManifest({
    ...generated.manifest,
    run_id: brief.run_id,
    selected_candidate: selected,
    target_stack: targetStack,
    model: models.design_model,
  });

  const files = {};
  for (const file of generated.files) {
    files[assertPrototypeRelativePath(file.path)] = file.content;
  }
  for (const filePath of manifest.files) assertPrototypeRelativePath(filePath);
  assertPrototypeRelativePath(manifest.preview_entry);
  assertPrototypeRelativePath("manifest.json");

  const prototypeDir = await writePrototypeFiles({
    runDir: resolvedRunDir,
    files: {
      ...files,
      "manifest.json": `${JSON.stringify(manifest, null, 2)}\n`,
    },
  });

  return {
    manifest,
    prototypeDir,
    manifestPath: join(prototypeDir, "manifest.json"),
    previewEntryPath: join(prototypeDir, manifest.preview_entry),
  };
}
