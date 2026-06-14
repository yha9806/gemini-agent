import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { ensureArtifactGitignore } from "./artifact-store.mjs";
import { runDesignBrief } from "./design-brief.mjs";
import { runDesignGenerate } from "./design-generate.mjs";
import { runDesignHandoff } from "./design-handoff.mjs";
import { resolveDesignModels } from "./design-model-router.mjs";
import { runDesignPrototype } from "./design-prototype.mjs";
import { writeDesignJson } from "./design-run-store.mjs";
import { captureGeminiTelemetry } from "./telemetry-capture.mjs";

const QUALITY_VALUES = new Set(["fast", "pro"]);
const TARGET_STACK_VALUES = new Set(["html", "react", "tailwind", "auto"]);
const REQUESTED_STEPS = ["brief", "generate", "perceive", "prototype", "handoff"];

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function rel(cwd, path) {
  if (!path) return null;
  return relative(cwd, path) || ".";
}

function step(name, status, details = {}) {
  return { name, status, ...details };
}

async function directorySizeBytes(path) {
  let total = 0;

  async function walk(entry) {
    let info;
    try {
      info = await lstat(entry);
    } catch {
      return;
    }
    if (info.isSymbolicLink()) return;
    if (info.isFile()) {
      total += info.size;
      return;
    }
    if (!info.isDirectory()) return;
    const children = await readdir(entry);
    for (const child of children) await walk(join(entry, child));
  }

  await walk(path);
  return total;
}

function validateVariants(variants) {
  if (!Number.isInteger(variants) || variants < 1 || variants > 4) {
    throw new Error("--variants must be between 1 and 4.");
  }
}

function validateQuality(quality) {
  if (!QUALITY_VALUES.has(quality)) throw new Error("--quality must be fast or pro.");
}

function validateTargetStack(targetStack) {
  if (!TARGET_STACK_VALUES.has(targetStack)) {
    throw new Error("--target-stack must be html, react, tailwind, or auto.");
  }
}

export function validateDesignDraftModelPreflight({
  env = process.env,
  quality = "fast",
  skipGenerate = false,
} = {}) {
  validateQuality(quality);
  if (skipGenerate) return true;
  const models = resolveDesignModels({ env });
  const missing = quality === "pro" ? !models.image_pro_model : !models.image_model;
  if (missing) {
    const envName = quality === "pro" ? "GEMINI_IMAGE_PRO_MODEL" : "GEMINI_IMAGE_MODEL";
    throw new Error(
      `${envName} is required for design draft image generation. Run: gemini-agent design doctor --json, configure ${envName}, or retry with --skip-generate.`,
    );
  }
  return true;
}

function nextActions({
  runDir,
  skipPrototype,
  skipHandoff,
  failedStep = null,
}) {
  const actions = [];
  if (failedStep === "generate") {
    actions.push(`gemini-agent design generate --run ${runDir} --variants 1 --quality fast`);
  }
  if (failedStep === "prototype") {
    actions.push(`gemini-agent design prototype --run ${runDir} --target-stack html`);
  }
  if (failedStep === "handoff") {
    actions.push(`gemini-agent design handoff --run ${runDir}`);
  }
  if (!skipHandoff) actions.push(`Read ${runDir}/codex-tasks.md before editing repository files.`);
  if (!skipPrototype) actions.push(`Review ${runDir}/prototype/manifest.json before Codex implementation.`);
  actions.push("After Codex implementation, capture a screenshot and run gemini-agent design loop.");
  return actions;
}

async function writeSummary({ cwd, runDir, value }) {
  const path = await writeDesignJson({ runDir, relativePath: "draft-summary.json", value });
  return { path, relative_path: rel(cwd, path) };
}

async function captureDraftTelemetry({
  telemetry,
  cwd,
  inputText,
  status,
  errorType,
  latencyMs,
  metadata,
}) {
  const capture = telemetry?.capture ?? captureGeminiTelemetry;
  await capture({
    cwd,
    source: telemetry?.source || "cli",
    command: "design-draft",
    prompt: inputText,
    response: "",
    status,
    errorType,
    latencyMs,
    metadata: {
      ...plainObject(telemetry?.metadata),
      ...plainObject(metadata),
    },
  }).catch(() => null);
}

function telemetrySuccessMetadata({
  env,
  models,
  steps,
  variants,
  quality,
  targetStack,
}) {
  return {
    design_stage: "draft",
    draft_steps_requested: REQUESTED_STEPS,
    draft_steps_completed: steps.map((item) => item.name),
    variants,
    quality,
    target_stack: targetStack,
    actual_design_model: models.design_model,
    actual_image_model: models.image_model,
    actual_image_pro_model: quality === "pro" ? models.image_pro_model : null,
    vision_banana_provider: env.VISION_BANANA_ENDPOINT ? "configured" : "missing",
  };
}

export async function readLatestDesignSummary({ cwd = process.cwd() } = {}) {
  const root = join(cwd, ".gemini-agent", "design");
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  const runIds = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const runId of runIds) {
    try {
      return JSON.parse(await readFile(join(root, runId, "draft-summary.json"), "utf8"));
    } catch {
      // Keep scanning older runs.
    }
  }
  return null;
}

