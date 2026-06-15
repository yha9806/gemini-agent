# Visual Review Gate Orchestration

## Summary

Add a visual review gate layer that turns the existing `artifact-review`, `design loop`, screenshot evidence, and artifact-review readiness telemetry into a repeatable quality gate for UI and design-sensitive work.

The purpose is not to make every UI task call Gemini by default. The purpose is to make visual review risk-based, cheap when possible, strict when necessary, and safe to operate with raw telemetry enabled. Codex remains the execution authority for running apps, capturing screenshots, editing code, testing, committing, and deciding whether a release is complete.

## Goals

- Define when visual review should be required, recommended, or skipped.
- Compose local screenshot checks, optional browser evidence, `artifact-review` quick or comparison review, and existing readiness-plan telemetry into one gate result.
- Prefer comparison review for target-vs-actual, before-vs-after, and desktop-vs-mobile workflows.
- Keep visual review useful for real quality problems: blank screens, layout overflow, mobile breakage, unreadable charts, inaccessible contrast, missing labels, canvas or image rendering failures, and design implementation drift.
- Preserve raw-content governance: ordinary outputs and telemetry must not expose raw prompts, raw responses, event ids, local paths, media file names, or image bytes.
- Define routing interfaces early so later Codex active policy changes can call the gate without duplicating risk logic.

## Non-Goals

- Do not replace `artifact-review`; the gate orchestrates it.
- Do not make Gemini edit repository files.
- Do not require Playwright or browser automation for the MVP.
- Do not make the gate a mandatory CI dependency for all projects.
- Do not upload screenshots or raw prompts in dry-run, smoke-only, or local-only modes.
- Do not claim measured Codex savings from visual review. Token savings remain estimates unless billing-backed data is added.

## Current Context

The repository already has most building blocks:

- `artifact-review` supports PNG, JPEG, and WEBP review, up to four files, single or comparison mode, quick or standard depth, and structured design scorecards.
- Quick single review uses a 2048 output-token cohort, while quick comparison review uses a 4096 output-token cohort.
- `design loop` can compare target and actual screenshots through `artifact-review`.
- Telemetry summary, quality-gate, coverage-plan, readiness-plan, priorities, economics, raw inventory, and raw preflight already report aggregate artifact-review health without exposing raw content.
- Active Codex policy already mentions `artifact-review`, `design draft`, and post-implementation `design loop`.

The missing product layer is an explicit visual gate that says when to run which pieces and how to interpret the result.

## Gate Model

The visual gate returns one of three verdicts:

- `pass`: no blocking visual risk was found. Minor notes may still be present.
- `caution`: visual risk exists, but Codex can proceed with a clear follow-up or user choice.
- `block`: the implementation or release should not be presented as visually complete until the issue is fixed or explicitly waived.

The gate should also return a `review_posture`:

- `smoke_only`: local checks ran, Gemini did not.
- `quick_review`: Gemini quick review ran.
- `comparison_review`: Gemini quick comparison review ran.
- `standard_fallback`: standard artifact review ran after quick review was insufficient or malformed.
- `blocked_before_gemini`: local or governance checks prevented a Gemini call.

## Routing Policy

Routing should be risk-based.

Required visual gate:

- New or materially redesigned UI, page, dashboard, report, game, prototype, or design-system surface.
- Any implementation from a screenshot, mockup, Figma export, generated candidate, or design handoff.
- 3D, canvas, chart-heavy, image-heavy, or map-like surfaces where rendering failure is common.
- Release or handoff claims that mention visual polish, responsive behavior, accessibility, or design matching.

Recommended visual gate:

- CSS or layout changes with visible user impact.
- Copy changes that may affect wrapping, overflow, or hierarchy.
- Responsive breakpoint changes.
- Theming, typography, color, spacing, or icon updates.

Usually skip:

- Backend-only changes.
- Pure tests, docs, telemetry math, or CLI behavior with no visual output.
- Tiny UI copy changes when the existing test path already captures the affected screen and risk is low.

