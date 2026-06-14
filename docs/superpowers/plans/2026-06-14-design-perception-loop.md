# Design Perception Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the MVP `gemini-agent design` workflow: brief, generate, perceive, prototype, handoff, loop, and doctor.

**Architecture:** Add focused design modules and keep `src/cli.mjs` as a thin parser/router. Reuse `palette-split` for the first Vision-Banana-inspired perception provider, reuse `artifact-review` for visual diff, and keep generated prototype code isolated under `.gemini-agent/design/<run-id>/prototype/`.

**Tech Stack:** Node.js 22 ESM, `node:test`, `zod`, `@google/genai`, `pngjs`, `jpeg-js`, existing keychain auth and telemetry capture.

---

## Scope Check

This plan implements the MVP from `docs/superpowers/specs/2026-06-14-design-perception-loop-design.md`. It covers one cohesive workflow, not separate products:

1. design artifact/run storage;
2. model routing, cost gates, and doctor;
3. structured design brief/prototype/handoff generation;
4. Nano Banana candidate image generation;
5. palette-mask-backed perception;
6. manual screenshot design loop.

Browser screenshot automation and a real Vision Banana endpoint remain behind configured providers. The MVP must fail clearly when those providers are unavailable.

Model policy: default text/design calls stay on the project default `gemini-3.5-flash`. A stronger design-director model, such as an available 3.1 Pro model ID, is enabled only through `GEMINI_DESIGN_MODEL`; image/Nano-Banana-style generation is enabled only through `GEMINI_IMAGE_MODEL` or `GEMINI_IMAGE_PRO_MODEL`.

## File Structure

Create:

- `src/design-schemas.mjs`: all zod schemas and pretty JSON helpers for design brief, candidate manifests, perception, prototype manifest, handoff, loop review, and doctor.
- `src/design-run-store.mjs`: safe run id generation, path containment, atomic run directory creation, JSON writes, and prototype file writes.
- `src/design-model-router.mjs`: resolves design/image/pro routes from env, validates fallback capability, exposes doctor-safe model state.
- `src/design-costs.mjs`: bundled conservative cost estimates plus env/config override parsing for `--max-cost-usd`.
- `src/design-image-dimensions.mjs`: PNG/JPEG/WEBP dimension extraction with safe null-coordinate degradation.
- `src/design-brief.mjs`: builds brief prompt, calls Gemini structured JSON, writes `brief.json` and `DESIGN.md`.
- `src/design-generate.mjs`: calls Gemini image models, extracts inline images, writes candidates and `candidates/manifest.json`.
- `src/design-perceive.mjs`: provider selection, `palette-mask` adapter, `gemini-vision` structured perception, unconfigured `vision-banana` error.
- `src/design-prototype.mjs`: isolated preview code generation, manifest validation, atomic prototype directory writes.
- `src/design-handoff.mjs`: structured handoff generation and `codex-tasks.md`.
- `src/design-loop.mjs`: manual screenshot loop, resumable checklist output, `artifact-review` comparison, loop review.

Modify:

- `src/gemini-client.mjs`: export design-specific structured generation functions and image generation helper using existing telemetry conventions.
- `src/cli.mjs`: add `design` command parsing and dispatch.
- `README.md`: document the new design commands and model routing.

Tests:

- `test/design-schemas.test.mjs`
- `test/design-run-store.test.mjs`
- `test/design-model-router.test.mjs`
- `test/design-costs.test.mjs`
- `test/design-image-dimensions.test.mjs`
- `test/design-brief.test.mjs`
- `test/design-generate.test.mjs`
- `test/design-perceive.test.mjs`
- `test/design-prototype.test.mjs`
- `test/design-handoff.test.mjs`
- `test/design-loop.test.mjs`
- update `test/cli.test.mjs`
- update `test/gemini-client.test.mjs`
- update `test/package.test.mjs`

---

### Task 1: Design Schemas

**Files:**
- Create: `src/design-schemas.mjs`
- Test: `test/design-schemas.test.mjs`

- [ ] **Step 1: Write failing schema tests**

Create `test/design-schemas.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import {
  GeminiDesignBriefSchema,
  GeminiDesignHandoffSchema,
  GeminiDesignPrototypeResponseSchema,
  normalizeDesignBrief,
  normalizeDesignCandidateManifest,
  normalizeDesignHandoff,
  normalizeDesignLoopReview,
  normalizeDesignPerception,
  normalizeDesignPrototypeManifest,
} from "../src/design-schemas.mjs";

test("normalizes a design brief with required fields", () => {
  const brief = normalizeDesignBrief({
    kind: "design_brief",
    run_id: "20260614T120000Z-abc123",
    goal: "Improve the telemetry dashboard.",
    target_user: "Product operator",
    screens: [{ id: "admin", purpose: "Review usage" }],
    visual_direction: ["quiet", "dense", "clear"],
    design_system: { tokens: [{ name: "--surface", value: "#ffffff" }] },
    accessibility: ["AA contrast"],
    responsive_requirements: ["Works at 390px and 1440px"],
    acceptance_criteria: ["Dashboard shows key reliability metrics"],
    implementation_risks: ["Existing admin CSS may be shared"],
    metadata: { model: "configured-design-model", generated_at: "2026-06-14T12:00:00.000Z" },
  });
  assert.equal(brief.kind, "design_brief");
  assert.equal(brief.screens[0].id, "admin");
});

test("normalizes perception with nullable normalized coordinates", () => {
  const perception = normalizeDesignPerception({
    kind: "design_perception",
    run_id: "20260614T120000Z-abc123",
    provider: "palette-mask",
    source: "candidate-a.png",
    regions: [{
      id: "hero",
      label: "Hero",
      role: "main content",
      importance: 1,
      bbox: { x: 0.1, y: 0.2, width: 0.8, height: 0.3 },
      mask_ref: "layers/hero.png",
      confidence: 0.8,
    }],
    hierarchy: ["hero"],
    layout_observations: ["Hero spans most of the viewport"],
    implementation_constraints: ["Use existing card component"],
    confidence: 0.7,
    warnings: [],
  });
  assert.equal(perception.regions[0].bbox.width, 0.8);
});

test("rejects out-of-range perception coordinates", () => {
  assert.throws(() => normalizeDesignPerception({
    kind: "design_perception",
    run_id: "20260614T120000Z-abc123",
    provider: "gemini-vision",
    source: "screen.png",
    regions: [{
      id: "bad",
      label: "Bad",
      role: "unknown",
      importance: 1,
      bbox: { x: 2, y: 0, width: 1, height: 1 },
      mask_ref: null,
      confidence: 0.5,
    }],
    hierarchy: [],
    layout_observations: [],
    implementation_constraints: [],
    confidence: 0.5,
    warnings: [],
  }), /Invalid design perception JSON/);
});

test("exports Gemini response schemas for live design calls", () => {
  assert.equal(GeminiDesignBriefSchema.properties.kind.enum[0], "design_brief");
  assert.ok(GeminiDesignPrototypeResponseSchema.properties.manifest);
  assert.equal(GeminiDesignHandoffSchema.properties.kind.enum[0], "design_handoff");
});

test("normalizes candidate manifest, prototype manifest, handoff, and loop review", () => {
  const candidates = normalizeDesignCandidateManifest({
    kind: "design_candidates",
    run_id: "20260614T120000Z-abc123",
    candidates: [{
      id: "candidate-a",
      file: "candidate-a.png",
      model: "configured-image-model",
      prompt_hash: "abc",
      status: "success",
      image_size: "1K",
      aspect_ratio: "16:9",
      warnings: [],
    }],
  });
  assert.equal(candidates.candidates[0].status, "success");

  const prototype = normalizeDesignPrototypeManifest({
    kind: "design_prototype",
    run_id: "20260614T120000Z-abc123",
    selected_candidate: "candidate-a",
    target_stack: "html",
    model: "configured-design-model",
    files: ["preview.html", "review-notes.md"],
    preview_entry: "preview.html",
    review_notes: ["Static preview only"],
    limitations: ["Not production source"],
    integration_recommendation: "Use as a visual reference.",
  });
  assert.equal(prototype.preview_entry, "preview.html");

  const handoff = normalizeDesignHandoff({
    kind: "design_handoff",
    run_id: "20260614T120000Z-abc123",
    selected_candidate: "candidate-a",
    implementation_summary: "Update dashboard layout.",
    file_hints: ["src/AdminDashboard.tsx"],
    component_tasks: ["Add reliability summary"],
    style_tokens: [{ name: "--surface", value: "#ffffff" }],
    responsive_tasks: ["Verify at 390px"],
    asset_tasks: [],
    verification: ["npm test"],
    open_questions: [],
    risk_notes: [],
  });
  assert.equal(handoff.verification[0], "npm test");

  const loopReview = normalizeDesignLoopReview({
    kind: "design_loop_review",
    run_id: "20260614T120000Z-abc123",
    iteration: 1,
    target_screenshot: "candidate-a.png",
    actual_screenshot: "after.png",
    status: "reviewed",
    summary: ["Close match"],
    next_actions: [],
    artifact_review: { verdict: "pass" },
  });
  assert.equal(loopReview.status, "reviewed");
});
```

- [ ] **Step 2: Run failing schema test**

Run: `node --test test/design-schemas.test.mjs`

Expected: FAIL with `Cannot find module '../src/design-schemas.mjs'`.

- [ ] **Step 3: Implement schemas**

Create `src/design-schemas.mjs`:

