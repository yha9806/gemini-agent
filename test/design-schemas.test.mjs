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

test("normalizes perception with numeric and null bounding boxes", () => {
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
    }, {
      id: "unknown",
      label: "Unknown",
      role: "unclassified",
      importance: 0.2,
      bbox: null,
      mask_ref: null,
      confidence: null,
    }],
    hierarchy: ["hero"],
    layout_observations: ["Hero spans most of the viewport"],
    implementation_constraints: ["Use existing card component"],
    confidence: 0.7,
    warnings: [],
  });
  assert.equal(perception.regions[0].bbox.width, 0.8);
  assert.equal(perception.regions[1].bbox, null);
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
