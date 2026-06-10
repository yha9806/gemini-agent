import { createPartFromText } from "@google/genai";
import { writeJsonArtifact } from "./artifact-store.mjs";
import { generateArtifactReview, getDefaultModel } from "./gemini-client.mjs";
import { detectArtifactMime, imagePartWithMetadataFromFile, resolveCwdFilePath } from "./input-collector.mjs";
import { inferMediaKind, syntheticMediaBasename } from "./media-metadata.mjs";
import { loadProjectPolicy } from "./policies.mjs";
import { buildArtifactReviewPrompt } from "./prompts.mjs";
import { normalizeArtifactReview } from "./schemas.mjs";

const MAX_ARTIFACT_REVIEW_FILES = 4;
const ARTIFACT_REVIEW_MODES = new Set(["single", "comparison"]);
const SAFE_MEDIA_KINDS = new Set(["screenshot", "design", "document", "image", "unknown"]);

function artifactTypeFor({ artifactKind = "image", mimeType }) {
  if (mimeType === "application/pdf") return "pdf";

  const kind = String(artifactKind ?? "").trim().toLowerCase();
  if (kind === "ui" || kind === "design") return "design";
  if (kind === "architecture" || kind === "diagram") return "diagram";
  if (kind === "research") return "research";
  return "image";
}

function normalizeArtifactFiles({ file, files }) {
  const values = Array.isArray(files) ? files : file ? [file] : [];
  const normalized = values.map((value) => String(value ?? "").trim()).filter(Boolean);
  if (normalized.length === 0) throw new Error("--file requires a path.");
  if (normalized.length > MAX_ARTIFACT_REVIEW_FILES) {
    throw new Error(`artifact-review supports at most ${MAX_ARTIFACT_REVIEW_FILES} files.`);
  }
  return normalized;
}

function normalizeReviewMode(mode, sourceCount) {
  const value = String(mode ?? "").trim().toLowerCase();
  if (!value) return sourceCount > 1 ? "comparison" : "single";
  if (!ARTIFACT_REVIEW_MODES.has(value)) throw new Error("--review-mode must be single or comparison.");
  return value;
}

function artifactTelemetryMediaKind(artifactKind) {
  const kind = String(artifactKind ?? "").trim().toLowerCase();
  if (kind === "ui" || kind === "design" || kind === "architecture" || kind === "diagram") {
    return "design";
  }
  return null;
}

function withArtifactMediaKinds(mediaRefs, { artifactKind } = {}) {
  const mediaKind = artifactTelemetryMediaKind(artifactKind);
  return mediaRefs.map((mediaRef) => (
    mediaKind ? { ...mediaRef, media_kind: mediaKind } : mediaRef
  ));
}

function safeMediaKindForManifest(mediaRef) {
  const explicit = typeof mediaRef.media_kind === "string" ? mediaRef.media_kind.trim().toLowerCase() : "";
  if (SAFE_MEDIA_KINDS.has(explicit)) return explicit;
  return inferMediaKind({
    mimeType: mediaRef.mime_type,
    reference: mediaRef.source,
  });
}

function artifactMediaManifest(mediaRefs, { cwd } = {}) {
  return mediaRefs.map((mediaRef) => {
    const item = {
      basename: syntheticMediaBasename(mediaRef.source, { salt: cwd }),
    };
    if (typeof mediaRef.mime_type === "string" && mediaRef.mime_type.trim()) {
      item.mime_type = mediaRef.mime_type;
    }
    if (Number.isInteger(mediaRef.byte_size) && mediaRef.byte_size >= 0) {
      item.byte_size = mediaRef.byte_size;
    }
    const mediaKind = safeMediaKindForManifest(mediaRef);
    if (SAFE_MEDIA_KINDS.has(mediaKind)) item.media_kind = mediaKind;
    return item;
  });
}

export async function runArtifactReview({
  apiKey,
  cwd = process.cwd(),
  file,
  files = null,
  artifactKind = "image",
  reviewMode = null,
  env = process.env,
  allowFakeResponse = false,
  now = new Date(),
  writeArtifact = false,
  generate = generateArtifactReview,
  telemetry = { cwd, source: "cli", command: "artifact-review" },
} = {}) {
  const sources = normalizeArtifactFiles({ file, files });
  const mode = normalizeReviewMode(reviewMode, sources.length);

  const resolvedFiles = sources.map((source) => resolveCwdFilePath(source, { cwd }));
  const mimeTypes = sources.map((source) => detectArtifactMime(source));
  const mimeType = mimeTypes[0];
  const artifactType = artifactTypeFor({ artifactKind, mimeType });

  if (mimeTypes.some((type) => type === "application/pdf")) {
    throw new Error("PDF artifact review requires Files API support.");
  }

  const imageParts = [];
  const telemetryMediaRefs = [];
  for (let index = 0; index < resolvedFiles.length; index += 1) {
    const { part, metadata } = await imagePartWithMetadataFromFile(resolvedFiles[index]);
    imageParts.push(part);
    telemetryMediaRefs.push({
      source: sources[index],
      ...metadata,
    });
  }
  const policy = await loadProjectPolicy(cwd);
  const prompt = buildArtifactReviewPrompt({
    artifactKind,
    reviewMode: mode,
    sources,
    policy,
  });
  const contents = [...imageParts, createPartFromText(prompt)];
  const telemetryContents = withArtifactMediaKinds(telemetryMediaRefs, { artifactKind });

  const generated = await generate({
    apiKey,
    prompt,
    contents,
    env,
    allowFakeResponse,
    telemetry: telemetry ? { ...telemetry, contents: telemetryContents } : telemetry,
  });

  const review = normalizeArtifactReview({
    ...generated,
    artifact_type: artifactType,
    metadata: {
      ...generated.metadata,
      model: getDefaultModel(),
      generated_at: now.toISOString(),
      sources,
      omitted_sources: [],
      media_manifest: artifactMediaManifest(telemetryContents, { cwd }),
      review_mode: mode,
    },
  });

  if (writeArtifact) {
    await writeJsonArtifact({ cwd, category: "artifacts", artifact: review, now });
  }

  return review;
}
