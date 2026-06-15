import { DEFAULT_GEMINI_MODEL } from "./gemini-client.mjs";

export const DEFAULT_DESIGN_MODEL = DEFAULT_GEMINI_MODEL;
export const DEFAULT_NANO_BANANA_MODEL = "gemini-3.1-flash-image";

const SECRET_VALUE_PATTERN = /(AIza[0-9A-Za-z_-]+|secret|token|bearer\s+[0-9A-Za-z._-]+)/gi;

function envString(env, key) {
  const value = env?.[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function redactSecretText(value) {
  if (typeof value !== "string") return value;
  return value.replace(SECRET_VALUE_PATTERN, "[REDACTED]");
}

function doctorModelValue(value) {
  if (value === null) return null;
  return redactSecretText(value);
}

function safeProbeResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return { ok: null, status: "unknown" };
  }
  const ok = typeof result.ok === "boolean" || result.ok === null ? result.ok : null;
  const status = typeof result.status === "string"
    ? redactSecretText(result.status)
    : "unknown";
  return { ok, status };
}

export function resolveDesignModels({ env = process.env } = {}) {
  return {
    default_model: DEFAULT_GEMINI_MODEL,
    design_model: envString(env, "GEMINI_DESIGN_MODEL") || DEFAULT_DESIGN_MODEL,
    image_model: envString(env, "GEMINI_IMAGE_MODEL"),
    image_pro_model: envString(env, "GEMINI_IMAGE_PRO_MODEL"),
  };
}

export function validateDesignFallback(capabilities) {
  if (!capabilities?.multimodal) {
    throw new Error("Fallback design model must support multimodal input.");
  }
  if (!capabilities?.structuredOutput) {
    throw new Error("Fallback design model must support structured output.");
  }
  return true;
}

export async function designDoctor({
  env = process.env,
  probe = async () => ({ ok: null, status: "not_probed" }),
} = {}) {
  const models = resolveDesignModels({ env });
  const probes = {};

  for (const [key, model] of Object.entries({
    design_model: models.design_model,
    image_model: models.image_model,
    image_pro_model: models.image_pro_model,
  })) {
    if (!model) {
      probes[key] = { ok: null, status: "not_configured" };
      continue;
    }
    try {
      probes[key] = safeProbeResult(await probe(model, key));
    } catch {
      probes[key] = { ok: false, status: "probe_failed" };
    }
  }

  return {
    ok: Object.values(probes).every((item) => item.ok !== false),
    models: {
      default_model: doctorModelValue(models.default_model),
      design_model: doctorModelValue(models.design_model),
      image_model: doctorModelValue(models.image_model),
      image_pro_model: doctorModelValue(models.image_pro_model),
    },
    probes,
    required_env: {
      gemini_auth: "keychain or GEMINI_API_KEY",
      image_model: models.image_model ? "present" : "missing",
      image_pro_model: models.image_pro_model ? "present" : "missing",
      vision_banana_endpoint: envString(env, "VISION_BANANA_ENDPOINT") ? "present" : "missing",
      vision_banana_provider: envString(env, "VISION_BANANA_ENDPOINT") ? "configured" : "nano-banana-palette-mask",
      vision_banana_compatible_fallback: "available",
      visual_quality_gate: "available",
      nano_banana_model: envString(env, "GEMINI_IMAGE_MODEL") || DEFAULT_NANO_BANANA_MODEL,
    },
  };
}
