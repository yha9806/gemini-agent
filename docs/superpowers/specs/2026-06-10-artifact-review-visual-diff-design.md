# Artifact Review Visual Diff Design

## Purpose

Extend `artifact-review` from single-image review to bounded multi-image comparison so Codex can delegate visual diff, UI regression review, and before/after design judgment to Gemini before spending tokens reading or describing screenshots itself.

This is the first Multimodal Quality slice after telemetry attribution and media metadata. It should improve the product's user-facing multimodal capability while preserving the current safety posture: Codex remains the execution authority, Gemini provides structured advice, and telemetry records aggregate media metadata without raw image bytes or file names.

## Current Evidence

Live local telemetry on 2026-06-10 shows:

- 885 total Gemini Agent events.
- `gemini-artifact-review` and artifact review backfill are established usage paths.
- 128 multimodal events and 142 media items have been captured.
- Historical media kind coverage is weak because `media_kind` was added after most events.
- `diff-review` remains the largest token-saving workflow, so visual diff should reuse familiar review ergonomics instead of adding a separate product surface.

Gemini plan critique recommended implementing multi-file `artifact-review` before schema-heavy design scorecards. The main risks are payload size, MIME validation, and accidental raw image exposure in telemetry.

## User Experience

Existing single-file usage continues to work:

```bash
gemini-agent artifact-review --file design.png --kind ui
```

New comparison usage:

```bash
gemini-agent artifact-review --file before.png --file after.png --kind ui --review-mode comparison
```

If the caller passes two or more files without `--review-mode`, the CLI chooses `comparison`. If one file is passed, it chooses `single`.

`--review-mode single` with multiple files is allowed only when the user wants a grouped artifact review rather than a before/after comparison. The prompt must still name all supplied sources.

## Scope

In scope:

- Accept repeated `--file` arguments in the CLI.
- Keep the existing `--file <path>` form backward compatible.
- Add `--review-mode single|comparison`.
- Support PNG, JPEG, and WEBP images using the existing inline image pipeline.
- Build Gemini contents as alternating image parts followed by one prompt part.
- Preserve the existing `artifact_review` JSON schema.
- Store all supplied relative source labels in `metadata.sources`.
- Keep telemetry command name as `artifact-review` and let existing media metadata collection capture each inline image item.
- Reject unsafe paths and unsupported file types before API key lookup.

Out of scope for this slice:

- PDF support through Files API.
- New top-level `visual-diff` command.
- Design scorecard schema fields.
- Image downscaling or compression.
- Pixel-level local image diff.
- Server/dashboard changes.
- Historical media kind correction backfill.

## Architecture

`src/cli.mjs` will parse multiple `--file` flags into `files: string[]`, while still returning `file` for compatibility where useful. It will prevalidate every file before resolving credentials.

`src/artifact-review.mjs` will accept either `file` or `files`. It will normalize to a bounded array, create one image part per file, and pass all image parts plus one prompt part to `generateArtifactReview`.

`src/prompts.mjs` will teach `buildArtifactReviewPrompt` about `reviewMode`. The `comparison` prompt will ask Gemini to focus on visual changes, regressions, hierarchy, accessibility, implementation-relevant differences, and uncertainty. It will still request the current `artifact_review` JSON shape.

No production code should inspect or print raw image bytes beyond the existing inline request path. Telemetry should see multimodal metadata through existing content-part capture, not through new raw fields.

## Limits And Errors

- Maximum files: 4.
- Zero files: `--file requires a path.`
- More than 4 files: `artifact-review supports at most 4 files.`
- Unknown `--review-mode`: `--review-mode must be single or comparison.`
- Unsupported image types keep using the existing unsupported artifact error before auth lookup.
- PDF still fails with the existing explicit Files API error at runtime.

## Testing

Focused tests should prove:

- `runArtifactReview` sends two image parts and one prompt for comparison.
- Metadata sources preserve both caller-provided relative labels.
- `parseArtifactArgs` accepts repeated `--file` and `--review-mode comparison`.
- CLI multi-file usage prints valid `artifact_review` JSON with fake Gemini response.
- Unsupported second files fail before auth lookup and do not mention API key setup.
- Too many files fail before auth lookup.
- Telemetry capture stores multiple multimodal metadata items without base64/raw image content.

Full verification should include:

```bash
node --test test/artifact-review.test.mjs test/cli.test.mjs --test-name-pattern "artifact-review"
node --test test/telemetry-capture.test.mjs --test-name-pattern "multimodal|media reference|fileData"
git diff --check
npm test
git diff main...HEAD | ./bin/gemini-agent diff-review --stdin
```

## Acceptance Criteria

- Existing single-file artifact review tests still pass.
- Multi-file comparison can be used from CLI with fake response in tests.
- Multiple image parts reach the Gemini generation layer in deterministic order.
- The final prompt includes comparison guidance only when `reviewMode` is `comparison`.
- No ordinary CLI, summary, doctor, or telemetry output exposes raw image bytes, base64 payloads, event IDs, or batch IDs.
