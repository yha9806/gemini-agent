# Vision Banana Compatible Visual Quality Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `vision-banana` missing-endpoint behavior clear, enrich its fallback perception route, and add candidate visual quality scoring before draft handoff.

**Architecture:** Keep `vision-banana` as the public provider name and represent fallback truth in metadata. Add focused helpers for perception route metadata and candidate quality selection rather than widening the CLI parser or putting review logic directly in `src/cli.mjs`. The first slice improves provider diagnostics and hybrid fallback; the second slice adds candidate quality artifacts and uses them in draft and handoff selection.

**Tech Stack:** Node.js ES modules, `node:test`, `zod`, existing Gemini client adapters, existing artifact-review scorecard shape, PNG fixture helpers in tests.

---

## Scope Check

The spec covers two connected subsystems: perception fallback and candidate quality. They can be implemented in two independent commits, but they share run metadata and handoff output, so one implementation plan is appropriate.

## File Map

- Modify `src/cli.mjs`: improve `design perceive` argument diagnostics, defer provider validation until all args are parsed, expose provider route metadata in JSON output, and wire quality review adapters for CLI commands.
- Modify `src/design-perceive.mjs`: return requested/resolved provider metadata, add optional visual-review enrichment for Vision Banana fallback, and preserve endpoint-backed behavior.
- Modify `src/design-schemas.mjs`: add perception `metadata` support plus a normalized candidate quality schema.
- Modify `src/design-model-router.mjs`: expose separate doctor readiness fields for endpoint, compatible fallback, and visual quality gate.
- Create `src/design-quality-gate.mjs`: score generated candidates from artifact-review scorecards, write `candidates/quality.json`, and choose the best candidate.
- Modify `src/design-generate.mjs`: optionally run the quality gate after writing candidates and return the quality artifact path.
- Modify `src/design-draft.mjs`: use quality results to select candidates and record visual quality in `draft-summary.json`.
- Modify `src/design-handoff.mjs`: read optional quality and perception artifacts and include their actionable notes in prompt and markdown output.
- Modify tests in `test/cli.test.mjs`, `test/design-perceive.test.mjs`, `test/design-model-router.test.mjs`, `test/design-generate.test.mjs`, `test/design-draft.test.mjs`, and `test/design-handoff.test.mjs`.
- Create `test/design-quality-gate.test.mjs`.

## Task 1: Perceive Parser Diagnostics

**Files:**
- Modify: `src/cli.mjs`
- Test: `test/cli.test.mjs`

- [ ] **Step 1: Add failing CLI tests for target help and order-independent provider validation**

Append these tests near the existing `design perceive` parser tests in `test/cli.test.mjs`:

```js
test("design perceive target format error explains quoting", async () => {
  await assert.rejects(
    () => execBin([
      "design",
      "perceive",
      "--run",
      "20260614T120000000Z-abcdef",
      "--file",
      "screen.png",
      "--target",
      "hero:",
    ], {
      env: { PATH: process.env.PATH, HOME: CLI_TEST_HOME, USERPROFILE: CLI_TEST_HOME },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Target must use "name: description" format/);
      assert.match(error.stderr, /quote targets with spaces/);
      assert.doesNotMatch(error.stderr, /Gemini API key/);
      return true;
    },
  );
});

test("design perceive invalid provider is rejected after parsing all args", async () => {
  await assert.rejects(
    () => execBin([
      "design",
      "perceive",
      "--provider",
      "unknown",
      "--run",
      "20260614T120000000Z-abcdef",
      "--file",
      "screen.png",
      "--target",
      "hero: main area",
    ], {
      env: { PATH: process.env.PATH, HOME: CLI_TEST_HOME, USERPROFILE: CLI_TEST_HOME },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /--provider must be auto, palette-mask, gemini-vision, or vision-banana\./);
      assert.doesNotMatch(error.stderr, /Gemini API key/);
      return true;
    },
  );
});
```

- [ ] **Step 2: Run the failing CLI tests**

Run:

```bash
npm test -- --test-name-pattern "design perceive target format error|design perceive invalid provider is rejected after parsing all args"
```

Expected: the first test fails because the target error does not mention quoting. The second test may pass already; keep it as a regression guard.

- [ ] **Step 3: Implement parser diagnostics**

In `src/cli.mjs`, add this helper near `validateDesignPerceiveTarget`:

```js
const DESIGN_PERCEIVE_TARGET_HELP = "Target values must be quoted when they contain spaces, for example: --target \"hero: main area\".";
```

Replace `validateDesignPerceiveTarget` with:

```js
function validateDesignPerceiveTarget(target) {
  const value = String(target ?? "");
  const separator = value.indexOf(":");
  if (separator < 1) {
    throw new Error(`Target must use "name: description" format: ${value}. ${DESIGN_PERCEIVE_TARGET_HELP}`);
  }
  const name = value.slice(0, separator).trim();
  const description = value.slice(separator + 1).trim();
  if (!name || !description || !/^[A-Za-z0-9_-]+$/u.test(name)) {
    throw new Error(`Target must use "name: description" format: ${value}. ${DESIGN_PERCEIVE_TARGET_HELP}`);
  }
}
```

In `parseDesignPerceiveArgs`, remove the immediate `selectPerceptionProvider({ provider: options.provider, targets: options.targets });` call from the `--provider` branch. Leave the final call after required argument checks:

