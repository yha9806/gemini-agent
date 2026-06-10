# Telemetry Retry Failed Recovery Design

Date: 2026-06-10

## Scope

Add a controlled recovery command for historical telemetry batches that were archived under `queue/failed` after non-retryable delivery failures. The immediate production need is to recover old auth-failure batches after the current telemetry token and endpoint have been repaired.

This feature does not automatically resend failed telemetry, change receiver ingest behavior, reveal raw payloads, alter retention policy, or reclassify historical failure counters. It only moves explicitly selected failed event files back to `pending` so the existing bounded `telemetry flush` path can send them.

## Decision

Implement:

```bash
gemini-agent telemetry retry-failed [--global] --reason <reason> [--dry-run|--write] [--batch-size <n>]
```

Behavior:

- `--dry-run` is the default when neither mode flag is supplied.
- `--write` is required for any filesystem mutation.
- `--reason` is required and must match the sanitized failed-batch reason exactly.
- `--batch-size` limits the number of event files moved in one write. It defaults to `1` in write mode and can be higher for controlled recovery.
- The command uses the existing local/global telemetry scope resolution.
- Write mode requires enabled raw telemetry config, a valid endpoint URL, and the configured telemetry token environment variable to be present. It does not send events itself.
- Recovery is followed by the existing safe sequence: dry-run flush, then bounded flush.

The first intended operator sequence is:

```bash
gemini-agent telemetry doctor --global
gemini-agent telemetry retry-failed --global --reason http_403 --dry-run
gemini-agent telemetry retry-failed --global --reason http_403 --write --batch-size 5
gemini-agent telemetry flush --global --dry-run --batch-size 1
gemini-agent telemetry flush --global --batch-size 1 --timeout-ms 20000
```

## Architecture

Keep recovery inside the telemetry subsystem:

- `src/telemetry-queue.mjs` owns failed-batch scanning and event-file movement.
- `src/cli.mjs` owns argument parsing, telemetry scope resolution, write-mode preflight, and JSON output.
- Existing `telemetry doctor`, `telemetry summary`, and `telemetry flush` remain unchanged except for help text listing the new command.

The queue module should expose one focused helper:

```js
retryFailedTelemetryEvents({
  cwd,
  reason,
  batchSize,
  dryRun,
})
```

The helper returns aggregate counts only. It must not return event ids, batch ids, raw prompt text, raw response text, request payloads, media file names, or filesystem paths.

## Matching Rules

Failed batches are stored as:

```text
.gemini-agent/telemetry/queue/failed/<batch-id>/
  reason.json
  event_*.json
```

The command reads each failed batch's `reason.json` through the same sanitization used by `loadFailedTelemetryBatchSummaries`. A batch matches only when its sanitized reason equals the user-provided `--reason` after applying the same sanitizer to the user input.

Examples:

- `--reason http_403` matches historical `http_403`.
- `--reason unauthorized` matches historical `unauthorized`.
- `--reason ../http_403` sanitizes to a different literal value and matches nothing.

If `reason.json` is missing, unreadable, or malformed, the batch reason is `unknown`. Operators can recover those batches with `--reason unknown`, still in bounded batches.

## Data Flow

Dry-run:

1. Resolve telemetry scope and storage cwd.
2. Scan failed batch directories.
3. Match failed batches by sanitized reason.
4. Count candidate event files, bytes, and matched batch count.
5. Return a JSON preview with `dry_run: true`, `would_move_count`, `matched_batch_count`, `bytes`, and a safe `next_command`.

Write:

1. Resolve enabled raw telemetry context for the selected scope.
2. Verify token env is configured and currently present.
3. Acquire `withTelemetryQueueLock`.
4. Re-scan failed batches while holding the lock.
5. Move at most `batchSize` matching event files from `failed/<batch>/` to `pending/`.
6. Preserve `reason.json` when a failed batch still has remaining event files.
7. Remove an empty failed batch directory only after all event files have been moved.
8. Recompute `queue_bytes` from pending files and save queue state.
9. Return aggregate moved counts and the recommended bounded flush command.

