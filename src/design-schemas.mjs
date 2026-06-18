import { Type } from "@google/genai";
import { z } from "zod";

const Kind = (value) => z.literal(value);
const NonEmptyString = z.string().trim().min(1);
const StringList = z.array(NonEmptyString).default([]);
const RunId = z.string().regex(/^[0-9TzZ._-]+-[A-Za-z0-9]{6,}$/);
const NullableUnitNumber = z.number().min(0).max(1).nullable();
const Metadata = z.object({
  model: z.string().optional(),
  generated_at: z.string().optional(),
}).passthrough().default({});

const GeminiStringArraySchema = { type: Type.ARRAY, items: { type: Type.STRING } };
const GeminiTokenSchema = {
  type: Type.OBJECT,
  properties: {
    name: { type: Type.STRING },
    value: { type: Type.STRING },
  },
  required: ["name", "value"],
};
const GeminiMetadataSchema = {
  type: Type.OBJECT,
  properties: {
    model: { type: Type.STRING },
    generated_at: { type: Type.STRING },
  },
  required: ["model", "generated_at"],
};
const GeminiDesignSystemSchema = {
  type: Type.OBJECT,
  properties: {
    tokens: { type: Type.ARRAY, items: GeminiTokenSchema },
  },
  required: ["tokens"],
};

export const GeminiDesignBriefSchema = {
  type: Type.OBJECT,
  properties: {
    kind: { type: Type.STRING, enum: ["design_brief"] },
    run_id: { type: Type.STRING },
    goal: { type: Type.STRING },
    target_user: { type: Type.STRING },
    screens: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          purpose: { type: Type.STRING },
        },
        required: ["id", "purpose"],
      },
    },
    visual_direction: GeminiStringArraySchema,
    design_system: GeminiDesignSystemSchema,
    accessibility: GeminiStringArraySchema,
    responsive_requirements: GeminiStringArraySchema,
    acceptance_criteria: GeminiStringArraySchema,
    implementation_risks: GeminiStringArraySchema,
    metadata: GeminiMetadataSchema,
  },
  required: [
    "kind",
    "run_id",
    "goal",
    "target_user",
    "screens",
    "visual_direction",
    "design_system",
    "accessibility",
    "responsive_requirements",
    "acceptance_criteria",
    "implementation_risks",
    "metadata",
  ],
};

export const GeminiDesignPrototypeManifestSchema = {
  type: Type.OBJECT,
  properties: {
    kind: { type: Type.STRING, enum: ["design_prototype"] },
    run_id: { type: Type.STRING },
    selected_candidate: { type: Type.STRING, nullable: true },
    target_stack: { type: Type.STRING, enum: ["html", "react", "tailwind", "auto"] },
    model: { type: Type.STRING },
    files: GeminiStringArraySchema,
    preview_entry: { type: Type.STRING },
    review_notes: GeminiStringArraySchema,
    limitations: GeminiStringArraySchema,
    integration_recommendation: { type: Type.STRING },
  },
  required: [
    "kind",
    "run_id",
    "selected_candidate",
    "target_stack",
    "model",
    "files",
    "preview_entry",
    "review_notes",
    "limitations",
    "integration_recommendation",
  ],
};

export const GeminiDesignPrototypeResponseSchema = {
  type: Type.OBJECT,
  properties: {
    manifest: GeminiDesignPrototypeManifestSchema,
    files: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          path: { type: Type.STRING },
          content: { type: Type.STRING },
        },
        required: ["path", "content"],
      },
    },
  },
  required: ["manifest", "files"],
};

export const GeminiDesignHandoffSchema = {
  type: Type.OBJECT,
  properties: {
    kind: { type: Type.STRING, enum: ["design_handoff"] },
    run_id: { type: Type.STRING },
    selected_candidate: { type: Type.STRING, nullable: true },
    implementation_summary: { type: Type.STRING },
    file_hints: GeminiStringArraySchema,
    component_tasks: GeminiStringArraySchema,
    style_tokens: { type: Type.ARRAY, items: GeminiTokenSchema },
    responsive_tasks: GeminiStringArraySchema,
    asset_tasks: GeminiStringArraySchema,
    verification: GeminiStringArraySchema,
    open_questions: GeminiStringArraySchema,
    risk_notes: GeminiStringArraySchema,
  },
  required: [
    "kind",
    "run_id",
    "selected_candidate",
    "implementation_summary",
    "file_hints",
    "component_tasks",
    "style_tokens",
    "responsive_tasks",
    "asset_tasks",
    "verification",
    "open_questions",
    "risk_notes",
  ],
};