```js
  if (!options.run) throw new Error("--run requires a path.");
  if (!options.file) throw new Error("--file requires a path.");
  selectPerceptionProvider({ provider: options.provider, targets: options.targets });
  return options;
```

- [ ] **Step 4: Run parser tests**

Run:

```bash
npm test -- --test-name-pattern "design perceive target format error|design perceive invalid provider is rejected after parsing all args|design perceive rejects invalid provider before auth lookup"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli.mjs test/cli.test.mjs
git commit -m "Improve design perceive argument diagnostics"
```

## Task 2: Provider Route Metadata And Missing Endpoint Error

**Files:**
- Modify: `src/design-schemas.mjs`
- Modify: `src/design-perceive.mjs`
- Modify: `src/cli.mjs`
- Test: `test/design-perceive.test.mjs`
- Test: `test/cli.test.mjs`

- [ ] **Step 1: Add failing metadata and error tests**

In `test/design-perceive.test.mjs`, update the fallback test assertions:

```js
    assert.equal(result.provider, "palette-mask");
    assert.equal(result.requestedProvider, "vision-banana");
    assert.equal(result.resolvedProvider, "palette-mask");
    assert.equal(result.fallbackUsed, true);
    assert.equal(result.fallbackReason, "missing_vision_banana_endpoint");
    assert.equal(result.perception.provider, "palette-mask");
    assert.equal(result.perception.metadata.requested_provider, "vision-banana");
    assert.equal(result.perception.metadata.resolved_provider, "palette-mask");
    assert.equal(result.perception.metadata.provider_fallback_used, true);
    assert.equal(result.perception.metadata.provider_fallback_reason, "missing_vision_banana_endpoint");
```

Replace the unconfigured test body with:

```js
test("vision-banana provider fails clearly when unconfigured without targets", async () => {
  await assert.rejects(() => runDesignPerceive({
    runDir: "/tmp/run",
    file: "screen.png",
    provider: "vision-banana",
    env: {},
  }), /Vision Banana provider is not configured.*--provider gemini-vision.*--target "header: top navigation and primary controls"/s);
});
```

In `test/cli.test.mjs`, update the endpoint-backed JSON expectation:

```js
    assert.deepEqual(parsed, {
      provider: "vision-banana",
      requested_provider: "vision-banana",
      resolved_provider: "vision-banana",
      fallback_used: false,
      perception: "perceive/perception.json",
    });
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
npm test -- --test-name-pattern "vision-banana provider falls back|vision-banana provider fails clearly|design perceive vision-banana writes perception"
```

Expected: FAIL because metadata fields and new JSON keys are not implemented.

- [ ] **Step 3: Add metadata to perception schema**

In `src/design-schemas.mjs`, add `metadata: Metadata` to `DesignPerceptionZodSchema`:

```js
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
  metadata: Metadata,
});
```

- [ ] **Step 4: Add route metadata helpers**

In `src/design-perceive.mjs`, update `perceptionDefaults`:

```js
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
```

Add:

```js
function routeMetadata({ provider, selected, providerFallbackWarning }) {
  return {
    requested_provider: provider,
    resolved_provider: selected,
    provider_fallback_used: Boolean(providerFallbackWarning),
    ...(providerFallbackWarning ? { provider_fallback_reason: "missing_vision_banana_endpoint" } : {}),
  };
}

function unconfiguredVisionBananaMessage() {
  return [
    "Vision Banana provider is not configured.",
    "Set VISION_BANANA_ENDPOINT, choose --provider gemini-vision, or add at least one quoted target for the Nano Banana palette-mask fallback:",
    "  --target \"header: top navigation and primary controls\"",
  ].join("\n");
}
```

Use the helper in the missing endpoint branch:

```js
  if (selected === "vision-banana" && !env.VISION_BANANA_ENDPOINT) {
    if (targets.length === 0) {
      throw new Error(unconfiguredVisionBananaMessage());
    }
    selected = "palette-mask";
    providerFallbackWarning = "Vision Banana endpoint missing; used palette-mask fallback.";
  }
```

When creating palette-mask perception, pass metadata:

```js
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
```

For endpoint-backed and `gemini-vision` paths, pass the same route metadata with `providerFallbackWarning` null.

Return route fields:

```js
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
```

- [ ] **Step 5: Update CLI JSON output**

In `runDesignCommand`, in the `perceive` branch, change the output object:

```js
    output.write(`${JSON.stringify({
      provider: result.provider,
      requested_provider: result.requestedProvider,
      resolved_provider: result.resolvedProvider,
      fallback_used: result.fallbackUsed,
      ...(result.fallbackReason ? { fallback_reason: result.fallbackReason } : {}),
      perception: "perceive/perception.json",
    }, null, 2)}\n`);
```

- [ ] **Step 6: Run route metadata tests**

Run:

```bash
npm test -- --test-name-pattern "vision-banana provider falls back|vision-banana provider fails clearly|design perceive vision-banana writes perception"
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/design-schemas.mjs src/design-perceive.mjs src/cli.mjs test/design-perceive.test.mjs test/cli.test.mjs
git commit -m "Record design perceive provider route metadata"
```

## Task 3: Hybrid Fallback Perception Enrichment

**Files:**
- Modify: `src/design-perceive.mjs`
- Test: `test/design-perceive.test.mjs`

- [ ] **Step 1: Add failing enrichment tests**

