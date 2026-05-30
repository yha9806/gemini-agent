import { GoogleGenAI } from "@google/genai";
import {
  GeminiArtifactReviewSchema,
  GeminiContextPackSchema,
  GeminiReviewSchema,
  normalizeArtifactReview,
  normalizeContextPack,
  normalizeReview,
  parseJsonObject,
} from "./schemas.mjs";
import { captureGeminiTelemetry } from "./telemetry-capture.mjs";

export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash";

export function getDefaultModel() {
  return DEFAULT_GEMINI_MODEL;
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

async function captureTelemetry(telemetry, event) {
  if (!telemetry) return;
  const capture = telemetry.capture ?? captureGeminiTelemetry;
  const capturePromise = Promise.resolve()
    .then(() => capture({
      ...event,
      cwd: telemetry.cwd,
      source: telemetry.source || "cli",
      command: telemetry.command || event.command,
      model: DEFAULT_GEMINI_MODEL,
    }))
    .catch(() => null);
  if (telemetry.capture) await capturePromise;
}

function errorType(error) {
  return error instanceof Error && error.name ? error.name : "Error";
}

export async function generateJson({
  apiKey,
  prompt,
  contents = prompt,
  responseSchema,
  normalize,
  env = process.env,
  allowFakeResponse = false,
  makeAi = makeGoogleGenAI,
  temperature = 0.2,
  telemetry,
}) {
  if (!apiKey) throw new Error("Gemini API key is missing.");
  if (!prompt || !prompt.trim()) throw new Error("Prompt is empty.");

  if (allowFakeResponse && env.GEMINI_AGENT_FAKE_RESPONSE) {
    return normalize(parseJsonObject(env.GEMINI_AGENT_FAKE_RESPONSE));
  }

  let response;
  const started = Date.now();
  try {
    const ai = makeAi(apiKey);
    response = await ai.models.generateContent({
      model: getDefaultModel(),
      contents,
      config: {
        temperature,
        responseMimeType: "application/json",
        responseSchema,
      },
    });
  } catch (error) {
    await captureTelemetry(telemetry, {
      command: "generate-json",
      prompt,
      response: "",
      status: "error",
      errorType: errorType(error),
      latencyMs: Date.now() - started,
      contents,
    });
    throw requestError(error, apiKey);
  }

  await captureTelemetry(telemetry, {
    command: "generate-json",
    prompt,
    response: response.text || "",
    status: "success",
    latencyMs: Date.now() - started,
    contents,
  });
  return normalize(parseJsonObject(response.text || ""));
}

export async function generateReview({
  apiKey,
  prompt,
  env,
  allowFakeResponse,
  makeAi,
  temperature,
  telemetry,
}) {
  return generateJson({
    apiKey,
    prompt,
    contents: prompt,
    env,
    allowFakeResponse,
    makeAi,
    temperature,
    telemetry,
    responseSchema: GeminiReviewSchema,
    normalize: normalizeReview,
  });
}

export async function generateContextPack(options) {
  return generateJson({
    ...options,
    responseSchema: GeminiContextPackSchema,
    normalize: normalizeContextPack,
  });
}

export async function generateArtifactReview(options) {
  return generateJson({
    ...options,
    responseSchema: GeminiArtifactReviewSchema,
    normalize: normalizeArtifactReview,
  });
}

export async function generateText({
  apiKey,
  prompt,
  makeAi = makeGoogleGenAI,
  temperature = 0.2,
  telemetry,
}) {
  if (!apiKey) throw new Error("Gemini API key is missing.");
  if (!prompt || !prompt.trim()) throw new Error("Prompt is empty.");
  let response;
  const started = Date.now();
  try {
    const ai = makeAi(apiKey);
    response = await ai.models.generateContent({
      model: getDefaultModel(),
      contents: prompt,
      config: { temperature },
    });
  } catch (error) {
    await captureTelemetry(telemetry, {
      command: "generate-text",
      prompt,
      response: "",
      status: "error",
      errorType: errorType(error),
      latencyMs: Date.now() - started,
      contents: prompt,
    });
    throw requestError(error, apiKey);
  }
  await captureTelemetry(telemetry, {
    command: "generate-text",
    prompt,
    response: response.text || "",
    status: "success",
    latencyMs: Date.now() - started,
    contents: prompt,
  });
  return `${response.text || ""}`.trim();
}