```js
import { Type } from "@google/genai";
import { z } from "zod";

const Kind = (value) => z.literal(value);
const NonEmptyString = z.string().trim().min(1);
const StringList = z.array(NonEmptyString).default([]);
const RunId = z.string().regex(/^[0-9TzZ._-]+-[A-Za-z0-9]{6,}$/);
const NullableUnitNumber = z.number().min(0).max(1).nullable();
const Metadata = z.object({
  model: z.string().optional(),
  generated_at: z.string().optional(),
}).passthrough().default({});

const GeminiStringArraySchema = { type: Type.ARRAY, items: { type: Type.STRING } };
const GeminiTokenSchema = {
  type: Type.OBJECT,
  properties: {
    name: { type: Type.STRING },
    value: { type: Type.STRING },
  },
  required: ["name", "value"],
};
const GeminiMetadataSchema = {
  type: Type.OBJECT,
  properties: {
    model: { type: Type.STRING },
    generated_at: { type: Type.STRING },
  },
  required: ["model", "generated_at"],
};
const GeminiDesignSystemSchema = {
  type: Type.OBJECT,
  properties: {
    tokens: { type: Type.ARRAY, items: GeminiTokenSchema },
  },
  required: ["tokens"],
};

export const GeminiDesignBriefSchema = {
  type: Type.OBJECT,
  properties: {
    kind: { type: Type.STRING, enum: ["design_brief"] },
    run_id: { type: Type.STRING },
    goal: { type: Type.STRING },
    target_user: { type: Type.STRING },
    screens: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          purpose: { type: Type.STRING },
        },
        required: ["id", "purpose"],
      },
    },
    visual_direction: GeminiStringArraySchema,
    design_system: GeminiDesignSystemSchema,
    accessibility: GeminiStringArraySchema,
    responsive_requirements: GeminiStringArraySchema,
    acceptance_criteria: GeminiStringArraySchema,
    implementation_risks: GeminiStringArraySchema,
    metadata: GeminiMetadataSchema,
  },
  required: [
    "kind",
    "run_id",
    "goal",
    "target_user",
    "screens",
    "visual_direction",
    "design_system",
    "accessibility",
    "responsive_requirements",
    "acceptance_criteria",
    "implementation_risks",
    "metadata",
  ],
};

export const GeminiDesignPrototypeManifestSchema = {
  type: Type.OBJECT,
  properties: {
    kind: { type: Type.STRING, enum: ["design_prototype"] },
    run_id: { type: Type.STRING },
    selected_candidate: { type: Type.STRING, nullable: true },
    target_stack: { type: Type.STRING, enum: ["html", "react", "tailwind", "auto"] },
    model: { type: Type.STRING },
    files: GeminiStringArraySchema,
    preview_entry: { type: Type.STRING },
    review_notes: GeminiStringArraySchema,
    limitations: GeminiStringArraySchema,
    integration_recommendation: { type: Type.STRING },
  },
  required: [
    "kind",
    "run_id",
    "selected_candidate",
    "target_stack",
    "model",
    "files",
    "preview_entry",
    "review_notes",
    "limitations",
    "integration_recommendation",
  ],
};

export const GeminiDesignPrototypeResponseSchema = {
  type: Type.OBJECT,
  properties: {
    manifest: GeminiDesignPrototypeManifestSchema,
    files: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          path: { type: Type.STRING },
          content: { type: Type.STRING },
        },
        required: ["path", "content"],
      },
    },
  },
  required: ["manifest", "files"],
};

export const GeminiDesignHandoffSchema = {
  type: Type.OBJECT,
  properties: {
    kind: { type: Type.STRING, enum: ["design_handoff"] },
    run_id: { type: Type.STRING },
    selected_candidate: { type: Type.STRING, nullable: true },
    implementation_summary: { type: Type.STRING },
    file_hints: GeminiStringArraySchema,
    component_tasks: GeminiStringArraySchema,
    style_tokens: { type: Type.ARRAY, items: GeminiTokenSchema },
    responsive_tasks: GeminiStringArraySchema,
    asset_tasks: GeminiStringArraySchema,
    verification: GeminiStringArraySchema,
    open_questions: GeminiStringArraySchema,
    risk_notes: GeminiStringArraySchema,
  },
  required: [
    "kind",
    "run_id",
    "selected_candidate",
    "implementation_summary",
    "file_hints",
    "component_tasks",
    "style_tokens",
    "responsive_tasks",
    "asset_tasks",
    "verification",
    "open_questions",
    "risk_notes",
  ],
};

const BBox = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().min(0).max(1),
  height: z.number().min(0).max(1),
});

const Region = z.object({
  id: NonEmptyString,
  label: NonEmptyString,
  role: NonEmptyString,
  importance: z.number().min(0).max(1),
  bbox: BBox.nullable(),
  mask_ref: z.string().nullable().default(null),
  confidence: NullableUnitNumber.default(null),
});

export const DesignBriefZodSchema = z.object({
  kind: Kind("design_brief"),
  run_id: RunId,
  goal: NonEmptyString,
  target_user: NonEmptyString,
  screens: z.array(z.object({
    id: NonEmptyString,
    purpose: NonEmptyString,
  })).default([]),
  visual_direction: StringList,
  design_system: z.object({
    tokens: z.array(z.object({
      name: NonEmptyString,
      value: NonEmptyString,
    })).default([]),
  }).passthrough().default({ tokens: [] }),
  accessibility: StringList,
  responsive_requirements: StringList,
  acceptance_criteria: StringList,
  implementation_risks: StringList,
  metadata: Metadata,
});

export const DesignCandidateManifestZodSchema = z.object({
  kind: Kind("design_candidates"),
  run_id: RunId,
  candidates: z.array(z.object({
    id: NonEmptyString,
    file: NonEmptyString,
    model: NonEmptyString,
    prompt_hash: NonEmptyString,
    status: z.enum(["success", "failed"]),
    image_size: z.string().nullable().default(null),
    aspect_ratio: z.string().nullable().default(null),
    warnings: StringList,
  })).default([]),
});

export const DesignPerceptionZodSchema = z.object({
  kind: Kind("design_perception"),
  run_id: RunId,
  provider: z.enum(["palette-mask", "gemini-vision", "vision-banana"]),
  source: NonEmptyString,
  regions: z.array(Region).default([]),
  hierarchy: StringList,
  layout_observations: StringList,
  implementation_constraints: StringList,
  confidence: NullableUnitNumber.default(null),
  warnings: StringList,
});

export const DesignPrototypeManifestZodSchema = z.object({
  kind: Kind("design_prototype"),
  run_id: RunId,
  selected_candidate: z.string().nullable().default(null),
  target_stack: z.enum(["html", "react", "tailwind", "auto"]),
  model: NonEmptyString,
  files: z.array(NonEmptyString).default([]),
  preview_entry: NonEmptyString,
  review_notes: StringList,
  limitations: StringList,
  integration_recommendation: NonEmptyString,
});

export const DesignHandoffZodSchema = z.object({
  kind: Kind("design_handoff"),
  run_id: RunId,
  selected_candidate: z.string().nullable().default(null),
  implementation_summary: NonEmptyString,
  file_hints: StringList,
  component_tasks: StringList,
  style_tokens: z.array(z.object({
    name: NonEmptyString,
    value: NonEmptyString,
  })).default([]),
  responsive_tasks: StringList,
  asset_tasks: StringList,
  verification: StringList,
  open_questions: StringList,
  risk_notes: StringList,
});

export const DesignLoopReviewZodSchema = z.object({
  kind: Kind("design_loop_review"),
  run_id: RunId,
  iteration: z.number().int().min(1).max(3),
  target_screenshot: z.string().nullable().default(null),
  actual_screenshot: z.string().nullable().default(null),
  status: z.enum(["needs_screenshot", "reviewed"]),
  summary: StringList,
  next_actions: StringList,
  artifact_review: z.record(z.string(), z.unknown()).nullable().default(null),
});

function normalizeWith(schema, value, label) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`Invalid ${label} JSON: ${parsed.error.message}`);
  return parsed.data;
}

export function normalizeDesignBrief(value) {
  return normalizeWith(DesignBriefZodSchema, value, "design brief");
}

export function normalizeDesignCandidateManifest(value) {
  return normalizeWith(DesignCandidateManifestZodSchema, value, "design candidate manifest");
}

export function normalizeDesignPerception(value) {
  return normalizeWith(DesignPerceptionZodSchema, value, "design perception");
}

export function normalizeDesignPrototypeManifest(value) {
  return normalizeWith(DesignPrototypeManifestZodSchema, value, "design prototype manifest");
}

export function normalizeDesignHandoff(value) {
  return normalizeWith(DesignHandoffZodSchema, value, "design handoff");
}

export function normalizeDesignLoopReview(value) {
  return normalizeWith(DesignLoopReviewZodSchema, value, "design loop review");
}

export function designJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}
```

- [ ] **Step 4: Verify schema tests pass**

Run: `node --test test/design-schemas.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit schemas**

```bash
git add src/design-schemas.mjs test/design-schemas.test.mjs
git commit -m "Add design workflow schemas"
```

### Task 2: Run Store And Safe Artifact Layout

**Files:**
- Create: `src/design-run-store.mjs`
- Test: `test/design-run-store.test.mjs`

- [ ] **Step 1: Write failing run-store tests**

Create `test/design-run-store.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  assertPrototypeRelativePath,
  createDesignRun,
  designRunRoot,
  readDesignRunId,
  resolveDesignRun,
  safeRunId,
  writeDesignJson,
  writePrototypeFiles,
} from "../src/design-run-store.mjs";

