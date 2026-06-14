# Design Draft Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `gemini-agent design draft` plus MCP and active-policy routing so Gemini can safely produce design briefs, visual candidates, isolated prototypes, and Codex handoff artifacts before Codex edits the real repository.

**Architecture:** Add one orchestration module over the existing design commands instead of rewriting the design stack. The orchestrator writes only under `.gemini-agent/design/<run-id>/`, emits a safe `draft-summary.json`, and exposes the workflow through CLI and MCP. Codex keeps responsibility for source edits, tests, commits, and final claims.

**Tech Stack:** Node.js ESM, `node:test`, MCP SDK, existing Gemini client/design modules, existing telemetry queue/capture modules.

---

## File Structure

- Create `src/design-draft.mjs`: orchestrates brief, generate, optional perceive, prototype, handoff, summary writing, latest summary reading, model preflight, and top-level telemetry.
- Create `src/workspace-paths.mjs`: shared physical path validation for MCP/design references.
- Create `test/design-draft.test.mjs`: unit tests for orchestration, failure summaries, gitignore safety, and model preflight.
- Create `test/workspace-paths.test.mjs`: focused path traversal and symlink escape tests.
- Modify `src/cli.mjs`: parse `design draft`, print help, call `runDesignDraft`.
- Modify `src/mcp-server.mjs`: add `gemini_design_draft`, `gemini-agent://design/latest`, and `gemini-agent://design/handoff/latest`.
- Modify `src/codex-global-install.mjs`: update active policy to route UI/visual/product-first-version tasks through `design draft`.
- Modify `README.md`: document `design draft` and its safety boundary.
- Modify `test/cli.test.mjs`: CLI coverage for help, validation, and fake-response smoke path.
- Modify `test/mcp.test.mjs`: MCP tool/resource coverage.
- Modify `test/codex-global-install.test.mjs`: active policy expectations.
- Modify `test/package.test.mjs`: README command and safety text expectations.

---

### Task 1: Workspace Path Validation Helper

**Files:**
- Create: `src/workspace-paths.mjs`
- Test: `test/workspace-paths.test.mjs`

- [ ] **Step 1: Write failing tests for relative path validation**

Create `test/workspace-paths.test.mjs`:

```js
import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveWorkspaceFilePath } from "../src/workspace-paths.mjs";

test("resolveWorkspaceFilePath accepts relative files inside cwd", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "workspace-paths-"));
  try {
    await mkdir(join(cwd, "screens"), { recursive: true });
    await writeFile(join(cwd, "screens", "home.png"), "png");
    const result = await resolveWorkspaceFilePath("screens/home.png", { cwd });
    assert.equal(result.endsWith("/screens/home.png"), true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("resolveWorkspaceFilePath rejects absolute paths and dot-dot traversal", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "workspace-paths-"));
  try {
    await assert.rejects(
      () => resolveWorkspaceFilePath("/tmp/outside.png", { cwd }),
      /Reference paths must be relative/,
    );
    await assert.rejects(
      () => resolveWorkspaceFilePath("../outside.png", { cwd }),
      /Reference path must stay inside cwd/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("resolveWorkspaceFilePath rejects symlink escapes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "workspace-paths-"));
  const outside = await mkdtemp(join(tmpdir(), "workspace-paths-outside-"));
  try {
    await writeFile(join(outside, "secret.png"), "secret");
    await symlink(join(outside, "secret.png"), join(cwd, "linked.png"));
    await assert.rejects(
      () => resolveWorkspaceFilePath("linked.png", { cwd }),
      /Reference path must stay inside cwd/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
node --test test/workspace-paths.test.mjs
```

Expected: fail with `Cannot find module '../src/workspace-paths.mjs'`.

- [ ] **Step 3: Implement `src/workspace-paths.mjs`**

Create `src/workspace-paths.mjs`:

```js
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

function contained(root, candidate) {
  const rel = relative(root, candidate);
  return rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export async function resolveWorkspaceFilePath(path, { cwd = process.cwd() } = {}) {
  const value = String(path ?? "").trim();
  if (!value) throw new Error("Reference path is required.");
  if (isAbsolute(value)) throw new Error("Reference paths must be relative.");
  const physicalCwd = await realpath(cwd);
  const lexicalCandidate = resolve(physicalCwd, value);
  if (!contained(physicalCwd, lexicalCandidate)) {
    throw new Error("Reference path must stay inside cwd.");
  }
  const physicalCandidate = await realpath(lexicalCandidate);
  if (!contained(physicalCwd, physicalCandidate)) {
    throw new Error("Reference path must stay inside cwd.");
  }
  return physicalCandidate;
}
```