const BBox = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().min(0).max(1),
  height: z.number().min(0).max(1),
});

const Region = z.object({
  id: NonEmptyString,
  label: NonEmptyString,
  role: NonEmptyString,
  importance: z.number().min(0).max(1),
  bbox: BBox.nullable(),
  mask_ref: z.string().nullable().default(null),
  confidence: NullableUnitNumber.default(null),
});

export const DesignBriefZodSchema = z.object({
  kind: Kind("design_brief"),
  run_id: RunId,
  goal: NonEmptyString,
  target_user: NonEmptyString,
  screens: z.array(z.object({
    id: NonEmptyString,
    purpose: NonEmptyString,
  })).default([]),
  visual_direction: StringList,
  design_system: z.object({
    tokens: z.array(z.object({
      name: NonEmptyString,
      value: NonEmptyString,
    })).default([]),
  }).passthrough().default({ tokens: [] }),
  accessibility: StringList,
  responsive_requirements: StringList,
  acceptance_criteria: StringList,
  implementation_risks: StringList,
  metadata: Metadata,
});

export const DesignCandidateManifestZodSchema = z.object({
  kind: Kind("design_candidates"),
  run_id: RunId,
  candidates: z.array(z.object({
    id: NonEmptyString,
    file: NonEmptyString,
    model: NonEmptyString,
    prompt_hash: NonEmptyString,
    status: z.enum(["success", "failed"]),
    image_size: z.string().nullable().default(null),
    aspect_ratio: z.string().nullable().default(null),
    warnings: StringList,
  })).default([]),
});

export const DesignPerceptionZodSchema = z.object({
  kind: Kind("design_perception"),
  run_id: RunId,
  provider: z.enum(["palette-mask", "gemini-vision", "vision-banana"]),
  source: NonEmptyString,
  regions: z.array(Region).default([]),
  hierarchy: StringList,
  layout_observations: StringList,
  implementation_constraints: StringList,
  confidence: NullableUnitNumber.default(null),
  warnings: StringList,
});

export const DesignPrototypeManifestZodSchema = z.object({
  kind: Kind("design_prototype"),
  run_id: RunId,
  selected_candidate: z.string().nullable().default(null),
  target_stack: z.enum(["html", "react", "tailwind", "auto"]),
  model: NonEmptyString,
  files: z.array(NonEmptyString).default([]),
  preview_entry: NonEmptyString,
  review_notes: StringList,
  limitations: StringList,
  integration_recommendation: NonEmptyString,
});

export const DesignHandoffZodSchema = z.object({
  kind: Kind("design_handoff"),
  run_id: RunId,
  selected_candidate: z.string().nullable().default(null),
  implementation_summary: NonEmptyString,
  file_hints: StringList,
  component_tasks: StringList,
  style_tokens: z.array(z.object({
    name: NonEmptyString,
    value: NonEmptyString,
  })).default([]),
  responsive_tasks: StringList,
  asset_tasks: StringList,
  verification: StringList,
  open_questions: StringList,
  risk_notes: StringList,
});

export const DesignLoopReviewZodSchema = z.object({
  kind: Kind("design_loop_review"),
  run_id: RunId,
  iteration: z.number().int().min(1).max(3),
  target_screenshot: z.string().nullable().default(null),
  actual_screenshot: z.string().nullable().default(null),
  status: z.enum(["needs_screenshot", "reviewed"]),
  summary: StringList,
  next_actions: StringList,
  artifact_review: z.record(z.string(), z.unknown()).nullable().default(null),
  visual_gate: z.record(z.string(), z.unknown()).nullable().default(null),
});

function normalizeWith(schema, value, label) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`Invalid ${label} JSON: ${parsed.error.message}`);
  return parsed.data;
}

export function normalizeDesignBrief(value) {
  return normalizeWith(DesignBriefZodSchema, value, "design brief");
}

export function normalizeDesignCandidateManifest(value) {
  return normalizeWith(DesignCandidateManifestZodSchema, value, "design candidate manifest");
}

export function normalizeDesignPerception(value) {
  return normalizeWith(DesignPerceptionZodSchema, value, "design perception");
}

export function normalizeDesignPrototypeManifest(value) {
  return normalizeWith(DesignPrototypeManifestZodSchema, value, "design prototype manifest");
}

export function normalizeDesignHandoff(value) {
  return normalizeWith(DesignHandoffZodSchema, value, "design handoff");
}

export function normalizeDesignLoopReview(value) {
  return normalizeWith(DesignLoopReviewZodSchema, value, "design loop review");
}

export function designJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}
