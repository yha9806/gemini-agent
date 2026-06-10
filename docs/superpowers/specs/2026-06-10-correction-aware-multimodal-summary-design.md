# Correction-Aware Multimodal Summary Design

## Purpose

Make `gemini-agent telemetry summary` more truthful for product decisions after artifact-review media corrections have been backfilled.

The current summary correctly keeps original multimodal events immutable, but it reports historical `media_kind` coverage as missing even when correction events already contain enriched media manifests. That makes recommendations less useful: the product may look like it still lacks media-kind instrumentation when the real issue is that the default summary view is not correction-aware.

This feature adds an aggregate-only adjusted multimodal view. It does not alter raw events, resend telemetry, reveal raw payloads, or expose identifiers.

## Current Evidence

Observed local global telemetry on 2026-06-10:

- `event_counts.total`: 901
- `status_counts.error_count`: 2
- pending, failed, and quarantine counts: 0
- all observed models: `gemini-3.5-flash`
- `multimodal.event_count`: 129
- `multimodal.item_count`: 144
- `multimodal.unknown_kind_items`: 144
- `corrections.event_count`: 18
- `corrections.media_item_count`: 18
- `corrections.media_items_with_mime`: 18
- `corrections.media_items_with_byte_size`: 16

The recently shipped inline artifact-review telemetry change improves future events by sending safe `{ source }` references to telemetry while keeping Gemini SDK requests unchanged. It does not repair historical summary coverage.

`gemini-agent plan-critique` reviewed this proposed direction and returned `verdict: caution`. The useful risks were:

- Avoid double-counting multiple correction versions for the same original event.
- Ignore orphan correction events when computing adjusted metrics.
- Keep event IDs, batch IDs, paths, filenames, prompts, and responses out of output.
- Define the recommendation threshold instead of saying "materially better" without a formula.

## Goals

1. Add a correction-aware aggregate section to telemetry summary output.
2. Preserve the current `multimodal` section as raw observed coverage.
3. Add an adjusted view that applies safe correction media manifests when they can be matched to original multimodal events.
4. Make recommendations distinguish capture gaps from historical correction gaps.
5. Keep all ordinary output aggregate-only and safe.

## Non-Goals

- No raw prompt/response reveal workflow.
- No local or server-side delete/export UI.
- No mutation of original events in the local queue.
- No receiver or Vulca backend schema change.
- No attempt to infer per-file labels from raw filenames in ordinary output.
- No global re-backfill command in this slice.

## Output Shape

`runTelemetrySummary()` should continue returning the existing `multimodal` object unchanged. Add:

```json
{
  "multimodal_adjusted": {
    "event_count": 0,
    "item_count": 0,
    "byte_count": 0,
    "unknown_mime_items": 0,
    "unknown_byte_size_items": 0,
    "unknown_kind_items": 0,
    "media_items_with_mime": 0,
    "media_items_with_byte_size": 0,
    "media_items_with_kind": 0,
    "correction_event_count": 0,
    "corrected_original_event_count": 0,
    "orphan_correction_event_count": 0,
    "superseded_correction_event_count": 0,
    "applied_correction_event_count": 0,
    "top_media_mime": [],
    "top_media_kind": [],
    "top_correction_versions": []
  }
}
```

Meaning:

- `multimodal`: raw observed media metadata from non-correction events.
- `corrections`: existing correction overlay diagnostics, still separate.
- `multimodal_adjusted`: product-analysis view where original events remain counted once, and the best matching correction manifest replaces the original media manifest for aggregate coverage only.

Text output should add a short "Adjusted multimodal" block after "Multimodal". It should show counts only.

## Reconciliation Rules

Correction events are identified by:

- `event.command === "artifact-review-backfill-correction"`
- `event.metadata.correction_for_event_id` is a non-empty string
- `event.metadata.correction_version` is a safe non-empty string after existing dimension sanitization

Original events eligible for adjustment are non-correction events with `event_id` equal to a correction's `correction_for_event_id`. Corrections referencing missing originals are orphan corrections. They must increment `orphan_correction_event_count`, but they must not change adjusted media totals.

If multiple correction events target the same original:

1. Prefer the highest correction version by semantic order when versions match `^media-v(\d+)$`. Parse the captured number as a base-10 integer; larger numbers win.
2. If semantic order is unavailable, prefer the lexicographically greatest sanitized version.
3. If versions tie, prefer the correction with the latest valid `created_at` timestamp. Malformed or missing timestamps sort lower than valid timestamps.
4. If both version and `created_at` tie, prefer the correction encountered last during deterministic queue traversal.

