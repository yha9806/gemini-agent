import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PNG } from "pngjs";
import { saveTelemetryConfig } from "../src/telemetry-config.mjs";
import { runTelemetrySummary } from "../src/telemetry-summary.mjs";
import { runVisualGate } from "../src/visual-gate.mjs";
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
    limitations: ["raw prompt unavailable", "after.png includes a stale frame"],
    metadata: {
      generated_at: "2026-06-15T00:00:00.000Z",
      artifact_review_readiness_status: "unknown",
      media_summary: [],
    },
  });

  assert.doesNotMatch(text, /\/Users|event_id|prompt|response|Authorization|secret-token|after\.png/);
  assert.match(text, /redacted unsafe visual gate text/);
});

function onePixelPng() {
  const image = new PNG({ width: 1, height: 1 });
  image.data[0] = 255;
  image.data[3] = 255;
  return PNG.sync.write(image);
}

const minimalPng = onePixelPng();
const corruptPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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
    width: 1,
    height: 1,
    media_kind: "screenshot",
  }]);
  assert.ok(smoke.checks.some((check) => check.name === "file_readable" && check.status === "pass"));
  assert.doesNotMatch(JSON.stringify(smoke), /after\.png|\/tmp|LOCAL_HOME_PATH/);
});

test("collectVisualGateSmoke cautions for corrupt image dimensions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "visual-gate-smoke-"));
  await writeFile(join(dir, "broken.png"), corruptPng);

  const smoke = await collectVisualGateSmoke({
    cwd: dir,
    screenshots: [{ role: "actual", path: "broken.png" }],
  });

  assert.equal(smoke.status, "caution");
  assert.deepEqual(smoke.media_summary, [{
    role: "actual",
    mime_type: "image/png",
    byte_size: corruptPng.length,
    width: null,
    height: null,
    media_kind: "screenshot",
  }]);
  assert.ok(smoke.checks.some((check) => check.name === "dimensions" && check.status === "caution"));
  assert.doesNotMatch(JSON.stringify(smoke), /broken\.png|\/tmp|LOCAL_HOME_PATH/);
});

test("collectVisualGateSmoke blocks screenshots above byte limit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "visual-gate-smoke-"));
  await writeFile(join(dir, "large.png"), minimalPng);

  const smoke = await collectVisualGateSmoke({
    cwd: dir,
    screenshots: [{ role: "actual", path: "large.png" }],
    maxImageBytes: minimalPng.length - 1,
  });

  assert.equal(smoke.status, "block");
  assert.ok(smoke.checks.some((check) => check.name === "byte_size" && check.status === "block"));
  assert.doesNotMatch(JSON.stringify(smoke), /large\.png|\/tmp|LOCAL_HOME_PATH/);
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
  assert.deepEqual({
    ...seenInput.telemetry.metadata.visual_gate,
    smoke_check_counts: undefined,
  }, {
    phase: "pre_gemini",
    risk_level: "high",
    risk_reasons: ["design_implementation", "target_actual_comparison"],
    routing: "required",
    review_posture: "comparison_review",
    smoke_status: "pass",
    smoke_check_counts: undefined,
    artifact_review_used: true,
    artifact_review_mode: "comparison",
    artifact_review_depth: "quick",
    fallback_used: false,
    issue_category_counts: {},
  });
  assert.ok(seenInput.telemetry.metadata.visual_gate.smoke_check_counts.pass >= 8);
  assert.equal(seenInput.telemetry.metadata.visual_gate.smoke_check_counts.block, undefined);
  assert.equal(result.verdict, "pass");
  assert.equal(result.review_posture, "comparison_review");
  assert.equal(result.artifact_review.scorecard.implementation_readiness_score, 81);
  assert.doesNotMatch(JSON.stringify(result), /target\.png|after\.png|\/tmp|LOCAL_HOME_PATH/);
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

test("runVisualGate redacts artifact review media filenames from ordinary output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "visual-gate-run-"));
  await writeFile(join(dir, "target.png"), minimalPng);
  await writeFile(join(dir, "after.png"), minimalPng);

  const result = await runVisualGate({
    apiKey: "fake-key",
    cwd: dir,
    targetScreenshot: "target.png",
    actualScreenshot: "after.png",
    riskHints: ["design-implementation"],
    artifactReview: async () => ({
      ...fakeArtifactReview,
      design_scorecard: {
        ...fakeArtifactReview.design_scorecard,
        issues: ["after.png has clipped footer text"],
        recommended_actions: ["Compare target.png and after.png before release"],
      },
    }),
  });

  const serialized = JSON.stringify(result);
  assert.equal(result.verdict, "caution");
  assert.doesNotMatch(serialized, /target\.png|after\.png|\/tmp/);
});

