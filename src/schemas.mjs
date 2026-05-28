import { Type } from "@google/genai";
import { z } from "zod";

export const REVIEW_VERDICTS = ["pass", "caution", "block"];

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
