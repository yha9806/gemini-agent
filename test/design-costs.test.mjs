import assert from "node:assert/strict";
import test from "node:test";
import {
  assertDesignBudget,
  estimateDesignCost,
  loadDesignPricing,
} from "../src/design-costs.mjs";

test("loads bundled conservative pricing with env override", () => {
  const pricing = loadDesignPricing({
    env: {
      GEMINI_AGENT_DESIGN_PRICING_JSON: JSON.stringify({
        models: {
          "custom-model": {
            input_per_million: 2,
            output_per_million: 8,
            image_per_unit: 0.05,
          },
        },
      }),
    },
  });

  assert.equal(pricing.models["custom-model"].image_per_unit, 0.05);
  assert.ok(pricing.models["gemini-3.5-flash"]);
});

test("invalid pricing override JSON falls back to bundled pricing", () => {
  const pricing = loadDesignPricing({
    env: { GEMINI_AGENT_DESIGN_PRICING_JSON: "{not-json" },
  });

  assert.deepEqual(Object.keys(pricing.models), ["gemini-3.5-flash"]);
});

test("estimates cost from token and image units", () => {
  const pricing = loadDesignPricing({
    env: {
      GEMINI_AGENT_DESIGN_PRICING_JSON: JSON.stringify({
        models: {
          "configured-image-model": {
            input_per_million: 2,
            output_per_million: 8,
            image_per_unit: 0.05,
          },
        },
      }),
    },
  });

  const estimate = estimateDesignCost({
    model: "configured-image-model",
    inputTokens: 1000,
    outputTokens: 500,
    imageUnits: 2,
    pricing,
  });

  assert.equal(estimate.usd, 0.106);
  assert.equal(estimate.unknown, false);
});

test("budget gate fails closed on unknown cost unless allowed", () => {
  assert.throws(
    () => assertDesignBudget({
      estimate: { usd: null, unknown: true },
      maxCostUsd: 1,
      allowUnknownCost: false,
    }),
    /unknown cost/,
  );

  assert.equal(assertDesignBudget({
    estimate: { usd: null, unknown: true },
    maxCostUsd: 1,
    allowUnknownCost: true,
  }), true);
});

test("budget gate rejects invalid max budget values", () => {
  assert.throws(
    () => assertDesignBudget({
      estimate: { usd: 0.25, unknown: false },
      maxCostUsd: "invalid",
      allowUnknownCost: false,
    }),
    /Invalid design budget/,
  );
});

test("budget gate blocks estimates above max", () => {
  assert.throws(
    () => assertDesignBudget({
      estimate: { usd: 2, unknown: false },
      maxCostUsd: 1,
      allowUnknownCost: false,
    }),
    /exceeds/,
  );
});
