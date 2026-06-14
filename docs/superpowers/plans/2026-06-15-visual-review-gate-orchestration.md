# Visual Review Gate Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a risk-based `gemini-agent visual gate` command that composes local screenshot smoke checks, optional Gemini `artifact-review`, safe telemetry, design-loop integration, and active policy routing guidance.

**Architecture:** Add focused visual-gate modules instead of expanding `artifact-review` into an orchestrator. `visual-gate` owns routing, smoke checks, verdict decisions, and output sanitization; it calls `runArtifactReview` for Gemini review and reuses existing telemetry capture. CLI, design loop, README, and active policy become thin integration layers.

**Tech Stack:** Node.js ESM, `node:test`, `zod`, existing `pngjs` and `jpeg-js` image helpers, existing Gemini client and telemetry queue.

---

## File Structure

- Create `src/visual-gate-schemas.mjs`
  - Zod schemas, constants, safe normalization, JSON formatting.
  - Owns allowed verdicts, review postures, risk levels, issue categories, and media-summary shape.
- Create `src/visual-gate-routing.mjs`
  - Pure routing policy for required, recommended, and skipped visual gates.
  - Takes risk hints and task traits; returns `risk_level`, `routing`, and safe reason codes.
- Create `src/visual-gate-smoke.mjs`
  - Local-only screenshot checks.
  - Uses `resolveCwdFilePath`, `detectArtifactMime`, `stat`, `imageDimensions`, and PNG decoding where available.
- Create `src/visual-gate.mjs`
  - Orchestrates smoke checks, optional Gemini review, decision rules, safe telemetry metadata, and output normalization.
- Create `test/visual-gate.test.mjs`
  - Unit and integration-style tests for schemas, routing, smoke checks, orchestration, and telemetry metadata.
- Modify `src/cli.mjs`
  - Add `gemini-agent visual gate` parser, pre-auth validation, usage text, and dispatch.
- Modify `test/cli.test.mjs`
  - CLI coverage for smoke-only, single review, comparison review, invalid args, and output sanitization.
- Modify `src/design-schemas.mjs`
  - Add optional `visual_gate` field to `design_loop_review`.
- Modify `src/design-loop.mjs`
  - Use visual gate for target-vs-actual decisioning while preserving existing artifact-review data.
- Modify `test/design-loop.test.mjs`
  - Verify loop review includes gate verdict.
- Modify `src/telemetry-summary.mjs`
  - Add aggregate `visual_gate` section from safe metadata.
- Modify `test/telemetry-summary.test.mjs`
  - Verify aggregate visual-gate counts and no raw content exposure.
- Modify `src/codex-global-install.mjs`
  - Update active policy to route high-risk visual work through `visual gate`.
- Modify `test/codex-global-install.test.mjs`
  - Assert policy includes `visual gate` and screenshot evidence boundary.
- Modify `README.md` and `test/package.test.mjs`
  - Document command examples and safety notes.

---

### Task 1: Visual Gate Schemas And Decision Rules

**Files:**
- Create: `src/visual-gate-schemas.mjs`
- Create: `src/visual-gate-routing.mjs`
- Create: `test/visual-gate.test.mjs`

- [ ] **Step 1: Write failing schema and decision tests**

Append this initial test file:

```js
import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeVisualGateResult,
  visualGateToPrettyJson,
  visualGateVerdictFromSignals,
} from "../src/visual-gate-schemas.mjs";
import { classifyVisualGateRoute } from "../src/visual-gate-routing.mjs";

test("classifyVisualGateRoute requires visual gate for design implementation", () => {
  const route = classifyVisualGateRoute({
    riskHints: ["design-implementation"],
    traits: { hasTargetScreenshot: true, hasActualScreenshot: true },
  });

  assert.equal(route.routing, "required");
  assert.equal(route.risk_level, "high");
  assert.deepEqual(route.risk_reasons, ["design_implementation", "target_actual_comparison"]);
});

test("classifyVisualGateRoute skips backend-only work", () => {
  const route = classifyVisualGateRoute({
    riskHints: ["backend-only"],
    traits: { hasTargetScreenshot: false, hasActualScreenshot: false },
  });

  assert.equal(route.routing, "skip");
  assert.equal(route.risk_level, "low");
  assert.deepEqual(route.risk_reasons, ["backend_only"]);
});

test("classifyVisualGateRoute handles malformed inputs as low risk", () => {
  const route = classifyVisualGateRoute({
    riskHints: "design-implementation",
    traits: null,
  });

  assert.equal(route.routing, "skip");
  assert.equal(route.risk_level, "low");
  assert.deepEqual(route.risk_reasons, ["no_visual_risk_hint"]);
});

test("visualGateVerdictFromSignals blocks hard issue categories before score averages", () => {
  const verdict = visualGateVerdictFromSignals({
    routing: "required",
    smokeStatus: "pass",
    scorecard: { implementation_readiness_score: 92, accessibility_score: 91 },
    issues: [{ category: "blank_or_missing_render", severity: "high" }],
  });

  assert.equal(verdict, "block");
});

test("visualGateVerdictFromSignals cautions weak accessibility", () => {
  const verdict = visualGateVerdictFromSignals({
    routing: "required",
    smokeStatus: "pass",
    scorecard: { implementation_readiness_score: 75, accessibility_score: 52 },
    issues: [],
  });

  assert.equal(verdict, "caution");
});

test("normalizeVisualGateResult rejects unsafe media names and paths", () => {
  assert.throws(
    () => normalizeVisualGateResult({
      kind: "visual_review_gate",
      verdict: "pass",
      review_posture: "smoke_only",
      risk_level: "low",
      risk_reasons: [],
      smoke: { status: "pass", checks: [] },
      artifact_review: { used: false, mode: null, depth: null, fallback_used: false, scorecard: null },
      issues: [],
      next_actions: [],
      limitations: [],
      metadata: {
        generated_at: "2026-06-15T00:00:00.000Z",
        artifact_review_readiness_status: "unknown",
        media_summary: [{ role: "actual", basename: "private.png", mime_type: "image/png" }],
      },
    }),
    /Unrecognized key: "basename"/,
  );
});

test("visualGateToPrettyJson emits stable safe JSON", () => {
  const text = visualGateToPrettyJson({
    kind: "visual_review_gate",
    verdict: "pass",
    review_posture: "smoke_only",
    risk_level: "low",
    risk_reasons: [],
    smoke: { status: "pass", checks: [{ name: "file_readable", status: "pass", evidence: "1 file checked" }] },
    artifact_review: { used: false, mode: null, depth: null, fallback_used: false, scorecard: null },
    issues: [],
    next_actions: [],
    limitations: [],
    metadata: {
      generated_at: "2026-06-15T00:00:00.000Z",
      artifact_review_readiness_status: "unknown",
      media_summary: [{ role: "actual", mime_type: "image/png", byte_size: 8, width: null, height: null, media_kind: "screenshot" }],
    },
  });

  assert.match(text, /"kind": "visual_review_gate"/);
  assert.doesNotMatch(text, /private|\/Users|event_id|prompt|response/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test test/visual-gate.test.mjs
```

