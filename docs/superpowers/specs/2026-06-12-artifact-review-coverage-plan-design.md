# Artifact Review Production Coverage Plan Design

Date: 2026-06-12

## Purpose

Add a local aggregate `gemini-agent telemetry artifact-review coverage-plan` report that tells operators what is still needed before `artifact-review` can be treated as a dependable production multimodal helper for Codex.

This is A1: production scorecard coverage first.

The current quality gate already reports quick-depth readiness, active budget cohorts, latency, and scorecard coverage. It shows a useful caution state today:

- active quick `2048` cohort has 4 successes and 0 errors, but the sample is too small;
- historical quick `768` cohort has failures and should stay visible as historical risk;
- artifact-review scorecard coverage is about 6.25%, so visual-quality analytics are not yet product-grade;
- Gemini generation p95 is close to the 15 second budget, but still inside it.

The coverage plan turns those signals into a concrete next-step report without pretending that validation-only runs prove production readiness.

## Command

```bash
gemini-agent telemetry artifact-review coverage-plan [--global] [--json] [--top <n>]
```

Defaults:

- Scope follows existing telemetry scope behavior.
- `--top` defaults to `10`.
- Text output is the default.
- `--json` prints a strict machine-readable object.

## Product Boundary

The command answers four questions:

1. How much real production artifact-review scorecard coverage do we have?
2. How much validation or canary scorecard coverage do we have?
3. How many more active quick-budget samples are needed before wider routing?
4. What is the next highest-value action for reducing Codex token usage with Gemini while keeping reliability safe?

It does not automatically change routing. Codex remains responsible for code edits, tests, commits, release decisions, and final interpretation.

## Data Source

Use the same local/global telemetry queue files scanned by `telemetry summary`.

Do not read raw payload text, raw prompt/response APIs, server admin APIs, screenshot files, artifact JSON files, or media paths in v1. The report is aggregate-only and local-first.

Implementation should reuse `runTelemetrySummary` and extend its aggregate output only where current summary data is insufficient. The coverage-plan command must not introduce a second telemetry queue scanner, direct JSON file reader, or independent concurrency model. It inherits existing summary behavior for queue state scanning, invalid sample handling, and partially written telemetry files.

Production versus validation classification uses the existing telemetry-purpose contract: `safeTelemetryPurpose(event.metadata.telemetry_purpose)` returns either `production` or `validation`, and missing or unknown values are treated as `production`. Current `artifact_review_quality` and `artifact_review_depths` already exclude validation events, so they can remain the product-adjusted production view for compatibility. Add explicit validation aggregates so A1 can show calibration progress separately.

Required summary additions:

```json
{
  "artifact_review_validation_quality": {
    "event_count": 0,
    "success_count": 0,
    "error_count": 0,
    "scorecard_event_count": 0,
    "scorecard_field_coverage": [],
    "avg_overall_score": null,
    "avg_implementation_readiness_score": null,
    "top_commands": []
  },
  "artifact_review_validation_depths": {
    "event_count": 0,
    "known_depth_event_count": 0,
    "top_depths": [],
    "top_budget_cohorts": []
  }
}
```

Existing `artifact_review_quality` and `artifact_review_depths` must keep their current shape and behavior.

## Report Model

Create a focused coverage-plan module that builds a whitelisted object from summary data and the existing quality gate:

- production scorecard coverage from `artifact_review_quality`;
- validation scorecard coverage from `artifact_review_validation_quality`;
- active quick budget cohort sample deficit from `telemetry artifact-review quality-gate`;
- historical quick budget cohort risk from the quality gate;
- generation latency guard from the quality gate;
- next actions ordered by product value and safety.

The module should not spread full summary or quality-gate objects into its output. It should explicitly construct only allowed fields.

## Decision Model

The report includes `plan.status`:

- `blocked`: production artifact-review scorecard coverage is zero, active quick reliability is unsafe, or generation latency is over budget with enough samples.
- `caution`: production coverage is low, active quick samples are too sparse, validation coverage is strong but production coverage is weak, or latency is near the budget.
- `ready_for_more_collection`: production scorecard coverage is still below product-grade, but active quick reliability is clean enough to collect more production samples gradually.
- `ready_for_limited_routing`: production scorecard coverage is at least 80%, all scorecard fields are at least 80%, active quick sample size is high-confidence, active quick error rate is below 5%, and generation latency is within budget.

Initial thresholds:

- Production scorecard coverage target: 80%.
- Validation scorecard coverage target: 80%.
- Active quick cohort confidence target: 10 known outcomes per active quick budget cohort.
- Active quick error-rate target: below 5%.
- Generation latency budget: use the existing quality-gate generation latency budget.
- Near-latency warning: p95 at or above 90% of budget.

Validation coverage can explain calibration progress, but it must not promote production status by itself.

## JSON Output

`--json` prints this strict shape:

```json
{
  "ok": true,
  "scope": "global",
  "generated_at": "2026-06-12T00:00:00.000Z",
  "command": "artifact-review",
  "plan": {
    "status": "ready_for_more_collection",
    "reasons": []
  },
  "production_scorecard": {
    "event_count": 0,
    "scorecard_event_count": 0,
    "coverage_rate": null,
    "field_coverage_min": null,
    "weakest_field": null,
    "target_coverage_rate": 0.8,
    "events_needed_for_target": null
  },
  "validation_scorecard": {
    "event_count": 0,
    "scorecard_event_count": 0,
    "coverage_rate": null,
    "field_coverage_min": null,
    "weakest_field": null,
    "target_coverage_rate": 0.8
  },
  "active_quick_collection": {
    "active_budget_cohorts": [],
    "target_events_per_cohort": 10,
    "additional_events_needed": 0,
    "active_error_rate": null,
    "low_confidence": true
  },
  "latency_guard": {
    "status": "unknown",
    "p95_ms": null,
    "budget_ms": 15000,
    "near_budget": false
  },
  "historical_risks": [],
  "next_actions": [],
  "limitations": []
}
```

## Text Output

Human output should include:

- plan status;
- production scorecard coverage and event target gap;
- validation scorecard coverage as calibration context;
- active quick cohort sample deficit;
- latency guard;
- historical budget cohort risk;
- next actions.

Example:

```text
Artifact-review coverage plan: ready_for_more_collection
- Production scorecard coverage: 6.3% (10 of 160)
- Validation scorecard coverage: 80.0% (4 of 5)
- Active quick collection: 6 more 2048 samples needed
- Latency guard: within budget, near 15,000 ms p95 limit
- Next action: route a small number of production artifact-review tasks through quick 2048 and require numeric scorecards.
```

## Privacy Boundary

Allowed outputs:

- aggregate counts;
- rates;
- scorecard field names from the fixed allowlist;
- active budget cohort labels such as `2048` and `768`;
- latency percentiles and budget values;
- fixed recommendations and limitations.

Forbidden outputs:

- raw prompt text;
- raw response text;
- request payloads;
- event ids;
- batch ids;
- filesystem paths;
- media file names;
- credential-shaped strings;
- arbitrary metadata values.

The final output should be schema-shaped and tested for leakage with hostile input.

## Error Handling

Cold start behavior:

- If telemetry is empty, return `ok: true`, `plan.status: "caution"`, and reasons such as `insufficient_artifact_review_data`.

Partial data behavior:

- If validation-specific aggregates are absent, treat validation coverage as unknown and add a limitation instead of throwing.
- If the quality gate is absent or cannot build, return safe null/zero quick and latency fields with a caution status.
- If active quick cohorts are empty, show zero additional samples needed only when there is no quick-depth routing signal; otherwise show a caution reason.

Argument errors:

- Reject unknown arguments.
- Reject missing, non-integer, zero, or negative `--top` values before reading telemetry.
- Preserve existing global/local telemetry scope behavior.

## Testing

Use TDD.

Required tests:

- Summary exposes validation-only artifact-review quality/depth aggregates while preserving existing product-adjusted `artifact_review_quality` and `artifact_review_depths`.
- Coverage plan returns caution for empty telemetry without leaking private text.
- Low production scorecard coverage with good validation coverage stays caution or ready-for-collection, never ready-for-routing.
- Active quick `2048` sample deficit is computed from active cohorts only; historical `768` failures remain historical risk.
- Latency near 90% of the budget appears as a guard in next actions.
- Ready-for-limited-routing requires production coverage, field coverage, active quick confidence, active quick error rate, and latency to pass.
- CLI route works for text and `--json`.
- CLI rejects unknown arguments and invalid `--top` values before reading telemetry.
- Malformed, invalid, or partially written telemetry files keep the report in a safe caution state through existing summary invalid-sample handling.
- JSON output has a strict whitelist shape.
- Hostile aggregate input containing prompt text, response text, event ids, paths, media names, or credential-shaped strings does not appear in text or JSON output.
- README documents the command and explicitly says validation coverage cannot prove production readiness.

Run targeted tests first, then full `npm test`.

## Out Of Scope

- Server-side Vulca API changes.
- Frontend admin dashboard changes.
- Raw payload reveal, export, deletion, or retention changes.
- New Gemini calls.
- New screenshot analysis algorithms.
- Automatic routing changes for `artifact-review`.
- Changing the current active quick output-token budgets.

The report recommends what to collect next; it does not collect or route work by itself.

## Acceptance Criteria

- `gemini-agent telemetry artifact-review coverage-plan --global --json` returns a stable aggregate plan for improving artifact-review production coverage.
- The command separates production scorecard coverage from validation scorecard coverage.
- Validation-only success cannot produce a ready-for-routing status.
- Active quick sample gaps are based on current active budget cohorts, while historical risky cohorts stay visible.
- Output is aggregate-only and governed by a strict whitelist.
- Existing telemetry summary, quality gate, priorities, economics, and report behavior remains compatible.
- Relevant targeted tests and full `npm test` pass before implementation is considered complete.

## Self-Review

- No placeholders or incomplete sections remain.
- Scope is limited to local aggregate telemetry planning.
- The design preserves existing summary compatibility.
- The design explicitly separates production readiness from validation calibration.
- Privacy boundaries, fallback behavior, tests, and acceptance criteria are explicit.
