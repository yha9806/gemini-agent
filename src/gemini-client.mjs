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

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function mergeTelemetryMetadata(telemetryMetadata, eventMetadata) {
  const telemetryObject = plainObject(telemetryMetadata);
  const eventObject = plainObject(eventMetadata);
  return {
    ...telemetryObject,
    ...eventObject,
    latency_stages_ms: {
      ...plainObject(telemetryObject.latency_stages_ms),
      ...plainObject(eventObject.latency_stages_ms),
    },
  };
}

function nonnegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function withGeminiGenerationLatency(metadata, latencyMs) {
  const base = plainObject(metadata);
  return {
    ...base,
    latency_stages_ms: {
      ...plainObject(base.latency_stages_ms),
      gemini_generation: nonnegativeSafeInteger(latencyMs),
    },
  };
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
      metadata: mergeTelemetryMetadata(telemetry.metadata, event.metadata),
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

function telemetryMetadataFromResult(extract, result) {
  if (typeof extract !== "function") return undefined;
  const metadata = extract(result);
  return metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : undefined;
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
  maxOutputTokens,
  telemetry,
  telemetryResultMetadata,
}) {
  if (!apiKey) throw new Error("Gemini API key is missing.");
  if (!prompt || !prompt.trim()) throw new Error("Prompt is empty.");

  if (allowFakeResponse && env.GEMINI_AGENT_FAKE_RESPONSE) {
    const responseText = env.GEMINI_AGENT_FAKE_RESPONSE;
    const started = Date.now();
    const normalized = normalize(parseJsonObject(responseText));
    const latencyMs = Date.now() - started;
    await captureTelemetry(telemetry, {
      command: "generate-json",
      prompt,
      response: responseText,
      status: "success",
      latencyMs,
      contents,
      metadata: withGeminiGenerationLatency(
        telemetryMetadataFromResult(telemetryResultMetadata, normalized),
        latencyMs,
      ),
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
        ...(Number.isInteger(maxOutputTokens) && maxOutputTokens > 0 ? { maxOutputTokens } : {}),
        responseMimeType: "application/json",
        responseSchema,
      },
    });
  } catch (error) {
    const latencyMs = Date.now() - started;
    await captureTelemetry(telemetry, {
      command: "generate-json",
      prompt,
      response: "",
      status: "error",
      errorType: errorType(error),
      latencyMs,
      contents,
      metadata: withGeminiGenerationLatency(undefined, latencyMs),
    }, { awaitCapture: true });
    throw requestError(error, apiKey);
  }

  const responseText = response.text || "";
  let normalized;
  try {
    normalized = normalize(parseJsonObject(responseText));
  } catch (error) {
    const latencyMs = Date.now() - started;
    await captureTelemetry(telemetry, {
      command: "generate-json",
      prompt,
      response: responseText,
      status: "error",
      errorType: errorType(error),
      latencyMs,
      contents,
      economics: usageMetadataFromResponse(response),
      metadata: withGeminiGenerationLatency(undefined, latencyMs),
    }, { awaitCapture: true });
    throw error;
  }

  const latencyMs = Date.now() - started;
  await captureTelemetry(telemetry, {
    command: "generate-json",
    prompt,
    response: responseText,
    status: "success",
    latencyMs,
    contents,
    economics: usageMetadataFromResponse(response),
    metadata: withGeminiGenerationLatency(
      telemetryMetadataFromResult(telemetryResultMetadata, normalized),
      latencyMs,
    ),
  });
  return normalized;
}

function designScoreValue(value) {
  return Number.isInteger(value) && value >= 0 && value <= 100 ? value : null;
}

function artifactReviewTelemetryMetadata(review) {
  const scorecard = review?.design_scorecard;
  if (!scorecard || typeof scorecard !== "object" || Array.isArray(scorecard)) return undefined;
  return {
    design_scorecard: {
      overall_score: designScoreValue(scorecard.overall_score),
      visual_hierarchy_score: designScoreValue(scorecard.visual_hierarchy_score),
      clarity_score: designScoreValue(scorecard.clarity_score),
      accessibility_score: designScoreValue(scorecard.accessibility_score),
      consistency_score: designScoreValue(scorecard.consistency_score),
      implementation_readiness_score: designScoreValue(scorecard.implementation_readiness_score),
    },
  };
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
    telemetryResultMetadata: artifactReviewTelemetryMetadata,
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
    const latencyMs = Date.now() - started;
    await captureTelemetry(telemetry, {
      command: "generate-text",
      prompt,
      response: "",
      status: "error",
      errorType: errorType(error),
      latencyMs,
      contents: prompt,
      metadata: withGeminiGenerationLatency(undefined, latencyMs),
    }, { awaitCapture: true });
    throw requestError(error, apiKey);
  }
  const latencyMs = Date.now() - started;
  await captureTelemetry(telemetry, {
    command: "generate-text",
    prompt,
    response: response.text || "",
    status: "success",
    latencyMs,
    contents: prompt,
    economics: usageMetadataFromResponse(response),
    metadata: withGeminiGenerationLatency(undefined, latencyMs),
  });
  return `${response.text || ""}`.trim();
}