Expected: FAIL with module-not-found errors for `src/visual-gate-schemas.mjs` and `src/visual-gate-routing.mjs`.

- [ ] **Step 3: Create visual gate schemas**

Create `src/visual-gate-schemas.mjs`:

```js
import { z } from "zod";

export const VISUAL_GATE_VERDICTS = ["pass", "caution", "block"];
export const VISUAL_GATE_REVIEW_POSTURES = [
  "smoke_only",
  "quick_review",
  "comparison_review",
  "standard_fallback",
  "blocked_before_gemini",
];
export const VISUAL_GATE_RISK_LEVELS = ["low", "medium", "high"];
export const VISUAL_GATE_ROUTINGS = ["required", "recommended", "skip"];
export const VISUAL_GATE_ISSUE_CATEGORIES = [
  "blank_or_missing_render",
  "layout_overflow",
  "responsive_breakage",
  "text_overflow_or_occlusion",
  "accessibility_contrast_or_readability",
  "chart_or_data_readability",
  "target_actual_drift",
  "missing_labels_or_context",
  "asset_rendering_failure",
  "interaction_state_gap",
  "uncertain_visual_evidence",
];

const HARD_BLOCK_CATEGORIES = new Set([
  "blank_or_missing_render",
  "layout_overflow",
  "text_overflow_or_occlusion",
  "target_actual_drift",
  "asset_rendering_failure",
]);

const NullableScore = z.number().int().min(0).max(100).nullable().default(null);

export const VisualGateScorecardZodSchema = z.object({
  overall_score: NullableScore,
  visual_hierarchy_score: NullableScore,
  clarity_score: NullableScore,
  accessibility_score: NullableScore,
  consistency_score: NullableScore,
  implementation_readiness_score: NullableScore,
});

export const VisualGateIssueZodSchema = z.object({
  category: z.enum(VISUAL_GATE_ISSUE_CATEGORIES),
  severity: z.enum(["low", "medium", "high"]),
  summary: z.string(),
  recommended_action: z.string(),
});

export const VisualGateSmokeCheckZodSchema = z.object({
  name: z.string(),
  status: z.enum(VISUAL_GATE_VERDICTS),
  evidence: z.string(),
});

export const VisualGateMediaSummaryZodSchema = z.object({
  role: z.enum(["target", "actual", "before", "after", "viewport"]),
  mime_type: z.string().nullable().default(null),
  byte_size: z.number().int().nonnegative().nullable().default(null),
  width: z.number().int().positive().nullable().default(null),
  height: z.number().int().positive().nullable().default(null),
  media_kind: z.enum(["screenshot", "design", "document", "image", "unknown"]).default("screenshot"),
}).strict();

export const VisualGateResultZodSchema = z.object({
  kind: z.literal("visual_review_gate"),
  verdict: z.enum(VISUAL_GATE_VERDICTS),
  review_posture: z.enum(VISUAL_GATE_REVIEW_POSTURES),
  risk_level: z.enum(VISUAL_GATE_RISK_LEVELS),
  risk_reasons: z.array(z.string()).default([]),
  smoke: z.object({
    status: z.enum(VISUAL_GATE_VERDICTS),
    checks: z.array(VisualGateSmokeCheckZodSchema).default([]),
  }),
  artifact_review: z.object({
    used: z.boolean(),
    mode: z.enum(["single", "comparison"]).nullable().default(null),
    depth: z.enum(["quick", "standard"]).nullable().default(null),
    fallback_used: z.boolean().default(false),
    scorecard: VisualGateScorecardZodSchema.nullable().default(null),
  }),
  issues: z.array(VisualGateIssueZodSchema).default([]),
  next_actions: z.array(z.string()).default([]),
  limitations: z.array(z.string()).default([]),
  metadata: z.object({
    generated_at: z.string(),
    artifact_review_readiness_status: z.enum(["ready", "collect_more_samples", "blocked", "unknown"]).default("unknown"),
    media_summary: z.array(VisualGateMediaSummaryZodSchema).default([]),
  }),
}).strict();

export function visualGateVerdictFromSignals({
  routing = "recommended",
  smokeStatus = "pass",
  scorecard = null,
  issues = [],
} = {}) {
  if (smokeStatus === "block") return "block";
  if (issues.some((issue) => HARD_BLOCK_CATEGORIES.has(issue.category) && issue.severity !== "low")) return "block";

  const readiness = scorecard?.implementation_readiness_score;
  if (routing === "required" && Number.isInteger(readiness) && readiness < 50) return "block";
  if (Number.isInteger(readiness) && readiness < 70) return "caution";
  const accessibility = scorecard?.accessibility_score;
  if (Number.isInteger(accessibility) && accessibility < 60) return "caution";
  if (smokeStatus === "caution") return "caution";
  if (issues.some((issue) => issue.severity === "medium" || issue.severity === "high")) return "caution";
  return "pass";
}

export function normalizeVisualGateResult(value) {
  const parsed = VisualGateResultZodSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Invalid visual gate JSON: ${parsed.error.message}`);
  }
  return parsed.data;
}

export function visualGateToPrettyJson(result) {
  return `${JSON.stringify(normalizeVisualGateResult(result), null, 2)}\n`;
}
```

- [ ] **Step 4: Create routing policy module**

Create `src/visual-gate-routing.mjs`:

```js
const REQUIRED_HINTS = new Map([
  ["new-ui", "new_visual_surface"],
  ["redesign", "material_redesign"],
  ["design-implementation", "design_implementation"],
  ["dashboard", "dashboard_or_report"],
  ["report", "dashboard_or_report"],
  ["game", "interactive_visual_surface"],
  ["canvas", "canvas_or_3d_surface"],
  ["3d", "canvas_or_3d_surface"],
  ["release-visual", "visual_release_claim"],
]);

const RECOMMENDED_HINTS = new Map([
  ["css-change", "visible_css_change"],
  ["layout-change", "visible_layout_change"],
  ["copy-change", "copy_wrapping_risk"],
  ["responsive-change", "responsive_change"],
  ["theme-change", "theme_or_token_change"],
]);

const SKIP_HINTS = new Map([
  ["backend-only", "backend_only"],
  ["docs-only", "docs_only"],
  ["tests-only", "tests_only"],
  ["telemetry-only", "non_visual_telemetry"],
]);

