import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { generateDesignImage } from "./gemini-client.mjs";
import { normalizeDesignBrief, normalizeDesignCandidateManifest } from "./design-schemas.mjs";
import { resolveDesignModels } from "./design-model-router.mjs";
import { writeDesignJson } from "./design-run-store.mjs";

const QUALITY_VALUES = new Set(["fast", "pro"]);

function candidateId(index) {
  return `candidate-${String.fromCharCode(97 + index)}`;
}

function promptHash(prompt) {
  return createHash("sha256").update(prompt).digest("hex").slice(0, 16);
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function validateVariants(variants) {
  if (!Number.isInteger(variants) || variants < 1 || variants > 4) {
    throw new Error("--variants must be between 1 and 4.");
  }
}

function validateQuality(quality) {
  if (!QUALITY_VALUES.has(quality)) {
    throw new Error("--quality must be fast or pro.");
  }
}

function imageBuffer(image) {
  if (Buffer.isBuffer(image?.buffer)) return image.buffer;
  if (image?.buffer instanceof Uint8Array) return Buffer.from(image.buffer);
  throw new Error("Generated image is missing a buffer.");
}

function stringList(values) {
  return Array.isArray(values) ? values : [];
}

export function buildDesignGeneratePrompt({ brief, index }) {
  const screens = stringList(brief?.screens);
  const visualDirection = stringList(brief?.visual_direction);
  const designTokens = stringList(brief?.design_system?.tokens);
  const accessibility = stringList(brief?.accessibility);
  const responsiveRequirements = stringList(brief?.responsive_requirements);
  const acceptanceCriteria = stringList(brief?.acceptance_criteria);
  const screenSummary = screens
    .map((screen) => `${screen.id}: ${screen.purpose}`)
    .join("; ") || "not specified";
  const tokenSummary = designTokens
    .map((token) => `${token.name}=${token.value}`)
    .join(", ") || "not specified";

  return [
    "Create a high-fidelity UI candidate image for this design brief.",
    `Variant index: ${index + 1}`,
    `Goal: ${brief?.goal || "not specified"}`,
    `Target user: ${brief?.target_user || "not specified"}`,
    `Screens: ${screenSummary}`,
    `Visual direction: ${visualDirection.join(", ") || "not specified"}`,
    `Design tokens: ${tokenSummary}`,
    `Accessibility: ${accessibility.join(", ") || "not specified"}`,
    `Responsive requirements: ${responsiveRequirements.join(", ") || "not specified"}`,
    `Acceptance criteria: ${acceptanceCriteria.join(", ") || "not specified"}`,
    "Return image output only.",
  ].join("\n");
}

export async function runDesignGenerate({
  runDir,
  variants = 1,
  quality = "fast",
  apiKey,
  env = process.env,
  generateImage,
  qualityGate,
  telemetry,
} = {}) {
  if (!runDir) throw new Error("runDir is required.");
  validateVariants(variants);
  validateQuality(quality);

  const resolvedRunDir = resolve(runDir);
  const brief = normalizeDesignBrief(JSON.parse(await readFile(join(resolvedRunDir, "brief.json"), "utf8")));
  const models = resolveDesignModels({ env });
  const model = quality === "pro" ? models.image_pro_model : models.image_model;
  if (!model) {
    throw new Error(quality === "pro"
      ? "GEMINI_IMAGE_PRO_MODEL is required for --quality pro."
      : "GEMINI_IMAGE_MODEL is required for design generate.");
  }

  const outputDir = join(resolvedRunDir, "candidates");
  await mkdir(outputDir, { recursive: true });
  const baseTelemetryMetadata = plainObject(telemetry?.metadata);
  const candidates = [];

  for (let index = 0; index < variants; index += 1) {
    const id = candidateId(index);
    const prompt = buildDesignGeneratePrompt({ brief, index });
    const image = generateImage
      ? await generateImage({ apiKey, prompt, index, model, quality, brief, env, telemetry })
      : await generateDesignImage({
        apiKey,
        model,
        prompt,
        contents: prompt,
        telemetry: telemetry ? {
          ...telemetry,
          command: "design-generate",
          metadata: {
            ...baseTelemetryMetadata,
            design_stage: "generate",
            variant_index: index,
            actual_model: model,
          },
        } : telemetry,
      });
    const mimeType = image?.mimeType || "image/png";
    const file = `${id}.png`;
    await writeFile(join(outputDir, file), imageBuffer(image));
    candidates.push({
      id,
      file,
      model,
      prompt_hash: promptHash(prompt),
      status: "success",
      image_size: null,
      aspect_ratio: null,
      warnings: mimeType === "image/png" ? [] : [`Generated MIME type was ${mimeType}`],
    });
  }

  const manifest = normalizeDesignCandidateManifest({
    kind: "design_candidates",
    run_id: brief.run_id,
    candidates,
  });
  const manifestPath = await writeDesignJson({
    runDir: resolvedRunDir,
    relativePath: join("candidates", "manifest.json"),
    value: manifest,
  });
  const gate = typeof qualityGate === "function"
    ? await qualityGate({
      runDir: resolvedRunDir,
      manifest,
      apiKey,
      env,
      telemetry,
    })
    : null;
  return {
    manifest,
    outputDir,
    manifestPath,
    ...(gate ? { quality: gate.quality, qualityPath: gate.qualityPath } : {}),
  };
}
