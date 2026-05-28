import { GoogleGenAI } from "@google/genai";
import { GeminiReviewSchema, normalizeReview, parseJsonObject } from "./schemas.mjs";

export function getDefaultModel(env = process.env) {
  return env.GEMINI_AGENT_MODEL || "gemini-2.5-pro";
}

export function makeGoogleGenAI(apiKey) {
  return new GoogleGenAI({ apiKey });
}

function redactApiKey(message, apiKey) {
  if (!apiKey) return message;
  return `${message}`.split(apiKey).join("[REDACTED]");
}

function requestError(error, apiKey) {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`Gemini API request failed: ${redactApiKey(message, apiKey)}`);
}

export async function generateReview({
  apiKey,
  prompt,
  env = process.env,
  allowFakeResponse = false,
  model = getDefaultModel(env),
  makeAi = makeGoogleGenAI,
  temperature = 0.2,
}) {
  if (!apiKey) throw new Error("Gemini API key is missing.");
  if (!prompt || !prompt.trim()) throw new Error("Prompt is empty.");

  if (allowFakeResponse && env.GEMINI_AGENT_FAKE_RESPONSE) {
    return normalizeReview(parseJsonObject(env.GEMINI_AGENT_FAKE_RESPONSE));
  }

  let response;
  try {
    const ai = makeAi(apiKey);
    response = await ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        temperature,
        responseMimeType: "application/json",
        responseSchema: GeminiReviewSchema,
      },
    });
  } catch (error) {
    throw requestError(error, apiKey);
  }

  return normalizeReview(parseJsonObject(response.text || ""));
}

export async function generateText({ apiKey, prompt, model = getDefaultModel(), makeAi = makeGoogleGenAI, temperature = 0.2 }) {
  if (!apiKey) throw new Error("Gemini API key is missing.");
  if (!prompt || !prompt.trim()) throw new Error("Prompt is empty.");
  let response;
  try {
    const ai = makeAi(apiKey);
    response = await ai.models.generateContent({
      model,
      contents: prompt,
      config: { temperature },
    });
  } catch (error) {
    throw requestError(error, apiKey);
  }
  return `${response.text || ""}`.trim();
}