The first implementation should expose the routing decision as a pure function or module so both CLI commands and Codex active policy text can reference the same categories.

## User Workflow

### Single Screenshot Review

Use when Codex has one screenshot of the implemented UI:

```sh
gemini-agent visual gate --actual-screenshot after.png --kind ui --risk ui-change
```

The gate should first run local screenshot smoke checks, then run quick artifact-review when risk requires Gemini.

### Target-vs-Actual Review

Use when Codex has a target design or before screenshot:

```sh
gemini-agent visual gate --target-screenshot target.png --actual-screenshot after.png --kind ui --risk design-implementation
```

Comparison review is the preferred high-value path because it asks Gemini to find drift, regressions, hierarchy changes, accessibility issues, and implementation-specific differences.

### Local Smoke Only

Use when the project policy or user request does not permit external image review:

```sh
gemini-agent visual gate --actual-screenshot after.png --smoke-only
```

Smoke-only mode should never call Gemini. It can still check file existence, image metadata, dimensions, suspicious blankness, and basic evidence completeness.

## Local Smoke Checks

The MVP local smoke checks should avoid heavy dependencies:

- File exists and is readable.
- File MIME is supported.
- Image dimensions are sane and nonzero.
- File byte size is within configured bounds.
- If image dimensions can be decoded with existing image libraries, detect obviously tiny or all-transparent PNGs.
- When multiple screenshots are supplied, record width, height, MIME, byte size, and role: `target`, `actual`, `before`, `after`, or `viewport`.

Optional later browser evidence:

- Use Playwright or the Codex browser only when already available and when the user or project workflow gives a URL.
- Capture desktop and mobile screenshots.
- Detect document-level horizontal overflow.
- Check for empty body or empty root app container.
- Check known canvas elements for nonblank pixels.
- Record aggregate evidence only, not paths or screenshots in ordinary telemetry.

## Gemini Review Strategy

Default strategy:

- Use quick review first for single screenshots.
- Use quick comparison review for two screenshots.
- Use standard review only when quick review fails schema validation, misses required scorecard fields, hits token limits, or the gate is high-risk and quick output is inconclusive.

Prompt emphasis:

- For single screenshot review: focus on user-facing correctness and implementation risks, not generic aesthetic commentary.
- For comparison review: focus on target-vs-actual drift and regressions.
- For dashboards and reports: prioritize chart readability, labels, legends, density, empty states, and scanning behavior.
- For mobile: prioritize overflow, tap targets, text wrapping, sticky controls, and content order.
- For visual assets and hero sections: prioritize whether the user can inspect the real product, place, object, person, or state.

The structured scorecard remains:

- `overall_score`
- `visual_hierarchy_score`
- `clarity_score`
- `accessibility_score`
- `consistency_score`
- `implementation_readiness_score`

The gate result should add issue categories:

- `blank_or_missing_render`
- `layout_overflow`
- `responsive_breakage`
- `text_overflow_or_occlusion`
- `accessibility_contrast_or_readability`
- `chart_or_data_readability`
- `target_actual_drift`
- `missing_labels_or_context`
- `asset_rendering_failure`
- `interaction_state_gap`
- `uncertain_visual_evidence`

## Gate Decision Rules

Hard block examples:

- Blank or near-blank screenshot for a page that should render content.
- Canvas, image, chart, or 3D scene appears absent when it is the primary experience.
- Critical text or controls are visibly clipped or overlapped.
- Target-vs-actual comparison shows major missing content or layout mismatch.
- Quick review returns malformed JSON and standard fallback is unavailable or also invalid.
- Project policy blocks external review and no sufficient local evidence exists for a claimed visual completion.

Caution examples:

- Accessibility score below threshold but no critical workflow is blocked.
- Mobile layout has moderate spacing or hierarchy issues.
- Design scorecard is low confidence because screenshot evidence is partial.
- Telemetry readiness says artifact-review expansion is blocked, but this is a single manual review with user-visible value.

