import { createPartFromText } from "@google/genai";
import { writeJsonArtifact } from "./artifact-store.mjs";
import { generateArtifactReview, getDefaultModel } from "./gemini-client.mjs";
import { detectArtifactMime, imagePartFromFile, resolveCwdFilePath } from "./input-collector.mjs";
import { loadProjectPolicy } from "./policies.mjs";
import { buildArtifactReviewPrompt } from "./prompts.mjs";
import { normalizeArtifactReview } from "./schemas.mjs";

function artifactTypeFor({ artifactKind = "image", mimeType }) {
  if (mimeType === "application/pdf") return "pdf";

  const kind = String(artifactKind ?? "").trim().toLowerCase();
  if (kind === "ui" || kind === "design") return "design";
  if (kind === "architecture" || kind === "diagram") return "diagram";
  if (kind === "research") return "research";
  return "image";
}

export async function runArtifactReview({
  apiKey,
  cwd = process.cwd(),
  file,
  artifactKind = "image",
  env = process.env,
  allowFakeResponse = false,
  now = new Date(),
  writeArtifact = false,
  generate = generateArtifactReview,
  telemetry = { cwd, source: "cli", command: "artifact-review" },
} = {}) {
  if (!file) throw new Error("--file requires a path.");

  const resolvedFile = resolveCwdFilePath(file, { cwd });
  const mimeType = detectArtifactMime(file);
  const artifactType = artifactTypeFor({ artifactKind, mimeType });

  if (mimeType === "application/pdf") {
    throw new Error("PDF artifact review requires Files API support.");
  }

  const imagePart = await imagePartFromFile(resolvedFile);
  const policy = await loadProjectPolicy(cwd);
  const prompt = buildArtifactReviewPrompt({
    artifactKind,
    sources: [file],
    policy,
  });
  const contents = [imagePart, createPartFromText(prompt)];

  const generated = await generate({
    apiKey,
    prompt,
    contents,
    env,
    allowFakeResponse,
    telemetry,
  });

  const review = normalizeArtifactReview({
    ...generated,
    artifact_type: artifactType,
    metadata: {
      ...generated.metadata,
      model: getDefaultModel(),
      generated_at: now.toISOString(),
      sources: [file],
      omitted_sources: [],
    },
  });

  if (writeArtifact) {
    await writeJsonArtifact({ cwd, category: "artifacts", artifact: review, now });
  }

  return review;
}