function normalizeHint(value) {
  return String(value ?? "").trim().toLowerCase().replace(/_/gu, "-");
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function reasonFromHints(hints, map) {
  return hints.map((hint) => map.get(hint)).filter(Boolean);
}

export function classifyVisualGateRoute({ riskHints = [], traits = {} } = {}) {
  const hints = Array.isArray(riskHints) ? riskHints.map(normalizeHint).filter(Boolean) : [];
  const safeTraits = traits && typeof traits === "object" && !Array.isArray(traits) ? traits : {};
  const skipReasons = reasonFromHints(hints, SKIP_HINTS);
  const requiredReasons = reasonFromHints(hints, REQUIRED_HINTS);
  const recommendedReasons = reasonFromHints(hints, RECOMMENDED_HINTS);

  if (safeTraits.hasTargetScreenshot && safeTraits.hasActualScreenshot) requiredReasons.push("target_actual_comparison");
  if (safeTraits.hasActualScreenshot && safeTraits.isVisualSurface) recommendedReasons.push("visual_evidence_available");

  if (requiredReasons.length > 0) {
    return {
      routing: "required",
      risk_level: "high",
      risk_reasons: unique(requiredReasons),
    };
  }

  if (recommendedReasons.length > 0) {
    return {
      routing: "recommended",
      risk_level: "medium",
      risk_reasons: unique(recommendedReasons),
    };
  }

  if (skipReasons.length > 0) {
    return {
      routing: "skip",
      risk_level: "low",
      risk_reasons: unique(skipReasons),
    };
  }

  return {
    routing: safeTraits.hasActualScreenshot ? "recommended" : "skip",
    risk_level: safeTraits.hasActualScreenshot ? "medium" : "low",
    risk_reasons: safeTraits.hasActualScreenshot ? ["visual_evidence_available"] : ["no_visual_risk_hint"],
  };
}
```

- [ ] **Step 5: Run tests for Task 1**

Run:

```bash
node --test test/visual-gate.test.mjs
```

Expected: PASS for the schema and routing tests added in Step 1.

- [ ] **Step 6: Commit Task 1**

```bash
git add src/visual-gate-schemas.mjs src/visual-gate-routing.mjs test/visual-gate.test.mjs
git commit -m "Add visual gate schema and routing policy"
```

---

### Task 2: Local Screenshot Smoke Checks

**Files:**
- Create: `src/visual-gate-smoke.mjs`
- Modify: `test/visual-gate.test.mjs`

- [ ] **Step 1: Add failing smoke-check tests**

Append to `test/visual-gate.test.mjs`:

```js
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectVisualGateSmoke } from "../src/visual-gate-smoke.mjs";

const minimalPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test("collectVisualGateSmoke returns safe media summary for readable screenshot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "visual-gate-smoke-"));
  await writeFile(join(dir, "after.png"), minimalPng);

  const smoke = await collectVisualGateSmoke({
    cwd: dir,
    screenshots: [{ role: "actual", path: "after.png" }],
  });

  assert.equal(smoke.status, "pass");
  assert.deepEqual(smoke.media_summary, [{
    role: "actual",
    mime_type: "image/png",
    byte_size: minimalPng.length,
    width: null,
    height: null,
    media_kind: "screenshot",
  }]);
  assert.ok(smoke.checks.some((check) => check.name === "file_readable" && check.status === "pass"));
  assert.doesNotMatch(JSON.stringify(smoke), /after\.png|\/tmp|\/Users/);
});

test("collectVisualGateSmoke blocks unsupported files before Gemini", async () => {
  const dir = await mkdtemp(join(tmpdir(), "visual-gate-smoke-"));
  await writeFile(join(dir, "archive.zip"), "zip");

  const smoke = await collectVisualGateSmoke({
    cwd: dir,
    screenshots: [{ role: "actual", path: "archive.zip" }],
  });

  assert.equal(smoke.status, "block");
  assert.ok(smoke.checks.some((check) => check.name === "mime_supported" && check.status === "block"));
});

test("collectVisualGateSmoke blocks missing actual screenshot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "visual-gate-smoke-"));

  const smoke = await collectVisualGateSmoke({
    cwd: dir,
    screenshots: [{ role: "actual", path: "missing.png" }],
  });

  assert.equal(smoke.status, "block");
  assert.ok(smoke.checks.some((check) => check.name === "file_readable" && check.status === "block"));
});

test("collectVisualGateSmoke cautions instead of crashing when dimensions fail", async () => {
  const dir = await mkdtemp(join(tmpdir(), "visual-gate-smoke-"));
  await writeFile(join(dir, "after.png"), minimalPng);

  const smoke = await collectVisualGateSmoke({
    cwd: dir,
    screenshots: [{ role: "actual", path: "after.png" }],
    readDimensions: async () => {
      throw new Error("decode failed");
    },
  });

  assert.equal(smoke.status, "caution");
  assert.ok(smoke.checks.some((check) => check.name === "dimensions" && check.status === "caution"));
});
```

- [ ] **Step 2: Run smoke tests to verify failure**

Run:

```bash
node --test test/visual-gate.test.mjs --test-name-pattern "collectVisualGateSmoke"
```

Expected: FAIL with module-not-found for `src/visual-gate-smoke.mjs`.

- [ ] **Step 3: Implement smoke checks**

Create `src/visual-gate-smoke.mjs`:

```js
import { stat } from "node:fs/promises";
import { detectArtifactMime, resolveCwdFilePath, DEFAULT_IMAGE_LIMIT_BYTES } from "./input-collector.mjs";
import { imageDimensions } from "./design-image-dimensions.mjs";

const ROLES = new Set(["target", "actual", "before", "after", "viewport"]);

function safeRole(value) {
  const role = String(value ?? "").trim().toLowerCase();
  return ROLES.has(role) ? role : "actual";
}

function worstStatus(checks) {
  if (checks.some((check) => check.status === "block")) return "block";
  if (checks.some((check) => check.status === "caution")) return "caution";
  return "pass";
}

function check(name, status, evidence) {
  return { name, status, evidence };
}

async function inspectScreenshot({ role, path }, { cwd, maxImageBytes, readDimensions }) {
  const checks = [];
  const media = {
    role: safeRole(role),
    mime_type: null,
    byte_size: null,
    width: null,
    height: null,
    media_kind: "screenshot",
  };

  let resolved;
  try {
    resolved = resolveCwdFilePath(path, { cwd });
  } catch {
    checks.push(check("path_safe", "block", "path must be relative to cwd"));
    return { checks, media };
  }
  checks.push(check("path_safe", "pass", "relative path accepted"));

  let mimeType;
  try {
    mimeType = detectArtifactMime(path);
    media.mime_type = mimeType;
    checks.push(check("mime_supported", mimeType.startsWith("image/") ? "pass" : "block", mimeType));
  } catch {
    checks.push(check("mime_supported", "block", "unsupported artifact file type"));
    return { checks, media };
  }

  let info;
  try {
    info = await stat(resolved);
    media.byte_size = info.size;
    checks.push(check("file_readable", info.isFile() ? "pass" : "block", info.isFile() ? "file is readable" : "path is not a file"));
  } catch {
    checks.push(check("file_readable", "block", "file is missing or unreadable"));
    return { checks, media };
  }

  if (info.size <= 0) checks.push(check("byte_size", "block", "image file is empty"));
  else if (info.size > maxImageBytes) checks.push(check("byte_size", "block", `image exceeds ${maxImageBytes} bytes`));
  else checks.push(check("byte_size", "pass", `${info.size} bytes`));

  let dimensions;
  try {
    dimensions = await readDimensions(resolved);
  } catch {
    dimensions = { width: null, height: null, mimeType };
  }
  media.width = dimensions.width;
  media.height = dimensions.height;
  if (Number.isInteger(dimensions.width) && Number.isInteger(dimensions.height)) {
    checks.push(check("dimensions", "pass", `${dimensions.width}x${dimensions.height}`));
  } else {
    checks.push(check("dimensions", "caution", "image dimensions unavailable"));
  }

  return { checks, media };
}

