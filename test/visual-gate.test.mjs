import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectVisualGateSmoke } from "../src/visual-gate-smoke.mjs";
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

test("visualGateVerdictFromSignals tolerates null issues", () => {
  const verdict = visualGateVerdictFromSignals({
    routing: "recommended",
    smokeStatus: "pass",
    scorecard: { implementation_readiness_score: 92, accessibility_score: 91 },
    issues: null,
  });

  assert.equal(verdict, "pass");
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

test("visualGateToPrettyJson sanitizes unsafe free-text fields", () => {
  const text = visualGateToPrettyJson({
    kind: "visual_review_gate",
    verdict: "caution",
    review_posture: "quick_review",
    risk_level: "medium",
    risk_reasons: ["visible_css_change", "review /Users/alice/project"],
    smoke: {
      status: "caution",
      checks: [{
        name: "file_readable",
        status: "caution",
        evidence: "prompt event_id evt_private at /Users/alice/project",
      }],
    },
    artifact_review: { used: false, mode: null, depth: null, fallback_used: false, scorecard: null },
    issues: [{
      category: "uncertain_visual_evidence",
      severity: "medium",
      summary: "response mentioned Authorization: Bearer secret-token",
      recommended_action: "inspect prompt output before release",
    }],
    next_actions: ["check response event_id before release"],
    limitations: ["raw prompt unavailable"],
    metadata: {
      generated_at: "2026-06-15T00:00:00.000Z",
      artifact_review_readiness_status: "unknown",
      media_summary: [],
    },
  });

  assert.doesNotMatch(text, /\/Users|event_id|prompt|response|Authorization|secret-token/);
  assert.match(text, /redacted unsafe visual gate text/);
});

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
  assert.doesNotMatch(JSON.stringify(smoke), /after\.png|\/tmp|LOCAL_HOME_PATH/);
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