Pass examples:

- Local screenshot smoke checks pass.
- Artifact-review returns valid structured JSON.
- No hard block categories are present.
- Scorecard clears configured thresholds or issues are explicitly non-blocking.

Default thresholds:

- Block if `implementation_readiness_score < 50` for required visual gates.
- Caution if `implementation_readiness_score` is 50 to 69.
- Caution if `accessibility_score < 60`.
- Block if any hard block category is present, regardless of average score.

Thresholds should be configurable later, but the MVP can use constants.

## Output Shape

The gate should output JSON with this shape:

```json
{
  "kind": "visual_review_gate",
  "verdict": "pass | caution | block",
  "review_posture": "smoke_only | quick_review | comparison_review | standard_fallback | blocked_before_gemini",
  "risk_level": "low | medium | high",
  "risk_reasons": ["string"],
  "smoke": {
    "status": "pass | caution | block",
    "checks": [
      {
        "name": "string",
        "status": "pass | caution | block",
        "evidence": "safe aggregate string"
      }
    ]
  },
  "artifact_review": {
    "used": "boolean",
    "mode": "single | comparison",
    "depth": "quick | standard",
    "fallback_used": "boolean",
    "scorecard": {
      "overall_score": "integer 0-100 or null",
      "visual_hierarchy_score": "integer 0-100 or null",
      "clarity_score": "integer 0-100 or null",
      "accessibility_score": "integer 0-100 or null",
      "consistency_score": "integer 0-100 or null",
      "implementation_readiness_score": "integer 0-100 or null"
    }
  },
  "issues": [
    {
      "category": "layout_overflow",
      "severity": "low | medium | high",
      "summary": "string",
      "recommended_action": "string"
    }
  ],
  "next_actions": ["string"],
  "limitations": ["string"],
  "metadata": {
    "generated_at": "ISO-8601 string",
    "artifact_review_readiness_status": "ready | collect_more_samples | blocked | unknown",
    "media_summary": [
      {
        "role": "actual",
        "mime_type": "image/png",
        "byte_size": "integer or null",
        "width": "integer or null",
        "height": "integer or null",
        "media_kind": "screenshot"
      }
    ]
  }
}
```

No raw prompt, raw response, event id, local path, media file name, or image bytes should appear in this output.

## Telemetry

Telemetry should record safe aggregate metadata:

- command: `visual-gate`
- source: `cli`, `mcp`, or `active-policy`
- risk level and risk reason codes
- review posture
- smoke check counts by status
- artifact-review mode and depth
- fallback used or not
- scorecard numeric fields
- issue category counts
- latency stage summaries
- media manifest with synthetic basename only, MIME, byte size, dimensions, and media kind

Telemetry must not record:

- raw prompt text in aggregate outputs
- raw response text in aggregate outputs
- event ids in ordinary summaries
- local paths
- original media file names
- screenshot bytes in ordinary summaries

Raw telemetry may still capture governed payloads when explicitly enabled by existing telemetry settings. The visual gate must rely on existing raw preflight, inventory, reveal, export, delete, prune, and flush safeguards rather than creating a second raw governance path.

## Integration Points

### `artifact-review`

The gate should call `runArtifactReview` instead of duplicating Gemini calls.

Needed additions:

- accept caller-supplied safe metadata for visual gate context;
- preserve current quick and comparison budget behavior;
- expose enough schema failure information for gate fallback decisions without printing raw response text.

### `design loop`

`design loop` should be able to delegate decisioning to the visual gate after target-vs-actual review. The existing loop review can continue to store the full artifact-review object under the design run, but CLI output should summarize the gate verdict clearly.

### Telemetry Reports

Existing `artifact-review readiness-plan` remains the aggregate readiness signal. The visual gate can include that readiness status in metadata, but it should not block a user-requested manual review solely because broad routing readiness is blocked.

