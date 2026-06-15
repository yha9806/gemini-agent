# Vision Banana Compatible Visual Quality Loop

## Summary

Upgrade the current Vision Banana path from a thin reserved provider into a practical visual quality loop that works today without a dedicated `VISION_BANANA_ENDPOINT`, while preserving a clean route for a future endpoint.

The immediate problem is twofold:

- `design doctor` correctly reports `VISION_BANANA_ENDPOINT` as missing and falls back to `nano-banana-palette-mask`, but users can still reasonably expect `design perceive --provider vision-banana` to explain exactly what happened and how to recover.
- The current visual workflow can produce useful artifacts, but the default generated UI and prototype direction can feel visually average because candidate generation, perception, review, and handoff are not yet connected into a quality loop.

This design keeps the current safety boundary: Gemini and Nano Banana write only design artifacts under `.gemini-agent/design/<run-id>/`; Codex remains responsible for production edits, verification, and commits.

## Goals

- Make `vision-banana` provider behavior transparent when the dedicated endpoint is missing.
- Improve fallback perception quality by combining target masks with structured visual review.
- Add a lightweight candidate quality gate so generated UI images and prototypes get concrete visual feedback before handoff.
- Improve `design doctor` output so operators can distinguish dedicated Vision Banana, Nano Banana fallback, Gemini vision review, and quality-gate readiness.
- Preserve honest claims: never report that a dedicated Vision Banana endpoint ran unless `VISION_BANANA_ENDPOINT` was configured and the endpoint call succeeded.
- Keep the first implementation slice small enough to test with existing unit tests and fixtures.

## Non-Goals

- Do not implement or host a real Vision Banana service.
- Do not depend on a public Vision Banana model id.
- Do not make fallback output claim parity with a dedicated segmentation or scene-understanding model.
- Do not replace `artifact-review`, `palette-split`, `design perceive`, `design generate`, `design prototype`, `design handoff`, or `design loop`.
- Do not let Gemini write into production source directories.
- Do not require visual quality gates for `--skip-generate` text-only flows.

## Current Behavior

`design perceive` supports four provider names:

- `auto`
- `palette-mask`
- `gemini-vision`
- `vision-banana`

When `provider=vision-banana` and `VISION_BANANA_ENDPOINT` is configured, the command posts `image_path`, `run_id`, and bounded `targets` to the endpoint and normalizes the returned perception.

When `provider=vision-banana` and `VISION_BANANA_ENDPOINT` is missing:

- with explicit targets, the implementation falls back to `palette-mask`;
- without explicit targets, it fails because there is no endpoint and no target-driven fallback route.

That behavior is technically correct, but it is not yet productized. The user can see `design doctor` report the fallback state, then run a command that fails without enough guidance about targets, shell quoting, or the exact provider that actually ran.

## Proposed Approaches

### Recommended: Hybrid Fallback Plus Quality Gate

Keep `vision-banana` as a provider interface, but make the missing-endpoint path useful:

- explicit targets use `palette-mask` for region extraction;
- a structured visual review pass adds layout, hierarchy, visual quality, and implementation constraints;
- `perception.json` records both requested and resolved providers;
- generated candidates get a visual quality score and actionable notes before prototype/handoff.

This provides immediate improvement without waiting for endpoint infrastructure.

### Endpoint-First Upgrade

Build only the dedicated endpoint integration and require operators to configure `VISION_BANANA_ENDPOINT`.

This is clean architecturally, but it does not address the current user's complaint because the environment still falls back today. It also creates a hard dependency on infrastructure outside this CLI.

### Prompt-Only Visual Polish

Improve only `design generate` prompts and image-model routing.

This is cheap and likely improves aesthetics, but it does not fix confusing `vision-banana` behavior, perception quality, or the absence of objective review before handoff.

## Recommended Design

### 1. Provider Diagnostics

`design perceive --provider vision-banana` should parse all arguments first, then validate the provider. This reduces confusing order-sensitive failures and allows one error formatter to include actionable context.

Missing endpoint behavior:

- If `VISION_BANANA_ENDPOINT` is present, call the endpoint.
- If it is missing and at least one `--target "name: description"` is present, use the hybrid fallback route.
- If it is missing and no targets are present, fail with a concise recovery message:

```text
Vision Banana provider is not configured.
Set VISION_BANANA_ENDPOINT, choose --provider gemini-vision, or add at least one quoted target for the Nano Banana palette-mask fallback:
  --target "header: top navigation and primary controls"
```

The command summary should include:

- requested provider;
- resolved provider;
- whether fallback was used;
- fallback reason;
- perception artifact path.

The parser should keep enforcing `name: description` target format and safe target names, but error messages should mention shell quoting because unquoted targets with spaces become unknown extra arguments.