test("creates unique run directories under .gemini-agent/design", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "design-run-store-"));
  try {
    const first = await createDesignRun({ cwd, now: new Date("2026-06-14T12:00:00.000Z"), random: () => "abcdef" });
    const second = await createDesignRun({ cwd, now: new Date("2026-06-14T12:00:00.000Z"), random: () => "abcdeg" });
    assert.match(first.runId, /^20260614T120000000Z-[A-Za-z0-9]{6,}$/);
    assert.notEqual(first.runId, second.runId);
    assert.equal(relative(designRunRoot(cwd), first.dir).startsWith(".."), false);
    assert.equal(await readDesignRunId(first.dir), first.runId);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("rejects unsafe run ids and escaping paths", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "design-run-store-"));
  try {
    assert.throws(() => safeRunId("../bad"), /Unsafe design run id/);
    assert.throws(() => safeRunId("20260614T120000000Z-abc/def"), /Unsafe design run id/);
    assert.throws(() => safeRunId("20260614T120000000Z-abc\u0000def"), /Unsafe design run id/);
    assert.throws(() => resolveDesignRun({ cwd, run: "../outside" }), /Design run path must stay/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("writes JSON artifacts and prototype files atomically", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "design-run-store-"));
  try {
    const run = await createDesignRun({ cwd, now: new Date("2026-06-14T12:00:00.000Z"), random: () => "abcdef" });
    await writeDesignJson({ runDir: run.dir, relativePath: "brief.json", value: { run_id: run.runId, ok: true } });
    assert.deepEqual(JSON.parse(await readFile(join(run.dir, "brief.json"), "utf8")), { run_id: run.runId, ok: true });
    assert.equal(await readDesignRunId(run.dir), run.runId);

    await writePrototypeFiles({
      runDir: run.dir,
      files: {
        "preview.html": "<!doctype html><title>Preview</title>",
        "review-notes.md": "# Review\n",
      },
    });
    assert.deepEqual((await readdir(join(run.dir, "prototype"))).sort(), ["preview.html", "review-notes.md"]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("prototype relative paths cannot escape prototype directory", () => {
  assert.equal(assertPrototypeRelativePath("preview.html"), "preview.html");
  assert.throws(() => assertPrototypeRelativePath("../src/app.js"), /Prototype file path must stay/);
  assert.throws(() => assertPrototypeRelativePath("/tmp/preview.html"), /Prototype file path must stay/);
});
```

- [ ] **Step 2: Run failing run-store test**

Run: `node --test test/design-run-store.test.mjs`

Expected: FAIL with `Cannot find module '../src/design-run-store.mjs'`.

- [ ] **Step 3: Implement run store**

Create `src/design-run-store.mjs`:

```js
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

const DESIGN_ROOT = join(".gemini-agent", "design");
const RUN_ID_PATTERN = /^[0-9TzZ._-]+-[A-Za-z0-9]{6,}$/;

function stamp(now) {
  return now.toISOString().replace(/[-:]/g, "").replace(".", "");
}

function randomSuffix(random) {
  return random().toString(36).replace(/[^A-Za-z0-9]/g, "").slice(0, 8).padEnd(6, "0");
}

export function designRunRoot(cwd = process.cwd()) {
  return resolve(cwd, DESIGN_ROOT);
}

function assertContained(root, candidate, message) {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const rel = relative(resolvedRoot, resolvedCandidate);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(message);
  }
  return resolvedCandidate;
}

export function safeRunId(value) {
  const runId = String(value ?? "").trim();
  if (
    !RUN_ID_PATTERN.test(runId)
    || runId.includes("..")
    || /[\u0000-\u001f]/u.test(runId)
  ) {
    throw new Error("Unsafe design run id.");
  }
  return runId;
}

export function resolveDesignRun({ cwd = process.cwd(), run }) {
  const root = designRunRoot(cwd);
  const candidate = run && String(run).includes(sep)
    ? resolve(cwd, run)
    : resolve(root, safeRunId(run));
  return assertContained(root, candidate, "Design run path must stay under .gemini-agent/design.");
}

export async function readDesignRunId(runDir) {
  const brief = await readFile(resolve(runDir, "brief.json"), "utf8")
    .then((text) => JSON.parse(text))
    .catch(() => null);
  if (brief?.run_id) return safeRunId(brief.run_id);
  return safeRunId(basename(resolve(runDir)));
}

export async function createDesignRun({ cwd = process.cwd(), now = new Date(), random = Math.random } = {}) {
  const root = designRunRoot(cwd);
  await mkdir(root, { recursive: true });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const suffix = attempt === 0 ? randomSuffix(random) : `${randomSuffix(random)}${attempt}`;
    const runId = safeRunId(`${stamp(now)}Z-${suffix}`);
    const dir = resolve(root, runId);
    assertContained(root, dir, "Design run path must stay under .gemini-agent/design.");
    try {
      await mkdir(dir, { recursive: false });
      return { runId, dir };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  throw new Error("Unable to create a unique design run directory.");
}

export async function writeDesignJson({ runDir, relativePath, value }) {
  const target = assertContained(runDir, resolve(runDir, relativePath), "Design artifact path must stay inside the run directory.");
  await mkdir(resolve(target, ".."), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`);
  return target;
}

export function assertPrototypeRelativePath(path) {
  const value = String(path ?? "").trim();
  if (!value || /[\u0000-\u001f]/u.test(value)) {
    throw new Error("Prototype file path must stay under prototype/.");
  }
  const prototypeRoot = resolve("/", "__prototype__");
  const resolved = resolve(prototypeRoot, value);
  const rel = relative(prototypeRoot, resolved);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("Prototype file path must stay under prototype/.");
  }
  return rel;
}

export async function writePrototypeFiles({ runDir, files }) {
  const prototypeDir = resolve(runDir, "prototype");
  const tmpDir = resolve(runDir, `prototype.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(tmpDir, { recursive: true });
  try {
    for (const [name, body] of Object.entries(files)) {
      const safeName = assertPrototypeRelativePath(name);
      const target = resolve(tmpDir, safeName);
      await mkdir(resolve(target, ".."), { recursive: true });
      await writeFile(target, String(body));
    }
    await rm(prototypeDir, { recursive: true, force: true });
    await rename(tmpDir, prototypeDir);
  } catch (error) {
    await rm(tmpDir, { recursive: true, force: true });
    throw error;
  }
  return prototypeDir;
}
```

- [ ] **Step 4: Verify run-store tests pass**

Run: `node --test test/design-run-store.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit run store**

```bash
git add src/design-run-store.mjs test/design-run-store.test.mjs
git commit -m "Add design run artifact store"
```

### Task 3: Model Router And Cost Gates

**Files:**
- Create: `src/design-model-router.mjs`
- Create: `src/design-costs.mjs`
- Test: `test/design-model-router.test.mjs`
- Test: `test/design-costs.test.mjs`

- [ ] **Step 1: Write failing router and cost tests**

Create `test/design-model-router.test.mjs`:

```js
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
  assert.throws(() => validateDesignFallback({ multimodal: false, structuredOutput: true }), /multimodal/);
  assert.throws(() => validateDesignFallback({ multimodal: true, structuredOutput: false }), /structured/);
});

test("doctor reports safe model state without secrets", async () => {
  const report = await designDoctor({
    env: { GEMINI_DESIGN_MODEL: "custom-design" },
    probe: async (model) => ({ ok: model === "custom-design", status: "ok" }),
  });
  assert.equal(report.models.design_model, "custom-design");
  assert.equal(report.probes.design_model.ok, true);
  assert.doesNotMatch(JSON.stringify(report), /AIza|secret|token/i);
});
```

Create `test/design-costs.test.mjs`:

```js
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
          "custom-model": { input_per_million: 2, output_per_million: 8, image_per_unit: 0.05 },
        },
      }),
    },
  });
  assert.equal(pricing.models["custom-model"].image_per_unit, 0.05);
  assert.ok(pricing.models["gemini-3.5-flash"]);
});

test("estimates cost from token and image units", () => {
  const pricing = loadDesignPricing({
    env: {
      GEMINI_AGENT_DESIGN_PRICING_JSON: JSON.stringify({
        models: {
          "configured-image-model": { input_per_million: 2, output_per_million: 8, image_per_unit: 0.05 },
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
  assert.ok(estimate.usd > 0);
  assert.equal(estimate.unknown, false);
});

test("budget gate fails closed on unknown cost unless allowed", () => {
  assert.throws(() => assertDesignBudget({
    estimate: { usd: null, unknown: true },
    maxCostUsd: 1,
    allowUnknownCost: false,
  }), /unknown cost/);
  assert.equal(assertDesignBudget({
    estimate: { usd: null, unknown: true },
    maxCostUsd: 1,
    allowUnknownCost: true,
  }), true);
});

test("budget gate blocks estimates above max", () => {
  assert.throws(() => assertDesignBudget({
    estimate: { usd: 2, unknown: false },
    maxCostUsd: 1,
    allowUnknownCost: false,
  }), /exceeds/);
});
```

- [ ] **Step 2: Run failing router and cost tests**

Run: `node --test test/design-model-router.test.mjs test/design-costs.test.mjs`

Expected: FAIL with missing modules.

- [ ] **Step 3: Implement router**

Create `src/design-model-router.mjs`:

```js
import { DEFAULT_GEMINI_MODEL } from "./gemini-client.mjs";

export const DEFAULT_DESIGN_MODEL = DEFAULT_GEMINI_MODEL;

export function resolveDesignModels({ env = process.env } = {}) {
  return {
    default_model: env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL,
    design_model: env.GEMINI_DESIGN_MODEL || DEFAULT_DESIGN_MODEL,
    image_model: env.GEMINI_IMAGE_MODEL || null,
    image_pro_model: env.GEMINI_IMAGE_PRO_MODEL || null,
  };
}

export function validateDesignFallback(capabilities) {
  if (!capabilities?.multimodal) throw new Error("Fallback design model must support multimodal input.");
  if (!capabilities?.structuredOutput) throw new Error("Fallback design model must support structured output.");
  return true;
}

export async function designDoctor({ env = process.env, probe = async () => ({ ok: null, status: "not_probed" }) } = {}) {
  const models = resolveDesignModels({ env });
  const probes = {};
  for (const [key, model] of Object.entries({
    design_model: models.design_model,
    image_model: models.image_model,
    image_pro_model: models.image_pro_model,
  })) {
    probes[key] = await probe(model);
  }
  return {
    ok: Object.values(probes).every((item) => item.ok !== false),
    models,
    probes,
    required_env: {
      gemini_auth: "keychain or GEMINI_API_KEY",
      image_model: models.image_model ? "present" : "missing",
      vision_banana_endpoint: env.VISION_BANANA_ENDPOINT ? "present" : "missing",
    },
  };
}
```

- [ ] **Step 4: Implement cost gates**

Create `src/design-costs.mjs`:

```js
const BUNDLED_PRICING = {
  models: {
    "gemini-3.5-flash": { input_per_million: 1, output_per_million: 3, image_per_unit: 0 },
  },
};

export function loadDesignPricing({ env = process.env } = {}) {
  const overrideText = env.GEMINI_AGENT_DESIGN_PRICING_JSON;
  if (!overrideText) return BUNDLED_PRICING;
  let override;
  try {
    override = JSON.parse(overrideText);
  } catch {
    return BUNDLED_PRICING;
  }
  return {
    models: {
      ...BUNDLED_PRICING.models,
      ...(override.models && typeof override.models === "object" ? override.models : {}),
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
  const row = pricing.models?.[model];
  if (!row) return { usd: null, unknown: true, model };
  const usd = (inputTokens / 1_000_000) * row.input_per_million
    + (outputTokens / 1_000_000) * row.output_per_million
    + imageUnits * row.image_per_unit;
  return { usd, unknown: false, model };
}

export function assertDesignBudget({ estimate, maxCostUsd, allowUnknownCost = false }) {
  if (maxCostUsd == null) return true;
  if (estimate.unknown) {
    if (allowUnknownCost) return true;
    throw new Error("Design cost estimate has unknown cost; pass --allow-unknown-cost to continue.");
  }
  if (estimate.usd > maxCostUsd) {
    throw new Error(`Estimated design cost ${estimate.usd.toFixed(4)} exceeds budget ${maxCostUsd}.`);
  }
  return true;
}
```

- [ ] **Step 5: Verify router and cost tests pass**

Run: `node --test test/design-model-router.test.mjs test/design-costs.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit router and cost gates**

```bash
git add src/design-model-router.mjs src/design-costs.mjs test/design-model-router.test.mjs test/design-costs.test.mjs
git commit -m "Add design model routing and cost gates"
```

### Task 4: Gemini Client Design Helpers

**Files:**
- Modify: `src/gemini-client.mjs`
- Test: `test/gemini-client.test.mjs`

- [ ] **Step 1: Verify local SDK image generation surface**

Run:

```bash
rg -n "generateImages" node_modules/@google/genai/dist/node/node.d.ts
```

Expected: command passes. Use `ai.models.generateImages` for text-to-image generation; keep `generateContent` only for structured JSON/text calls.

- [ ] **Step 2: Add failing tests for model-specific design calls**

Append to `test/gemini-client.test.mjs`:

```js
test("generateDesignJson uses caller model and structured schema", async () => {
  let seenRequest;
  const result = await generateDesignJson({
    apiKey: "key",
    model: "configured-design-model",
    prompt: "Return design brief JSON",
    responseSchema: {
      type: "object",
      properties: { kind: { type: "string" } },
      required: ["kind"],
    },
    normalize: (value) => value,
    makeAi: () => ({
      models: {
        async generateContent(request) {
          seenRequest = request;
          return { text: JSON.stringify({ kind: "design_brief" }) };
        },
      },
    }),
  });
  assert.equal(result.kind, "design_brief");
  assert.equal(seenRequest.model, "configured-design-model");
  assert.equal(seenRequest.config.responseMimeType, "application/json");
});

test("generateDesignImage extracts first inline image", async () => {
  let seenRequest;
  const image = await generateDesignImage({
    apiKey: "key",
    model: "configured-image-model",
    contents: "draw",
    makeAi: () => ({
      models: {
        async generateImages(request) {
          seenRequest = request;
          return {
            generatedImages: [{
              image: {
                mimeType: "image/png",
                imageBytes: Buffer.from("png").toString("base64"),
              },
            }],
          };
        },
      },
    }),
  });
  assert.equal(seenRequest.model, "configured-image-model");
  assert.equal(seenRequest.prompt, "draw");
  assert.equal(image.mimeType, "image/png");
  assert.equal(image.buffer.toString("utf8"), "png");
});
```

Also update the import list in that test file to include:

```js
import {
  generateDesignImage,
  generateDesignJson,
} from "../src/gemini-client.mjs";
```

- [ ] **Step 3: Run failing client tests**

Run: `node --test test/gemini-client.test.mjs --test-name-pattern "generateDesign"`

Expected: FAIL with missing exports.

- [ ] **Step 4: Export design helpers from Gemini client**

Modify `src/gemini-client.mjs` by exporting a design-specific structured helper near `generateJson`:

```js
export async function generateDesignJson({
  apiKey,
  model,
  prompt,
  contents = prompt,
  env = process.env,
  allowFakeResponse = false,
  makeAi = makeGoogleGenAI,
  temperature = 0.2,
  telemetry,
  responseSchema,
  normalize,
  maxOutputTokens,
}) {
  return generateJson({
    apiKey,
    prompt,
    contents,
    env,
    allowFakeResponse,
    makeAi,
    temperature,
    telemetry,
    responseSchema,
    normalize,
    maxOutputTokens,
    model,
  });
}
```

Then adjust the private `generateJson` signature to accept `model`, and replace the existing request model value:

```js
model = getDefaultModel(),
```

and:

```js
model,
```

instead of:

```js
model: getDefaultModel(),
```

Do not change existing callers. Their default model remains `getDefaultModel()`.

Add the image helper near `generateText`:

```js
function imageFromGenerateImagesResponse(response) {
  const image = response?.generatedImages?.find((item) => item?.image?.imageBytes)?.image;
  if (image?.imageBytes) {
    return {
      mimeType: image.mimeType || "image/png",
      buffer: Buffer.from(image.imageBytes, "base64"),
    };
  }
  throw new Error("Gemini response did not include an image.");
}

export async function generateDesignImage({
  apiKey,
  model,
  contents,
  makeAi = makeGoogleGenAI,
  telemetry,
}) {
  if (!apiKey) throw new Error("Gemini API key is missing.");
  if (!model) throw new Error("Design image model is required.");
  const started = Date.now();
  try {
    const ai = makeAi(apiKey);
    const response = await ai.models.generateImages({
      model,
      prompt: typeof contents === "string" ? contents : String(contents ?? ""),
      config: { numberOfImages: 1 },
    });
    const image = imageFromGenerateImagesResponse(response);
    await captureTelemetry(telemetry, {
      command: "design-generate",
      prompt: typeof contents === "string" ? contents : "",
      response: `[image:${image.mimeType}:${image.buffer.length}]`,
      status: "success",
      latencyMs: Date.now() - started,
      contents: typeof contents === "string" ? [contents] : contents,
      economics: usageMetadataFromResponse(response),
      metadata: withGeminiGenerationLatency({ actual_model: model }, Date.now() - started),
    });
    return image;
  } catch (error) {
    await captureTelemetry(telemetry, {
      command: "design-generate",
      prompt: typeof contents === "string" ? contents : "",
      response: "",
      status: "error",
      errorType: errorType(error),
      latencyMs: Date.now() - started,
      contents: typeof contents === "string" ? [contents] : contents,
      metadata: withGeminiGenerationLatency({ actual_model: model }, Date.now() - started),
    }, { awaitCapture: true });
    throw requestError(error, apiKey);
  }
}
```

- [ ] **Step 5: Verify design client tests pass**

Run: `node --test test/gemini-client.test.mjs --test-name-pattern "generateDesign"`

Expected: PASS.

- [ ] **Step 6: Run full client tests**

Run: `node --test test/gemini-client.test.mjs`

Expected: PASS.

- [ ] **Step 7: Commit design client helpers**

```bash
git add src/gemini-client.mjs test/gemini-client.test.mjs
git commit -m "Add design Gemini client helpers"
```

### Task 5: Design Brief Command

**Files:**
- Create: `src/design-brief.mjs`
- Modify: `src/cli.mjs`
- Modify: `README.md`
- Test: `test/design-brief.test.mjs`
- Modify: `test/cli.test.mjs`
- Modify: `test/package.test.mjs`

- [ ] **Step 1: Write failing brief tests**

Create `test/design-brief.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDesignBrief } from "../src/design-brief.mjs";

test("runDesignBrief writes brief JSON and DESIGN.md", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "design-brief-"));
  try {
    const generated = {
      kind: "design_brief",
      run_id: "20260614T120000000Z-abcdef",
      goal: "Improve dashboard",
      target_user: "Operator",
      screens: [{ id: "admin", purpose: "Monitor telemetry" }],
      visual_direction: ["quiet"],
      design_system: { tokens: [{ name: "--surface", value: "#ffffff" }] },
      accessibility: ["AA contrast"],
      responsive_requirements: ["390px"],
      acceptance_criteria: ["Shows reliability"],
      implementation_risks: ["Shared CSS"],
      metadata: { model: "configured-design-model", generated_at: "2026-06-14T12:00:00.000Z" },
    };
    const result = await runDesignBrief({
      cwd,
      inputText: "Design a dashboard",
      apiKey: "key",
      now: new Date("2026-06-14T12:00:00.000Z"),
      random: () => "abcdef",
      generate: async ({ runId }) => ({ ...generated, run_id: runId }),
    });
    assert.equal(result.brief.goal, "Improve dashboard");
    assert.match(await readFile(join(result.run.dir, "DESIGN.md"), "utf8"), /# Design System/);
    assert.equal(JSON.parse(await readFile(join(result.run.dir, "brief.json"), "utf8")).kind, "design_brief");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run failing brief test**

Run: `node --test test/design-brief.test.mjs`

Expected: FAIL with missing module.

- [ ] **Step 3: Implement brief module**

Create `src/design-brief.mjs`:

```js
import { createPartFromText } from "@google/genai";
import { generateDesignJson } from "./gemini-client.mjs";
import { GeminiDesignBriefSchema, normalizeDesignBrief } from "./design-schemas.mjs";
import { createDesignRun, writeDesignJson } from "./design-run-store.mjs";
import { resolveDesignModels } from "./design-model-router.mjs";

export function buildDesignBriefPrompt({ inputText, runId }) {
  return [
    "Create a structured design brief for gemini-agent.",
    `Run id: ${runId}`,
    "Return JSON only. Keep implementation guidance concise and actionable.",
    "",
    inputText,
  ].join("\n");
}

export function designBriefToMarkdown(brief) {
  return [
    `# Design Brief: ${brief.goal}`,
    "",
    `Target user: ${brief.target_user}`,
    "",
    "## Visual Direction",
    ...brief.visual_direction.map((item) => `- ${item}`),
    "",
    "## Design System",
    ...brief.design_system.tokens.map((token) => `- ${token.name}: ${token.value}`),
    "",
    "## Acceptance Criteria",
    ...brief.acceptance_criteria.map((item) => `- ${item}`),
    "",
  ].join("\n");
}

export async function runDesignBrief({
  cwd = process.cwd(),
  inputText,
  apiKey,
  env = process.env,
  now = new Date(),
  random = Math.random,
  generate,
  telemetry,
} = {}) {
  if (!inputText || !inputText.trim()) throw new Error("design brief input is empty.");
  const run = await createDesignRun({ cwd, now, random });
  const models = resolveDesignModels({ env });
  const prompt = buildDesignBriefPrompt({ inputText, runId: run.runId });
  const generated = generate
    ? await generate({ prompt, runId: run.runId, model: models.design_model })
    : await generateDesignJson({
      apiKey,
      model: models.design_model,
      prompt,
      contents: createPartFromText(prompt),
      responseSchema: GeminiDesignBriefSchema,
      normalize: normalizeDesignBrief,
      telemetry: {
        ...telemetry,
        command: "design-brief",
        metadata: { ...(telemetry?.metadata ?? {}), design_stage: "brief", actual_model: models.design_model },
      },
    });
  const brief = normalizeDesignBrief({
    ...generated,
    run_id: run.runId,
    metadata: {
      ...generated.metadata,
      model: models.design_model,
      generated_at: generated.metadata?.generated_at ?? now.toISOString(),
    },
  });
  await writeDesignJson({ runDir: run.dir, relativePath: "brief.json", value: brief });
  await writeDesignJson({ runDir: run.dir, relativePath: "brief.generated.json", value: generated });
  await import("node:fs/promises").then(({ writeFile }) => writeFile(
    new URL("DESIGN.md", `file://${run.dir}/`),
    designBriefToMarkdown(brief),
  ));
  return { run, brief };
}
```

- [ ] **Step 4: Verify brief unit test**

Run: `node --test test/design-brief.test.mjs`

Expected: PASS.

- [ ] **Step 5: Add CLI help and parser for design brief**

Modify `src/cli.mjs`:

```js
import { runDesignBrief } from "./design-brief.mjs";
```

Add to `printUsage()`:

```js
"  gemini-agent design brief [--stdin|--file <path>] [--write-artifact]",
```

Add:

```js
function parseDesignBriefArgs(args) {
  const options = { stdin: false, files: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--stdin") options.stdin = true;
    else if (arg === "--file") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--file requires a path.");
      options.files.push(value);
      index += 1;
    } else if (arg === "--write-artifact") {
      options.writeArtifact = true;
    } else {
      throw new Error(`Unknown design brief argument: ${arg}`);
    }
  }
  return options;
}

async function runDesignCommand(args) {
  const [subcommand, ...subArgs] = args;
  if (subcommand === "brief") {
    const options = parseDesignBriefArgs(subArgs);
    const stdinText = options.stdin ? await readStdin() : "";
    const collected = await collectTextInput({ stdinText, files: options.files, cwd: process.cwd() });
    const key = await resolveApiKey();
    if (!key.ok) throw new Error("Gemini API key is not configured. Run: gemini-agent auth set");
    const result = await runDesignBrief({
      cwd: process.cwd(),
      inputText: collected.text,
      apiKey: key.key,
      telemetry: { cwd: process.cwd(), source: "cli", command: "design-brief" },
    });
    output.write(`${JSON.stringify({ run_id: result.run.runId, run_dir: result.run.dir, brief: "brief.json" }, null, 2)}\n`);
    return;
  }
  throw new Error("Unknown design command.");
}
```

Add in `main()` before gate commands:

```js
if (command === "design") {
  await runDesignCommand(args);
  return;
}
```

- [ ] **Step 6: Add CLI tests for help and argument errors**

Append to `test/cli.test.mjs`:

```js
test("design brief rejects empty input before auth lookup", async () => {
  await assert.rejects(
    () => execBin(["design", "brief", "--stdin"], { input: "" }),
    /Command failed/,
  );
});
```

Update `test/package.test.mjs` README expectations after README is updated.

- [ ] **Step 7: Update README**

Add command examples:

```md
./bin/gemini-agent design brief --stdin --write-artifact
```

Add a short feature note:

```md
- `design brief` starts a design run under `.gemini-agent/design/<run-id>/` and writes `brief.json` plus `DESIGN.md`.
```

- [ ] **Step 8: Run targeted tests**

Run:

```bash
node --test test/design-brief.test.mjs test/cli.test.mjs test/package.test.mjs --test-name-pattern "design brief|README"
```

Expected: PASS.

- [ ] **Step 9: Commit brief command**

```bash
git add src/design-brief.mjs src/cli.mjs README.md test/design-brief.test.mjs test/cli.test.mjs test/package.test.mjs
git commit -m "Add design brief command"
```

### Task 6: Design Generate Command

**Files:**
- Create: `src/design-generate.mjs`
- Modify: `src/cli.mjs`
- Modify: `README.md`
- Test: `test/design-generate.test.mjs`
- Modify: `test/cli.test.mjs`
- Modify: `test/package.test.mjs`

- [ ] **Step 1: Write failing generate tests**

Create `test/design-generate.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDesignGenerate } from "../src/design-generate.mjs";