export async function runDesignDraft({
  cwd = process.cwd(),
  inputText,
  apiKey,
  env = process.env,
  variants = 1,
  quality = "fast",
  targetStack = "html",
  skipGenerate = false,
  skipPerceive = false,
  skipPrototype = false,
  skipHandoff = false,
  allowFakeResponse = false,
  now = new Date(),
  random = Math.random,
  telemetry,
  runners = {},
} = {}) {
  const started = Date.now();
  if (!inputText || !String(inputText).trim()) throw new Error("design draft input is empty.");
  validateVariants(variants);
  validateTargetStack(targetStack);
  validateDesignDraftModelPreflight({ env, quality, skipGenerate });
  await ensureArtifactGitignore(cwd);

  const runBrief = runners.brief ?? runDesignBrief;
  const runGenerate = runners.generate ?? runDesignGenerate;
  const runPrototype = runners.prototype ?? runDesignPrototype;
  const runHandoff = runners.handoff ?? runDesignHandoff;
  const models = resolveDesignModels({ env });
  const steps = [];
  let run = null;
  let selectedCandidate = null;
  let currentStep = "brief";

  try {
    currentStep = "brief";
    const briefResult = await runBrief({
      cwd,
      inputText,
      apiKey,
      env,
      now,
      random,
      allowFakeResponse,
      telemetry: {
        ...telemetry,
        cwd,
        source: telemetry?.source || "cli",
        command: "design-brief",
      },
    });
    run = briefResult.run;
    steps.push(step("brief", "success", { artifact: rel(cwd, briefResult.artifacts?.brief_json) }));

    currentStep = "generate";
    if (skipGenerate) {
      steps.push(step("generate", "skipped"));
    } else {
      const generated = await runGenerate({
        runDir: run.dir,
        variants,
        quality,
        apiKey,
        env,
        allowFakeResponse,
        telemetry: {
          ...telemetry,
          cwd,
          source: telemetry?.source || "cli",
          command: "design-generate",
        },
      });
      selectedCandidate = generated.manifest?.candidates?.[0]?.id ?? null;
      steps.push(step("generate", "success", { selected_candidate: selectedCandidate }));
    }

    currentStep = "perceive";
    steps.push(step("perceive", "skipped", { reason: skipPerceive ? "disabled" : "no_review_artifact" }));

    currentStep = "prototype";
    if (skipPrototype) {
      steps.push(step("prototype", "skipped"));
    } else {
      await runPrototype({
        runDir: run.dir,
        apiKey,
        env,
        selectedCandidate,
        targetStack,
        allowFakeResponse,
        telemetry: {
          ...telemetry,
          cwd,
          source: telemetry?.source || "cli",
          command: "design-prototype",
        },
      });
      steps.push(step("prototype", "success", { artifact: "prototype/manifest.json" }));
    }

    currentStep = "handoff";
    if (skipHandoff) {
      steps.push(step("handoff", "skipped"));
    } else {
      await runHandoff({
        runDir: run.dir,
        apiKey,
        env,
        selectedCandidate,
        allowFakeResponse,
        telemetry: {
          ...telemetry,
          cwd,
          source: telemetry?.source || "cli",
          command: "design-handoff",
        },
      });
      steps.push(step("handoff", "success", { artifact: "handoff.json" }));
    }

    const sizeBytes = await directorySizeBytes(run.dir);
    const summary = {
      kind: "design_draft_summary",
      status: "success",
      run_id: run.runId,
      run_dir: run.dir,
      selected_candidate: selectedCandidate,
      steps,
      model_routes: models,
      options: { variants, quality, target_stack: targetStack },
      local_artifact_bytes: sizeBytes,
      warnings: [],
      next_actions: nextActions({ runDir: run.dir, skipPrototype, skipHandoff }),
    };
    await writeSummary({ cwd, runDir: run.dir, value: summary });
    await captureDraftTelemetry({
      telemetry,
      cwd,
      inputText,
      status: "success",
      latencyMs: Date.now() - started,
      metadata: telemetrySuccessMetadata({ env, models, steps, variants, quality, targetStack }),
    });
    return summary;
  } catch (error) {
    if (run?.dir) {
      if (!steps.some((item) => item.name === currentStep)) {
        steps.push(step(currentStep, "error", { error_type: error.name || "Error" }));
      } else {
        steps.push(step(`${currentStep}_error`, "error", { error_type: error.name || "Error" }));
      }
      const summary = {
        kind: "design_draft_summary",
        status: "partial_failure",
        run_id: run.runId,
        run_dir: run.dir,
        selected_candidate: selectedCandidate,
        steps,
        model_routes: models,
        options: { variants, quality, target_stack: targetStack },
        warnings: [error.message],
        next_actions: nextActions({
          runDir: run.dir,
          skipPrototype,
          skipHandoff,
          failedStep: currentStep,
        }),
      };
      await writeSummary({ cwd, runDir: run.dir, value: summary }).catch(() => null);
    }
    await captureDraftTelemetry({
      telemetry,
      cwd,
      inputText,
      status: "error",
      errorType: error.name || "Error",
      latencyMs: Date.now() - started,
      metadata: {
        design_stage: "draft",
        draft_error: error.message,
        draft_steps_completed: steps.filter((item) => item.status === "success").map((item) => item.name),
      },
    });
    throw error;
  }
}
