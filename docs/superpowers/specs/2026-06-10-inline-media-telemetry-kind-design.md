# Inline Media Telemetry Kind Design

## Purpose

Improve multimodal telemetry quality for `artifact-review` and visual diff without changing the Gemini API request payload. The immediate goal is to let future inline image reviews record safe media metadata such as MIME, byte size, synthetic basename, and `media_kind` so product analytics can segment screenshots, design artifacts, documents, and generic images before making design-quality claims.

## Evidence

After multi-file `artifact-review` visual diff shipped and was smoke-tested with real Gemini on 2026-06-10:

- Global telemetry had 893 events.
- Multimodal had 129 events and 144 media items.
- MIME coverage was 97 of 144 items.
- Byte-size coverage was 79 of 144 items.
- `media_kind` coverage was 0 of 144 items.

The real visual diff smoke added two PNG media items, but both still classified as `unknown` because telemetry only inspected Gemini request parts shaped like `{ inlineData }`. That shape carries MIME and base64 data, but not the original safe source label such as `before-screenshot.png` or `design.png`.

## Design

Add a telemetry-only content override that is isolated from the Gemini SDK request:

- `generateJson` and its wrappers continue sending `contents` to Gemini unchanged.
- `captureTelemetry` may receive `telemetry.contents` and use it only for telemetry capture.
- `runArtifactReview` builds safe telemetry references from the caller's source labels and passes them through the telemetry object.
- The telemetry references should be plain objects such as `{ source: "before-screenshot.png" }`, not inline base64 image parts.
- `collectMultimodalMetadata` already knows how to enrich safe media references with MIME, byte size, synthetic basename, and `media_kind`.

This creates a strict separation:

```text
Gemini request contents: inline image parts + prompt
Telemetry contents: safe local media references
```

## Scope

In scope:

- Add `telemetry.contents` override support in `src/gemini-client.mjs`.
- Pass safe artifact source references from `src/artifact-review.mjs`.
- Ensure artifact-review telemetry can classify `design`, `screenshot`, and `image` from source labels.
- Preserve raw/base64 safety: telemetry must not store inline image base64.
- Add tests proving request payloads are not polluted by telemetry-only fields.

Out of scope:

- Historical backfill correction for old media items.
- New design scorecard fields.
- Server/dashboard migrations.
- Changing the public `artifact_review` response schema.
- Adding raw source file names to analytics outputs.

## Safety

The biggest risk is accidentally leaking telemetry-only fields into the live Gemini request or into ordinary analytics. The implementation must prove:

- The SDK request still receives only valid Gemini content parts.
- Telemetry capture receives only safe source references or existing content parts.
- Summary/doctor style outputs remain aggregate-only and do not print media file names, paths, base64, event IDs, or batch IDs.
- Synthetic basenames continue to be used for local media references.

## Testing

Focused tests should cover:

- `generateJson` sends unchanged `contents` to the fake SDK while telemetry capture receives `telemetry.contents`.
- `generateJson` still falls back to request `contents` when no telemetry override is present.
- `runArtifactReview` passes telemetry-safe source references for single and multi-file reviews.
- The resulting captured telemetry contains `media_kind` for source labels like `checkout-screenshot.png` and `homepage-design.png`.
- No captured telemetry payload contains base64 strings or raw directory paths.

## Acceptance Criteria

- Future `artifact-review` events with local image file sources can populate `media_kind`.
- Gemini request payloads remain valid and unchanged.
- Existing artifact-review, visual diff, and telemetry tests pass.
- `npm test` passes.
- Gemini diff review finds no critical or important issues.