In `test/design-perceive.test.mjs`, add:

```js
test("vision-banana fallback enriches palette perception with visual review", async () => {
  const dir = await mkdtemp(join(tmpdir(), "design-perceive-"));
  try {
    const image = join(dir, "screen.png");
    await writeFile(image, PNG.sync.write(new PNG({ width: 2, height: 2 })));
    await writeBrief(dir);

    const result = await runDesignPerceive({
      runDir: dir,
      file: image,
      provider: "vision-banana",
      targets: ["hero: main visual area"],
      apiKey: "key",
      env: {},
      paletteSplit: async ({ outputDir }) => {
        const manifest = {
          contact_sheet: "contact_sheet.png",
          layers: [{ name: "hero", file: "layers/hero.png" }],
          warnings: ["mask edge is soft"],
        };
        await writeFile(join(outputDir, "manifest.json"), `${JSON.stringify(manifest)}\n`);
        return { outputDir, manifest };
      },
      reviewPerception: async ({ sourceImagePath, contactSheetPath, targets }) => {
        assert.equal(sourceImagePath, image);
        assert.match(contactSheetPath, /contact_sheet\.png$/);
        assert.deepEqual(targets, ["hero: main visual area"]);
        return {
          layout_observations: ["Hero has weak contrast against the page background"],
          implementation_constraints: ["Increase vertical spacing around the primary CTA"],
          hierarchy: ["hero"],
          warnings: ["Visual review saw low contrast"],
          confidence: 0.7,
        };
      },
    });

    assert.equal(result.perception.metadata.perception_enrichment, "visual-review");
    assert.match(result.perception.layout_observations.join("\n"), /weak contrast/);
    assert.match(result.perception.implementation_constraints.join("\n"), /vertical spacing/);
    assert.match(result.perception.warnings.join("\n"), /mask edge is soft/);
    assert.match(result.perception.warnings.join("\n"), /low contrast/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("vision-banana fallback preserves perception when visual review fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "design-perceive-"));
  try {
    const image = join(dir, "screen.png");
    await writeFile(image, PNG.sync.write(new PNG({ width: 2, height: 2 })));
    await writeBrief(dir);

    const result = await runDesignPerceive({
      runDir: dir,
      file: image,
      provider: "vision-banana",
      targets: ["hero: main visual area"],
      apiKey: "key",
      env: {},
      paletteSplit: async ({ outputDir }) => {
        const manifest = { layers: [{ name: "hero", file: "layers/hero.png" }], warnings: [] };
        await writeFile(join(outputDir, "manifest.json"), `${JSON.stringify(manifest)}\n`);
        return { outputDir, manifest };
      },
      reviewPerception: async () => {
        throw new Error("review unavailable");
      },
    });

    assert.equal(result.perception.regions[0].id, "hero");
    assert.equal(result.perception.metadata.perception_enrichment, "unavailable");
    assert.match(result.perception.warnings.join("\n"), /Visual review enrichment failed: review unavailable/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run failing enrichment tests**

Run:

```bash
npm test -- --test-name-pattern "vision-banana fallback enriches|vision-banana fallback preserves perception"
```

Expected: FAIL because `reviewPerception` is not used.

- [ ] **Step 3: Implement enrichment helpers**

In `src/design-perceive.mjs`, add:

```js
function stringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.trim()) : [];
}

function manifestContactSheetPath(outputDir, manifest) {
  return typeof manifest?.contact_sheet === "string" && manifest.contact_sheet.trim()
    ? join(outputDir, manifest.contact_sheet)
    : null;
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
      hierarchy: stringArray(review.hierarchy).length > 0 ? stringArray(review.hierarchy) : perception.hierarchy,
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
```

Add `reviewPerception` to `runDesignPerceive` parameters:

```js
  reviewPerception,
```

After creating palette-mask perception, call enrichment only for Vision Banana fallback:

```js
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
```

- [ ] **Step 4: Run perceive tests**

Run:

```bash
npm test -- test/design-perceive.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/design-perceive.mjs test/design-perceive.test.mjs
git commit -m "Enrich Vision Banana fallback perception"
```

## Task 4: Doctor Readiness Fields

**Files:**
- Modify: `src/design-model-router.mjs`
- Test: `test/design-model-router.test.mjs`
- Test: `test/cli.test.mjs`

- [ ] **Step 1: Add failing doctor readiness assertions**

In `test/design-model-router.test.mjs`, update the fallback test:

```js
  assert.equal(report.required_env.vision_banana_compatible_fallback, "available");
  assert.equal(report.required_env.visual_quality_gate, "available");
```

In `test/cli.test.mjs`, inside `design doctor reports model state without auth lookup or live probe`, add:

```js
  assert.equal(parsed.required_env.vision_banana_compatible_fallback, "available");
  assert.equal(parsed.required_env.visual_quality_gate, "available");
```

- [ ] **Step 2: Run failing doctor tests**

Run:

```bash
npm test -- --test-name-pattern "doctor reports Nano Banana|design doctor reports model state"
```

Expected: FAIL because new fields are absent.

- [ ] **Step 3: Implement readiness fields**

In `src/design-model-router.mjs`, add the new fields to `required_env`:

```js
      vision_banana_compatible_fallback: "available",
      visual_quality_gate: "available",
```

Keep `vision_banana_endpoint` and `vision_banana_provider` unchanged.

- [ ] **Step 4: Run doctor tests**

Run:

```bash
npm test -- test/design-model-router.test.mjs --test-name-pattern "doctor reports"
npm test -- test/cli.test.mjs --test-name-pattern "design doctor reports model state"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/design-model-router.mjs test/design-model-router.test.mjs test/cli.test.mjs
git commit -m "Report visual fallback readiness in design doctor"
```

## Task 5: Candidate Quality Gate Module

**Files:**
- Create: `src/design-quality-gate.mjs`
- Modify: `src/design-schemas.mjs`
- Test: `test/design-quality-gate.test.mjs`

- [ ] **Step 1: Add failing quality gate tests**

Create `test/design-quality-gate.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runDesignCandidateQualityGate,
  scoreCandidateReview,
  selectCandidateFromQuality,
} from "../src/design-quality-gate.mjs";

