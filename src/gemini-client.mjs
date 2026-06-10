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

async function captureTelemetry(telemetry, event, { awaitCapture = false } = {}) {
  if (!telemetry) return;
  const capture = telemetry.capture ?? captureGeminiTelemetry;
  const telemetryContents = Object.prototype.hasOwnProperty.call(telemetry, "contents")
    ? telemetry.contents
    : event.contents;
  const capturePromise = Promise.resolve()
    .then(() => capture({
      ...event,
      contents: telemetryContents,
      cwd: telemetry.cwd,
      source: telemetry.source || "cli",
      command: telemetry.command || event.command,
      model: DEFAULT_GEMINI_MODEL,
      context: telemetry.context,
      outcome: telemetry.outcome,
      economics: {
        ...(telemetry.economics && typeof telemetry.economics === "object" ? telemetry.economics : {}),
        ...(event.economics && typeof event.economics === "object" ? event.economics : {}),
      },
      metadata: {
        ...(telemetry.metadata && typeof telemetry.metadata === "object" ? telemetry.metadata : {}),
        ...(event.metadata && typeof event.metadata === "object" ? event.metadata : {}),
      },
    }))
    .catch(() => null);
  if (telemetry.capture || telemetry.awaitCapture || awaitCapture) await capturePromise;
}

function errorType(error) {
  return error instanceof Error && error.name ? error.name : "Error";
}

function nonnegativeIntegerOrNull(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function usageMetadataFromResponse(response) {
  const usage = response?.usageMetadata ?? response?.usage_metadata;
  if (!usage || typeof usage !== "object") return undefined;
  const inputTokens = nonnegativeIntegerOrNull(
    usage.promptTokenCount ?? usage.prompt_token_count ?? usage.inputTokens ?? usage.input_tokens,
  );
  const outputTokens = nonnegativeIntegerOrNull(
    usage.candidatesTokenCount
      ?? usage.candidates_token_count
      ?? usage.outputTokens
      ?? usage.output_tokens,
  );
  const totalTokens = nonnegativeIntegerOrNull(
    usage.totalTokenCount ?? usage.total_token_count ?? usage.totalTokens ?? usage.total_tokens,
  );
  if (inputTokens === null && outputTokens === null && totalTokens === null) return undefined;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
  };
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
    const responseText = env.GEMINI_AGENT_FAKE_RESPONSE;
    const started = Date.now();
    const normalized = normalize(parseJsonObject(responseText));
    await captureTelemetry(telemetry, {
      command: "generate-json",
      prompt,
      response: responseText,
      status: "success",
      latencyMs: Date.now() - started,
      contents,
    });
    return normalized;
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
    }, { awaitCapture: true });
    throw requestError(error, apiKey);
  }

  const responseText = response.text || "";
  let normalized;
  try {
    normalized = normalize(parseJsonObject(responseText));
  } catch (error) {
    await captureTelemetry(telemetry, {
      command: "generate-json",
      prompt,
      response: responseText,
      status: "error",
      errorType: errorType(error),
      latencyMs: Date.now() - started,
      contents,
      economics: usageMetadataFromResponse(response),
    }, { awaitCapture: true });
    throw error;
  }

  await captureTelemetry(telemetry, {
    command: "generate-json",
    prompt,
    response: responseText,
    status: "success",
    latencyMs: Date.now() - started,
    contents,
    economics: usageMetadataFromResponse(response),
  });
  return normalized;
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
    }, { awaitCapture: true });
    throw requestError(error, apiKey);
  }
  await captureTelemetry(telemetry, {
    command: "generate-text",
    prompt,
    response: response.text || "",
    status: "success",
    latencyMs: Date.now() - started,
    contents: prompt,
    economics: usageMetadataFromResponse(response),
  });
  return `${response.text || ""}`.trim();
}