- [ ] **Step 4: Verify helper tests pass**

Run:

```bash
node --test test/workspace-paths.test.mjs
```

Expected: `pass 3`, `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/workspace-paths.mjs test/workspace-paths.test.mjs
git commit -m "Add workspace reference path validation"
```

---

### Task 2: Design Draft Orchestrator Core

**Files:**
- Create: `src/design-draft.mjs`
- Test: `test/design-draft.test.mjs`

- [ ] **Step 1: Write failing orchestration tests**

Create `test/design-draft.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDesignDraft, validateDesignDraftModelPreflight } from "../src/design-draft.mjs";

async function makeBriefRun(cwd) {
  const runId = "20260614T120000000Z-abcdef";
  const dir = join(cwd, ".gemini-agent", "design", runId);
  await mkdir(dir, { recursive: true });
  const brief = {
    kind: "design_brief",
    run_id: runId,
    goal: "Improve dashboard",
    target_user: "Operator",
    screens: [{ id: "admin", purpose: "Monitor telemetry" }],
    visual_direction: ["quiet"],
    design_system: { tokens: [] },
    accessibility: [],
    responsive_requirements: [],
    acceptance_criteria: [],
    implementation_risks: [],
    metadata: {},
  };
  await writeFile(join(dir, "brief.json"), `${JSON.stringify(brief)}\n`);
  return { run: { runId, dir }, brief, artifacts: { brief_json: join(dir, "brief.json"), design_markdown: join(dir, "DESIGN.md") } };
}

test("runDesignDraft orchestrates brief, generate, prototype, handoff, and summary", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "design-draft-"));
  const calls = [];
  try {
    const result = await runDesignDraft({
      cwd,
      inputText: "Design a telemetry dashboard",
      apiKey: "key",
      env: {
        GEMINI_DESIGN_MODEL: "configured-design-model",
        GEMINI_IMAGE_MODEL: "configured-image-model",
      },
      variants: 2,
      quality: "fast",
      targetStack: "html",
      runners: {
        brief: async (input) => {
          calls.push(["brief", input.inputText]);
          return makeBriefRun(cwd);
        },
        generate: async (input) => {
          calls.push(["generate", input.variants, input.quality]);
          return { manifest: { candidates: [{ id: "candidate-a", file: "candidate-a.png" }] } };
        },
        prototype: async (input) => {
          calls.push(["prototype", input.selectedCandidate, input.targetStack]);
          return { manifest: { preview_entry: "preview.html" } };
        },
        handoff: async (input) => {
          calls.push(["handoff", input.selectedCandidate]);
          return { handoff: { implementation_summary: "Update dashboard cards." } };
        },
      },
    });

    assert.deepEqual(calls, [
      ["brief", "Design a telemetry dashboard"],
      ["generate", 2, "fast"],
      ["prototype", "candidate-a", "html"],
      ["handoff", "candidate-a"],
    ]);
    assert.equal(result.status, "success");
    assert.equal(result.run_id, "20260614T120000000Z-abcdef");
    assert.equal(result.selected_candidate, "candidate-a");
    assert.equal(result.steps.map((step) => step.name).join(","), "brief,generate,prototype,handoff");
    const summary = JSON.parse(await readFile(join(result.run_dir, "draft-summary.json"), "utf8"));
    assert.equal(summary.kind, "design_draft_summary");
    assert.equal(summary.status, "success");
    assert.equal(summary.model_routes.design_model, "configured-design-model");
    assert.equal(summary.model_routes.image_model, "configured-image-model");
    assert.match(summary.next_actions.join("\n"), /codex-tasks\.md/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runDesignDraft can create a text-only draft when generation and prototype are skipped", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "design-draft-"));
  const calls = [];
  try {
    const result = await runDesignDraft({
      cwd,
      inputText: "Create a settings page",
      apiKey: "key",
      env: { GEMINI_DESIGN_MODEL: "configured-design-model" },
      skipGenerate: true,
      skipPrototype: true,
      runners: {
        brief: async () => {
          calls.push("brief");
          return makeBriefRun(cwd);
        },
        handoff: async () => {
          calls.push("handoff");
          return { handoff: { implementation_summary: "Build settings page." } };
        },
      },
    });
    assert.deepEqual(calls, ["brief", "handoff"]);
    assert.equal(result.steps.find((step) => step.name === "generate").status, "skipped");
    assert.equal(result.steps.find((step) => step.name === "prototype").status, "skipped");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("validateDesignDraftModelPreflight fails clearly when default generation lacks image model", () => {
  assert.throws(
    () => validateDesignDraftModelPreflight({ env: {}, quality: "fast", skipGenerate: false }),
    /GEMINI_IMAGE_MODEL is required.*design doctor.*--skip-generate/s,
  );
});

test("runDesignDraft writes partial summary before rethrowing a step failure", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "design-draft-"));
  try {
    await assert.rejects(
      () => runDesignDraft({
        cwd,
        inputText: "Design a dashboard",
        apiKey: "key",
        env: { GEMINI_DESIGN_MODEL: "configured-design-model", GEMINI_IMAGE_MODEL: "configured-image-model" },
        runners: {
          brief: () => makeBriefRun(cwd),
          generate: async () => ({ manifest: { candidates: [{ id: "candidate-a", file: "candidate-a.png" }] } }),
          prototype: async () => {
            throw new Error("prototype failed");
          },
        },
      }),
      /prototype failed/,
    );
    const summary = JSON.parse(await readFile(join(cwd, ".gemini-agent", "design", "20260614T120000000Z-abcdef", "draft-summary.json"), "utf8"));
    assert.equal(summary.status, "partial_failure");
    assert.equal(summary.steps.find((step) => step.name === "prototype").status, "error");
    assert.match(summary.next_actions.join("\n"), /design prototype/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runDesignDraft ensures .gemini-agent is ignored before writing draft artifacts", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "design-draft-"));
  try {
    await runDesignDraft({
      cwd,
      inputText: "Design a dashboard",
      apiKey: "key",
      env: { GEMINI_DESIGN_MODEL: "configured-design-model" },
      skipGenerate: true,
      skipPrototype: true,
      skipHandoff: true,
      runners: { brief: () => makeBriefRun(cwd) },
    });
    assert.match(await readFile(join(cwd, ".gitignore"), "utf8"), /^\.gemini-agent\/$/m);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
node --test test/design-draft.test.mjs
```