## State Accounting

Recovery updates live queue state only:

- `queue_bytes` is recomputed from pending files after write.
- `last_failure_reason` is left unchanged by `retry-failed`.
- `sent_failure_count` remains a lifetime counter and is not decremented.
- `non_retryable_failure_count` remains a lifetime counter and is not decremented.

The live failed event count is derived from `queue/failed` scans by `doctor` and `summary`, so it will drop as recovered files leave the failed directory.

## Privacy Boundary

Allowed output:

- `scope`
- `storage_cwd`
- sanitized `reason`
- `dry_run`
- `matched_batch_count`
- `would_move_count`
- `moved_count`
- `remaining_failed_count_for_reason`
- byte counts
- `next_command`

Forbidden output:

- event ids
- batch ids
- raw prompts
- raw responses
- request payloads
- response candidates
- tool calls
- media filenames
- failed directory names
- event file paths

This command is a reliability tool, not a raw reveal/export tool.

## Error Handling

- Missing `--reason`: fail before reading queue state.
- Both `--dry-run` and `--write`: fail argument parsing.
- Invalid `--batch-size`: fail argument parsing.
- Write mode with disabled telemetry: fail before acquiring the queue lock.
- Write mode with missing token env: fail before moving files.
- No matching failed batches: return `ok: true`, zero counts, and no mutation.
- Lock contention: fail with the existing queue lock error; do not partially recover.
- Move failure after some files have moved: preserve the original error. The next dry-run should reflect actual filesystem state; the command must not invent counts.

## Concurrency

All write-mode scanning, movement, empty-directory cleanup, and `queue_bytes` updates happen under `withTelemetryQueueLock`. This prevents concurrent `flush`, `tick`, `append`, `quarantine`, or another `retry-failed` from racing against recovery.

Dry-run may scan without a lock for low overhead. Its output is advisory and can become stale. Write mode always re-scans under lock.

## Testing

Use TDD with focused tests in `test/telemetry-queue.test.mjs` and CLI coverage in `test/cli.test.mjs`.

Required tests:

- Dry-run reports matching failed batches without filesystem mutation.
- Write mode moves only matching reason events from failed to pending.
- Partial recovery preserves `reason.json` and leaves remaining failed events recoverable.
- Empty failed batch directories are removed only after all event files move out.
- Non-matching reasons are ignored.
- `unknown` can recover malformed or missing reason metadata.
- Output does not contain event ids, batch ids, raw prompt text, raw response text, media filenames, or file paths.
- Write mode requires enabled raw telemetry and a present token env.
- `--global` targets the global telemetry storage cwd; default scope targets the local cwd.
- Lock contention prevents write-mode recovery.

Run targeted tests first:

```bash
node --test test/telemetry-queue.test.mjs test/cli.test.mjs
```

Then run full verification:

```bash
npm test
```

## Acceptance Criteria

- `gemini-agent telemetry retry-failed --global --reason http_403 --dry-run` previews historical `http_403` recovery with aggregate counts only.
- `gemini-agent telemetry retry-failed --global --reason http_403 --write --batch-size 5` moves at most five matching failed events to pending.
- The command never sends telemetry directly; existing `telemetry flush` remains the only sender path.
- The command never prints raw content, event ids, batch ids, media filenames, or event file paths.
- Queue state remains consistent after partial recovery.
- `telemetry doctor` and `telemetry summary` reflect reduced failed counts and increased pending counts after write.
- All targeted tests and full `npm test` pass.

## Self-Review

- No fill-in markers or open design choices remain.
- The feature is limited to explicit failed-event recovery.
- Historical auth failures are not automatically retried.
- Raw governance is preserved by aggregate-only output.
- The write path is protected by the existing telemetry queue lock.
