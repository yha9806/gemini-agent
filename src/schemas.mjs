import { Type } from "@google/genai";
import { z } from "zod";

export const REVIEW_VERDICTS = ["pass", "caution", "block"];
export const ARTIFACT_TYPES = ["image", "pdf", "design", "diagram", "research"];

export const ReviewZodSchema = z.object({
  verdict: z.enum(REVIEW_VERDICTS),
  top_risks: z.array(z.string()).default([]),
  missing_tests: z.array(z.string()).default([]),
  unsafe_claims: z.array(z.string()).default([]),
  suggested_changes: z.array(z.string()).default([]),
  notes: z.array(z.string()).default([]),
});

export const GeminiReviewSchema = {
  type: Type.OBJECT,
  properties: {
    verdict: { type: Type.STRING, enum: REVIEW_VERDICTS },
    top_risks: { type: Type.ARRAY, items: { type: Type.STRING } },
    missing_tests: { type: Type.ARRAY, items: { type: Type.STRING } },
    unsafe_claims: { type: Type.ARRAY, items: { type: Type.STRING } },
    suggested_changes: { type: Type.ARRAY, items: { type: Type.STRING } },
    notes: { type: Type.ARRAY, items: { type: Type.STRING } },
  },
  required: ["verdict", "top_risks", "missing_tests", "unsafe_claims", "suggested_changes", "notes"],
};

const MetadataZodSchema = z.object({
  model: z.string(),
  generated_at: z.string(),
  sources: z.array(z.string()).default([]),
  omitted_sources: z.array(z.string()).default([]),
}).passthrough();

export const ContextPackZodSchema = z.object({
  kind: z.literal("context_pack"),
  source_summary: z.array(z.string()).default([]),
  project_facts: z.array(z.string()).default([]),
  relevant_files: z.array(z.object({
    path: z.string(),
    why_relevant: z.string(),
  })).default([]),
  open_questions: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  recommended_codex_actions: z.array(z.string()).default([]),
  limitations: z.array(z.string()).default([]),
  metadata: MetadataZodSchema,
});

export const ArtifactReviewZodSchema = z.object({
  kind: z.literal("artifact_review"),
  artifact_type: z.enum(ARTIFACT_TYPES),
  summary: z.array(z.string()).default([]),
  important_details: z.array(z.string()).default([]),
  design_or_research_findings: z.array(z.string()).default([]),
  implementation_hints_for_codex: z.array(z.string()).default([]),
  risks_or_ambiguities: z.array(z.string()).default([]),
  questions_for_user: z.array(z.string()).default([]),
  limitations: z.array(z.string()).default([]),
  metadata: MetadataZodSchema,
});

const GeminiMetadataSchema = {
  type: Type.OBJECT,
  properties: {
    model: { type: Type.STRING },
    generated_at: { type: Type.STRING },
    sources: { type: Type.ARRAY, items: { type: Type.STRING } },
    omitted_sources: { type: Type.ARRAY, items: { type: Type.STRING } },
  },
  required: ["model", "generated_at", "sources", "omitted_sources"],
};

export const GeminiContextPackSchema = {
  type: Type.OBJECT,
  properties: {
    kind: { type: Type.STRING, enum: ["context_pack"] },
    source_summary: { type: Type.ARRAY, items: { type: Type.STRING } },
    project_facts: { type: Type.ARRAY, items: { type: Type.STRING } },
    relevant_files: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          path: { type: Type.STRING },
          why_relevant: { type: Type.STRING },
        },
        required: ["path", "why_relevant"],
      },
    },
    open_questions: { type: Type.ARRAY, items: { type: Type.STRING } },
    risks: { type: Type.ARRAY, items: { type: Type.STRING } },
    recommended_codex_actions: { type: Type.ARRAY, items: { type: Type.STRING } },
    limitations: { type: Type.ARRAY, items: { type: Type.STRING } },
    metadata: GeminiMetadataSchema,
  },
  required: [
    "kind",
    "source_summary",
    "project_facts",
    "relevant_files",
    "open_questions",
    "risks",
    "recommended_codex_actions",
    "limitations",
    "metadata",
  ],
};

export const GeminiArtifactReviewSchema = {
  type: Type.OBJECT,
  properties: {
    kind: { type: Type.STRING, enum: ["artifact_review"] },
    artifact_type: { type: Type.STRING, enum: ARTIFACT_TYPES },
    summary: { type: Type.ARRAY, items: { type: Type.STRING } },
    important_details: { type: Type.ARRAY, items: { type: Type.STRING } },
    design_or_research_findings: { type: Type.ARRAY, items: { type: Type.STRING } },
    implementation_hints_for_codex: { type: Type.ARRAY, items: { type: Type.STRING } },
    risks_or_ambiguities: { type: Type.ARRAY, items: { type: Type.STRING } },
    questions_for_user: { type: Type.ARRAY, items: { type: Type.STRING } },
    limitations: { type: Type.ARRAY, items: { type: Type.STRING } },
    metadata: GeminiMetadataSchema,
  },
  required: [
    "kind",
    "artifact_type",
    "summary",
    "important_details",
    "design_or_research_findings",
    "implementation_hints_for_codex",
    "risks_or_ambiguities",
    "questions_for_user",
    "limitations",
    "metadata",
  ],
};

export function parseJsonObject(text) {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) throw new Error("Gemini response did not contain a JSON object.");
    return JSON.parse(text.slice(start, end + 1));
  }
}

export function normalizeReview(value) {
  const parsed = ReviewZodSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Invalid review JSON: ${parsed.error.message}`);
  }
  return parsed.data;
}

export function reviewToPrettyJson(review) {
  return `${JSON.stringify(normalizeReview(review), null, 2)}\n`;
}

export function normalizeContextPack(value) {
  const parsed = ContextPackZodSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Invalid context pack JSON: ${parsed.error.message}`);
  }
  return parsed.data;
}

export function contextPackToPrettyJson(pack) {
  return `${JSON.stringify(normalizeContextPack(pack), null, 2)}\n`;
}

export function normalizeArtifactReview(value) {
  const parsed = ArtifactReviewZodSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Invalid artifact review JSON: ${parsed.error.message}`);
  }
  return parsed.data;
}

export function artifactReviewToPrettyJson(review) {
  return `${JSON.stringify(normalizeArtifactReview(review), null, 2)}\n`;
}
