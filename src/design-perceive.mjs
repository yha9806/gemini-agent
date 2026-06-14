import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { normalizeDesignPerception } from "./design-schemas.mjs";
import { readDesignRunId, writeDesignJson } from "./design-run-store.mjs";
import { runPaletteSplit } from "./palette-mask.mjs";

const PERCEPTION_PROVIDERS = new Set(["auto", "palette-mask", "gemini-vision", "vision-banana"]);
const VISION_BANANA_TIMEOUT_MS = 10000;
const MAX_VISION_BANANA_TARGETS = 20;
const MAX_VISION_BANANA_FIELD_CHARS = 1000;

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function truncateField(value) {
  const text = String(value ?? "");
  return text.length > MAX_VISION_BANANA_FIELD_CHARS
    ? text.slice(0, MAX_VISION_BANANA_FIELD_CHARS)
    : text;
}

function boundedTargets(targets) {
  return targets.slice(0, MAX_VISION_BANANA_TARGETS).map((target) => truncateField(target));
}

function parseTargetName(target) {
  return String(target).split(":")[0].trim();
}

function layerByName(layers = []) {
  return new Map(layers
    .filter((layer) => layer?.name)
    .map((layer) => [String(layer.name), layer]));
}

function perceptionDefaults({ runId, provider, source }) {
  return {
    kind: "design_perception",
    run_id: runId,
    provider,
    source,
    regions: [],
    hierarchy: [],
    layout_observations: [],
    implementation_constraints: [],
    confidence: null,
    warnings: [],
  };
}

async function callVisionBanana({
  endpoint,
  file,
  runId,
  targets,
  fetchImpl,
  timeoutMs = VISION_BANANA_TIMEOUT_MS,
}) {
  const fetchFn = fetchImpl ?? globalThis.fetch;
  if (typeof fetchFn !== "function") {
    throw new Error("Vision Banana provider requires fetch support.");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        image_path: truncateField(file),
        run_id: runId,
        targets: boundedTargets(targets),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Vision Banana provider failed with HTTP ${response.status}: ${body.slice(0, 200)}`);
    }

    const generated = await response.json();
    return normalizeDesignPerception({
      ...perceptionDefaults({ runId, provider: "vision-banana", source: file }),
      ...plainObject(generated),
      run_id: plainObject(generated).run_id ?? runId,
      provider: "vision-banana",
      source: plainObject(generated).source ?? file,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Vision Banana provider timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function selectPerceptionProvider({ provider = "auto", targets = [] } = {}) {
  if (!PERCEPTION_PROVIDERS.has(provider)) {
    throw new Error("--provider must be auto, palette-mask, gemini-vision, or vision-banana.");
  }
  if (provider !== "auto") return provider;
  return targets.length > 0 ? "palette-mask" : "gemini-vision";
}

export async function runDesignPerceive({
  runDir,
  file,
  provider = "auto",
  targets = [],
  apiKey,
  env = process.env,
  paletteSplit = runPaletteSplit,
  fetchImpl,
  timeoutMs = VISION_BANANA_TIMEOUT_MS,
  generate,
  telemetry,
} = {}) {
  if (!runDir) throw new Error("runDir is required.");
  if (!file) throw new Error("--file requires a path.");
  const selected = selectPerceptionProvider({ provider, targets });

  if (selected === "palette-mask" && targets.length === 0) {
    throw new Error("palette-mask provider requires at least one --target.");
  }
  if (selected === "vision-banana" && !env.VISION_BANANA_ENDPOINT) {
    throw new Error("Vision Banana provider is not configured; set VISION_BANANA_ENDPOINT or choose another provider.");
  }
  if (selected === "gemini-vision" && typeof generate !== "function") {
    throw new Error("gemini-vision provider requires an injected generate function; live vision is not implemented yet.");
  }

  const resolvedRunDir = resolve(runDir);
  const runId = await readDesignRunId(resolvedRunDir);
  const outputDir = join(resolvedRunDir, "perceive");
  await mkdir(outputDir, { recursive: true });

  let perception;
  if (selected === "palette-mask") {
    const split = await paletteSplit({
      sourceImagePath: file,
      targets,
      outputDir,
      apiKey,
      env,
      telemetry,
    });
    const layers = layerByName(split?.manifest?.layers);
    const regions = targets.map((target, index) => {
      const name = parseTargetName(target);
      const layer = layers.get(name);
      return {
        id: name,
        label: name,
        role: "target",
        importance: index === 0 ? 1 : 0.5,
        bbox: null,
        mask_ref: layer?.file ?? null,
        confidence: null,
      };
    });
    perception = normalizeDesignPerception({
      ...perceptionDefaults({ runId, provider: "palette-mask", source: file }),
      regions,
      hierarchy: regions.map((region) => region.id),
      warnings: Array.isArray(split?.manifest?.warnings) ? split.manifest.warnings : [],
    });
  } else if (selected === "vision-banana") {
    perception = await callVisionBanana({
      endpoint: env.VISION_BANANA_ENDPOINT,
      file,
      runId,
      targets,
      fetchImpl,
      timeoutMs,
    });
  } else {
    const generated = await generate({
      apiKey,
      env,
      file,
      provider: selected,
      runId,
      targets,
      telemetry,
    });
    perception = normalizeDesignPerception({
      ...perceptionDefaults({ runId, provider: selected, source: file }),
      ...plainObject(generated),
      run_id: plainObject(generated).run_id ?? runId,
      provider: selected,
      source: plainObject(generated).source ?? file,
    });
  }

  const perceptionPath = await writeDesignJson({
    runDir: resolvedRunDir,
    relativePath: "perceive/perception.json",
    value: perception,
  });

  return {
    provider: selected,
    perception,
    outputDir,
    perceptionPath,
  };
}