export async function collectVisualGateSmoke({
  cwd = process.cwd(),
  screenshots = [],
  maxImageBytes = DEFAULT_IMAGE_LIMIT_BYTES,
  readDimensions = imageDimensions,
} = {}) {
  const checks = [];
  const mediaSummary = [];
  const inputs = Array.isArray(screenshots) ? screenshots : [];
  if (inputs.length === 0) {
    return {
      status: "block",
      checks: [check("screenshot_present", "block", "at least one screenshot is required")],
      media_summary: [],
    };
  }

  checks.push(check("screenshot_present", "pass", `${inputs.length} screenshot input(s)`));
  for (const item of inputs) {
    const result = await inspectScreenshot(item, { cwd, maxImageBytes, readDimensions });
    checks.push(...result.checks);
    mediaSummary.push(result.media);
  }

  return {
    status: worstStatus(checks),
    checks,
    media_summary: mediaSummary,
  };
}
```

- [ ] **Step 4: Run smoke tests**

Run:

```bash
node --test test/visual-gate.test.mjs --test-name-pattern "collectVisualGateSmoke"
```

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/visual-gate-smoke.mjs test/visual-gate.test.mjs
git commit -m "Add visual gate smoke checks"
```

---

### Task 3: Visual Gate Orchestrator

**Files:**
- Create: `src/visual-gate.mjs`
- Modify: `test/visual-gate.test.mjs`

- [ ] **Step 1: Add failing orchestrator tests**

Append to `test/visual-gate.test.mjs`:

```js
import { runVisualGate } from "../src/visual-gate.mjs";

const fakeArtifactReview = {
  kind: "artifact_review",
  artifact_type: "design",
  summary: ["Readable dashboard"],
  important_details: [],
  design_or_research_findings: [],
  implementation_hints_for_codex: ["Keep labels visible"],
  risks_or_ambiguities: [],
  questions_for_user: [],
  limitations: [],
  design_scorecard: {
    overall_score: 82,
    visual_hierarchy_score: 84,
    clarity_score: 80,
    accessibility_score: 76,
    consistency_score: 85,
    implementation_readiness_score: 81,
    strengths: [],
    issues: [],
    recommended_actions: ["Keep labels visible"],
  },
  metadata: {
    model: "gemini-3.5-flash",
    generated_at: "2026-06-15T00:00:00.000Z",
    sources: ["target.png", "after.png"],
    omitted_sources: [],
  },
};

test("runVisualGate smoke-only returns block before Gemini for missing screenshot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "visual-gate-run-"));
  let artifactCalled = false;

  const result = await runVisualGate({
    cwd: dir,
    actualScreenshot: "missing.png",
    smokeOnly: true,
    artifactReview: async () => {
      artifactCalled = true;
      return fakeArtifactReview;
    },
    now: new Date("2026-06-15T00:00:00.000Z"),
  });

  assert.equal(artifactCalled, false);
  assert.equal(result.verdict, "block");
  assert.equal(result.review_posture, "blocked_before_gemini");
});

test("runVisualGate uses quick comparison review for target and actual screenshots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "visual-gate-run-"));
  await writeFile(join(dir, "target.png"), minimalPng);
  await writeFile(join(dir, "after.png"), minimalPng);
  let seenInput = null;

  const result = await runVisualGate({
    apiKey: "fake-key",
    cwd: dir,
    targetScreenshot: "target.png",
    actualScreenshot: "after.png",
    riskHints: ["design-implementation"],
    now: new Date("2026-06-15T00:00:00.000Z"),
    artifactReview: async (input) => {
      seenInput = input;
      return fakeArtifactReview;
    },
  });

  assert.deepEqual(seenInput.files, ["target.png", "after.png"]);
  assert.equal(seenInput.reviewMode, "comparison");
  assert.equal(seenInput.reviewDepth, "quick");
  assert.equal(seenInput.telemetry.command, "visual-gate");
  assert.equal(seenInput.telemetry.metadata.visual_gate.risk_level, "high");
  assert.equal(result.verdict, "pass");
  assert.equal(result.review_posture, "comparison_review");
  assert.equal(result.artifact_review.scorecard.implementation_readiness_score, 81);
  assert.doesNotMatch(JSON.stringify(result), /target\.png|after\.png|\/tmp|\/Users/);
});

test("runVisualGate maps weak artifact scorecard to caution", async () => {
  const dir = await mkdtemp(join(tmpdir(), "visual-gate-run-"));
  await writeFile(join(dir, "after.png"), minimalPng);

  const result = await runVisualGate({
    apiKey: "fake-key",
    cwd: dir,
    actualScreenshot: "after.png",
    riskHints: ["css-change"],
    artifactReview: async () => ({
      ...fakeArtifactReview,
      design_scorecard: {
        ...fakeArtifactReview.design_scorecard,
        accessibility_score: 48,
        implementation_readiness_score: 66,
      },
    }),
  });

  assert.equal(result.verdict, "caution");
  assert.equal(result.review_posture, "quick_review");
});
```

- [ ] **Step 2: Run orchestrator tests to verify failure**

Run:

```bash
node --test test/visual-gate.test.mjs --test-name-pattern "runVisualGate"
```

Expected: FAIL with module-not-found for `src/visual-gate.mjs`.

- [ ] **Step 3: Implement the orchestrator**

Create `src/visual-gate.mjs`:

```js
import { runArtifactReview } from "./artifact-review.mjs";
import { captureGeminiTelemetry } from "./telemetry-capture.mjs";
import { classifyVisualGateRoute } from "./visual-gate-routing.mjs";
import { collectVisualGateSmoke } from "./visual-gate-smoke.mjs";
import {
  normalizeVisualGateResult,
  visualGateVerdictFromSignals,
} from "./visual-gate-schemas.mjs";

function screenshotsFromOptions({ targetScreenshot, actualScreenshot }) {
  const screenshots = [];
  if (targetScreenshot) screenshots.push({ role: "target", path: targetScreenshot });
  if (actualScreenshot) screenshots.push({ role: "actual", path: actualScreenshot });
  return screenshots;
}

function artifactScorecard(review) {
  const card = review?.design_scorecard;
  if (!card || typeof card !== "object") return null;
  return {
    overall_score: card.overall_score ?? null,
    visual_hierarchy_score: card.visual_hierarchy_score ?? null,
    clarity_score: card.clarity_score ?? null,
    accessibility_score: card.accessibility_score ?? null,
    consistency_score: card.consistency_score ?? null,
    implementation_readiness_score: card.implementation_readiness_score ?? null,
  };
}

function issueFromArtifactReview(review) {
  const issues = Array.isArray(review?.design_scorecard?.issues) ? review.design_scorecard.issues : [];
  return issues.slice(0, 4).map((item) => ({
    category: "uncertain_visual_evidence",
    severity: "medium",
    summary: String(item).slice(0, 240),
    recommended_action: "Inspect the visual review issue and adjust the implementation or screenshot evidence.",
  }));
}

function nextActions({ verdict, artifactReview }) {
  const actions = Array.isArray(artifactReview?.design_scorecard?.recommended_actions)
    ? artifactReview.design_scorecard.recommended_actions.slice(0, 4)
    : [];
  if (actions.length > 0) return actions;
  if (verdict === "block") return ["Fix the blocking visual issue and rerun visual gate."];
  if (verdict === "caution") return ["Review the visual caution before claiming the UI is complete."];
  return ["Proceed with normal verification."];
}

function smokeCheckCounts(checks) {
  return checks.reduce((counts, check) => {
    counts[check.status] = (counts[check.status] ?? 0) + 1;
    return counts;
  }, {});
}

function issueCategoryCounts(issues) {
  return issues.reduce((counts, issue) => {
    counts[issue.category] = (counts[issue.category] ?? 0) + 1;
    return counts;
  }, {});
}

function visualGateTelemetryMetadata({ route, posture, smoke, artifactReview, issues }) {
  return {
    visual_gate: {
      risk_level: route.risk_level,
      risk_reasons: route.risk_reasons,
      routing: route.routing,
      review_posture: posture,
      smoke_status: smoke.status,
      smoke_check_counts: smokeCheckCounts(smoke.checks),
      artifact_review_used: Boolean(artifactReview),
      artifact_review_mode: artifactReview ? (posture === "comparison_review" ? "comparison" : "single") : null,
      artifact_review_depth: artifactReview ? "quick" : null,
      fallback_used: false,
      issue_category_counts: issueCategoryCounts(issues),
    },
  };
}

async function captureSmokeOnlyTelemetry({ cwd, telemetry, route, posture, smoke, result }) {
  const capture = telemetry?.capture ?? captureGeminiTelemetry;
  await capture({
    cwd,
    source: telemetry?.source ?? "cli",
    command: telemetry?.command ?? "visual-gate",
    prompt: "",
    response: JSON.stringify({ verdict: result.verdict }),
    status: "success",
    latencyMs: 0,
    metadata: visualGateTelemetryMetadata({
      route,
      posture,
      smoke,
      artifactReview: null,
      issues: result.issues,
    }),
  });
}

export async function runVisualGate({
  apiKey,
  cwd = process.cwd(),
  targetScreenshot = null,
  actualScreenshot = null,
  kind = "ui",
  riskHints = [],
  smokeOnly = false,
  artifactReview = runArtifactReview,
  telemetry = { cwd, source: "cli", command: "visual-gate" },
  now = new Date(),
} = {}) {
  const screenshots = screenshotsFromOptions({ targetScreenshot, actualScreenshot });
  const route = classifyVisualGateRoute({
    riskHints,
    traits: {
      hasTargetScreenshot: Boolean(targetScreenshot),
      hasActualScreenshot: Boolean(actualScreenshot),
      isVisualSurface: kind === "ui" || kind === "design",
    },
  });
  const smoke = await collectVisualGateSmoke({ cwd, screenshots });
  let posture = smokeOnly ? "smoke_only" : targetScreenshot && actualScreenshot ? "comparison_review" : "quick_review";
  let review = null;
  let issues = [];

  if (smoke.status === "block") posture = "blocked_before_gemini";

  if (!smokeOnly && smoke.status !== "block" && route.routing !== "skip") {
    review = await artifactReview({
      apiKey,
      cwd,
      file: screenshots[0]?.path,
      files: screenshots.map((item) => item.path),
      artifactKind: kind,
      reviewMode: targetScreenshot && actualScreenshot ? "comparison" : "single",
      reviewDepth: "quick",
      telemetry: telemetry ? {
        ...telemetry,
        command: telemetry.command || "visual-gate",
        metadata: {
          ...(telemetry.metadata && typeof telemetry.metadata === "object" ? telemetry.metadata : {}),
          ...visualGateTelemetryMetadata({ route, posture, smoke, artifactReview: true, issues: [] }),
        },
      } : telemetry,
    });
    issues = issueFromArtifactReview(review);
  }

  const scorecard = artifactScorecard(review);
  const verdict = visualGateVerdictFromSignals({
    routing: route.routing,
    smokeStatus: smoke.status,
    scorecard,
    issues,
  });
  const result = normalizeVisualGateResult({
    kind: "visual_review_gate",
    verdict,
    review_posture: posture,
    risk_level: route.risk_level,
    risk_reasons: route.risk_reasons,
    smoke: { status: smoke.status, checks: smoke.checks },
    artifact_review: {
      used: Boolean(review),
      mode: review ? (targetScreenshot && actualScreenshot ? "comparison" : "single") : null,
      depth: review ? "quick" : null,
      fallback_used: false,
      scorecard,
    },
    issues,
    next_actions: nextActions({ verdict, artifactReview: review }),
    limitations: smokeOnly ? ["Smoke-only mode did not call Gemini."] : [],
    metadata: {
      generated_at: now.toISOString(),
      artifact_review_readiness_status: "unknown",
      media_summary: smoke.media_summary,
    },
  });

  if (smokeOnly && telemetry) {
    await captureSmokeOnlyTelemetry({ cwd, telemetry, route, posture, smoke, result });
  }

  return result;
}
```

- [ ] **Step 4: Run orchestrator tests**

Run:

```bash
node --test test/visual-gate.test.mjs --test-name-pattern "runVisualGate"
```

Expected: PASS.

- [ ] **Step 5: Run full visual gate unit tests**

Run:

```bash
node --test test/visual-gate.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit Task 3**

```bash
git add src/visual-gate.mjs test/visual-gate.test.mjs
git commit -m "Add visual gate orchestration"
```

---

### Task 4: CLI Command

**Files:**
- Modify: `src/cli.mjs`
- Modify: `test/cli.test.mjs`

- [ ] **Step 1: Add failing CLI tests**

Append near existing artifact-review CLI tests in `test/cli.test.mjs`:

```js
test("visual gate smoke-only outputs safe JSON without auth", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));
  await writeFile(join(dir, "after.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

  const { stdout } = await execFileAsync(bin, [
    "visual",
    "gate",
    "--actual-screenshot",
    "after.png",
    "--smoke-only",
    "--json",
  ], {
    cwd: dir,
    env: { PATH: process.env.PATH, HOME: CLI_TEST_HOME },
  });

  const parsed = JSON.parse(stdout);
  assert.equal(parsed.kind, "visual_review_gate");
  assert.equal(parsed.artifact_review.used, false);
  assert.doesNotMatch(stdout, /after\.png|\/tmp|\/Users|event_id/);
});

test("visual gate target actual comparison uses fake artifact review", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  await writeFile(join(dir, "target.png"), png);
  await writeFile(join(dir, "after.png"), png);

  const { stdout } = await execFileAsync(bin, [
    "visual",
    "gate",
    "--target-screenshot",
    "target.png",
    "--actual-screenshot",
    "after.png",
    "--kind",
    "ui",
    "--risk",
    "design-implementation",
    "--json",
  ], {
    cwd: dir,
    env: {
      ...process.env,
      HOME: CLI_TEST_HOME,
      GEMINI_API_KEY: "fake-key",
      GEMINI_AGENT_ALLOW_FAKE_RESPONSE: "1",
      GEMINI_AGENT_FAKE_RESPONSE: fakeArtifactReview,
    },
  });

  const parsed = JSON.parse(stdout);
  assert.equal(parsed.review_posture, "comparison_review");
  assert.equal(parsed.artifact_review.mode, "comparison");
  assert.equal(parsed.artifact_review.depth, "quick");
  assert.doesNotMatch(stdout, /target\.png|after\.png|\/tmp|\/Users/);
});