Queue traversal must be deterministic. The current `walkFiles()` implementation sorts directory entries lexicographically before yielding them; the adjusted-summary implementation should preserve that property and should not rely on filesystem-native ordering.

All non-applied correction events for an original increment `superseded_correction_event_count`.

Adjusted multimodal counts start from non-correction events. For every original with an applied correction:

- Remove the original event's raw multimodal contribution from adjusted aggregate totals.
- Add the applied correction's `payload.multimodal` contribution.
- Count the original event once toward `event_count` if either original or corrected media items exist.

This makes adjusted coverage answer: "What would the aggregate media metadata look like after accepted correction overlays?"

## Privacy And Safety

The output must never include:

- raw prompt or response text
- request or response payloads
- event IDs
- batch IDs
- absolute or relative file paths
- media filenames
- raw `basename` values from multimodal items
- raw correction target identifiers

Implementation should keep event IDs only in local in-memory maps used for reconciliation. It should not copy those IDs into returned summary objects, invalid samples, recommendations, text output, or JSON output.

Tests must serialize the full summary and assert that private marker strings do not appear.

## Recommendation Rules

Current recommendation:

> Most multimodal metadata is missing media kind; classify screenshots, designs, documents, and images before making quality claims.

Replace it with correction-aware logic:

- If raw media-kind coverage is below 50% and adjusted coverage is also below 50%, recommend improving capture.
- If raw media-kind coverage is below 50% but adjusted coverage is at least 50% and improves raw coverage by at least 25 percentage points, recommend applying or keeping correction-aware reporting/backfill.
- If raw media-kind coverage is at least 50%, do not emit the missing media-kind recommendation.

Coverage formula:

```text
media_kind_coverage = media_items_with_kind / item_count
```

When `item_count` is 0, coverage is 0 and no missing-kind recommendation is emitted.

## Error Handling

- Malformed correction metadata should be treated as an orphan correction for adjusted aggregation.
- Malformed multimodal items should follow existing summary behavior: count missing MIME, byte size, or kind as unknown.
- Queue read errors and invalid files should continue through the existing invalid-event path.
- The feature should not throw because of inconsistent correction data.

## Performance

The summary command already walks local queue files. The adjusted pass may keep compact in-memory maps:

- original media aggregate by event id
- best correction by original event id
- correction version counters

No raw prompts or responses should be retained in these maps. Original and correction maps should store only the event id needed for local reconciliation plus compact aggregate-ready media metadata. They should not store whole event objects.

The existing large-queue summary test should be extended or mirrored with correction events to ensure top-limit behavior and runtime remain bounded. The test does not need to create 100,000 events, but it should be large enough to catch accidental retention of whole event payloads and top-list expansion beyond `topLimit`.

## Testing Requirements

Focused tests should cover:

1. Baseline summary still reports raw `multimodal` unchanged.
2. A correction event for an existing original improves `multimodal_adjusted.media_items_with_kind`.
3. Duplicate correction versions for one original choose one applied correction and count superseded corrections.
4. Orphan correction events are counted but do not affect adjusted totals.
5. Non-`media-v<number>` correction versions fall back to lexicographic ordering.
6. Malformed or missing `created_at` timestamps do not beat valid timestamps.
7. Deterministic tie-breaking does not depend on filesystem-native directory order.
8. Correction events with missing, empty, or malformed `payload.multimodal` structures do not throw.
9. Full JSON and text output do not include event IDs, correction target IDs, batch IDs, paths, filenames, prompts, or responses.
10. Recommendations use adjusted coverage thresholds.
11. Large queues with many corrections stay bounded by `topLimit`.

## Rollout

This is local summary-only in v1. It can ship independently because it does not change event capture, queue format, receiver ingest, or existing output fields. Existing consumers that ignore unknown fields will continue to work.

After this lands, the next product decision should be based on a fresh summary:

```bash
./bin/gemini-agent telemetry summary --global --json
./bin/gemini-agent telemetry economics --global --json
```

If adjusted media-kind coverage reaches at least 50% and improves raw coverage by at least 25 percentage points, the next slice should be backfill/correction operationalization. If it remains weak, the next slice should be stronger future capture and design scorecards.
