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