const runId = "20260614T120000000Z-abcdef";

async function writeManifest(dir) {
  await mkdir(join(dir, "candidates"), { recursive: true });
  await writeFile(join(dir, "candidates", "candidate-a.png"), "a");
  await writeFile(join(dir, "candidates", "candidate-b.png"), "b");
  await writeFile(join(dir, "candidates", "manifest.json"), `${JSON.stringify({
    kind: "design_candidates",
    run_id: runId,
    candidates: [
      {
        id: "candidate-a",
        file: "candidate-a.png",
        model: "image-model",
        prompt_hash: "aaa",
        status: "success",
        image_size: null,
        aspect_ratio: null,
        warnings: [],
      },
      {
        id: "candidate-b",
        file: "candidate-b.png",
        model: "image-model",
        prompt_hash: "bbb",
        status: "success",
        image_size: null,
        aspect_ratio: null,
        warnings: [],
      },
    ],
  })}\n`);
}

function review(overrides = {}) {
  return {
    design_scorecard: {
      overall_score: 82,
      visual_hierarchy_score: 80,
      clarity_score: 84,
      accessibility_score: 78,
      consistency_score: 81,
      implementation_readiness_score: 79,
      strengths: ["Clear hierarchy"],
      issues: ["CTA contrast could be stronger"],
      recommended_actions: ["Increase CTA contrast"],
      ...overrides,
    },
  };
}

test("scoreCandidateReview maps scorecard to pass warn and fail statuses", () => {
  assert.deepEqual(scoreCandidateReview({ candidateId: "a", file: "a.png", review: review() }), {
    id: "a",
    file: "a.png",
    score: 81,
    status: "pass",
    strengths: ["Clear hierarchy"],
    issues: ["CTA contrast could be stronger"],
    recommended_actions: ["Increase CTA contrast"],
    warnings: [],
  });
  assert.equal(scoreCandidateReview({
    candidateId: "b",
    file: "b.png",
    review: review({ overall_score: 68 }),
  }).status, "warn");
  assert.equal(scoreCandidateReview({
    candidateId: "c",
    file: "c.png",
    review: review({ overall_score: 49 }),
  }).status, "fail");
});