Expected: fail with `Cannot find module '../src/design-draft.mjs'`.

- [ ] **Step 3: Implement `src/design-draft.mjs`**

Create `src/design-draft.mjs`:

```js
import { stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
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

function bool(value) {
  return Boolean(value);
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function rel(cwd, path) {
  if (!path) return null;
  return relative(cwd, path) || ".";
}

async function directorySizeBytes(path) {
  let total = 0;
  async function walk(entry) {
    let info;
    try {
      info = await stat(entry);
    } catch {
      return;
    }
    if (info.isFile()) {
      total += info.size;
    }
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

export function validateDesignDraftModelPreflight({ env = process.env, quality = "fast", skipGenerate = false } = {}) {
  validateQuality(quality);
  if (skipGenerate) return true;
  const models = resolveDesignModels({ env });
  const missing = quality === "pro" ? !models.image_pro_model : !models.image_model;
  if (missing) {
    const envName = quality === "pro" ? "GEMINI_IMAGE_PRO_MODEL" : "GEMINI_IMAGE_MODEL";
    throw new Error(`${envName} is required for design draft image generation. Run: gemini-agent design doctor --json, configure ${envName}, or retry with --skip-generate.`);
  }
  return true;
}

function step(name, status, details = {}) {
  return { name, status, ...details };
}

function nextActions({ runDir, skipPrototype, skipHandoff, failedStep }) {
  const actions = [];
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

async function captureDraftTelemetry({ telemetry, cwd, inputText, status, errorType, latencyMs, metadata }) {
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
    metadata,
  }).catch(() => null);
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
  let run;
  let selectedCandidate = null;
  let failedStep = null;

  try {
    const briefResult = await runBrief({
      cwd,
      inputText,
      apiKey,
      env,
      now,
      random,
      allowFakeResponse,
      telemetry: { ...telemetry, cwd, source: telemetry?.source || "cli", command: "design-brief" },
    });
    run = briefResult.run;
    steps.push(step("brief", "success", { artifact: rel(cwd, briefResult.artifacts?.brief_json) }));

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
        telemetry: { ...telemetry, cwd, source: telemetry?.source || "cli", command: "design-generate" },
      });
      selectedCandidate = generated.manifest?.candidates?.[0]?.id ?? null;
      steps.push(step("generate", "success", { selected_candidate: selectedCandidate }));
    }

    if (skipPerceive) steps.push(step("perceive", "skipped"));

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
        telemetry: { ...telemetry, cwd, source: telemetry?.source || "cli", command: "design-prototype" },
      });
      steps.push(step("prototype", "success", { artifact: "prototype/manifest.json" }));
    }

    if (skipHandoff) {
      steps.push(step("handoff", "skipped"));
    } else {
      await runHandoff({
        runDir: run.dir,
        apiKey,
        env,
        selectedCandidate,
        allowFakeResponse,
        telemetry: { ...telemetry, cwd, source: telemetry?.source || "cli", command: "design-handoff" },
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
      metadata: { design_stage: "draft", draft_steps_completed: steps.map((item) => item.name), actual_design_model: models.design_model, actual_image_model: models.image_model },
    });
    return summary;
  } catch (error) {
    const last = steps[steps.length - 1];
    failedStep = last?.status === "success" ? null : last?.name;
    if (run?.dir) {
      const name = failedStep || "prototype";
      if (!steps.some((item) => item.status === "error")) {
        steps.push(step(name, "error", { error_type: error.name || "Error" }));
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
        next_actions: nextActions({ runDir: run.dir, skipPrototype, skipHandoff, failedStep: name }),
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
      metadata: { design_stage: "draft", draft_error: error.message },
    });
    throw error;
  }
}
```

