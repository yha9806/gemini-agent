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
