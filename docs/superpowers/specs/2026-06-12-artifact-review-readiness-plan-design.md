# Artifact Review Readiness Plan Design

Date: 2026-06-12

## Purpose

Add an A2 `gemini-agent telemetry artifact-review readiness-plan` command that turns the existing artifact-review telemetry reports into one production-readiness decision.

A1 made `coverage-plan` available. A2 should not immediately widen routing. It should first prove that artifact-review can be used as a reliable, governed, low-surprise production multimodal helper for Codex.

The current aggregate state shows why this needs a readiness gate:

- `coverage-plan` status is `ready_for_more_collection`, not ready for broad routing.
- production scorecard coverage is `10 of 160`, or `6.25%`, against an 80% target.
- active quick `2048` has `4` successful events and `0` errors, but still needs `6` more events for minimum confidence.
- Gemini generation p95 is `14,055 ms` against a `15,000 ms` budget, so latency is inside budget but near the limit.
- telemetry priorities still rank structured JSON envelope failure as the highest reliability risk for artifact-review.
- telemetry doctor reports `9` pending raw events and says small flushes are safe, but raw preflight risk signals still need governed handling before broad routing.

## Command

```bash
gemini-agent telemetry artifact-review readiness-plan [--global] [--json] [--top <n>]
```

Defaults:

- Scope follows the existing local/global telemetry behavior.
- `--top` defaults to `10`.
- Text output is default.
- `--json` prints a strict machine-readable object.
- The command is aggregate-only. It must not reveal raw prompt text, response text, request payloads, event ids, paths, media file names, or credential-shaped strings.

## Product Boundary

The readiness plan answers one question:

> Can Codex safely expand production artifact-review routing now, or should it keep collecting bounded production samples?

The command must not:

- call Gemini;
- run artifact-review samples by itself;
- upload raw telemetry;
- change global routing rules;
- mark any raw data as safe;
- treat validation-only runs as proof of production readiness.

Codex remains the execution authority for edits, tests, commits, routing decisions, and final claims.

## Inputs

The command combines existing aggregate sources:

- `runTelemetrySummary`, for product-adjusted artifact-review quality, depth, structured-response, latency, raw queue, and delivery aggregates;
- `buildArtifactReviewQualityGate`, for quick-depth readiness and generation-latency status;
- `buildArtifactReviewCoveragePlan`, for production versus validation scorecard coverage and active quick sample deficit;
- telemetry doctor style delivery diagnostics, for pending, failed, quarantine, endpoint, and small-flush readiness signals;
- raw preflight aggregate counts, for whether pending raw telemetry has sensitive categories that require explicit governance before flush.

The implementation should reuse existing modules where possible. It should not add a second queue scanner or read raw payload contents directly.

## Decision Model

The report includes `readiness.status`:

- `blocked`: artifact-review should not expand production routing.
- `collect_more_samples`: artifact-review may continue bounded production sampling, but limited routing is not yet allowed.
- `ready_for_limited_routing`: artifact-review meets the minimum gate for controlled production routing.

The report also includes `readiness.reasons`, a deduplicated list of safe reason codes.

### Blocked Conditions

Return `blocked` when any of these are true:

- active quick error rate is at least 5% after minimum blocking sample size;
- generation latency is over the budget;
- production scorecard coverage is zero after production artifact-review events exist;
- raw telemetry is in failed or quarantine state;
- endpoint/token/config checks fail when delivery diagnostics are available.

### Collect More Samples Conditions

Return `collect_more_samples` when routing is not blocked but any of these are true:

- active quick `2048` has fewer than 10 production outcomes;
- production scorecard coverage is below 80%;
- any fixed numeric scorecard field has coverage below 80%;
- structured JSON envelope risk exists for artifact-review and needs retry recovery evidence before limited routing;
- generation latency is within budget but at or above 90% of the budget;
- raw pending events have sensitive preflight signals and need governed review, reveal/export/delete/prune, or small-batch flush before broader routing;
- validation coverage is healthier than production coverage, meaning calibration is useful but production proof is still missing.