test("runVisualGate final telemetry records post-review issue counts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "visual-gate-run-"));
  await writeFile(join(dir, "after.png"), minimalPng);
  const captures = [];

  const result = await runVisualGate({
    apiKey: "fake-key",
    cwd: dir,
    actualScreenshot: "after.png",
    riskHints: ["css-change"],
    telemetry: {
      cwd: dir,
      source: "cli",
      command: "visual-gate",
      capture: async (event) => {
        captures.push(event);
        return { queued: true };
      },
    },
    artifactReview: async () => ({
      ...fakeArtifactReview,
      design_scorecard: {
        ...fakeArtifactReview.design_scorecard,
        issues: ["label overlaps /Users/alice/private.png"],
      },
    }),
  });

  assert.equal(result.verdict, "caution");
  assert.equal(captures.length, 1);
  assert.deepEqual(captures[0].metadata.visual_gate.issue_category_counts, {
    uncertain_visual_evidence: 1,
  });
  assert.equal(captures[0].metadata.visual_gate.verdict, "caution");
  assert.equal(captures[0].metadata.visual_gate.phase, "final");
  assert.equal(captures[0].metadata.visual_gate.review_posture, "quick_review");
  assert.equal(captures[0].metadata.visual_gate.artifact_review_used, true);
  assert.doesNotMatch(JSON.stringify(captures[0].metadata), /after\.png|\/tmp|\/Users|prompt|response/);
});

test("runVisualGate smoke-only telemetry records final safe metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "visual-gate-run-"));
  await writeFile(join(dir, "after.png"), minimalPng);
  const captures = [];

  const result = await runVisualGate({
    cwd: dir,
    actualScreenshot: "after.png",
    smokeOnly: true,
    telemetry: {
      cwd: dir,
      source: "cli",
      command: "visual-gate",
      capture: async (event) => {
        captures.push(event);
        return { queued: true };
      },
    },
  });

  assert.equal(result.verdict, "pass");
  assert.equal(captures.length, 1);
  assert.equal(captures[0].command, "visual-gate");
  assert.equal(captures[0].metadata.visual_gate.review_posture, "smoke_only");
  assert.equal(captures[0].metadata.visual_gate.smoke_status, "pass");
  assert.equal(captures[0].metadata.visual_gate.phase, "final");
  assert.deepEqual(captures[0].outcome, {
    task_outcome: "success",
    user_acceptance: "not_applicable",
    followup_required: false,
  });
  assert.doesNotMatch(JSON.stringify(captures[0].metadata), /after\.png|\/tmp|\/Users|prompt|response/);
});

test("runVisualGate queues final telemetry into configured summary", async () => {
  const dir = await mkdtemp(join(tmpdir(), "visual-gate-run-"));
  await writeFile(join(dir, "after.png"), minimalPng);
  await saveTelemetryConfig({
    cwd: dir,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: "GEMINI_AGENT_TEST_TOKEN",
    deploymentId: "gemini-agent-test",
    now: new Date("2026-06-15T00:00:00.000Z"),
  });

  const result = await runVisualGate({
    cwd: dir,
    actualScreenshot: "after.png",
    smokeOnly: true,
    now: new Date("2026-06-15T00:00:00.000Z"),
  });

  assert.equal(result.verdict, "pass");
  const summary = await runTelemetrySummary({ cwd: dir, scope: "local" });
  assert.deepEqual(summary.visual_gate, {
    command_event_count: 1,
    command_events_missing_phase_count: 0,
    event_count: 1,
    final_event_count: 1,
    phase_counts: [{ phase: "final", event_count: 1 }],
    verdict_counts: [{ verdict: "pass", event_count: 1 }],
    review_postures: [{ review_posture: "smoke_only", event_count: 1 }],
    issue_categories: [],
  });
});

test("runVisualGate returns normalized fallback when artifact review fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "visual-gate-run-"));
  await writeFile(join(dir, "after.png"), minimalPng);
  const captures = [];

  const result = await runVisualGate({
    apiKey: "fake-key",
    cwd: dir,
    actualScreenshot: "after.png",
    riskHints: ["css-change"],
    telemetry: {
      cwd: dir,
      source: "cli",
      command: "visual-gate",
      capture: async (event) => {
        captures.push(event);
        return { queued: true };
      },
    },
    artifactReview: async () => {
      throw new Error("Gemini timeout /Users/alice/private.png");
    },
  });

  assert.equal(result.verdict, "caution");
  assert.equal(result.review_posture, "standard_fallback");
  assert.equal(result.artifact_review.used, false);
  assert.equal(result.artifact_review.fallback_used, true);
  assert.match(result.limitations.join("\n"), /Gemini artifact review failed/);
  assert.equal(captures[0].metadata.visual_gate.fallback_used, true);
  assert.equal(captures[0].metadata.visual_gate.verdict, "caution");
  assert.doesNotMatch(JSON.stringify(result), /Gemini timeout|\/Users|private\.png/);
});

test("runVisualGate ignores final telemetry capture failures", async () => {
  const dir = await mkdtemp(join(tmpdir(), "visual-gate-run-"));
  await writeFile(join(dir, "after.png"), minimalPng);

  const result = await runVisualGate({
    cwd: dir,
    actualScreenshot: "after.png",
    smokeOnly: true,
    telemetry: {
      cwd: dir,
      source: "cli",
      command: "visual-gate",
      capture: async () => {
        throw new Error("telemetry failed");
      },
    },
  });

  assert.equal(result.kind, "visual_review_gate");
  assert.equal(result.verdict, "pass");
});
