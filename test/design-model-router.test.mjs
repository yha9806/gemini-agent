import assert from "node:assert/strict";
import test from "node:test";
import {
  designDoctor,
  resolveDesignModels,
  validateDesignFallback,
} from "../src/design-model-router.mjs";

test("resolves default design and image model routes", () => {
  const models = resolveDesignModels({ env: {} });

  assert.equal(models.default_model, "gemini-3.5-flash");
  assert.equal(models.design_model, "gemini-3.5-flash");
  assert.equal(models.image_model, null);
  assert.equal(models.image_pro_model, null);
});

test("uses configured model routes", () => {
  const models = resolveDesignModels({
    env: {
      GEMINI_DESIGN_MODEL: "custom-design",
      GEMINI_IMAGE_MODEL: "custom-image",
      GEMINI_IMAGE_PRO_MODEL: "custom-pro-image",
    },
  });

  assert.equal(models.design_model, "custom-design");
  assert.equal(models.image_model, "custom-image");
  assert.equal(models.image_pro_model, "custom-pro-image");
});

test("validates fallback capability contract", () => {
  assert.equal(validateDesignFallback({ multimodal: true, structuredOutput: true }), true);
  assert.throws(
    () => validateDesignFallback({ multimodal: false, structuredOutput: true }),
    /multimodal/,
  );
  assert.throws(
    () => validateDesignFallback({ multimodal: true, structuredOutput: false }),
    /structured/,
  );
});

test("doctor reports safe model state without secrets", async () => {
  const report = await designDoctor({
    env: {
      GEMINI_API_KEY: "AIza-secret-token",
      GEMINI_DESIGN_MODEL: "custom-design",
      VISION_BANANA_ENDPOINT: "https://example.invalid/vision",
    },
    probe: async (model) => ({ ok: model === "custom-design", status: "ok" }),
  });

  assert.equal(report.models.design_model, "custom-design");
  assert.equal(report.probes.design_model.ok, true);
  assert.equal(report.required_env.gemini_auth, "keychain or GEMINI_API_KEY");
  assert.doesNotMatch(JSON.stringify(report), /AIza|secret|token/i);
});

test("doctor reports Nano Banana as the Vision Banana compatible fallback", async () => {
  const report = await designDoctor({
    env: {},
    probe: async () => ({ ok: null, status: "not_probed" }),
  });

  assert.equal(report.required_env.vision_banana_endpoint, "missing");
  assert.equal(report.required_env.vision_banana_provider, "nano-banana-palette-mask");
  assert.equal(report.required_env.vision_banana_compatible_fallback, "available");
  assert.equal(report.required_env.visual_quality_gate, "available");
  assert.equal(report.required_env.nano_banana_model, "gemini-3.1-flash-image");
});