test("visual gate rejects missing actual screenshot before auth lookup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));

  await assert.rejects(
    execFileAsync(bin, ["visual", "gate", "--actual-screenshot", "missing.png"], {
      cwd: dir,
      env: { PATH: process.env.PATH, HOME: CLI_TEST_HOME },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /visual gate blocked before Gemini/);
      assert.doesNotMatch(error.stderr, /Gemini API key/);
      return true;
    },
  );
});
```

- [ ] **Step 2: Run CLI tests to verify failure**

Run:

```bash
node --test test/cli.test.mjs --test-name-pattern "visual gate"
```

Expected: FAIL with unknown command `visual`.

- [ ] **Step 3: Add CLI import and usage**

Modify `src/cli.mjs` imports:

```js
import { runVisualGate } from "./visual-gate.mjs";
import { visualGateToPrettyJson } from "./visual-gate-schemas.mjs";
```

Add to `printUsage()` lines:

```js
"  gemini-agent visual gate --actual-screenshot <path> [--target-screenshot <path>] [--kind ui|design|image] [--risk <hint>] [--smoke-only] [--json]",
```

- [ ] **Step 4: Add CLI parser**

Add near `parseArtifactArgs`:

```js
const VISUAL_GATE_KINDS = new Set(["ui", "design", "image"]);

function parseVisualGateArgs(args) {
  const options = {
    targetScreenshot: null,
    actualScreenshot: null,
    kind: "ui",
    riskHints: [],
    smokeOnly: false,
    json: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--target-screenshot") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--target-screenshot requires a path.");
      options.targetScreenshot = value;
      index += 1;
    } else if (arg === "--actual-screenshot") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--actual-screenshot requires a path.");
      options.actualScreenshot = value;
      index += 1;
    } else if (arg === "--kind") {
      const value = args[index + 1];
      if (!value || value.startsWith("--") || !VISUAL_GATE_KINDS.has(value)) {
        throw new Error("--kind requires one of: ui, design, image.");
      }
      options.kind = value;
      index += 1;
    } else if (arg === "--risk") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--risk requires a hint.");
      options.riskHints.push(value);
      index += 1;
    } else if (arg === "--smoke-only") {
      options.smokeOnly = true;
    } else if (arg === "--json") {
      options.json = true;
    } else {
      throw new Error(`Unknown visual gate argument: ${arg}`);
    }
  }
  if (!options.actualScreenshot) throw new Error("--actual-screenshot is required.");
  return options;
}
```

- [ ] **Step 5: Add command runner and dispatch**

Add near `runArtifactReviewCommand`:

```js
async function runVisualCommand(args) {
  const [subcommand, ...subArgs] = args;
  if (subcommand !== "gate") throw new Error("Unknown visual command.");
  const options = parseVisualGateArgs(subArgs);
  const cwd = process.cwd();
  const fakeAllowed = allowFakeResponse(process.env);
  if (process.env.GEMINI_AGENT_FAKE_RESPONSE && !fakeAllowed) {
    throw new Error("GEMINI_AGENT_FAKE_RESPONSE requires GEMINI_AGENT_ALLOW_FAKE_RESPONSE=1.");
  }
  let key = { ok: false, key: null };
  if (!options.smokeOnly) {
    const smokeProbe = await runVisualGate({ cwd, ...options, smokeOnly: true, telemetry: null });
    if (smokeProbe.review_posture === "blocked_before_gemini") {
      throw new Error("visual gate blocked before Gemini: capture a readable supported screenshot and retry.");
    }
    key = await resolveApiKey();
    if (!key.ok) throw new Error("Gemini API key is not configured. Run: gemini-agent auth set");
  }
  const result = await runVisualGate({
    ...options,
    apiKey: key.key,
    cwd,
    telemetry: {
      cwd,
      source: "cli",
      command: "visual-gate",
    },
  });
  output.write(options.json ? visualGateToPrettyJson(result) : visualGateToPrettyJson(result));
}
```

Add in `main` before gate commands:

```js
if (command === "visual") {
  await runVisualCommand(args);
  return;
}
```

- [ ] **Step 6: Run CLI tests**

Run:

```bash
node --test test/cli.test.mjs --test-name-pattern "visual gate"
```

Expected: PASS.

- [ ] **Step 7: Run focused unit and CLI tests**

Run:

```bash
node --test test/visual-gate.test.mjs
node --test test/cli.test.mjs --test-name-pattern "visual gate|artifact-review accepts"
```

Expected: PASS.

- [ ] **Step 8: Commit Task 4**

```bash
git add src/cli.mjs test/cli.test.mjs
git commit -m "Expose visual gate CLI"
```

---

### Task 5: Design Loop Integration

**Files:**
- Modify: `src/design-schemas.mjs`
- Modify: `src/design-loop.mjs`
- Modify: `test/design-loop.test.mjs`

- [ ] **Step 1: Add failing design-loop gate test**

Modify `test/design-loop.test.mjs` comparison test to inject `visualGate`:

```js
    let seenGateInput = null;
    const result = await runDesignLoop({
      runDir: dir,
      targetScreenshot: target,
      actualScreenshot: actual,
      maxIterations: 1,
      apiKey: "fake-key",
      telemetry: { cwd: dir, source: "test", command: "design-loop" },
      visualGate: async (input) => {
        seenGateInput = input;
        return {
          kind: "visual_review_gate",
          verdict: "caution",
          review_posture: "comparison_review",
          risk_level: "high",
          risk_reasons: ["design_implementation"],
          smoke: { status: "pass", checks: [] },
          artifact_review: {
            used: true,
            mode: "comparison",
            depth: "quick",
            fallback_used: false,
            scorecard: {
              overall_score: 72,
              visual_hierarchy_score: 76,
              clarity_score: 70,
              accessibility_score: 65,
              consistency_score: 74,
              implementation_readiness_score: 68,
            },
          },
          issues: [],
          next_actions: ["Tighten spacing"],
          limitations: [],
          metadata: {
            generated_at: "2026-06-15T00:00:00.000Z",
            artifact_review_readiness_status: "unknown",
            media_summary: [],
          },
        };
      },
    });

    assert.equal(seenGateInput.reviewMode, undefined);
    assert.equal(seenGateInput.targetScreenshot, target);
    assert.equal(seenGateInput.actualScreenshot, actual);
    assert.equal(result.review.visual_gate.verdict, "caution");
    assert.equal(result.review.summary[0], "Visual gate verdict: caution");
    assert.equal(JSON.parse(await readFile(join(dir, "loop-review.json"), "utf8")).visual_gate.verdict, "caution");