test("runDesignCandidateQualityGate writes quality artifact and selects best pass", async () => {
  const dir = await mkdtemp(join(tmpdir(), "design-quality-"));
  try {
    await writeManifest(dir);
    const reviewed = [];
    const result = await runDesignCandidateQualityGate({
      runDir: dir,
      reviewCandidate: async ({ candidate }) => {
        reviewed.push(candidate.id);
        return candidate.id === "candidate-a"
          ? review({ overall_score: 66 })
          : review({ overall_score: 88 });
      },
    });

    assert.deepEqual(reviewed, ["candidate-a", "candidate-b"]);
    assert.equal(result.quality.selected_candidate, "candidate-b");
    assert.equal(result.quality.candidates[0].status, "warn");
    assert.equal(result.quality.candidates[1].status, "pass");
    const written = JSON.parse(await readFile(join(dir, "candidates", "quality.json"), "utf8"));
    assert.equal(written.kind, "design_candidate_quality");
    assert.equal(written.selected_candidate, "candidate-b");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("selectCandidateFromQuality preserves run when all candidates fail", () => {
  assert.equal(selectCandidateFromQuality({
    candidates: [
      { id: "candidate-a", score: 42, status: "fail" },
      { id: "candidate-b", score: 55, status: "fail" },
    ],
  }), null);
});
```

- [ ] **Step 2: Run failing quality tests**

Run:

```bash
npm test -- test/design-quality-gate.test.mjs
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Add candidate quality schema**

In `src/design-schemas.mjs`, add:

```js
export const DesignCandidateQualityZodSchema = z.object({
  kind: Kind("design_candidate_quality"),
  run_id: RunId,
  selected_candidate: z.string().nullable().default(null),
  candidates: z.array(z.object({
    id: NonEmptyString,
    file: NonEmptyString,
    score: z.number().int().min(0).max(100).nullable().default(null),
    status: z.enum(["pass", "warn", "fail", "unavailable"]),
    strengths: StringList,
    issues: StringList,
    recommended_actions: StringList,
    warnings: StringList,
  })).default([]),
  warnings: StringList,
  metadata: Metadata,
});
```

Add an exported normalizer near the existing normalizers:

```js
export function normalizeDesignCandidateQuality(value) {
  return normalizeWith(DesignCandidateQualityZodSchema, value, "design candidate quality");
}
```

- [ ] **Step 4: Implement quality gate module**

Create `src/design-quality-gate.mjs`:

```js
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { normalizeDesignCandidateManifest, normalizeDesignCandidateQuality } from "./design-schemas.mjs";
import { writeDesignJson } from "./design-run-store.mjs";

const SCORE_FIELDS = [
  "overall_score",
  "visual_hierarchy_score",
  "clarity_score",
  "accessibility_score",
  "consistency_score",
  "implementation_readiness_score",
];

function numericScores(scorecard = {}) {
  return SCORE_FIELDS
    .map((field) => scorecard[field])
    .filter((value) => Number.isInteger(value) && value >= 0 && value <= 100);
}

function averageScore(scores) {
  if (scores.length === 0) return null;
  return Math.round(scores.reduce((total, value) => total + value, 0) / scores.length);
}

function statusForScore(score) {
  if (!Number.isInteger(score)) return "unavailable";
  if (score >= 80) return "pass";
  if (score >= 60) return "warn";
  return "fail";
}

function stringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.trim()) : [];
}

export function scoreCandidateReview({ candidateId, file, review }) {
  const scorecard = review?.design_scorecard && typeof review.design_scorecard === "object"
    ? review.design_scorecard
    : {};
  const score = averageScore(numericScores(scorecard));
  return {
    id: candidateId,
    file,
    score,
    status: statusForScore(score),
    strengths: stringList(scorecard.strengths),
    issues: stringList(scorecard.issues),
    recommended_actions: stringList(scorecard.recommended_actions),
    warnings: score === null ? ["Artifact review did not provide numeric design scorecard values."] : [],
  };
}

export function selectCandidateFromQuality(quality) {
  const candidates = Array.isArray(quality?.candidates) ? quality.candidates : [];
  const usable = candidates
    .filter((candidate) => candidate.status === "pass" || candidate.status === "warn")
    .sort((left, right) => (right.score ?? -1) - (left.score ?? -1));
  return usable[0]?.id ?? null;
}

export async function runDesignCandidateQualityGate({
  runDir,
  reviewCandidate,
  telemetry,
} = {}) {
  if (!runDir) throw new Error("runDir is required.");
  if (typeof reviewCandidate !== "function") throw new Error("reviewCandidate is required.");

  const resolvedRunDir = resolve(runDir);
  const manifest = normalizeDesignCandidateManifest(JSON.parse(
    await readFile(join(resolvedRunDir, "candidates", "manifest.json"), "utf8"),
  ));
  const outputDir = join(resolvedRunDir, "candidates");
  await mkdir(outputDir, { recursive: true });

  const qualityCandidates = [];
  const warnings = [];
  for (const candidate of manifest.candidates) {
    if (candidate.status !== "success") {
      qualityCandidates.push({
        id: candidate.id,
        file: candidate.file,
        score: null,
        status: "unavailable",
        strengths: [],
        issues: [],
        recommended_actions: [],
        warnings: ["Candidate generation did not succeed."],
      });
      continue;
    }
    try {
      const review = await reviewCandidate({
        candidate,
        filePath: join(outputDir, candidate.file),
        telemetry,
      });
      qualityCandidates.push(scoreCandidateReview({
        candidateId: candidate.id,
        file: candidate.file,
        review,
      }));
    } catch (error) {
      const message = `Candidate quality review failed for ${candidate.id}: ${error.message}`;
      warnings.push(message);
      qualityCandidates.push({
        id: candidate.id,
        file: candidate.file,
        score: null,
        status: "unavailable",
        strengths: [],
        issues: [],
        recommended_actions: [],
        warnings: [message],
      });
    }
  }

  const selected = selectCandidateFromQuality({ candidates: qualityCandidates });
  const quality = normalizeDesignCandidateQuality({
    kind: "design_candidate_quality",
    run_id: manifest.run_id,
    selected_candidate: selected,
    candidates: qualityCandidates,
    warnings,
    metadata: {
      quality_gate: "artifact-review",
    },
  });
  const qualityPath = await writeDesignJson({
    runDir: resolvedRunDir,
    relativePath: join("candidates", "quality.json"),
    value: quality,
  });
  return { quality, qualityPath };
}
```

- [ ] **Step 5: Run quality gate tests**

Run:

```bash
npm test -- test/design-quality-gate.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/design-schemas.mjs src/design-quality-gate.mjs test/design-quality-gate.test.mjs
git commit -m "Add design candidate quality gate"
```

## Task 6: Wire Quality Gate Into Generate And Draft

**Files:**
- Modify: `src/design-generate.mjs`
- Modify: `src/design-draft.mjs`
- Modify: `src/cli.mjs`
- Test: `test/design-generate.test.mjs`
- Test: `test/design-draft.test.mjs`
- Test: `test/cli.test.mjs`

- [ ] **Step 1: Add failing generation and draft tests**

In `test/design-generate.test.mjs`, add:

```js
test("runDesignGenerate can run candidate quality gate after image generation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "design-generate-"));
  try {
    await writeBrief(dir);
    const result = await runDesignGenerate({
      runDir: dir,
      variants: 1,
      quality: "fast",
      apiKey: "key",
      generateImage: async () => ({ mimeType: "image/png", buffer: Buffer.from("image") }),
      qualityGate: async ({ runDir }) => ({
        quality: {
          kind: "design_candidate_quality",
          run_id: "20260614T120000000Z-abcdef",
          selected_candidate: "candidate-a",
          candidates: [{
            id: "candidate-a",
            file: "candidate-a.png",
            score: 84,
            status: "pass",
            strengths: ["Clear hierarchy"],
            issues: [],
            recommended_actions: [],
            warnings: [],
          }],
          warnings: [],
          metadata: {},
        },
        qualityPath: join(runDir, "candidates", "quality.json"),
      }),
      env: { GEMINI_IMAGE_MODEL: "configured-image-model" },
    });

    assert.equal(result.quality.selected_candidate, "candidate-a");
    assert.equal(result.qualityPath, join(dir, "candidates", "quality.json"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

In `test/design-draft.test.mjs`, add:

```js
test("runDesignDraft selects highest passing quality candidate", async () => {
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
      runners: {
        brief: () => makeBriefRun(cwd),
        generate: async () => ({
          manifest: {
            candidates: [
              { id: "candidate-a", file: "candidate-a.png" },
              { id: "candidate-b", file: "candidate-b.png" },
            ],
          },
          quality: {
            selected_candidate: "candidate-b",
            candidates: [
              { id: "candidate-a", score: 69, status: "warn", issues: ["Flat hierarchy"] },
              { id: "candidate-b", score: 88, status: "pass", issues: [] },
            ],
          },
        }),
        prototype: async (input) => {
          calls.push(["prototype", input.selectedCandidate]);
          return { manifest: { preview_entry: "preview.html" } };
        },
        handoff: async (input) => {
          calls.push(["handoff", input.selectedCandidate]);
          return { handoff: { implementation_summary: "Update dashboard cards." } };
        },
      },
    });

    assert.equal(result.selected_candidate, "candidate-b");
    assert.equal(result.candidate_quality.status, "pass");
    assert.deepEqual(calls, [["prototype", "candidate-b"], ["handoff", "candidate-b"]]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runDesignDraft preserves run when all generated candidates fail quality", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "design-draft-"));
  try {
    await assert.rejects(
      () => runDesignDraft({
        cwd,
        inputText: "Design a telemetry dashboard",
        apiKey: "key",
        env: {
          GEMINI_DESIGN_MODEL: "configured-design-model",
          GEMINI_IMAGE_MODEL: "configured-image-model",
        },
        runners: {
          brief: () => makeBriefRun(cwd),
          generate: async () => ({
            manifest: { candidates: [{ id: "candidate-a", file: "candidate-a.png" }] },
            quality: {
              selected_candidate: null,
              candidates: [{ id: "candidate-a", score: 45, status: "fail", issues: ["Unreadable text"] }],
            },
          }),
        },
      }),
      /All generated design candidates failed the visual quality gate/,
    );
    const summary = JSON.parse(await readFile(
      join(cwd, ".gemini-agent", "design", "20260614T120000000Z-abcdef", "draft-summary.json"),
      "utf8",
    ));
    assert.equal(summary.status, "partial_failure");
    assert.match(summary.warnings.join("\n"), /visual quality gate/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
npm test -- --test-name-pattern "quality gate|highest passing quality|all generated candidates fail"
```

Expected: FAIL because generate and draft do not use quality output.

- [ ] **Step 3: Update generation result**

Add parameters:

```js
  qualityGate,
```

After writing the manifest, run the gate only when provided:

```js
  const gate = typeof qualityGate === "function"
    ? await qualityGate({
      runDir: resolvedRunDir,
      manifest,
      apiKey,
      env,
      telemetry,
    })
    : null;
  return {
    manifest,
    outputDir,
    manifestPath,
    ...(gate ? { quality: gate.quality, qualityPath: gate.qualityPath } : {}),
  };
```

Do not call `runDesignCandidateQualityGate` directly in this module until the CLI adapter is added; keeping the injected gate preserves unit-test isolation.

- [ ] **Step 4: Add draft quality selection**

In `src/design-draft.mjs`, add:

```js
function qualityCandidateById(quality, candidateId) {
  const candidates = Array.isArray(quality?.candidates) ? quality.candidates : [];
  return candidates.find((candidate) => candidate.id === candidateId) ?? null;
}

function chooseGeneratedCandidate(generated) {
  const qualitySelected = typeof generated?.quality?.selected_candidate === "string"
    ? generated.quality.selected_candidate
    : null;
  if (generated?.quality && qualitySelected === null) {
    throw new Error("All generated design candidates failed the visual quality gate.");
  }
  return qualitySelected || generated?.manifest?.candidates?.[0]?.id || null;
}
```

In `runDesignDraft`, replace:

```js
      selectedCandidate = generated.manifest?.candidates?.[0]?.id ?? null;
      steps.push(step("generate", "success", { selected_candidate: selectedCandidate }));
```

with:

```js
      selectedCandidate = chooseGeneratedCandidate(generated);
      const selectedQuality = qualityCandidateById(generated.quality, selectedCandidate);
      steps.push(step("generate", "success", {
        selected_candidate: selectedCandidate,
        ...(selectedQuality ? {
          candidate_quality_status: selectedQuality.status,
          candidate_quality_score: selectedQuality.score,
        } : {}),
      }));
```

Track `selectedCandidateQuality` in the outer scope and add it to the success summary:

```js
  let selectedCandidateQuality = null;
```

Assign it after selection:

```js
      selectedCandidateQuality = qualityCandidateById(generated.quality, selectedCandidate);
```

Add to success summary:

```js
      ...(selectedCandidateQuality ? { candidate_quality: selectedCandidateQuality } : {}),
```

Add to telemetry metadata in `telemetrySuccessMetadata` parameters and return object:

```js
  selectedCandidateQuality,
```

```js
    candidate_quality_status: selectedCandidateQuality?.status ?? null,
    candidate_quality_score: selectedCandidateQuality?.score ?? null,
```

- [ ] **Step 5: Add a draft quality gate parameter**

In `src/design-draft.mjs`, add `qualityGate = null` to the `runDesignDraft` parameters:

```js
  qualityGate = null,
```

Pass it into `runGenerate`:

```js
      const generated = await runGenerate({
        runDir: run.dir,
        variants,
        quality,
        apiKey,
        env,
        allowFakeResponse,
        qualityGate,
        telemetry: {
          ...telemetry,
          cwd,
          source: telemetry?.source || "cli",
          command: "design-generate",
        },
      });
```

- [ ] **Step 6: Wire CLI quality gate adapter**

In `src/cli.mjs`, import:

```js
import { runDesignCandidateQualityGate } from "./design-quality-gate.mjs";
```

Add a small adapter near design command helpers:

```js
function designCandidateQualityGate({ apiKey, env, telemetry }) {
  return ({ runDir }) => runDesignCandidateQualityGate({
    runDir,
    telemetry: {
      ...telemetry,
      command: "design-candidate-quality",
      metadata: {
        ...(telemetry?.metadata && typeof telemetry.metadata === "object" ? telemetry.metadata : {}),
        design_stage: "candidate-quality",
      },
    },
    reviewCandidate: async ({ filePath }) => runArtifactReview({
      apiKey,
      env,
      file: filePath,
      artifactKind: "design",
      reviewDepth: "quick",
      telemetry,
    }),
  });
}
```

Pass it to `runDesignDraft`:

```js
      qualityGate: designCandidateQualityGate({
        apiKey: key.key,
        env: process.env,
        telemetry: { cwd: process.cwd(), source: "cli", command: "design-generate" },
      }),
```

Pass the same adapter to standalone `design generate` and add output fields:

```js
    output.write(`${JSON.stringify({
      candidates: result.manifest.candidates.length,
      manifest: "candidates/manifest.json",
      ...(result.quality ? {
        quality: "candidates/quality.json",
        selected_candidate: result.quality.selected_candidate,
      } : {}),
    }, null, 2)}\n`);
```

- [ ] **Step 7: Run generate and draft tests**

Run:

```bash
npm test -- test/design-generate.test.mjs test/design-draft.test.mjs
```

Expected: PASS.

- [ ] **Step 8: Run CLI design tests touched by this task**

Run:

```bash
npm test -- test/cli.test.mjs --test-name-pattern "design generate|design draft"
```

Expected: PASS. If fake image bytes make artifact review impossible in existing CLI tests, ensure test paths pass `--skip-generate` or use fake response fixtures that produce schema-valid artifact review output.

- [ ] **Step 9: Commit**

```bash
git add src/design-generate.mjs src/design-draft.mjs src/cli.mjs test/design-generate.test.mjs test/design-draft.test.mjs test/cli.test.mjs
git commit -m "Use quality gate for design candidate selection"
```

## Task 7: Handoff Quality And Perception Notes

**Files:**
- Modify: `src/design-handoff.mjs`
- Test: `test/design-handoff.test.mjs`

- [ ] **Step 1: Add failing handoff context test**

In `test/design-handoff.test.mjs`, add:

```js
test("runDesignHandoff includes candidate quality and perception fallback notes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "design-handoff-"));
  try {
    await writeBrief(dir);
    await mkdir(join(dir, "candidates"), { recursive: true });
    await mkdir(join(dir, "perceive"), { recursive: true });
    await writeFile(join(dir, "candidates", "quality.json"), `${JSON.stringify({
      kind: "design_candidate_quality",
      run_id: "20260614T120000000Z-abcdef",
      selected_candidate: "candidate-a",
      candidates: [{
        id: "candidate-a",
        file: "candidate-a.png",
        score: 72,
        status: "warn",
        strengths: ["Clear card grouping"],
        issues: ["CTA contrast is weak"],
        recommended_actions: ["Increase CTA contrast before implementation"],
        warnings: [],
      }],
      warnings: [],
      metadata: {},
    })}\n`);
    await writeFile(join(dir, "perceive", "perception.json"), `${JSON.stringify({
      kind: "design_perception",
      run_id: "20260614T120000000Z-abcdef",
      provider: "palette-mask",
      source: "candidate-a.png",
      regions: [],
      hierarchy: [],
      layout_observations: [],
      implementation_constraints: [],
      confidence: null,
      warnings: [],
      metadata: {
        requested_provider: "vision-banana",
        resolved_provider: "palette-mask",
        provider_fallback_used: true,
        provider_fallback_reason: "missing_vision_banana_endpoint",
      },
    })}\n`);

    const result = await runDesignHandoff({
      runDir: dir,
      apiKey: "key",
      selectedCandidate: "candidate-a",
      env: { GEMINI_DESIGN_MODEL: "configured-design-model" },
      generate: async ({ prompt }) => {
        assert.match(prompt, /Candidate quality: warn 72/);
        assert.match(prompt, /CTA contrast is weak/);
        assert.match(prompt, /Dedicated Vision Banana endpoint was not used/);
        return generatedHandoff({ risk_notes: [] });
      },
    });

    assert.match(result.handoff.risk_notes.join("\n"), /Candidate quality: warn 72/);
    assert.match(result.handoff.risk_notes.join("\n"), /Dedicated Vision Banana endpoint was not used/);
    const markdown = await readFile(join(dir, "codex-tasks.md"), "utf8");
    assert.match(markdown, /Candidate quality: warn 72/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

Update the import at the top of `test/design-handoff.test.mjs` so the test can create those directories:

```js
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
```

- [ ] **Step 2: Run failing handoff test**

Run:

```bash
npm test -- test/design-handoff.test.mjs --test-name-pattern "candidate quality and perception fallback"
```

Expected: FAIL because handoff does not read quality or perception artifacts.

- [ ] **Step 3: Implement optional artifact readers**

In `src/design-handoff.mjs`, update imports:

```js
import { mkdir, readFile, writeFile } from "node:fs/promises";
```

If `mkdir` is not needed in implementation, keep only existing imports and add it only in tests.

Add helpers:

```js
async function readJsonIfExists(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

function selectedQualitySummary(quality, selectedCandidate) {
  const candidates = Array.isArray(quality?.candidates) ? quality.candidates : [];
  const candidate = candidates.find((item) => item.id === selectedCandidate);
  if (!candidate) return null;
  const issues = Array.isArray(candidate.issues) ? candidate.issues.slice(0, 3) : [];
  const actions = Array.isArray(candidate.recommended_actions) ? candidate.recommended_actions.slice(0, 3) : [];
  return {
    note: `Candidate quality: ${candidate.status} ${candidate.score ?? "unscored"}`,
    issues,
    actions,
  };
}

function perceptionFallbackSummary(perception) {
  const metadata = plainObject(perception?.metadata);
  if (metadata.provider_fallback_used !== true) return null;
  return `Dedicated Vision Banana endpoint was not used; requested ${metadata.requested_provider}, resolved ${metadata.resolved_provider}, reason ${metadata.provider_fallback_reason}.`;
}
```

Update `buildDesignHandoffPrompt` signature and lines:

```js
function buildDesignHandoffPrompt({ brief, selectedCandidate, qualitySummary, fallbackSummary }) {
```

Add before the final instruction:

```js
    ...(qualitySummary ? [
      `${qualitySummary.note}.`,
      `Candidate quality issues: ${listSummary(qualitySummary.issues)}`,
      `Candidate quality actions: ${listSummary(qualitySummary.actions)}`,
    ] : []),
    ...(fallbackSummary ? [fallbackSummary] : []),
```

In `runDesignHandoff`, after `selected`:

```js
  const quality = await readJsonIfExists(join(resolvedRunDir, "candidates", "quality.json"));
  const perception = await readJsonIfExists(join(resolvedRunDir, "perceive", "perception.json"));
  const qualitySummary = selectedQualitySummary(quality, selected);
  const fallbackSummary = perceptionFallbackSummary(perception);
  const prompt = buildDesignHandoffPrompt({
    brief,
    selectedCandidate: selected,
    qualitySummary,
    fallbackSummary,
  });
```

After normalizing handoff, append notes:

```js
  const enrichedRiskNotes = [
    ...handoff.risk_notes,
    ...(qualitySummary ? [
      qualitySummary.note,
      ...qualitySummary.issues.map((issue) => `Quality issue: ${issue}`),
      ...qualitySummary.actions.map((action) => `Quality action: ${action}`),
    ] : []),
    ...(fallbackSummary ? [fallbackSummary] : []),
  ];
  const enrichedHandoff = normalizeDesignHandoff({
    ...handoff,
    risk_notes: enrichedRiskNotes,
  });
```

Write and return `enrichedHandoff` instead of `handoff`.

- [ ] **Step 4: Run handoff tests**

Run:

```bash
npm test -- test/design-handoff.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/design-handoff.mjs test/design-handoff.test.mjs
git commit -m "Include visual quality notes in design handoff"
```

## Task 8: Full Verification And Gemini Precheck

**Files:**
- No code files unless fixing test failures from earlier tasks.

- [ ] **Step 1: Run focused design test suite**

Run:

```bash
npm test -- test/design-perceive.test.mjs test/design-quality-gate.test.mjs test/design-generate.test.mjs test/design-draft.test.mjs test/design-handoff.test.mjs test/design-model-router.test.mjs
```

Expected: PASS.

- [ ] **Step 2: Run full test suite**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 3: Run diff check**

Run:

```bash
git diff --check
```

Expected: no output and exit code 0.

- [ ] **Step 4: Run Gemini diff review when dependencies and auth are available**

Run:

```bash
node src/cli.mjs diff-review --smart-diff
```

Expected: a concise diff review. If it fails because dependencies are not installed, run `npm install` first if project policy permits dependency installation in this worktree. If it fails because Gemini auth is unavailable, record that in the handoff and continue with local tests as the blocking verification.

- [ ] **Step 5: Commit verification fixes only if needed**

If Task 8 required fixes, commit them:

```bash
git add src test
git commit -m "Stabilize Vision Banana quality loop tests"
```

If no fixes were needed, do not create an empty commit.