### Ready For Limited Routing Conditions

Return `ready_for_limited_routing` only when all are true:

- production scorecard coverage is at least 80%;
- every fixed numeric scorecard field has at least 80% production coverage;
- every active quick budget cohort has at least 10 known production outcomes;
- active quick error rate is below 5%;
- generation latency is within budget and not near budget;
- structured-response retry diagnostics show no current unrecovered artifact-review JSON envelope risk;
- raw telemetry delivery has no failed or quarantined events;
- raw pending state is empty, or preflight says pending data is safe enough for the configured small-batch flush workflow.

## JSON Output

`--json` prints this strict top-level shape:

```json
{
  "ok": true,
  "scope": "global",
  "generated_at": "2026-06-12T00:00:00.000Z",
  "command": "artifact-review",
  "readiness": {
    "status": "collect_more_samples",
    "reasons": []
  },
  "production_scorecard": {},
  "validation_scorecard": {},
  "active_quick_collection": {},
  "structured_response": {
    "event_count": 0,
    "missing_json_envelope_count": 0,
    "missing_json_envelope_rate": null,
    "retry_event_count": 0,
    "retry_scheduled_count": 0,
    "retry_recovered_count": 0,
    "retry_recovery_rate": null,
    "affected_command": "artifact-review"
  },
  "latency_guard": {},
  "raw_governance": {
    "pending_count": 0,
    "failed_count": 0,
    "quarantine_count": 0,
    "small_flush_safe": false,
    "preflight_available": false,
    "preflight_selected_count": 0,
    "sensitive_signal_count": 0,
    "recommended_action": null
  },
  "routing_recommendation": {
    "limited_routing_allowed": false,
    "production_sampling_allowed": true,
    "additional_quick_samples_needed": 0,
    "recommended_review_depth": "quick",
    "recommended_budget_cohorts": ["2048"]
  },
  "next_actions": [],
  "limitations": []
}
```

Nested sections should be whitelisted projections from existing reports. Do not spread full summary, doctor, raw preflight, or queue objects into the output.

## Text Output

Human output should lead with the decision:

```text
Artifact-review readiness plan: collect_more_samples
- Limited routing: no
- Production sampling: yes, collect 6 more quick 2048 samples
- Production scorecard coverage: 6.3% (10 of 160)
- Structured response: artifact-review has unrecovered JSON-envelope risk
- Raw governance: 9 pending events; run preflight and small-batch flush workflow
- Latency: within budget but near 15,000 ms p95 limit
```

The text output should be concise and should mirror the JSON decision fields.

## Sample Collection Guidance

The command should recommend what to collect next, but it should not run samples.

For the current state, the recommendation should be:

- keep standard fallback available;
- allow bounded production sampling with `artifact-review --review-depth quick`;
- prioritize the active quick `2048` cohort;
- collect `6` more successful production samples before considering wider routing;
- require numeric design scorecards on new production artifact-review outputs;
- do not count validation-only runs toward production readiness.

Future implementation may add a separate runner, but this spec keeps the runner out of scope so the first A2 implementation stays safe and testable.

## Structured Response Handling

Existing artifact-review already performs one structured JSON retry for `MAX_TOKENS` and missing JSON envelopes. The readiness plan should verify whether that recovery path is visible in aggregate telemetry.

Rules:

- unrecovered artifact-review missing-envelope events block limited routing but still allow bounded sample collection when all hard safety gates are clean;
- retry recovery evidence can clear the structured-response collection reason when all other gates pass;
- retry diagnostics should remain aggregate-only;
- the command must not inspect raw response text to diagnose JSON failures.

## Raw Governance

Raw telemetry is necessary for the product, but readiness outputs must remain governed.

The readiness plan should:

- show pending, failed, and quarantine counts;
- show whether raw preflight is available;
- show aggregate sensitive-signal counts from preflight;
- recommend `telemetry flush --dry-run` and small batch flushes when appropriate;
- recommend reveal/export/delete/prune workflows when risk signals are present;
- avoid claiming that `small_flush_safe` means privacy-safe.

The command must not execute flush, reveal, export, delete, or prune actions.

## Privacy Boundary

Allowed outputs:

- aggregate counts and rates;
- fixed scorecard field names;
- safe reason codes;
- active budget cohort labels such as `2048`;
- latency percentiles and budgets;
- fixed next-action text;
- delivery status classes.

Forbidden outputs:

- raw prompts;
- raw responses;
- request payloads;
- event ids;
- batch ids;
- filesystem paths;
- media file names;
- arbitrary metadata values;
- credential-shaped strings.

Hostile aggregate input must not appear in text or JSON output.

## Error Handling

Cold start:

- Return `ok: true`, `readiness.status: "collect_more_samples"`, and `insufficient_artifact_review_data`.

Partial data:

- If coverage-plan cannot build, return safe null/zero scorecard and quick fields with a limitation.
- If quality-gate cannot build, return safe null/zero quick and latency fields with a limitation.
- If raw preflight is unavailable, keep raw governance conservative and recommend running preflight separately.
- If endpoint diagnostics are unavailable due to network conditions, do not fail the command; mark delivery evidence as unavailable and avoid `ready_for_limited_routing`.

Argument errors:

- Reject unknown arguments.
- Reject missing, non-integer, zero, or negative `--top` values before reading telemetry.
- Preserve existing telemetry scope behavior.

## Testing

Use TDD.

Required tests:

- Empty telemetry returns `collect_more_samples` without leaking private strings.
- Current A2-shaped data returns `collect_more_samples`, not `ready_for_limited_routing`.
- Active quick `2048` with 4 successes and 0 errors recommends 6 additional samples.
- Active quick error rate at or above 5% after enough samples returns `blocked`.
- Production scorecard coverage below 80% prevents limited routing even when validation coverage is healthy.
- Missing fixed scorecard field coverage below 80% prevents limited routing.
- Validation-only scorecards never promote production readiness.
- Generation latency over budget returns `blocked`.
- Generation latency at or above 90% but below budget returns `collect_more_samples`.
- Unrecovered structured JSON envelope risk blocks wider routing.
- Structured JSON retry recovery evidence downgrades the risk from blocked to sample collection when all other hard gates pass.
- Raw failed or quarantine events return `blocked`.
- Raw pending sensitive preflight signals prevent limited routing and recommend governed workflows.
- CLI route works for text and `--json`.
- CLI rejects unknown arguments and invalid `--top` values before reading telemetry.
- JSON output has a strict whitelist shape.
- Hostile aggregate input containing prompt text, response text, paths, media names, event ids, batch ids, or credential-shaped strings does not appear in text or JSON output.
- README documents the command and states that it does not run samples, upload raw telemetry, or change routing by itself.

Run targeted tests first, then full `npm test`.

## Out Of Scope

- Automatic artifact-review sampling runner.
- Automatic global routing changes.
- Server-side Vulca API changes.
- Frontend admin dashboard changes.
- Raw reveal, export, delete, prune, or flush execution.
- New Gemini calls.
- New screenshot analysis algorithms.
- Changing artifact-review output schemas.
- Changing active quick output-token budgets.

## Acceptance Criteria

- `gemini-agent telemetry artifact-review readiness-plan --global --json` returns a strict aggregate decision object.
- The command tells operators whether to block, collect more samples, or allow limited routing.
- The command uses existing A1 coverage and quality-gate signals instead of duplicating scanners.
- The command includes structured-response, latency, active quick, scorecard, and raw-governance gates.
- The command is aggregate-only and privacy-safe by construction.
- Current observed global telemetry produces `collect_more_samples`, not `ready_for_limited_routing`.
- The written implementation plan can be created from this spec without further product decomposition.