- [ ] **Step 4: Run focused tests and fix only this module if needed**

Run:

```bash
node --test test/design-draft.test.mjs test/workspace-paths.test.mjs
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/design-draft.mjs test/design-draft.test.mjs
git commit -m "Add design draft orchestrator"
```

---

### Task 3: CLI `design draft`

**Files:**
- Modify: `src/cli.mjs`
- Test: `test/cli.test.mjs`

- [ ] **Step 1: Add failing CLI tests**

Add to the design CLI test section in `test/cli.test.mjs`:

```js
test("design draft help is listed", async () => {
  const { stdout } = await execBin(["--help"], {
    env: { PATH: process.env.PATH, HOME: CLI_TEST_HOME, USERPROFILE: CLI_TEST_HOME },
  });
  assert.match(stdout, /gemini-agent design draft \[--stdin\|--file <path>\|text\]/);
});

test("design draft rejects empty input before auth lookup", async () => {
  await assert.rejects(
    () => execBin(["design", "draft", "--stdin"], {
      input: "",
      env: { PATH: process.env.PATH, HOME: CLI_TEST_HOME, USERPROFILE: CLI_TEST_HOME },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Context input is empty\.|design draft input is empty/);
      assert.doesNotMatch(error.stderr, /Gemini API key/);
      return true;
    },
  );
});

test("design draft missing image model gives doctor and skip guidance before auth lookup", async () => {
  await assert.rejects(
    () => execBin(["design", "draft", "Design a dashboard"], {
      env: { PATH: process.env.PATH, HOME: CLI_TEST_HOME, USERPROFILE: CLI_TEST_HOME },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /GEMINI_IMAGE_MODEL is required/);
      assert.match(error.stderr, /design doctor --json/);
      assert.match(error.stderr, /--skip-generate/);
      assert.doesNotMatch(error.stderr, /Gemini API key/);
      return true;
    },
  );
});

test("design draft writes text-only draft with fake Gemini response", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-design-draft-cli-"));
  try {
    const { stdout } = await execBin([
      "design",
      "draft",
      "--stdin",
      "--skip-generate",
      "--skip-prototype",
      "--skip-handoff",
      "--json",
    ], {
      cwd: dir,
      input: "Design a dashboard",
      env: {
        ...process.env,
        HOME: CLI_TEST_HOME,
        USERPROFILE: CLI_TEST_HOME,
        GEMINI_API_KEY: "fake-key",
        GEMINI_AGENT_ALLOW_FAKE_RESPONSE: "1",
        GEMINI_AGENT_FAKE_RESPONSE: fakeDesignBrief,
      },
    });
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.status, "success");
    assert.match(parsed.run_dir, /\.gemini-agent\/design\//);
    assert.equal(parsed.steps.find((step) => step.name === "generate").status, "skipped");
    assert.equal(parsed.steps.find((step) => step.name === "prototype").status, "skipped");
    assert.equal(parsed.steps.find((step) => step.name === "handoff").status, "skipped");
    assert.match(await readFile(join(parsed.run_dir, "draft-summary.json"), "utf8"), /design_draft_summary/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run targeted CLI tests and verify failure**

Run:

```bash
node --test test/cli.test.mjs --test-name-pattern "design draft"
```

Expected: fail because help/parser do not know `design draft`.

- [ ] **Step 3: Implement CLI parser and command**

Modify `src/cli.mjs`:

```js
import { runDesignDraft, validateDesignDraftModelPreflight } from "./design-draft.mjs";
```

Add usage line in `printUsage()`:

```js
"  gemini-agent design draft [--stdin|--file <path>|text] [--reference <path> ...] [--target <name: description> ...] [--variants <n>] [--quality fast|pro] [--target-stack html|react|tailwind|auto] [--skip-generate] [--skip-perceive] [--skip-prototype] [--skip-handoff] [--json]",
```

Add parser near the other design parsers:

```js
function parseDesignDraftArgs(args) {
  const options = {
    stdin: false,
    files: [],
    text: [],
    references: [],
    targets: [],
    variants: 1,
    quality: "fast",
    targetStack: "html",
    skipGenerate: false,
    skipPerceive: false,
    skipPrototype: false,
    skipHandoff: false,
    json: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--stdin") options.stdin = true;
    else if (arg === "--file") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--file requires a path.");
      options.files.push(value);
      index += 1;
    } else if (arg === "--reference") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--reference requires a path.");
      options.references.push(value);
      index += 1;
    } else if (arg === "--target") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--target requires a value.");
      validateDesignPerceiveTarget(value);
      options.targets.push(value);
      index += 1;
    } else if (arg === "--variants") {
      options.variants = parsePositiveIntegerArg(args[index + 1], "--variants");
      index += 1;
    } else if (arg === "--quality") {
      const value = args[index + 1];
      if (value !== "fast" && value !== "pro") throw new Error("--quality must be fast or pro.");
      options.quality = value;
      index += 1;
    } else if (arg === "--target-stack") {
      const value = args[index + 1];
      validatePrototypeTargetStack(value);
      options.targetStack = value;
      index += 1;
    } else if (arg === "--skip-generate") options.skipGenerate = true;
    else if (arg === "--skip-perceive") options.skipPerceive = true;
    else if (arg === "--skip-prototype") options.skipPrototype = true;
    else if (arg === "--skip-handoff") options.skipHandoff = true;
    else if (arg === "--json") options.json = true;
    else options.text.push(arg);
  }
  return options;
}
```

Add command branch at the top of `runDesignCommand()` after `doctor`:

```js
if (subcommand === "draft") {
  const options = parseDesignDraftArgs(subArgs);
  const stdinText = options.stdin ? await readStdin() : "";
  const collected = await collectTextInput({
    stdinText,
    files: options.files,
    cwd: process.cwd(),
  }).catch((error) => {
    if (options.text.length > 0 && !options.stdin && options.files.length === 0) {
      return { text: options.text.join(" "), sources: [] };
    }
    throw error;
  });
  const inputText = options.text.length > 0 && !options.stdin && options.files.length === 0
    ? options.text.join(" ")
    : collected.text;
  validateDesignDraftModelPreflight({
    env: process.env,
    quality: options.quality,
    skipGenerate: options.skipGenerate,
  });
  const key = await resolveApiKey();
  if (!key.ok) throw new Error("Gemini API key is not configured. Run: gemini-agent auth set");
  const result = await runDesignDraft({
    cwd: process.cwd(),
    inputText,
    apiKey: key.key,
    env: process.env,
    variants: options.variants,
    quality: options.quality,
    targetStack: options.targetStack,
    skipGenerate: options.skipGenerate,
    skipPerceive: options.skipPerceive,
    skipPrototype: options.skipPrototype,
    skipHandoff: options.skipHandoff,
    allowFakeResponse: allowFakeResponse(process.env),
    telemetry: { cwd: process.cwd(), source: "cli", command: "design-draft" },
  });
  output.write(`${JSON.stringify(result, null, 2)}\n`);
  return;
}
```

If `parsePositiveIntegerArg` does not exist, add a local parser:

```js
function parsePositiveIntegerArg(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${label} requires a positive integer.`);
  return number;
}
```

- [ ] **Step 4: Run targeted CLI tests**

Run:

```bash
node --test test/cli.test.mjs --test-name-pattern "design draft"
```

Expected: all matching tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/cli.mjs test/cli.test.mjs
git commit -m "Expose design draft CLI"
```

---

### Task 4: MCP Active Design Tool And Resources

**Files:**
- Modify: `src/mcp-server.mjs`
- Test: `test/mcp.test.mjs`

- [ ] **Step 1: Add failing MCP tests**

Add to `test/mcp.test.mjs`:

```js
const fakeDesignBrief = JSON.stringify({
  kind: "design_brief",
  run_id: "will-be-replaced",
  goal: "Improve dashboard",
  target_user: "Operator",
  screens: [],
  visual_direction: ["quiet"],
  design_system: { tokens: [] },
  accessibility: [],
  responsive_requirements: [],
  acceptance_criteria: [],
  implementation_risks: [],
  metadata: {},
});

test("mcp server exposes design draft tool and latest design resource", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-mcp-design-"));
  const transport = new StdioClientTransport({
    command: "node",
    args: [new URL("../bin/gemini-agent-mcp", import.meta.url).pathname],
    cwd: dir,
    env: {
      ...process.env,
      GEMINI_API_KEY: "fake-key",
      GEMINI_AGENT_FAKE_RESPONSE: fakeDesignBrief,
      GEMINI_AGENT_ALLOW_FAKE_RESPONSE: "1",
    },
  });
  const client = new Client({ name: "gemini-agent-test", version: "0.1.0" });
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "gemini_design_draft"));
    const result = await client.callTool({
      name: "gemini_design_draft",
      arguments: {
        input: "Design a dashboard",
        cwd: dir,
        skip_generate: true,
        skip_prototype: true,
        skip_handoff: true,
      },
    });
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.status, "success");
    assert.match(parsed.run_dir, /\.gemini-agent\/design\//);
    const resources = await client.listResources();
    assert.ok(resources.resources.some((resource) => resource.uri === "gemini-agent://design/latest"));
    const latest = await client.readResource({ uri: "gemini-agent://design/latest" });
    assert.match(latest.contents[0].text, /design_draft_summary/);
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("mcp design draft rejects symlink reference escapes before credentials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-mcp-design-"));
  const outside = await mkdtemp(join(tmpdir(), "gemini-agent-mcp-design-outside-"));
  await writeFile(join(outside, "secret.png"), "secret");
  await symlink(join(outside, "secret.png"), join(dir, "linked.png"));
  const transport = new StdioClientTransport({
    command: "node",
    args: [new URL("../bin/gemini-agent-mcp", import.meta.url).pathname],
    cwd: dir,
    env: { ...process.env, GEMINI_API_KEY: "" },
  });
  const client = new Client({ name: "gemini-agent-test", version: "0.1.0" });
  await client.connect(transport);
  try {
    const result = await client.callTool({
      name: "gemini_design_draft",
      arguments: {
        input: "Design with reference",
        cwd: dir,
        references: ["linked.png"],
        skip_generate: true,
        skip_prototype: true,
        skip_handoff: true,
      },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Reference path must stay inside cwd/);
    assert.doesNotMatch(result.content[0].text, /Gemini API key/);
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run MCP tests and verify failure**

Run:

```bash
node --test test/mcp.test.mjs --test-name-pattern "design draft|design resource"
```

Expected: fail because the MCP tool/resource is missing.

- [ ] **Step 3: Implement MCP tool and resources**

Modify imports in `src/mcp-server.mjs`:

```js
import { runDesignDraft, validateDesignDraftModelPreflight } from "./design-draft.mjs";
import { resolveWorkspaceFilePath } from "./workspace-paths.mjs";
```

Add tool:

```js
server.registerTool(
  "gemini_design_draft",
  {
    title: "Gemini Design Draft",
    description: "Create a safe design draft run with isolated prototype and Codex handoff artifacts.",
    inputSchema: {
      input: z.string().min(1),
      cwd: z.string().optional(),
      references: z.array(z.string()).optional(),
      targets: z.array(z.string()).optional(),
      variants: z.number().int().positive().optional(),
      quality: z.enum(["fast", "pro"]).optional(),
      target_stack: z.enum(["html", "react", "tailwind", "auto"]).optional(),
      skip_generate: z.boolean().optional(),
      skip_perceive: z.boolean().optional(),
      skip_prototype: z.boolean().optional(),
      skip_handoff: z.boolean().optional(),
    },
  },
  async ({
    input,
    cwd,
    references = [],
    variants = 1,
    quality = "fast",
    target_stack = "html",
    skip_generate = false,
    skip_perceive = false,
    skip_prototype = false,
    skip_handoff = false,
  }) => {
    const cwdValue = cwd || process.cwd();
    for (const reference of references) {
      await resolveWorkspaceFilePath(reference, { cwd: cwdValue });
    }
    validateDesignDraftModelPreflight({ env: process.env, quality, skipGenerate: skip_generate });
    const fakeAllowed = allowFakeResponse();
    const apiKey = await requireApiKey();
    const result = await runDesignDraft({
      cwd: cwdValue,
      inputText: input,
      apiKey,
      env: process.env,
      variants,
      quality,
      targetStack: target_stack,
      skipGenerate: skip_generate,
      skipPerceive: skip_perceive,
      skipPrototype: skip_prototype,
      skipHandoff: skip_handoff,
      allowFakeResponse: fakeAllowed,
      telemetry: { cwd: cwdValue, source: "mcp", command: "design-draft" },
    });
    return textContent(`${JSON.stringify(result, null, 2)}\n`);
  },
);
```

Add `readLatestDesignSummary({ cwd })` to `src/design-draft.mjs`:

```js
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

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
```

Add resource:

```js
server.registerResource(
  "gemini_design_latest",
  "gemini-agent://design/latest",
  {
    title: "Latest Gemini Design Draft",
    description: "Latest local design draft summary generated by gemini-agent.",
    mimeType: "application/json",
  },
  async (uri) => {
    const summary = await readLatestDesignSummary({ cwd: process.cwd() });
    return jsonResource(uri.href, summary || missingResource("design draft"));
  },
);
```

- [ ] **Step 4: Run MCP tests**

Run:

```bash
node --test test/mcp.test.mjs --test-name-pattern "design draft|design resource"
```

Expected: all matching tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/mcp-server.mjs test/mcp.test.mjs
git commit -m "Expose design draft through MCP"
```

---

### Task 5: Active Policy And README

**Files:**
- Modify: `src/codex-global-install.mjs`
- Modify: `README.md`
- Test: `test/codex-global-install.test.mjs`
- Test: `test/package.test.mjs`

- [ ] **Step 1: Add failing documentation/policy tests**

Update `test/codex-global-install.test.mjs` active policy assertions:

```js
test("active policy names design draft routing and Codex execution boundary", () => {
  assert.match(ACTIVE_POLICY_BLOCK, /design draft/);
  assert.match(ACTIVE_POLICY_BLOCK, /UI, visual, product-page, prototype, layout, or design-system/);
  assert.match(ACTIVE_POLICY_BLOCK, /Codex remains the execution authority/);
});
```

Update `test/package.test.mjs` README assertions:

```js
assert.match(readme, /^\.\/bin\/gemini-agent design draft --stdin --variants 2 --quality fast --target-stack html$/m);
assert.match(readme, /`design draft` orchestrates brief, candidate generation, prototype, and handoff artifacts under `\.gemini-agent\/design\/<run-id>\/`/);
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
node --test test/codex-global-install.test.mjs test/package.test.mjs
```

Expected: fail because active policy and README do not mention `design draft`.

- [ ] **Step 3: Update active policy**

Modify `ACTIVE_POLICY_BLOCK` in `src/codex-global-install.mjs` by adding this bullet after `artifact-review`:

```md
- `design draft`: for UI, visual, product-page, prototype, layout, or design-system implementation tasks, ask gemini-agent to create a safe design draft before Codex edits the repository. The draft may include a design brief, image candidates, isolated prototype files, and Codex handoff artifacts under `.gemini-agent/design/<run-id>/`.
```

Add this paragraph before `Context-pack reuse`:

```md
Active design routing: when the task is to create or materially redesign a UI, page, product surface, prototype, or visual workflow, prefer `gemini-agent design draft` before source edits when project data policy permits external Gemini calls. If a relevant design run already exists, read its handoff or run `gemini-agent design handoff` instead of creating a duplicate draft. After Codex implementation, capture a screenshot and use `gemini-agent design loop` or `artifact-review` for target-vs-actual feedback.
```

- [ ] **Step 4: Update README**

Add command to README command list:

```bash
./bin/gemini-agent design draft --stdin --variants 2 --quality fast --target-stack html
```

Add safety/capability bullet near the design bullets:

```md
- `design draft` orchestrates brief, candidate generation, prototype, and handoff artifacts under `.gemini-agent/design/<run-id>/`; Codex still performs real repository edits, tests, commits, and final verification.
```

- [ ] **Step 5: Run docs/policy tests**

Run:

```bash
node --test test/codex-global-install.test.mjs test/package.test.mjs
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/codex-global-install.mjs README.md test/codex-global-install.test.mjs test/package.test.mjs
git commit -m "Route active design through gemini draft"
```

---

### Task 6: Telemetry And Summary Artifact Polish

**Files:**
- Modify: `src/design-draft.mjs`
- Test: `test/design-draft.test.mjs`

- [ ] **Step 1: Add failing telemetry test**

Add to `test/design-draft.test.mjs`:

```js
test("runDesignDraft captures aggregate design-draft telemetry", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "design-draft-"));
  const events = [];
  try {
    const result = await runDesignDraft({
      cwd,
      inputText: "Design a dashboard",
      apiKey: "key",
      env: { GEMINI_DESIGN_MODEL: "configured-design-model" },
      skipGenerate: true,
      skipPrototype: true,
      skipHandoff: true,
      telemetry: {
        cwd,
        source: "cli",
        command: "design-draft",
        capture: async (event) => events.push(event),
      },
      runners: { brief: () => makeBriefRun(cwd) },
    });
    assert.equal(result.status, "success");
    assert.equal(events.length, 1);
    assert.equal(events[0].command, "design-draft");
    assert.equal(events[0].status, "success");
    assert.equal(events[0].metadata.design_stage, "draft");
    assert.deepEqual(events[0].metadata.draft_steps_completed, ["brief", "generate", "perceive", "prototype", "handoff"]);
    assert.equal(events[0].metadata.actual_design_model, "configured-design-model");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run focused test and verify failure if telemetry metadata is incomplete**

Run:

```bash
node --test test/design-draft.test.mjs --test-name-pattern "telemetry"
```

Expected: fail if Task 2 did not implement the exact metadata.

- [ ] **Step 3: Adjust telemetry metadata**

In `src/design-draft.mjs`, ensure successful telemetry passes:

```js
metadata: {
  design_stage: "draft",
  draft_steps_requested: ["brief", "generate", "perceive", "prototype", "handoff"],
  draft_steps_completed: steps.map((item) => item.name),
  variants,
  quality,
  target_stack: targetStack,
  actual_design_model: models.design_model,
  actual_image_model: models.image_model,
  actual_image_pro_model: quality === "pro" ? models.image_pro_model : null,
  vision_banana_provider: env.VISION_BANANA_ENDPOINT ? "configured" : "missing",
}
```

For error telemetry, keep:

```js
metadata: {
  design_stage: "draft",
  draft_error: error.message,
  draft_steps_completed: steps.filter((item) => item.status === "success").map((item) => item.name),
}
```

- [ ] **Step 4: Run focused design draft tests**

Run:

```bash
node --test test/design-draft.test.mjs
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/design-draft.mjs test/design-draft.test.mjs
git commit -m "Capture design draft telemetry"
```

---

### Task 7: Full Verification And Review

**Files:**
- No new source files unless previous tasks expose failures.

- [ ] **Step 1: Run full test suite**

Run:

```bash
npm test
```

Expected: `fail 0`.

- [ ] **Step 2: Run whitespace check**

Run:

```bash
git diff --check
```

Expected: no output.

- [ ] **Step 3: Run Gemini diff review**

Run:

```bash
./bin/gemini-agent diff-review --smart-diff
```

Expected: JSON with `verdict` equal to `pass` or `caution`. If `block`, fix the blocking issues before continuing.

- [ ] **Step 4: Run local CLI smoke with fake response**

Run:

```bash
GEMINI_API_KEY=fake-key \
GEMINI_AGENT_ALLOW_FAKE_RESPONSE=1 \
GEMINI_AGENT_FAKE_RESPONSE='{"kind":"design_brief","run_id":"fake","goal":"Improve dashboard","target_user":"Operator","screens":[],"visual_direction":["quiet"],"design_system":{"tokens":[]},"accessibility":[],"responsive_requirements":[],"acceptance_criteria":[],"implementation_risks":[],"metadata":{}}' \
./bin/gemini-agent design draft "Design a dashboard" --skip-generate --skip-prototype --skip-handoff --json
```

Expected: JSON with `status: "success"` and a `.gemini-agent/design/` run path.

- [ ] **Step 5: Commit any verification-driven fixes**

If verification required fixes:

```bash
git add <changed-files>
git commit -m "Fix design draft verification issues"
```

If no fixes were needed, do not create an empty commit.

---

## Self-Review

Spec coverage:

- Active design workflow: Tasks 2 and 3.
- MCP exposure: Task 4.
- Active global policy: Task 5.
- README/operator docs: Task 5.
- Safety boundary and `.gemini-agent/` gitignore: Tasks 1, 2, and 4.
- Model preflight and missing image model guidance: Tasks 2 and 3.
- Telemetry for `design-draft`: Task 6.
- Full verification and Gemini review: Task 7.

Placeholder scan:

- No task contains `TBD`, `TODO`, `FIXME`, `??`, or an instruction to fill in unspecified details.

Type consistency:

- CLI uses camelCase internally: `targetStack`, `skipGenerate`, `skipPrototype`, `skipHandoff`.
- MCP uses snake_case inputs: `target_stack`, `skip_generate`, `skip_prototype`, `skip_handoff`.
- Orchestrator summary uses stable JSON keys: `run_id`, `run_dir`, `selected_candidate`, `model_routes`, `next_actions`.
