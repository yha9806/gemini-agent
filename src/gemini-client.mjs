import { GoogleGenAI } from "@google/genai";
import { GeminiReviewSchema, normalizeReview, parseJsonObject } from "./schemas.mjs";

export function getDefaultModel(env = process.env) {
  return env.GEMINI_AGENT_MODEL || "gemini-2.5-pro";
}

export function makeGoogleGenAI(apiKey) {
  return new GoogleGenAI({ apiKey });
}

export async function generateReview({
  apiKey,
  prompt,
  model = getDefaultModel(),
  makeAi = makeGoogleGenAI,
  temperature = 0.2,
}) {
  if (!apiKey) throw new Error("Gemini API key is missing.");
  if (!prompt || !prompt.trim()) throw new Error("Prompt is empty.");

  if (process.env.GEMINI_AGENT_FAKE_RESPONSE) {
    return normalizeReview(parseJsonObject(process.env.GEMINI_AGENT_FAKE_RESPONSE));
  }

  const ai = makeAi(apiKey);
  const response = await ai.models.generateContent({
    model,
    contents: prompt,
    config: {
      temperature,
      responseMimeType: "application/json",
      responseSchema: GeminiReviewSchema,
    },
  });

  return normalizeReview(parseJsonObject(response.text || ""));
}

export async function generateText({ apiKey, prompt, model = getDefaultModel(), makeAi = makeGoogleGenAI, temperature = 0.2 }) {
  if (!apiKey) throw new Error("Gemini API key is missing.");
  if (!prompt || !prompt.trim()) throw new Error("Prompt is empty.");
  const ai = makeAi(apiKey);
  const response = await ai.models.generateContent({
    model,
    contents: prompt,
    config: { temperature },
  });
  return `${response.text || ""}`.trim();
}