```

Remove the old `artifactReview` injection from that test after adding `visualGate`.

- [ ] **Step 2: Run design-loop tests to verify failure**

Run:

```bash
node --test test/design-loop.test.mjs
```

Expected: FAIL because `runDesignLoop` does not accept `visualGate` and schema rejects `visual_gate`.

- [ ] **Step 3: Extend design loop schema**

Modify `src/design-schemas.mjs`:

```js
  visual_gate: z.record(z.string(), z.unknown()).nullable().default(null),
```

Place the field next to `artifact_review`.

- [ ] **Step 4: Update design loop to call visual gate**

Modify `src/design-loop.mjs` imports:

```js
import { runVisualGate } from "./visual-gate.mjs";
```

Modify `runDesignLoop` signature:

```js
  visualGate,
```

Replace the artifact-review call block with:

```js
  const gateInput = {
    apiKey,
    cwd: telemetry?.cwd || process.cwd(),
    targetScreenshot,
    actualScreenshot,
    kind: "ui",
    riskHints: ["design-implementation"],
    telemetry: telemetry ? {
      ...telemetry,
      command: telemetry.command || "design-loop",
    } : { cwd: process.cwd(), source: "cli", command: "design-loop" },
  };
  const gate = visualGate
    ? await visualGate(gateInput)
    : await runVisualGate(gateInput);

  const artifact = gate.artifact_review?.used
    ? { verdict: gate.verdict, summary: gate.next_actions, suggested_changes: gate.next_actions }
    : null;
```

Set normalized review fields:

```js
    summary: [`Visual gate verdict: ${gate.verdict}`, ...gate.next_actions.slice(0, 2)],
    next_actions: gate.next_actions,
    artifact_review: artifact,
    visual_gate: gate,
```

Keep the missing-screenshot branch with `visual_gate: null`.

- [ ] **Step 5: Run design-loop tests**

Run:

```bash
node --test test/design-loop.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit Task 5**

```bash
git add src/design-schemas.mjs src/design-loop.mjs test/design-loop.test.mjs
git commit -m "Use visual gate in design loop"
```

---

### Task 6: Safe Visual Gate Telemetry Aggregates

**Files:**
- Modify: `src/telemetry-summary.mjs`
- Modify: `test/telemetry-summary.test.mjs`
- Modify: `test/visual-gate.test.mjs`

- [ ] **Step 1: Add failing telemetry capture test**

Append to `test/visual-gate.test.mjs`:

```js
test("runVisualGate smoke-only telemetry records safe aggregate metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "visual-gate-telemetry-"));
  await writeFile(join(dir, "after.png"), minimalPng);
  let captured = null;

  await runVisualGate({
    cwd: dir,
    actualScreenshot: "after.png",
    smokeOnly: true,
    telemetry: {
      cwd: dir,
      source: "cli",
      command: "visual-gate",
      capture: async (event) => {
        captured = event;
        return { queued: true };
      },
    },
  });

  assert.equal(captured.command, "visual-gate");
  assert.equal(captured.metadata.visual_gate.review_posture, "smoke_only");
  assert.equal(captured.metadata.visual_gate.smoke_status, "pass");
  assert.doesNotMatch(JSON.stringify(captured.metadata), /after\.png|\/tmp|\/Users|prompt|response/);
});
```

- [ ] **Step 2: Add failing telemetry summary test**

Append to `test/telemetry-summary.test.mjs`:

```js
test("runTelemetrySummary aggregates visual gate metadata safely", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-telemetry-summary-"));
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });
  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(88, {
      command: "visual-gate",
      metadata: {
        visual_gate: {
          verdict: "block",
          review_posture: "comparison_review",
          risk_level: "high",
          risk_reasons: ["design_implementation"],
          smoke_status: "pass",
          smoke_check_counts: { pass: 3 },
          artifact_review_used: true,
          artifact_review_mode: "comparison",
          artifact_review_depth: "quick",
          fallback_used: false,
          issue_category_counts: { target_actual_drift: 1 },
        },
      },
    }),
  });

  const summary = await runTelemetrySummary({ cwd });
  assert.deepEqual(summary.visual_gate, {
    event_count: 1,
    verdict_counts: [{ verdict: "block", event_count: 1 }],
    review_postures: [{ review_posture: "comparison_review", event_count: 1 }],
    issue_categories: [{ category: "target_actual_drift", event_count: 1 }],
  });
  assert.doesNotMatch(JSON.stringify(summary.visual_gate), /private|\/Users|evt_/);
});
```

- [ ] **Step 3: Run telemetry tests to verify failure**

Run:

```bash
node --test test/visual-gate.test.mjs --test-name-pattern "telemetry"
node --test test/telemetry-summary.test.mjs --test-name-pattern "visual gate"
```

Expected: first test may pass if Task 3 implemented capture; second fails because `summary.visual_gate` is missing.

- [ ] **Step 4: Add visual gate aggregate helper in telemetry summary**

In `src/telemetry-summary.mjs`, add helper functions near other aggregate helpers:

```js
function safeVisualGateMetadata(event) {
  const value = event?.metadata?.visual_gate;
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function countBy(items, key, safeValues = null) {
  const counts = new Map();
  for (const item of items) {
    const value = item?.[key];
    if (typeof value !== "string") continue;
    if (safeValues && !safeValues.has(value)) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, event_count]) => ({ [key]: name, event_count }))
    .sort((left, right) => right.event_count - left.event_count || String(left[key]).localeCompare(String(right[key])));
}

function aggregateVisualGate(events) {
  const visual = events.map(safeVisualGateMetadata).filter(Boolean);
  const issueCounts = new Map();
  for (const item of visual) {
    const categories = item.issue_category_counts;
    if (!categories || typeof categories !== "object" || Array.isArray(categories)) continue;
    for (const [category, count] of Object.entries(categories)) {
      if (!/^[a-z0-9_]{1,64}$/u.test(category)) continue;
      const numeric = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
      if (numeric > 0) issueCounts.set(category, (issueCounts.get(category) ?? 0) + numeric);
    }
  }
  return {
    event_count: visual.length,
    verdict_counts: countBy(visual, "verdict", new Set(["pass", "caution", "block"])),
    review_postures: countBy(visual, "review_posture", new Set(["smoke_only", "quick_review", "comparison_review", "standard_fallback", "blocked_before_gemini"])),
    issue_categories: [...issueCounts.entries()]
      .map(([category, event_count]) => ({ category, event_count }))
      .sort((left, right) => right.event_count - left.event_count || left.category.localeCompare(right.category)),
  };
}
```

Add `visual_gate: aggregateVisualGate(events),` to the returned summary object.

- [ ] **Step 5: Run telemetry tests**

Run:

```bash
node --test test/visual-gate.test.mjs --test-name-pattern "telemetry"
node --test test/telemetry-summary.test.mjs --test-name-pattern "visual gate"
```

Expected: PASS.

- [ ] **Step 6: Commit Task 6**

```bash
git add src/telemetry-summary.mjs test/telemetry-summary.test.mjs test/visual-gate.test.mjs
git commit -m "Aggregate visual gate telemetry safely"
```

---

### Task 7: Active Policy And Documentation