### 2. Hybrid Fallback Perception

Add a `vision-banana-compatible` fallback mode behind the existing `vision-banana` provider when the endpoint is missing and targets are present.

Data flow:

1. Run the existing `palette-mask` path to produce target masks, extracted layers, bounding boxes, contact sheet, and palette quality metadata.
2. Run a structured visual review pass against the source image and, when available, the contact sheet or selected candidate.
3. Merge the results into one normalized `design_perception` artifact.

The merged perception should include:

- target regions from `palette-mask`;
- mask references and bounding boxes where available;
- hierarchy inferred from target order and review notes;
- layout observations from visual review;
- implementation constraints such as spacing, typography, density, alignment, and responsive risk;
- warnings from both mask decoding and visual review;
- metadata showing `requested_provider: vision-banana`, `resolved_provider: palette-mask`, and `perception_enrichment: visual-review`.

The fallback should not introduce a new public provider name unless needed. Internally, it can be represented as a route or metadata field so users still understand they requested `vision-banana` and got a compatible fallback.

### 3. Candidate Visual Quality Gate

After `design generate` writes candidate images, run a lightweight quality review for each successful candidate unless disabled.

The gate should evaluate:

- visual hierarchy;
- spacing and density;
- typography clarity;
- contrast and accessibility risk;
- visual distinctiveness;
- alignment with brief visual direction;
- likely implementation complexity;
- mobile/responsive risk when the brief mentions responsiveness.

Output:

- `candidates/quality.json`
- per-candidate score, status, strengths, issues, and recommended next action;
- updated candidate manifest warnings or quality summary.

Status values:

- `pass`: good enough for prototype/handoff;
- `warn`: usable, but handoff should include improvement notes;
- `fail`: candidate should not be auto-selected unless the user explicitly chooses it.

The MVP should not automatically regenerate failed images. Regeneration can be a later command once scoring is stable.

### 4. Draft And Handoff Integration

`design draft` should use the quality gate after generation and before prototype selection.

Selection rule:

- choose the highest-scoring `pass` candidate;
- if no candidate passes, choose the highest-scoring `warn` candidate and record the warning;
- if all candidates fail, preserve the run and ask the user to review candidates or rerun generation with different instructions.

`design handoff` should include:

- selected candidate quality status;
- top visual issues to address during Codex implementation;
- any perception fallback metadata;
- explicit statement when dedicated Vision Banana was not used.

### 5. Doctor Output

`design doctor --json` should expose separate readiness fields:

```json
{
  "required_env": {
    "vision_banana_endpoint": "missing",
    "vision_banana_provider": "nano-banana-palette-mask",
    "vision_banana_compatible_fallback": "available",
    "visual_quality_gate": "available"
  }
}
```

Human-readable doctor output should avoid implying that endpoint-backed Vision Banana is available when only fallback routes are configured.

### 6. Telemetry

Telemetry should capture route and quality metadata without exposing raw prompts, responses, media filenames, or local absolute paths in ordinary summaries.

Recommended metadata:

- `requested_provider`
- `resolved_provider`
- `provider_fallback_used`
- `provider_fallback_reason`
- `perception_enrichment`
- `candidate_quality_status`
- `candidate_quality_score`
- `selected_candidate_id`
- `vision_banana_endpoint_present`

The telemetry summary may aggregate quality gate adoption later, but the first slice only needs event metadata.

## Error Handling

- Missing endpoint with no targets fails clearly and suggests `--provider gemini-vision` or a quoted `--target`.
- Missing endpoint with targets falls back and records the fallback in perception and telemetry.
- Palette-mask failure preserves the run directory and reports the mask error.
- Visual review failure should not erase generated candidates. It should mark quality as unavailable and let the user continue manually.
- Invalid review JSON should be captured as a structured warning and should not corrupt the candidate manifest.
- Endpoint HTTP and timeout errors keep the existing clear Vision Banana error behavior.

## Testing Strategy

Add focused tests for:

- CLI parsing of quoted and unquoted target failure messages.
- `vision-banana` missing endpoint with no targets returns the new actionable error.
- `vision-banana` missing endpoint with targets records fallback metadata and visual enrichment metadata.
- Hybrid fallback merges palette regions and visual review observations into normalized `perception.json`.
- `design doctor --json` reports endpoint, compatible fallback, and quality-gate readiness separately.
- Candidate quality gate writes `candidates/quality.json` and updates selection behavior.
- `design draft` chooses the best passing or warning candidate and preserves runs when all candidates fail.

## Rollout

Implement in two coherent slices:

1. Provider diagnostics and hybrid fallback perception.
2. Candidate quality gate and draft/handoff integration.

Each slice should include tests and a small commit. Do not change production source files outside the design artifact directory during design runs.
