import { mkdir } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
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

function stringArray(value) {
  return Array.isArray(value)
    ? value
      .filter((item) => typeof item === "string" && item.trim())
      .map((item) => item.trim())
    : [];
}

function mergeStringArrays(...values) {
  const seen = new Set();
  const merged = [];
  for (const value of values.flatMap(stringArray)) {
    if (seen.has(value)) continue;
    seen.add(value);
    merged.push(value);
  }
  return merged;
}

function manifestContactSheetPath(outputDir, manifest) {
  if (typeof manifest?.contact_sheet !== "string") return null;
  const contactSheet = manifest.contact_sheet.trim();
  if (!contactSheet || isAbsolute(contactSheet)) return null;
  const outputRoot = resolve(outputDir);
  const candidate = resolve(outputRoot, contactSheet);
  return candidate.startsWith(`${outputRoot}${sep}`) ? candidate : null;
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

function perceptionDefaults({ runId, provider, source, metadata = {} }) {
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
    metadata,
  };
}

function routeMetadata({ provider, selected, providerFallbackWarning }) {
  return {
    requested_provider: provider,
    resolved_provider: selected,
    provider_fallback_used: Boolean(providerFallbackWarning),
    ...(providerFallbackWarning ? { provider_fallback_reason: "missing_vision_banana_endpoint" } : {}),
  };
}

async function enrichFallbackPerception({
  perception,
  reviewPerception,
  file,
  outputDir,
  manifest,
  targets,
}) {
  if (typeof reviewPerception !== "function") {
    return normalizeDesignPerception({
      ...perception,
      metadata: {
        ...plainObject(perception.metadata),
        perception_enrichment: "not_configured",
      },
    });
  }
  try {
    const review = plainObject(await reviewPerception({
      sourceImagePath: file,
      contactSheetPath: manifestContactSheetPath(outputDir, manifest),
      targets,
    }));
    return normalizeDesignPerception({
      ...perception,
      hierarchy: mergeStringArrays(perception.hierarchy, review.hierarchy),
      layout_observations: [
        ...perception.layout_observations,
        ...stringArray(review.layout_observations),
      ],
      implementation_constraints: [
        ...perception.implementation_constraints,
        ...stringArray(review.implementation_constraints),
      ],
      confidence: typeof review.confidence === "number" ? review.confidence : perception.confidence,
      warnings: [
        ...perception.warnings,
        ...stringArray(review.warnings),
      ],
      metadata: {
        ...plainObject(perception.metadata),
        perception_enrichment: "visual-review",
      },
    });
  } catch (error) {
    return normalizeDesignPerception({
      ...perception,
      warnings: [
        ...perception.warnings,
        `Visual review enrichment failed: ${error.message}`,
      ],
      metadata: {
        ...plainObject(perception.metadata),
        perception_enrichment: "unavailable",
      },
    });
  }
}

function unconfiguredVisionBananaMessage() {
  return [
    "Vision Banana provider is not configured.",
    "Set VISION_BANANA_ENDPOINT, choose --provider gemini-vision, or add at least one quoted target for the Nano Banana palette-mask fallback:",
    "  --target \"header: top navigation and primary controls\"",
  ].join("\n");
}

function perceptionTelemetry({ telemetry, provider, selected, providerFallbackWarning }) {
  if (!telemetry) return telemetry;
  const metadata = plainObject(telemetry.metadata);
  return {
    ...telemetry,
    metadata: {
      ...metadata,
      design_stage: "perceive",
      requested_provider: provider,
      resolved_provider: selected,
      provider_fallback_used: Boolean(providerFallbackWarning),
      ...(providerFallbackWarning ? { provider_fallback_reason: "missing_vision_banana_endpoint" } : {}),
    },
  };
}

async function callVisionBanana({
  endpoint,
  file,
  runId,
  targets,
  metadata,
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
    const generatedObject = plainObject(generated);
    return normalizeDesignPerception({
      ...perceptionDefaults({ runId, provider: "vision-banana", source: file, metadata }),
      ...generatedObject,
      run_id: generatedObject.run_id ?? runId,
      provider: "vision-banana",
      source: generatedObject.source ?? file,
      metadata: {
        ...plainObject(generatedObject.metadata),
        ...metadata,
      },
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
  reviewPerception,
} = {}) {
  if (!runDir) throw new Error("runDir is required.");
  if (!file) throw new Error("--file requires a path.");
  let selected = selectPerceptionProvider({ provider, targets });
  let providerFallbackWarning = null;

  if (selected === "palette-mask" && targets.length === 0) {
    throw new Error("palette-mask provider requires at least one --target.");
  }
  if (selected === "vision-banana" && !env.VISION_BANANA_ENDPOINT) {
    if (targets.length === 0) {
      throw new Error(unconfiguredVisionBananaMessage());
    }
    selected = "palette-mask";
    providerFallbackWarning = "Vision Banana endpoint missing; used palette-mask fallback.";
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
      telemetry: perceptionTelemetry({ telemetry, provider, selected, providerFallbackWarning }),
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
      ...perceptionDefaults({
        runId,
        provider: "palette-mask",
        source: file,
        metadata: routeMetadata({ provider, selected, providerFallbackWarning }),
      }),
      regions,
      hierarchy: regions.map((region) => region.id),
      warnings: [
        ...(providerFallbackWarning ? [providerFallbackWarning] : []),
        ...(Array.isArray(split?.manifest?.warnings) ? split.manifest.warnings : []),
      ],
    });
    if (providerFallbackWarning) {
      perception = await enrichFallbackPerception({
        perception,
        reviewPerception,
        file,
        outputDir,
        manifest: split?.manifest,
        targets,
      });
    }
  } else if (selected === "vision-banana") {
    perception = await callVisionBanana({
      endpoint: env.VISION_BANANA_ENDPOINT,
      file,
      runId,
      targets,
      metadata: routeMetadata({ provider, selected, providerFallbackWarning }),
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
    const generatedObject = plainObject(generated);
    const metadata = routeMetadata({ provider, selected, providerFallbackWarning });
    perception = normalizeDesignPerception({
      ...perceptionDefaults({ runId, provider: selected, source: file, metadata }),
      ...generatedObject,
      run_id: generatedObject.run_id ?? runId,
      provider: selected,
      source: generatedObject.source ?? file,
      metadata: {
        ...plainObject(generatedObject.metadata),
        ...metadata,
      },
    });
  }

  const perceptionPath = await writeDesignJson({
    runDir: resolvedRunDir,
    relativePath: "perceive/perception.json",
    value: perception,
  });

  return {
    provider: selected,
    requestedProvider: provider,
    resolvedProvider: selected,
    fallbackUsed: Boolean(providerFallbackWarning),
    fallbackReason: providerFallbackWarning ? "missing_vision_banana_endpoint" : null,
    perception,
    outputDir,
    perceptionPath,
  };
}
