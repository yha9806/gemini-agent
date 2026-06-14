const BUNDLED_PRICING = {
  models: {
    "gemini-3.5-flash": {
      input_per_million: 1,
      output_per_million: 3,
      image_per_unit: 0,
    },
  },
};

function copyPricing(pricing) {
  return {
    models: Object.fromEntries(
      Object.entries(pricing.models).map(([model, row]) => [model, { ...row }]),
    ),
  };
}

function nonnegativeFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validPricingRow(row) {
  return row
    && typeof row === "object"
    && !Array.isArray(row)
    && nonnegativeFiniteNumber(row.input_per_million)
    && nonnegativeFiniteNumber(row.output_per_million)
    && nonnegativeFiniteNumber(row.image_per_unit);
}

function sanitizeOverrideModels(models) {
  if (!models || typeof models !== "object" || Array.isArray(models)) return {};
  const safeModels = {};
  for (const [model, row] of Object.entries(models)) {
    if (typeof model === "string" && model.trim() && validPricingRow(row)) {
      safeModels[model] = {
        input_per_million: row.input_per_million,
        output_per_million: row.output_per_million,
        image_per_unit: row.image_per_unit,
      };
    }
  }
  return safeModels;
}

function nonnegativeNumberOrZero(value) {
  return nonnegativeFiniteNumber(value) ? value : 0;
}

function roundUsd(value) {
  return Math.round((value + Number.EPSILON) * 1_000_000_000_000) / 1_000_000_000_000;
}

export function loadDesignPricing({ env = process.env } = {}) {
  const bundled = copyPricing(BUNDLED_PRICING);
  const overrideText = env?.GEMINI_AGENT_DESIGN_PRICING_JSON;
  if (!overrideText) return bundled;

  let override;
  try {
    override = JSON.parse(overrideText);
  } catch {
    return bundled;
  }

  return {
    models: {
      ...bundled.models,
      ...sanitizeOverrideModels(override?.models),
    },
  };
}

export function estimateDesignCost({
  model,
  inputTokens = 0,
  outputTokens = 0,
  imageUnits = 0,
  pricing = loadDesignPricing(),
} = {}) {
  const row = pricing?.models?.[model];
  if (!validPricingRow(row)) return { usd: null, unknown: true, model };

  const usd = (nonnegativeNumberOrZero(inputTokens) / 1_000_000) * row.input_per_million
    + (nonnegativeNumberOrZero(outputTokens) / 1_000_000) * row.output_per_million
    + nonnegativeNumberOrZero(imageUnits) * row.image_per_unit;

  return { usd: roundUsd(usd), unknown: false, model };
}

export function assertDesignBudget({
  estimate,
  maxCostUsd,
  allowUnknownCost = false,
} = {}) {
  if (maxCostUsd == null) return true;
  if (!nonnegativeFiniteNumber(maxCostUsd)) {
    throw new Error("Invalid design budget: maxCostUsd must be a nonnegative number.");
  }

  if (estimate?.unknown || !nonnegativeFiniteNumber(estimate?.usd)) {
    if (allowUnknownCost) return true;
    throw new Error("Design cost estimate has unknown cost; pass --allow-unknown-cost to continue.");
  }

  if (estimate.usd > maxCostUsd) {
    throw new Error(`Estimated design cost ${estimate.usd.toFixed(4)} exceeds budget ${maxCostUsd}.`);
  }

  return true;
}