### Active Codex Policy

After the gate exists, active policy should route UI tasks through it:

- before source edits: use `design draft` for large design work;
- after source edits: capture screenshots and run visual gate;
- before commit or release: required visual gate for high-risk visual changes;
- fallback: if screenshot capture is impossible, report the missing evidence instead of claiming visual completion.

## Error Handling

- Missing screenshot: block with `blocked_before_gemini` and a next action to capture the required screenshot.
- Unsupported file type: block before auth lookup.
- Oversized image: caution or block before Gemini, with a next action to resize or crop.
- Gemini schema failure: retry through existing artifact-review structured response retry path when available; otherwise standard fallback.
- Gemini timeout or provider error: caution for optional gates, block for required release gates unless the user explicitly waives.
- Raw governance risk: block broad flushes, but do not block local visual review output. Report that telemetry delivery needs governed handling.
- Browser automation unavailable: return a manual screenshot fallback, not a crash.

## Testing

Unit tests:

- routing policy categorizes required, recommended, and skipped scenarios.
- smoke checks classify readable images, missing files, unsupported files, tiny images, and oversized images.
- gate decision rules produce pass, caution, and block from fixture scorecards and issue categories.
- output sanitization rejects local paths, media file names, event ids, raw prompt text, and raw response text.
- artifact-review fallback decisions handle valid quick output, malformed quick output, token-limit retry, and standard fallback.

CLI tests:

- `visual gate --actual-screenshot` outputs safe JSON.
- `visual gate --target-screenshot --actual-screenshot` uses comparison mode.
- `visual gate --smoke-only` does not require auth.
- missing screenshot fails before auth lookup.
- unsupported files fail before auth lookup.
- `--json` output never includes input file names or absolute paths.

Telemetry tests:

- visual gate telemetry records safe metadata only.
- raw inventory and preflight continue to count pending raw risks without exposing raw content.
- telemetry priorities can include visual-gate issue categories only as aggregate counts.

Integration tests:

- fake artifact-review single review produces a gate result.
- fake artifact-review comparison review produces target-vs-actual drift categories.
- design loop can write a loop review with a gate verdict.

## Rollout Plan

1. Add the visual gate schema, routing policy, local smoke checks, and decision rules without changing active policy.
2. Add CLI access behind explicit `gemini-agent visual gate`.
3. Reuse `runArtifactReview` for quick and comparison review.
4. Add telemetry capture for safe visual gate metadata.
5. Wire `design loop` to include a gate verdict.
6. Update active Codex policy to recommend the gate for high-risk visual work.
7. Evaluate aggregate telemetry before making broad automatic routing stricter.

## MVP Decisions And Deferred Work

- The MVP should add a top-level `visual gate` command so active policy can route to a stable product concept instead of overloading `artifact-review`.
- The MVP should not automatically block commits. It reports a `block` verdict; Codex and the user decide whether to fix, waive, or stop.
- The MVP should decode dimensions when existing dependencies support the file type. PNG dimension and blankness checks are first-class; JPEG and WEBP dimension checks can return `null` until a small dependency or parser is selected.
- Active policy should expect one screenshot by default. It should ask for desktop plus mobile screenshots when the task claims responsive behavior, changes breakpoints, or affects a mobile-visible surface.
- CI enforcement is deferred until local CLI behavior and telemetry show stable gate outcomes.

## Acceptance Criteria

- A developer can run one command against screenshots and receive `pass`, `caution`, or `block`.
- The command can run smoke-only without Gemini credentials.
- Target-vs-actual workflows use comparison review by default.
- High-risk visual problems map to explicit issue categories and next actions.
- Ordinary outputs and telemetry do not expose raw prompts, raw responses, event ids, local paths, media file names, or image bytes.
- Active policy can reference the routing categories without duplicating implementation details.
- Existing `artifact-review` and readiness telemetry remain the underlying review and aggregate readiness layers.