**Files:**
- Modify: `src/codex-global-install.mjs`
- Modify: `test/codex-global-install.test.mjs`
- Modify: `README.md`
- Modify: `test/package.test.mjs`

- [ ] **Step 1: Add failing active-policy assertions**

Modify `test/codex-global-install.test.mjs` active policy test:

```js
  assert.match(ACTIVE_POLICY_BLOCK, /visual gate/);
  assert.match(ACTIVE_POLICY_BLOCK, /high-risk visual/);
  assert.match(ACTIVE_POLICY_BLOCK, /screenshot evidence/i);
  assert.match(ACTIVE_POLICY_BLOCK, /Do not claim visual completion/i);
```

- [ ] **Step 2: Add failing README assertions**

Modify `test/package.test.mjs`:

```js
  assert.match(readme, /^\.\/bin\/gemini-agent visual gate --actual-screenshot after\.png --kind ui --smoke-only --json$/m);
  assert.match(readme, /^\.\/bin\/gemini-agent visual gate --target-screenshot target\.png --actual-screenshot after\.png --kind ui --risk design-implementation --json$/m);
  assert.match(readme, /`visual gate` composes local screenshot smoke checks/);
  assert.match(readme, /Visual gate outputs and telemetry do not expose raw prompts, raw responses, local paths, media file names, or image bytes/);
```

- [ ] **Step 3: Run docs/policy tests to verify failure**

Run:

```bash
node --test test/codex-global-install.test.mjs --test-name-pattern "active policy"
node --test test/package.test.mjs --test-name-pattern "README"
```

Expected: FAIL because docs and active policy do not mention visual gate.

- [ ] **Step 4: Update active policy**

Modify `ACTIVE_POLICY_BLOCK` in `src/codex-global-install.mjs` by adding this bullet after `artifact-review`:

```md
- `visual gate`: after UI, dashboard, report, game, canvas, 3D, prototype, or design implementation edits, capture screenshot evidence and run `gemini-agent visual gate` for high-risk visual work. Use target-vs-actual comparison when a design, before screenshot, generated candidate, or handoff target exists. If screenshot capture is impossible, report the missing evidence; do not claim visual completion.
```

Modify the active design routing paragraph:

```md
Active design routing: when the task is to create or materially redesign a UI, page, product surface, prototype, or visual workflow, prefer `gemini-agent design draft` before source edits when project data policy permits external Gemini calls. If a relevant design run already exists, read its handoff or run `gemini-agent design handoff` instead of creating a duplicate draft. After Codex implementation, capture screenshot evidence and use `gemini-agent visual gate` or `gemini-agent design loop` for target-vs-actual feedback. Do not claim visual completion when required screenshot evidence is missing.
```

- [ ] **Step 5: Update README command list and safety bullets**

Add to README command examples near `artifact-review`:

```md
./bin/gemini-agent visual gate --actual-screenshot after.png --kind ui --smoke-only --json
./bin/gemini-agent visual gate --target-screenshot target.png --actual-screenshot after.png --kind ui --risk design-implementation --json
```

Add to README safety/capabilities bullets:

```md
- `visual gate` composes local screenshot smoke checks, risk-based routing, and optional quick `artifact-review` into a pass/caution/block gate for UI and design-sensitive work.
- Visual gate outputs and telemetry do not expose raw prompts, raw responses, local paths, media file names, or image bytes in ordinary outputs.
```

- [ ] **Step 6: Run docs/policy tests**

Run:

```bash
node --test test/codex-global-install.test.mjs --test-name-pattern "active policy"
node --test test/package.test.mjs --test-name-pattern "README"
```

Expected: PASS.

- [ ] **Step 7: Commit Task 7**

```bash
git add src/codex-global-install.mjs test/codex-global-install.test.mjs README.md test/package.test.mjs
git commit -m "Document visual gate routing"
```

---

### Task 8: Final Verification And Release-Ready Review

**Files:**
- No code changes expected unless verification finds a defect.

- [ ] **Step 1: Run targeted test suite**

Run:

```bash
node --test test/visual-gate.test.mjs
node --test test/cli.test.mjs --test-name-pattern "visual gate|artifact-review"
node --test test/design-loop.test.mjs
node --test test/telemetry-summary.test.mjs --test-name-pattern "visual gate|artifact-review"
node --test test/codex-global-install.test.mjs --test-name-pattern "active policy"
node --test test/package.test.mjs --test-name-pattern "README"
```

Expected: PASS.

- [ ] **Step 2: Run full test suite**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 3: Run CLI smoke commands with fake response**

Run:

```bash
tmpdir="$(mktemp -d)"
printf '\\x89PNG\\r\\n\\x1a\\n' > "$tmpdir/after.png"
GEMINI_AGENT_ALLOW_FAKE_RESPONSE=1 \
GEMINI_AGENT_FAKE_RESPONSE='{"kind":"artifact_review","artifact_type":"design","summary":["ok"],"important_details":[],"design_or_research_findings":[],"implementation_hints_for_codex":[],"risks_or_ambiguities":[],"questions_for_user":[],"limitations":[],"design_scorecard":{"overall_score":80,"visual_hierarchy_score":80,"clarity_score":80,"accessibility_score":80,"consistency_score":80,"implementation_readiness_score":80,"strengths":[],"issues":[],"recommended_actions":[]},"metadata":{"model":"gemini-3.5-flash","generated_at":"2026-06-15T00:00:00.000Z","sources":[],"omitted_sources":[]}}' \
GEMINI_API_KEY=fake-key \
node ./bin/gemini-agent visual gate --actual-screenshot after.png --kind ui --risk css-change --json
```

Expected: JSON with `"kind": "visual_review_gate"` and no `after.png` path in output.

- [ ] **Step 4: Run diff review**

Run:

```bash
/opt/homebrew/bin/gemini-agent diff-review --smart-diff
```

Expected: JSON verdict. Address any `block` or concrete `caution` items before final commit.

- [ ] **Step 5: Commit verification fixes if needed**

If Step 1 through Step 4 required code fixes, commit them:

```bash
git add src test README.md
git commit -m "Stabilize visual gate implementation"
```

If no fixes were needed, do not create an empty commit.

- [ ] **Step 6: Final status**

Run:

```bash
git status --short
git log --oneline -5
```

Expected: no unstaged implementation changes. Recent commits should show the visual gate task commits.

---

## Self-Review Checklist

- Spec coverage:
  - Routing policy is covered in Task 1.
  - Local smoke checks are covered in Task 2.
  - `artifact-review` orchestration and pass/caution/block output are covered in Task 3.
  - CLI entrypoint is covered in Task 4.
  - `design loop` integration is covered in Task 5.
  - Safe telemetry aggregates are covered in Task 6.
  - Active policy and README are covered in Task 7.
  - Verification and independent review are covered in Task 8.
- Scope control:
  - Browser automation and CI blocking are not in this MVP.
  - Playwright screenshots remain a future extension.
  - The gate reports `block`; it does not automatically block commits.
- Data safety:
  - Tests assert no local paths, media file names, event ids, raw prompts, raw responses, or image bytes appear in ordinary output.
  - Telemetry uses safe aggregate metadata and existing raw governance.
