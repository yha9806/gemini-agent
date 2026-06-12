# Artifact Review Quality Gate Design

Date: 2026-06-12

## Purpose

Add a local `gemini-agent telemetry artifact-review quality-gate` report so operators can decide whether `artifact-review` quick depth is ready for wider routing.

The gate turns existing aggregate telemetry into an explicit product decision:

- whether quick depth is ready, cautionary, or blocked;
- which quick output-token budget cohort is the riskiest;
- whether design scorecard coverage is strong enough to support visual-quality decisions;
- what next action should happen before routing more Codex visual/design work through Gemini.

This supports the larger product goal: use Gemini for low-cost multimodal judgment while Codex keeps execution authority.

## Command

```bash
gemini-agent telemetry artifact-review quality-gate [--global] [--json] [--top <n>]
```

Defaults:

- Scope follows existing telemetry scope behavior.
- `--top` defaults to `10`.
- Text output is the default.
- `--json` prints a strict machine-readable object.

## Data Source

Use the same local/global telemetry queue files scanned by `telemetry summary`.

Do not read raw payload text, production raw APIs, server admin APIs, screenshot files, or artifact JSON files in v1. The gate is aggregate-only and local-first.

The implementation should reuse `runTelemetrySummary` rather than duplicating queue scans. It should consume:

- `artifact_review_quality`;
- `artifact_review_depths`;
- command latency aggregates;
- product-adjusted event counts.

If any expected summary subsection is absent or partial, the quality gate must return safe fallback values and a caution status instead of throwing.

## Decision Model

The output includes a `readiness.status`:

- `blocked`: quick depth has enough evidence to show unsafe expansion, such as high error rate in the quick cohort or a clearly failing budget cohort.
- `caution`: evidence is too sparse, scorecard coverage is weak, or latency/quality signals are incomplete.
- `ready`: quick depth has enough clean samples, acceptable error rate, and scorecard coverage is high enough for product use.

Initial thresholds:

- Quick depth needs at least 10 events before it can be `ready`.
- Each active quick budget cohort needs at least 10 known outcomes before it is high confidence.
- Quick depth error rate should be below 5% before it can be `ready`.
- Scorecard coverage should be at least 80% before visual quality claims can be product-grade.
- Scorecard field coverage should be at least 80% for every numeric score field before the gate treats scorecard capture as healthy.

These thresholds are deterministic defaults, not hard product truth. They can later become CLI options if usage shows a need.

## JSON Output

`--json` prints this strict shape:

```json
{
  "ok": true,
  "scope": "global",
  "generated_at": "2026-06-12T00:00:00.000Z",
  "command": "artifact-review",
  "readiness": {
    "status": "caution",
    "reasons": []
  },
  "quick_depth": {
    "event_count": 0,
    "error_rate": null,
    "p95_latency_ms": null,
    "total_tokens": 0,
    "budget_cohorts": [],
    "worst_budget_cohort": null,
    "low_confidence": true
  },
  "scorecard": {
    "event_count": 0,
    "scorecard_event_count": 0,
    "coverage_rate": null,
    "field_coverage_min": null,
    "avg_overall_score": null,
    "avg_implementation_readiness_score": null,
    "weakest_field": null
  },
  "next_actions": [],
  "limitations": []
}
```

The report builder should construct this object with a whitelist. It must not spread full summary objects into the result.

## Text Output

Human output should include:

- readiness status;
- quick depth event count, error rate, p95 latency, and total tokens;
- worst quick budget cohort when available;
- low-confidence sample warning when applicable;
- scorecard coverage and weakest field;
- next actions;
- limitations.

Example:

```text
Artifact-review quality gate: caution
- Quick depth: 6 events, 33.3% error, p95 12,217 ms
- Worst quick budget cohort: 768 at 100.0% error rate (2 events, 2 error)
- Scorecard coverage: 6.3%
- Next action: Keep standard fallback and avoid expanding the 768 quick cohort.
```

## Privacy Boundary

Allowed outputs:

- aggregate counts;
- rates;
- latency percentiles;
- token totals;
- sanitized cohort labels such as `2048`, `768`, `unknown`, and `unbounded`;
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

The implementation must validate or normalize final output through a strict schema so accidental extra fields fail tests.

## Error Handling

Cold start behavior:

- If telemetry is empty, return `ok: true`, `readiness.status: "caution"`, and reasons such as `insufficient_artifact_review_data`.

Partial data behavior:

- If `artifact_review_quality` or `artifact_review_depths` is missing, return safe null/zero fields and a caution reason.
- If budget cohorts are empty, `worst_budget_cohort` is `null`.
- If cohorts tie on error rate, choose the cohort with more known outcomes, then lexicographic label order for deterministic output.

Argument errors:

- Reject unknown arguments.
- Reject invalid `--top` values before reading telemetry.
- Preserve existing global/local telemetry scope behavior.

## Testing

Use TDD.

Required tests:

- CLI route exists for text and `--json`.
- Empty telemetry returns caution and does not throw.
- Weak quick depth with a failing `768` cohort returns caution or blocked and names that cohort.
- Low scorecard coverage recommends capturing numeric scorecards before product decisions.
- Ready path requires enough quick samples, low error rate, and healthy scorecard coverage.
- JSON output has a strict whitelist shape and rejects unexpected fields in tests.
- Text and JSON outputs do not expose raw prompt, raw response, event ids, batch ids, paths, media file names, or credential-shaped strings.

Run targeted tests first, then full `npm test`.

## Out Of Scope

- Server-side Vulca API changes.
- Frontend admin dashboard changes.
- Raw payload reveal, export, deletion, or retention changes.
- New Gemini calls.
- New screenshot analysis algorithms.
- Automatic routing changes for `artifact-review`.

The gate only reports whether wider routing is advisable; Codex or a later routing feature decides whether to act.

## Acceptance Criteria

- `gemini-agent telemetry artifact-review quality-gate --global --json` returns a stable aggregate quality decision for `artifact-review` without exposing the telemetry storage path.
- The command is useful when current telemetry shows low quick-depth sample size, failing budget cohorts, or weak scorecard coverage.
- Output is aggregate-only and governed by a strict whitelist.
- Existing telemetry summary, priorities, economics, and report behavior remains compatible.
- Relevant targeted tests and full `npm test` pass before implementation is considered complete.

## Self-Review

- No incomplete sections remain.
- Scope is limited to the local quality gate.
- Thresholds, privacy boundaries, fallback behavior, and tests are explicit.
- The design does not claim that telemetry proves visual quality; it uses aggregate evidence to guide the next product action.
