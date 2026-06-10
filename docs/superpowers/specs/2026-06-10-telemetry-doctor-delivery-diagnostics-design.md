# Telemetry Doctor Delivery Diagnostics Design

Date: 2026-06-10

## Scope

Add a Doctor-only delivery diagnostics slice to `gemini-agent telemetry doctor`. The goal is to explain local delivery health when local telemetry has pending or failed events, especially when local totals do not match accepted server totals.

This design does not add server admin queries, raw payload reveal, export, deletion, or retention controls. Those remain separate Reliability and Raw Governance work.

## Decision

Implement local-only delivery diagnostics in `runTelemetryDoctor`.

The doctor should report:

- local queue totals from the existing queue snapshot and state;
- unsent local events as `pending + failed + inflight`;
- non-retryable failure count from queue state;
- failed batch reason breakdown read from `queue/failed/<batch>/reason.json`;
- a delivery status and next action based on pending, failed, quarantine, and config health.

## Architecture

The implementation stays inside the telemetry subsystem:

- `src/telemetry-queue.mjs` owns safe queue inspection helpers.
- `src/telemetry-doctor.mjs` calls those helpers and adds a `delivery` object to its JSON result.
- `src/cli.mjs` can keep using the existing doctor result printing path unless text output needs a small delivery summary.

No new storage format is required. Existing failed batches already persist `reason.json` beside event files. The new code should summarize those files without exposing event payload content.

## Data Flow

1. `runTelemetryDoctor` resolves telemetry scope and storage cwd as it does today.
2. It loads `queue`, `state`, and config checks.
3. It loads failed batch summaries from `queue/failed`.
4. It builds `delivery`:
   - `sent_events`: `state.sent_success_count`
   - `pending_events`: `queue.pending.count`
   - `inflight_events`: `queue.inflight.count`
   - `failed_events`: `queue.failed.count`
   - `unsent_events`: pending + inflight + failed
   - `local_total_events`: sent + pending + inflight + failed + quarantine
   - `non_retryable_failure_count`: `state.non_retryable_failure_count`
   - `failed_reason_counts`: reason summaries by batch count and event count
5. It returns the existing doctor result plus `delivery`.

## Privacy Boundary

Delivery diagnostics must not read or return raw prompts, raw responses, media file names, event ids, request payloads, response candidates, or tool calls.

Allowed outputs:

- counts;
- sanitized failure reason labels;
- batch counts;
- event counts;
- queue byte counts already exposed by snapshots.

## Delivery Status Rules

Use a small deterministic status:

- `blocked_by_non_retryable_failures` when failed events or non-retryable failures are present;
- `quarantined_events_present` when quarantine count is nonzero and failed count is zero;
- `flush_ready` when pending or inflight exists and config/token/endpoint checks pass;
- `flush_blocked` when pending or inflight exists but config/token/endpoint checks fail;
- `delivered` when there are no pending, inflight, failed, or quarantine events.

The status should not depend on live server metrics. Server reconciliation is a later feature.

## Error Handling

If a failed batch has a missing, unreadable, or malformed `reason.json`, include it under reason `unknown` and keep doctor running. Diagnostics must not fail closed just because one failed batch has bad metadata.

If queue directories are absent, the doctor should preserve existing behavior: do not create queue directories during empty diagnostics.

## Testing

Use TDD in `test/telemetry-doctor.test.mjs`.

Required tests:

- doctor reports delivery totals and failed reason breakdown for pending plus non-retryable failed batches;
- doctor does not expose raw prompt or response text through `delivery`;
- doctor treats malformed failed `reason.json` as `unknown` without throwing;
- doctor keeps empty diagnostics from creating queue directories.

Run the targeted doctor tests first, then the full `npm test`.

## Acceptance Criteria

- `gemini-agent telemetry doctor --global --json` can explain local pending/failed delivery gaps without server admin access.
- The JSON result includes `delivery`.
- Existing doctor output remains backward compatible for current fields.
- No raw content, event ids, or media file names appear in delivery diagnostics.
- Tests pass.

## Self-Review

- No incomplete sections remain.
- Scope is limited to Doctor-only delivery diagnostics.
- Server reconciliation, cost reporting, and raw governance are explicitly out of scope.
- The privacy boundary is explicit and testable.