test("runDesignGenerate writes candidate images and manifest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "design-generate-"));
  try {
    await writeFile(join(dir, "brief.json"), JSON.stringify({
      kind: "design_brief",
      run_id: "20260614T120000000Z-abcdef",
      goal: "Dashboard",
      target_user: "Operator",
      screens: [],
      visual_direction: [],
      design_system: { tokens: [] },
      accessibility: [],
      responsive_requirements: [],
      acceptance_criteria: [],
      implementation_risks: [],
      metadata: {},
    }));
    const result = await runDesignGenerate({
      runDir: dir,
      variants: 2,
      quality: "fast",
      apiKey: "key",
      generateImage: async ({ index }) => ({
        mimeType: "image/png",
        buffer: Buffer.from(`image-${index}`),
      }),
      env: { GEMINI_IMAGE_MODEL: "configured-image-model" },
    });
    assert.equal(result.manifest.candidates.length, 2);
    assert.equal(await readFile(join(dir, "candidates", "candidate-a.png"), "utf8"), "image-0");
    assert.equal(JSON.parse(await readFile(join(dir, "candidates", "manifest.json"), "utf8")).kind, "design_candidates");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runDesignGenerate fails clearly when image model is not configured", async () => {
  const dir = await mkdtemp(join(tmpdir(), "design-generate-"));
  try {
    await writeFile(join(dir, "brief.json"), JSON.stringify({
      kind: "design_brief",
      run_id: "20260614T120000000Z-abcdef",
      goal: "Dashboard",
      target_user: "Operator",
      screens: [],
      visual_direction: [],
      design_system: { tokens: [] },
      accessibility: [],
      responsive_requirements: [],
      acceptance_criteria: [],
      implementation_risks: [],
      metadata: {},
    }));
    await assert.rejects(() => runDesignGenerate({
      runDir: dir,
      variants: 1,
      quality: "fast",
      apiKey: "key",
      env: {},
    }), /GEMINI_IMAGE_MODEL/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run failing generate test**

Run: `node --test test/design-generate.test.mjs`

Expected: FAIL with missing module.

- [ ] **Step 3: Implement generate module**

Create `src/design-generate.mjs`:

```js
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { generateDesignImage } from "./gemini-client.mjs";
import { normalizeDesignBrief, normalizeDesignCandidateManifest } from "./design-schemas.mjs";
import { resolveDesignModels } from "./design-model-router.mjs";

function candidateId(index) {
  return `candidate-${String.fromCharCode(97 + index)}`;
}

function promptHash(prompt) {
  return createHash("sha256").update(prompt).digest("hex").slice(0, 16);
}

export function buildDesignGeneratePrompt({ brief, index }) {
  return [
    "Create a high-fidelity UI candidate image for this design brief.",
    `Variant index: ${index + 1}`,
    `Goal: ${brief.goal}`,
    `Target user: ${brief.target_user}`,
    `Visual direction: ${brief.visual_direction.join(", ")}`,
    "Return image output.",
  ].join("\n");
}

export async function runDesignGenerate({
  runDir,
  variants = 1,
  quality = "fast",
  apiKey,
  env = process.env,
  generateImage,
  telemetry,
} = {}) {
  if (!runDir) throw new Error("runDir is required.");
  if (!Number.isInteger(variants) || variants < 1 || variants > 4) throw new Error("--variants must be between 1 and 4.");
  if (!["fast", "pro"].includes(quality)) throw new Error("--quality must be fast or pro.");
  const brief = normalizeDesignBrief(JSON.parse(await readFile(join(runDir, "brief.json"), "utf8")));
  const models = resolveDesignModels({ env });
  const model = quality === "pro" ? models.image_pro_model : models.image_model;
  if (!model) {
    throw new Error(quality === "pro"
      ? "GEMINI_IMAGE_PRO_MODEL is required for --quality pro."
      : "GEMINI_IMAGE_MODEL is required for design generate.");
  }
  const outputDir = join(runDir, "candidates");
  await mkdir(outputDir, { recursive: true });
  const candidates = [];
  for (let index = 0; index < variants; index += 1) {
    const id = candidateId(index);
    const prompt = buildDesignGeneratePrompt({ brief, index });
    const image = generateImage
      ? await generateImage({ prompt, index, model })
      : await generateDesignImage({
        apiKey,
        model,
        contents: prompt,
        telemetry: {
          ...telemetry,
          command: "design-generate",
          metadata: { ...(telemetry?.metadata ?? {}), design_stage: "generate", actual_model: model },
        },
      });
    const file = `${id}.png`;
    await writeFile(join(outputDir, file), image.buffer);
    candidates.push({
      id,
      file,
      model,
      prompt_hash: promptHash(prompt),
      status: "success",
      image_size: null,
      aspect_ratio: null,
      warnings: image.mimeType === "image/png" ? [] : [`Generated MIME type was ${image.mimeType}`],
    });
  }
  const manifest = normalizeDesignCandidateManifest({
    kind: "design_candidates",
    run_id: brief.run_id,
    candidates,
  });
  await writeFile(join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, outputDir };
}
```

- [ ] **Step 4: Verify generate unit test**

Run: `node --test test/design-generate.test.mjs`

Expected: PASS.

- [ ] **Step 5: Add CLI parser and README docs**

Add usage:

```js
"  gemini-agent design generate --run <path> [--variants <n>] [--quality fast|pro]",
```

Add `design generate` branch in `runDesignCommand`:

```js
if (subcommand === "generate") {
  const options = parseDesignGenerateArgs(subArgs);
  const key = await resolveApiKey();
  if (!key.ok) throw new Error("Gemini API key is not configured. Run: gemini-agent auth set");
  const result = await runDesignGenerate({
    runDir: resolveDesignRun({ cwd: process.cwd(), run: options.run }),
    variants: options.variants,
    quality: options.quality,
    apiKey: key.key,
    telemetry: { cwd: process.cwd(), source: "cli", command: "design-generate" },
  });
  output.write(`${JSON.stringify({ candidates: result.manifest.candidates.length, manifest: "candidates/manifest.json" }, null, 2)}\n`);
  return;
}
```

Add parser:

```js
function parseDesignGenerateArgs(args) {
  const options = { variants: 1, quality: "fast" };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--run") {
      options.run = args[index + 1];
      if (!options.run || options.run.startsWith("--")) throw new Error("--run requires a path.");
      index += 1;
    } else if (arg === "--variants") {
      const value = Number(args[index + 1]);
      if (!Number.isInteger(value) || value < 1 || value > 4) throw new Error("--variants must be between 1 and 4.");
      options.variants = value;
      index += 1;
    } else if (arg === "--quality") {
      const value = args[index + 1];
      if (!["fast", "pro"].includes(value)) throw new Error("--quality must be fast or pro.");
      options.quality = value;
      index += 1;
    } else {
      throw new Error(`Unknown design generate argument: ${arg}`);
    }
  }
  if (!options.run) throw new Error("--run requires a path.");
  return options;
}
```

- [ ] **Step 6: Run targeted generate tests**

Run:

```bash
node --test test/design-generate.test.mjs test/cli.test.mjs test/package.test.mjs --test-name-pattern "design generate|README"
```

Expected: PASS.

- [ ] **Step 7: Commit generate command**

```bash
git add src/design-generate.mjs src/cli.mjs README.md test/design-generate.test.mjs test/cli.test.mjs test/package.test.mjs
git commit -m "Add design candidate generation"
```

### Task 7: Design Perceive Command

**Files:**
- Create: `src/design-image-dimensions.mjs`
- Create: `src/design-perceive.mjs`
- Modify: `src/cli.mjs`
- Modify: `README.md`
- Test: `test/design-image-dimensions.test.mjs`
- Test: `test/design-perceive.test.mjs`

- [ ] **Step 1: Verify existing dependencies and adapter export**

Run:

```bash
node -e 'const p=require("./package.json"); if (!p.dependencies["pngjs"] || !p.dependencies["jpeg-js"]) process.exit(1)'
rg -n "export async function runPaletteSplit" src/palette-mask.mjs
```

Expected: both commands pass. If either dependency is absent, add it to `package.json` before implementing this task. If `runPaletteSplit` is not exported, add an explicit adapter function instead of importing a private symbol.

- [ ] **Step 2: Write failing image dimension tests**

Create `test/design-image-dimensions.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { imageDimensions, normalizeBBox } from "../src/design-image-dimensions.mjs";

test("reads PNG dimensions and normalizes bbox", async () => {
  const dir = await mkdtemp(join(tmpdir(), "design-dim-"));
  try {
    const png = new PNG({ width: 200, height: 100 });
    const file = join(dir, "screen.png");
    await writeFile(file, PNG.sync.write(png));
    assert.deepEqual(await imageDimensions(file), { width: 200, height: 100, mimeType: "image/png" });
    assert.deepEqual(normalizeBBox({ x: 20, y: 10, width: 100, height: 50 }, { width: 200, height: 100 }), {
      x: 0.1,
      y: 0.1,
      width: 0.5,
      height: 0.5,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function webpChunk(type, payload) {
  const pad = payload.length % 2;
  const buffer = Buffer.alloc(12 + 8 + payload.length + pad);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(4 + 8 + payload.length + pad, 4);
  buffer.write("WEBP", 8, "ascii");
  buffer.write(type, 12, "ascii");
  buffer.writeUInt32LE(payload.length, 16);
  payload.copy(buffer, 20);
  return buffer;
}

function vp8xWebp({ width, height }) {
  const payload = Buffer.alloc(10);
  payload.writeUIntLE(width - 1, 4, 3);
  payload.writeUIntLE(height - 1, 7, 3);
  return webpChunk("VP8X", payload);
}

function vp8lWebp({ width, height }) {
  const payload = Buffer.alloc(5);
  const w = width - 1;
  const h = height - 1;
  payload[0] = 0x2f;
  payload[1] = w & 0xff;
  payload[2] = ((w >> 8) & 0x3f) | ((h & 0x03) << 6);
  payload[3] = (h >> 2) & 0xff;
  payload[4] = (h >> 10) & 0x0f;
  return webpChunk("VP8L", payload);
}

function vp8Webp({ width, height }) {
  const payload = Buffer.alloc(10);
  payload[3] = 0x9d;
  payload[4] = 0x01;
  payload[5] = 0x2a;
  payload.writeUInt16LE(width, 6);
  payload.writeUInt16LE(height, 8);
  return webpChunk("VP8 ", payload);
}

test("reads VP8X, VP8L, and VP8 WEBP dimensions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "design-dim-"));
  try {
    const vp8x = join(dir, "screen-vp8x.webp");
    const vp8l = join(dir, "screen-vp8l.webp");
    const vp8 = join(dir, "screen-vp8.webp");
    await writeFile(vp8x, vp8xWebp({ width: 320, height: 180 }));
    await writeFile(vp8l, vp8lWebp({ width: 321, height: 181 }));
    await writeFile(vp8, vp8Webp({ width: 322, height: 182 }));
    assert.deepEqual(await imageDimensions(vp8x), { width: 320, height: 180, mimeType: "image/webp" });
    assert.deepEqual(await imageDimensions(vp8l), { width: 321, height: 181, mimeType: "image/webp" });
    assert.deepEqual(await imageDimensions(vp8), { width: 322, height: 182, mimeType: "image/webp" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("unsupported WEBP chunks degrade to unknown dimensions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "design-dim-"));
  try {
    const file = join(dir, "unknown.webp");
    await writeFile(file, webpChunk("ALPH", Buffer.from([1, 2, 3, 4])));
    assert.deepEqual(await imageDimensions(file), { width: null, height: null, mimeType: "image/webp" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("corrupted image payloads degrade to unknown dimensions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "design-dim-"));
  try {
    const png = join(dir, "bad.png");
    const jpg = join(dir, "bad.jpg");
    const webp = join(dir, "bad.webp");
    await writeFile(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(jpg, Buffer.from([0xff, 0xd8, 0xff]));
    await writeFile(webp, Buffer.from("RIFFxxxxWEBP", "ascii"));
    assert.deepEqual(await imageDimensions(png), { width: null, height: null, mimeType: "image/png" });
    assert.deepEqual(await imageDimensions(jpg), { width: null, height: null, mimeType: "image/jpeg" });
    assert.deepEqual(await imageDimensions(webp), { width: null, height: null, mimeType: "image/webp" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("invalid dimensions return null bbox", () => {
  assert.equal(normalizeBBox({ x: 1, y: 1, width: 1, height: 1 }, { width: 0, height: 10 }), null);
});
```

- [ ] **Step 3: Implement image dimensions**

Create `src/design-image-dimensions.mjs`:

```js
import { readFile } from "node:fs/promises";
import { PNG } from "pngjs";
import jpeg from "jpeg-js";

function isWebp(buffer) {
  return buffer.length >= 12
    && buffer.subarray(0, 4).toString("ascii") === "RIFF"
    && buffer.subarray(8, 12).toString("ascii") === "WEBP";
}

function readUInt24LE(buffer, offset) {
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
}

function parseVp8xDimensions(buffer, dataOffset, chunkSize) {
  if (chunkSize < 10) return null;
  return {
    width: readUInt24LE(buffer, dataOffset + 4) + 1,
    height: readUInt24LE(buffer, dataOffset + 7) + 1,
  };
}

function parseVp8lDimensions(buffer, dataOffset, chunkSize) {
  if (chunkSize < 5 || buffer[dataOffset] !== 0x2f) return null;
  const b0 = buffer[dataOffset + 1];
  const b1 = buffer[dataOffset + 2];
  const b2 = buffer[dataOffset + 3];
  const b3 = buffer[dataOffset + 4];
  return {
    width: 1 + (((b1 & 0x3f) << 8) | b0),
    height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
  };
}

function parseVp8Dimensions(buffer, dataOffset, chunkSize) {
  if (
    chunkSize < 10
    || buffer[dataOffset + 3] !== 0x9d
    || buffer[dataOffset + 4] !== 0x01
    || buffer[dataOffset + 5] !== 0x2a
  ) {
    return null;
  }
  return {
    width: buffer.readUInt16LE(dataOffset + 6) & 0x3fff,
    height: buffer.readUInt16LE(dataOffset + 8) & 0x3fff,
  };
}

function webpDimensions(buffer) {
  if (!isWebp(buffer)) return null;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkType = buffer.subarray(offset, offset + 4).toString("ascii");
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    if (dataOffset + chunkSize > buffer.length) return null;
    if (chunkType === "VP8X") return parseVp8xDimensions(buffer, dataOffset, chunkSize);
    if (chunkType === "VP8L") return parseVp8lDimensions(buffer, dataOffset, chunkSize);
    if (chunkType === "VP8 ") return parseVp8Dimensions(buffer, dataOffset, chunkSize);
    offset = dataOffset + chunkSize + (chunkSize % 2);
  }
  return null;
}

export async function imageDimensions(path) {
  const buffer = await readFile(path);
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    try {
      const png = PNG.sync.read(buffer);
      return { width: png.width, height: png.height, mimeType: "image/png" };
    } catch {
      return { width: null, height: null, mimeType: "image/png" };
    }
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    try {
      const decoded = jpeg.decode(buffer, { useTArray: true });
      return { width: decoded.width, height: decoded.height, mimeType: "image/jpeg" };
    } catch {
      return { width: null, height: null, mimeType: "image/jpeg" };
    }
  }
  if (isWebp(buffer)) {
    const dimensions = webpDimensions(buffer);
    return { width: dimensions?.width ?? null, height: dimensions?.height ?? null, mimeType: "image/webp" };
  }
  return { width: null, height: null, mimeType: "unknown" };
}

export function normalizeBBox(box, dimensions) {
  if (!box || !dimensions || dimensions.width <= 0 || dimensions.height <= 0) return null;
  const normalized = {
    x: box.x / dimensions.width,
    y: box.y / dimensions.height,
    width: box.width / dimensions.width,
    height: box.height / dimensions.height,
  };
  if (Object.values(normalized).some((value) => !Number.isFinite(value) || value < 0 || value > 1)) return null;
  return normalized;
}
```

- [ ] **Step 4: Write failing perceive tests**

Create `test/design-perceive.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { runDesignPerceive } from "../src/design-perceive.mjs";

test("palette-mask provider writes perception from palette split manifest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "design-perceive-"));
  try {
    const image = join(dir, "screen.png");
    await writeFile(image, PNG.sync.write(new PNG({ width: 2, height: 2 })));
    await writeFile(join(dir, "brief.json"), JSON.stringify({ run_id: "20260614T120000000Z-abcdef" }));
    const result = await runDesignPerceive({
      runDir: dir,
      file: image,
      provider: "palette-mask",
      targets: ["hero: main visual area"],
      apiKey: "key",
      paletteSplit: async ({ outputDir }) => {
        await writeFile(join(outputDir, "manifest.json"), JSON.stringify({
          layers: [{ name: "hero", file: "layers/hero.png" }],
          warnings: [],
        }));
        return { outputDir, manifest: { layers: [{ name: "hero", file: "layers/hero.png" }], warnings: [] } };
      },
    });
    assert.equal(result.perception.provider, "palette-mask");
    assert.equal(JSON.parse(await readFile(join(dir, "perceive", "perception.json"), "utf8")).regions[0].id, "hero");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("vision-banana provider fails clearly when unconfigured", async () => {
  await assert.rejects(() => runDesignPerceive({
    runDir: "/tmp/run",
    file: "screen.png",
    provider: "vision-banana",
    env: {},
  }), /Vision Banana provider is not configured/);
});

test("vision-banana provider reports HTTP failures", async () => {
  const dir = await mkdtemp(join(tmpdir(), "design-perceive-"));
  try {
    await writeFile(join(dir, "brief.json"), JSON.stringify({ run_id: "20260614T120000000Z-abcdef" }));
    await assert.rejects(() => runDesignPerceive({
      runDir: dir,
      file: "screen.png",
      provider: "vision-banana",
      env: { VISION_BANANA_ENDPOINT: "https://example.test/vision" },
      fetchImpl: async () => ({ ok: false, status: 503, text: async () => "down" }),
    }), /Vision Banana provider failed with HTTP 503/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("vision-banana provider reports timeout", async () => {
  const dir = await mkdtemp(join(tmpdir(), "design-perceive-"));
  try {
    await writeFile(join(dir, "brief.json"), JSON.stringify({ run_id: "20260614T120000000Z-abcdef" }));
    await assert.rejects(() => runDesignPerceive({
      runDir: dir,
      file: "screen.png",
      provider: "vision-banana",
      env: { VISION_BANANA_ENDPOINT: "https://example.test/vision" },
      fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      }),
      timeoutMs: 1,
    }), /Vision Banana provider timed out/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 5: Implement perceive module**

Create `src/design-perceive.mjs`:

```js
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { normalizeDesignPerception } from "./design-schemas.mjs";
import { readDesignRunId, writeDesignJson } from "./design-run-store.mjs";
import { runPaletteSplit } from "./palette-mask.mjs";

function parseTargetName(target) {
  return String(target).split(":")[0].trim();
}

async function callVisionBanana({ endpoint, file, runId, fetchImpl = fetch, timeoutMs = 10000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image_path: file, run_id: runId }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Vision Banana provider failed with HTTP ${response.status}: ${body.slice(0, 200)}`);
    }
    return normalizeDesignPerception({
      ...await response.json(),
      run_id: runId,
      provider: "vision-banana",
    });
  } catch (error) {
    if (error.name === "AbortError") throw new Error(`Vision Banana provider timed out after ${timeoutMs}ms.`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function selectPerceptionProvider({ provider = "auto", targets = [] } = {}) {
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
  fetchImpl = fetch,
  timeoutMs = 10000,
  generate,
} = {}) {
  if (!runDir) throw new Error("runDir is required.");
  if (!file) throw new Error("--file requires a path.");
  const selected = selectPerceptionProvider({ provider, targets });
  if (selected === "vision-banana" && !env.VISION_BANANA_ENDPOINT) {
    throw new Error("Vision Banana provider is not configured; use --provider gemini-vision or configure VISION_BANANA_ENDPOINT.");
  }
  const runId = await readDesignRunId(runDir);
  const outputDir = join(runDir, "perceive");
  await mkdir(outputDir, { recursive: true });
  let perception;
  if (selected === "palette-mask") {
    if (targets.length === 0) throw new Error("palette-mask provider requires at least one --target.");
    const split = await paletteSplit({
      sourceImagePath: file,
      targets,
      outputDir,
      apiKey,
      env,
      telemetry: { cwd: process.cwd(), source: "cli", command: "design-perceive" },
    });
    perception = normalizeDesignPerception({
      kind: "design_perception",
      run_id: runId,
      provider: "palette-mask",
      source: file,
      regions: targets.map((target, index) => ({
        id: parseTargetName(target),
        label: parseTargetName(target),
        role: "target",
        importance: index === 0 ? 1 : 0.5,
        bbox: null,
        mask_ref: split.manifest.layers?.find((layer) => layer.name === parseTargetName(target))?.file ?? null,
        confidence: null,
      })),
      hierarchy: targets.map(parseTargetName),
      layout_observations: [],
      implementation_constraints: [],
      confidence: null,
      warnings: split.manifest.warnings ?? [],
    });
  } else if (selected === "vision-banana") {
    perception = await callVisionBanana({
      endpoint: env.VISION_BANANA_ENDPOINT,
      file,
      runId,
      fetchImpl,
      timeoutMs,
    });
  } else {
    const generated = await generate({ file, provider: selected, runId });
    perception = normalizeDesignPerception({
      ...generated,
      run_id: generated.run_id ?? runId,
      provider: generated.provider ?? selected,
    });
  }
  await writeDesignJson({ runDir, relativePath: "perceive/perception.json", value: perception });
  return { perception, outputDir };
}
```

- [ ] **Step 6: Run perceive tests**

Run:

```bash
node --test test/design-image-dimensions.test.mjs test/design-perceive.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Add CLI and README docs**

Add usage:

```js
"  gemini-agent design perceive --run <path> --file <path> [--target <name: description> ...] [--provider auto|palette-mask|gemini-vision|vision-banana]",
```

Add CLI branch calling `runDesignPerceive`.

README line:

```md
./bin/gemini-agent design perceive --run .gemini-agent/design/<run-id> --file screenshot.png --target "hero: main area"
```

- [ ] **Step 8: Run targeted perceive tests**

Run:

```bash
node --test test/design-image-dimensions.test.mjs test/design-perceive.test.mjs test/cli.test.mjs test/package.test.mjs --test-name-pattern "design perceive|README"
```

Expected: PASS.

- [ ] **Step 9: Commit perceive command**

```bash
git add src/design-image-dimensions.mjs src/design-perceive.mjs src/cli.mjs README.md test/design-image-dimensions.test.mjs test/design-perceive.test.mjs test/cli.test.mjs test/package.test.mjs
git commit -m "Add design perception command"
```

### Task 8: Design Prototype Command

**Files:**
- Create: `src/design-prototype.mjs`
- Modify: `src/cli.mjs`
- Modify: `README.md`
- Test: `test/design-prototype.test.mjs`

- [ ] **Step 1: Write failing prototype tests**

Create `test/design-prototype.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDesignPrototype } from "../src/design-prototype.mjs";

test("runDesignPrototype writes isolated static preview", async () => {
  const dir = await mkdtemp(join(tmpdir(), "design-prototype-"));
  try {
    await writeFile(join(dir, "brief.json"), JSON.stringify({
      kind: "design_brief",
      run_id: "20260614T120000000Z-abcdef",
      goal: "Dashboard",
      target_user: "Operator",
      screens: [],
      visual_direction: [],
      design_system: { tokens: [] },
      accessibility: [],
      responsive_requirements: [],
      acceptance_criteria: [],
      implementation_risks: [],
      metadata: {},
    }));
    const result = await runDesignPrototype({
      runDir: dir,
      apiKey: "key",
      targetStack: "html",
      generate: async () => ({
        manifest: {
          kind: "design_prototype",
          run_id: "20260614T120000000Z-abcdef",
          selected_candidate: null,
          target_stack: "html",
          model: "configured-design-model",
          files: ["preview.html", "review-notes.md"],
          preview_entry: "preview.html",
          review_notes: ["Review only"],
          limitations: ["Not production"],
          integration_recommendation: "Use as reference.",
        },
        files: [
          { path: "preview.html", content: "<!doctype html><title>Preview</title>" },
          { path: "review-notes.md", content: "# Review\n" },
        ],
      }),
    });
    assert.equal(result.manifest.preview_entry, "preview.html");
    assert.match(await readFile(join(dir, "prototype", "preview.html"), "utf8"), /Preview/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runDesignPrototype rejects path traversal files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "design-prototype-"));
  try {
    await assert.rejects(() => runDesignPrototype({
      runDir: dir,
      apiKey: "key",
      targetStack: "html",
      generate: async () => ({
        manifest: {
          kind: "design_prototype",
          run_id: "20260614T120000000Z-abcdef",
          selected_candidate: null,
          target_stack: "html",
          model: "configured-design-model",
          files: ["../src/app.js"],
          preview_entry: "../src/app.js",
          review_notes: [],
          limitations: [],
          integration_recommendation: "bad",
        },
        files: [{ path: "../src/app.js", content: "bad" }],
      }),
    }), /Prototype file path must stay/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run failing prototype tests**

Run: `node --test test/design-prototype.test.mjs`

Expected: FAIL with missing module.

- [ ] **Step 3: Implement prototype module**

Create `src/design-prototype.mjs`:

```js
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { generateDesignJson } from "./gemini-client.mjs";
import {
  GeminiDesignPrototypeResponseSchema,
  normalizeDesignBrief,
  normalizeDesignPrototypeManifest,
} from "./design-schemas.mjs";
import { assertPrototypeRelativePath, writePrototypeFiles } from "./design-run-store.mjs";
import { resolveDesignModels } from "./design-model-router.mjs";

export function buildPrototypePrompt({ brief, targetStack }) {
  return [
    "Generate an isolated frontend prototype for user review.",
    "Do not modify production source. Return JSON with manifest and files.",
    `Target stack: ${targetStack}`,
    `Goal: ${brief.goal}`,
  ].join("\n");
}

export async function runDesignPrototype({
  runDir,
  apiKey,
  env = process.env,
  targetStack = "html",
  selectedCandidate = null,
  generate,
  telemetry,
} = {}) {
  if (!["html", "react", "tailwind", "auto"].includes(targetStack)) throw new Error("--target-stack must be html, react, tailwind, or auto.");
  const brief = normalizeDesignBrief(JSON.parse(await readFile(join(runDir, "brief.json"), "utf8")));
  const models = resolveDesignModels({ env });
  const prompt = buildPrototypePrompt({ brief, targetStack });
  const generated = generate
    ? await generate({ prompt, brief, targetStack, selectedCandidate, model: models.design_model })
    : await generateDesignJson({
      apiKey,
      model: models.design_model,
      prompt,
      responseSchema: GeminiDesignPrototypeResponseSchema,
      normalize: (value) => value,
      telemetry: { ...telemetry, command: "design-prototype" },
    });
  const manifest = normalizeDesignPrototypeManifest({
    ...generated.manifest,
    run_id: brief.run_id,
    selected_candidate: selectedCandidate,
    target_stack: targetStack,
    model: models.design_model,
  });
  const prototypeFiles = Object.fromEntries(
    generated.files.map((file) => [file.path, file.content]),
  );
  for (const file of manifest.files) assertPrototypeRelativePath(file);
  assertPrototypeRelativePath(manifest.preview_entry);
  await writePrototypeFiles({
    runDir,
    files: {
      ...prototypeFiles,
      "manifest.json": `${JSON.stringify(manifest, null, 2)}\n`,
    },
  });
  return { manifest };
}
```

- [ ] **Step 4: Verify prototype tests pass**

Run: `node --test test/design-prototype.test.mjs`

Expected: PASS.

- [ ] **Step 5: Add CLI and README docs**

Add usage:

```js
"  gemini-agent design prototype --run <path> [--candidate <id>] [--target-stack html|react|tailwind|auto]",
```

Add command branch and README example:

```md
./bin/gemini-agent design prototype --run .gemini-agent/design/<run-id> --target-stack html
```

- [ ] **Step 6: Run targeted prototype tests**

Run:

```bash
node --test test/design-prototype.test.mjs test/cli.test.mjs test/package.test.mjs --test-name-pattern "design prototype|README"
```

Expected: PASS.

- [ ] **Step 7: Commit prototype command**

```bash
git add src/design-prototype.mjs src/cli.mjs README.md test/design-prototype.test.mjs test/cli.test.mjs test/package.test.mjs
git commit -m "Add isolated design prototype command"
```

### Task 9: Design Handoff Command

**Files:**
- Create: `src/design-handoff.mjs`
- Modify: `src/cli.mjs`
- Modify: `README.md`
- Test: `test/design-handoff.test.mjs`

- [ ] **Step 1: Write failing handoff tests**

Create `test/design-handoff.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDesignHandoff } from "../src/design-handoff.mjs";

test("runDesignHandoff writes handoff JSON and codex tasks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "design-handoff-"));
  try {
    await writeFile(join(dir, "brief.json"), JSON.stringify({
      kind: "design_brief",
      run_id: "20260614T120000000Z-abcdef",
      goal: "Dashboard",
      target_user: "Operator",
      screens: [],
      visual_direction: [],
      design_system: { tokens: [] },
      accessibility: [],
      responsive_requirements: [],
      acceptance_criteria: [],
      implementation_risks: [],
      metadata: {},
    }));
    const result = await runDesignHandoff({
      runDir: dir,
      apiKey: "key",
      generate: async () => ({
        kind: "design_handoff",
        run_id: "20260614T120000000Z-abcdef",
        selected_candidate: null,
        implementation_summary: "Update dashboard cards.",
        file_hints: ["src/dashboard.tsx"],
        component_tasks: ["Add status row"],
        style_tokens: [],
        responsive_tasks: ["Check mobile"],
        asset_tasks: [],
        verification: ["npm test"],
        open_questions: [],
        risk_notes: [],
      }),
    });
    assert.equal(result.handoff.verification[0], "npm test");
    assert.match(await readFile(join(dir, "codex-tasks.md"), "utf8"), /Update dashboard cards/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run failing handoff test**

Run: `node --test test/design-handoff.test.mjs`

Expected: FAIL with missing module.

- [ ] **Step 3: Implement handoff module**

Create `src/design-handoff.mjs`:

```js
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateDesignJson } from "./gemini-client.mjs";
import { GeminiDesignHandoffSchema, normalizeDesignBrief, normalizeDesignHandoff } from "./design-schemas.mjs";
import { writeDesignJson } from "./design-run-store.mjs";
import { resolveDesignModels } from "./design-model-router.mjs";

export function handoffToMarkdown(handoff) {
  return [
    `# Codex Tasks: ${handoff.implementation_summary}`,
    "",
    "## Files",
    ...handoff.file_hints.map((item) => `- ${item}`),
    "",
    "## Component Tasks",
    ...handoff.component_tasks.map((item) => `- ${item}`),
    "",
    "## Verification",
    ...handoff.verification.map((item) => `- ${item}`),
    "",
  ].join("\n");
}

export async function runDesignHandoff({
  runDir,
  apiKey,
  env = process.env,
  selectedCandidate = null,
  generate,
  telemetry,
} = {}) {
  const brief = normalizeDesignBrief(JSON.parse(await readFile(join(runDir, "brief.json"), "utf8")));
  const models = resolveDesignModels({ env });
  const prompt = [
    "Create a Codex implementation handoff for this design run.",
    `Goal: ${brief.goal}`,
    "Return JSON only.",
  ].join("\n");
  const generated = generate
    ? await generate({ prompt, brief, selectedCandidate, model: models.design_model })
    : await generateDesignJson({
      apiKey,
      model: models.design_model,
      prompt,
      responseSchema: GeminiDesignHandoffSchema,
      normalize: normalizeDesignHandoff,
      telemetry: { ...telemetry, command: "design-handoff" },
    });
  const handoff = normalizeDesignHandoff({
    ...generated,
    run_id: brief.run_id,
    selected_candidate: selectedCandidate,
  });
  await writeDesignJson({ runDir, relativePath: "handoff.json", value: handoff });
  await writeFile(join(runDir, "codex-tasks.md"), handoffToMarkdown(handoff));
  return { handoff };
}
```

- [ ] **Step 4: Verify handoff test**

Run: `node --test test/design-handoff.test.mjs`

Expected: PASS.

- [ ] **Step 5: Add CLI and README docs**

Add usage:

```js
"  gemini-agent design handoff --run <path> [--candidate <id>]",
```

Add README example:

```md
./bin/gemini-agent design handoff --run .gemini-agent/design/<run-id>
```

- [ ] **Step 6: Run targeted handoff tests**

Run:

```bash
node --test test/design-handoff.test.mjs test/cli.test.mjs test/package.test.mjs --test-name-pattern "design handoff|README"
```

Expected: PASS.

- [ ] **Step 7: Commit handoff command**

```bash
git add src/design-handoff.mjs src/cli.mjs README.md test/design-handoff.test.mjs test/cli.test.mjs test/package.test.mjs
git commit -m "Add design handoff command"
```

### Task 10: Design Loop And Doctor Commands

**Files:**
- Create: `src/design-loop.mjs`
- Modify: `src/cli.mjs`
- Modify: `README.md`
- Test: `test/design-loop.test.mjs`
- Modify: `test/cli.test.mjs`

- [ ] **Step 1: Verify artifact-review export**

Run:

```bash
rg -n "export async function runArtifactReview" src/artifact-review.mjs
```

Expected: command passes. If `runArtifactReview` is not exported, add a small public adapter and test that adapter before wiring `design loop`.

- [ ] **Step 2: Write failing loop tests**

Create `test/design-loop.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDesignLoop } from "../src/design-loop.mjs";

test("runDesignLoop exits resumable when actual screenshot is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "design-loop-"));
  try {
    await writeFile(join(dir, "brief.json"), JSON.stringify({ run_id: "20260614T120000000Z-abcdef" }));
    await writeFile(join(dir, "codex-tasks.md"), "# Codex Tasks\n- Run app\n");
    const result = await runDesignLoop({ runDir: dir, maxIterations: 2 });
    assert.equal(result.review.status, "needs_screenshot");
    assert.match(result.message, /actual screenshot/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runDesignLoop compares target and actual screenshots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "design-loop-"));
  try {
    await writeFile(join(dir, "brief.json"), JSON.stringify({ run_id: "20260614T120000000Z-abcdef" }));
    const target = join(dir, "target.png");
    const actual = join(dir, "actual.png");
    await writeFile(target, "target");
    await writeFile(actual, "actual");
    const result = await runDesignLoop({
      runDir: dir,
      targetScreenshot: target,
      actualScreenshot: actual,
      maxIterations: 1,
      artifactReview: async () => ({ verdict: "pass", summary: ["ok"] }),
    });
    assert.equal(result.review.status, "reviewed");
    assert.equal(JSON.parse(await readFile(join(dir, "loop-review.json"), "utf8")).artifact_review.verdict, "pass");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run failing loop tests**

Run: `node --test test/design-loop.test.mjs`

Expected: FAIL with missing module.

- [ ] **Step 4: Implement loop module**

Create `src/design-loop.mjs`:

```js
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runArtifactReview } from "./artifact-review.mjs";
import { normalizeDesignLoopReview } from "./design-schemas.mjs";
import { readDesignRunId, writeDesignJson } from "./design-run-store.mjs";

export async function runDesignLoop({
  runDir,
  targetScreenshot = null,
  actualScreenshot = null,
  maxIterations = 2,
  apiKey,
  artifactReview,
} = {}) {
  if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > 3) {
    throw new Error("--max-iterations must be between 1 and 3.");
  }
  const runId = await readDesignRunId(runDir);
  if (!actualScreenshot) {
    const tasks = await readFile(join(runDir, "codex-tasks.md"), "utf8").catch(() => "");
    const review = normalizeDesignLoopReview({
      kind: "design_loop_review",
      run_id: runId,
      iteration: 1,
      target_screenshot: targetScreenshot,
      actual_screenshot: null,
      status: "needs_screenshot",
      summary: ["Actual screenshot is required before visual comparison."],
      next_actions: tasks.split(/\r?\n/).filter((line) => line.startsWith("- ")).map((line) => line.slice(2)),
      artifact_review: null,
    });
    await writeDesignJson({ runDir, relativePath: "loop-review.json", value: review });
    return { review, message: "Provide --actual-screenshot to resume design loop review." };
  }
  const artifact = artifactReview
    ? await artifactReview()
    : await runArtifactReview({
      apiKey,
      file: targetScreenshot,
      files: [targetScreenshot, actualScreenshot],
      artifactKind: "ui",
      reviewMode: "comparison",
      reviewDepth: "quick",
      telemetry: { cwd: process.cwd(), source: "cli", command: "design-loop" },
    });
  const review = normalizeDesignLoopReview({
    kind: "design_loop_review",
    run_id: runId,
    iteration: 1,
    target_screenshot: targetScreenshot,
    actual_screenshot: actualScreenshot,
    status: "reviewed",
    summary: artifact.summary ?? [],
    next_actions: artifact.suggested_changes ?? artifact.implementation_hints_for_codex ?? [],
    artifact_review: artifact,
  });
  await writeDesignJson({ runDir, relativePath: "loop-review.json", value: review });
  return { review, message: "Design loop review complete." };
}
```

- [ ] **Step 5: Add doctor CLI path**

In `src/cli.mjs`, add `design doctor` branch:

```js
if (subcommand === "doctor") {
  const json = subArgs.includes("--json");
  const report = await designDoctor({
    env: process.env,
    probe: async () => ({ ok: null, status: "not_probed" }),
  });
  output.write(json ? `${JSON.stringify(report, null, 2)}\n` : `Design doctor: ${report.ok ? "ok" : "caution"}\n`);
  return;
}
```

- [ ] **Step 6: Add design loop CLI branch**

Add usage and parser:

```js
"  gemini-agent design loop --run <path> [--target-screenshot <path>] [--actual-screenshot <path>] [--max-iterations <n>]",
```

Command branch calls `runDesignLoop`.

- [ ] **Step 7: Run loop and doctor tests**

Run:

```bash
node --test test/design-loop.test.mjs test/cli.test.mjs --test-name-pattern "design loop|design doctor"
```

Expected: PASS.

- [ ] **Step 8: Commit loop and doctor**

```bash
git add src/design-loop.mjs src/cli.mjs README.md test/design-loop.test.mjs test/cli.test.mjs
git commit -m "Add design loop and doctor commands"
```

### Task 11: Documentation, Telemetry Metadata, And Full Verification

**Files:**
- Modify: `README.md`
- Modify: `src/cli.mjs`
- Modify: `test/package.test.mjs`
- Modify: `test/design-brief.test.mjs`, `test/design-generate.test.mjs`, `test/design-perceive.test.mjs`, `test/design-prototype.test.mjs`, `test/design-handoff.test.mjs`, and `test/design-loop.test.mjs` only when telemetry assertions belong with their command tests.

- [ ] **Step 1: Add README command block**

Add this block near existing usage examples:

```md
./bin/gemini-agent design brief --stdin --write-artifact
./bin/gemini-agent design generate --run .gemini-agent/design/<run-id> --variants 2 --quality fast
./bin/gemini-agent design perceive --run .gemini-agent/design/<run-id> --file screenshot.png --target "main: primary content"
./bin/gemini-agent design prototype --run .gemini-agent/design/<run-id> --target-stack html
./bin/gemini-agent design handoff --run .gemini-agent/design/<run-id>
./bin/gemini-agent design loop --run .gemini-agent/design/<run-id> --actual-screenshot after.png
./bin/gemini-agent design doctor --json
```

Add feature bullets:

```md
- `design` commands create isolated design runs under `.gemini-agent/design/<run-id>/`.
- `design prototype` writes reviewable prototype code under `prototype/` only; Codex decides how to integrate it into real project files.
- `design perceive --provider palette-mask` reuses the existing Nano Banana palette-mask workflow as the first Vision-Banana-inspired perception provider.
- `design loop` keeps Codex as the source-editing authority and uses `artifact-review` for target-vs-actual visual review.
```

- [ ] **Step 2: Update package README assertions**

Add assertions in `test/package.test.mjs`:

```js
assert.match(readme, /^\.\/bin\/gemini-agent design brief --stdin --write-artifact$/m);
assert.match(readme, /^\.\/bin\/gemini-agent design prototype --run \.gemini-agent\/design\/<run-id> --target-stack html$/m);
assert.match(readme, /`design prototype` writes reviewable prototype code under `prototype\/` only/);
assert.match(readme, /Vision-Banana-inspired perception provider/);
```

- [ ] **Step 3: Ensure telemetry metadata keys are present**

In each `runDesign*` call path, telemetry metadata must include:

```js
metadata: {
  design_stage: "brief",
  actual_model: models.design_model,
}
```

Use stage values:

- `brief`
- `generate`
- `perceive`
- `prototype`
- `handoff`
- `loop`
- `doctor`

- [ ] **Step 4: Run all new design tests**

Run:

```bash
node --test test/design-*.test.mjs
```

Expected: all design tests PASS.

- [ ] **Step 5: Run full test suite**

Run:

```bash
npm test
```

Expected: all tests PASS.

- [ ] **Step 6: Run Gemini diff review**

Run:

```bash
gemini-agent diff-review --smart-diff
```

Expected: JSON with `verdict` of `pass` or `caution`. If `block`, fix the blocking issue and rerun this step.

- [ ] **Step 7: Commit final docs and metadata sweep**

```bash
git add README.md src/cli.mjs src/design-*.mjs test/design-*.test.mjs test/cli.test.mjs test/gemini-client.test.mjs test/package.test.mjs
git commit -m "Document design workflow commands"
```

## Self-Review

Spec coverage:

- Brief: Task 5.
- Generate: Task 6.
- Perceive: Task 7.
- Prototype: Task 8.
- Handoff: Task 9.
- Loop: Task 10.
- Doctor: Task 3 and Task 10.
- Model routing and fallback constraints: Task 3 and Task 4.
- Cost gates: Task 3.
- Safe run ids and prototype isolation: Task 2 and Task 8.
- Telemetry safety: Task 11.
- README and package tests: Task 11.

Completeness scan:

- Every task has a failing test, implementation step, targeted verification, and commit step.
- Live Gemini JSON calls in Task 5, Task 8, and Task 9 reference concrete schema exports from `src/design-schemas.mjs`.

Type consistency:

- All artifacts use the same `run_id` field and `kind` discriminator.
- The prototype command writes only under `prototype/`.
- `design loop` uses `loop-review.json` and does not modify source files.
