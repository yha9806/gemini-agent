# Design Perception Loop

## Summary

Add a Stitch-inspired design workflow to `gemini-agent` that connects Gemini design reasoning, Nano Banana visual generation, Vision-Banana-inspired perception, and Codex implementation.

The first version should build on the existing `palette-split` implementation. `palette-split` already uses `gemini-3.1-flash-image` to create a pure RGB palette mask, then decodes the generated image into machine-readable layers. That is the seed implementation for the broader perception layer: use image-generation-style outputs as structured visual intermediates that Codex and Gemini can reuse instead of repeatedly producing long natural-language screenshot descriptions.

## Goals

- Turn product/design prompts, screenshots, wireframes, and existing UI images into a structured design workflow.
- Generate or edit visual candidates with Nano Banana models through the existing Gemini API auth path.
- Produce machine-readable perception artifacts such as UI region maps, layer masks, visual hierarchy notes, spacing/layout observations, and implementation-relevant component boundaries.
- Produce an isolated, reviewable frontend prototype code draft with the design reasoning model so users can inspect the direction before Codex integrates it.
- Produce Codex-ready handoff artifacts that specify files, components, design tokens, responsive constraints, and verification steps.
- Close the loop by letting Codex implement changes, capture screenshots, and call `artifact-review` for visual diff and design scorecard feedback.
- Keep default low-cost text/review behavior on `gemini-3.5-flash`; use stronger or image models only inside explicit design commands.

## Non-Goals

- Do not make Gemini directly edit the repository.
- Do not treat Gemini-generated prototype code as production-ready source.
- Do not depend on a public Vision Banana model id in the MVP.
- Do not claim full Vision Banana parity for depth estimation, surface normals, or benchmark-quality segmentation.
- Do not replace `artifact-review`; reuse it for comparison, review, and quality gates.
- Do not automatically run unlimited design/code loops.
- Do not expose raw image bytes, local paths, prompts, or responses in ordinary telemetry summaries.

## Current Context

`gemini-agent` already has the necessary building blocks:

- `artifact-review` accepts up to four PNG/JPEG/WEBP images, supports single and comparison review, and returns structured design scorecards.
- `palette-split` uses `gemini-3.1-flash-image` by default, writes palette masks, decoded layers, a manifest, a contact sheet, and quality metadata.
- Telemetry already records multimodal media metadata, latency stages, design scorecard aggregates, and palette-split quality without exposing raw media bytes in summaries.
- Auth already supports local keychain-backed Gemini API access.

The missing product layer is the design workflow that composes these capabilities into a repeatable design-to-code loop.

## Model Roles

### Default Runtime Model

Normal text review, context pack, plan critique, patch precheck, diff review, and research brief calls continue to use the current default model policy, currently `gemini-3.5-flash`.

### Design Reasoning Model

`GEMINI_DESIGN_MODEL` should route design reasoning, isolated prototype code generation, and structured handoff generation. The intended default is `gemini-3.1-pro-preview` when available because it is suited to multimodal reasoning, structured output, software-engineering plans, and agentic workflows. It is not an image generation model.

The implementation must treat this as a configured route, not a hardcoded universal guarantee. A design doctor check should report whether the configured model is present, whether a probe call succeeds, and which fallback is active.

If a configured design model returns a model availability error such as 403 or 404, the command should fail closed for mutating workflows and print the fallback recommendation. It should not silently switch to a weaker model for prototype or handoff generation unless the user requested `--allow-fallback`. A fallback design model must satisfy the same capability contract as the primary route: multimodal input when screenshots are present and schema-valid structured JSON output for brief, perception, prototype manifest, and handoff commands.

### Image Generation Models

`GEMINI_IMAGE_MODEL` should route efficient visual generation and editing. The intended default remains `gemini-3.1-flash-image`.

`GEMINI_IMAGE_PRO_MODEL` should route premium visual generation when the user requests high-fidelity mockups, accurate in-image text, diagrams, product shots, or brand-sensitive output. The intended default is `gemini-3-pro-image`.

Image model ids are resolved at runtime from environment/configuration. The defaults reflect the current project and documented Gemini image routes, but the CLI must expose the resolved model in dry-run and doctor output so operators can update model ids without code changes.

If a configured image model returns 403 or 404, `design generate` should preserve the run manifest, mark the candidate as failed, and recommend `gemini-agent design doctor`. It should not retry on a different image model unless the user requested `--allow-fallback`.

### Vision Banana Provider

Vision Banana is treated as a provider interface, not a guaranteed public model dependency. The current project has Gemini/Nano Banana API access, but no dedicated `VISION_BANANA_ENDPOINT`, `VISION_BANANA_API_KEY`, or public Vision Banana model id.

The MVP should support:

- `provider=palette-mask`: use the existing Nano Banana palette-mask approach for explicit target masks.
- `provider=gemini-vision`: use design reasoning and artifact review to approximate region/layout perception.
- `provider=vision-banana`: reserved for a future dedicated endpoint or model id, configured by `VISION_BANANA_ENDPOINT` or a future model router setting.

## User Workflow

### 1. Create A Design Brief

Command:

```sh
gemini-agent design brief --stdin --write-artifact
```

Inputs:

- natural language product goal;
- optional screenshot, wireframe, design image, or URL-derived screenshot;
- optional repo context pack;
- optional existing `DESIGN.md`.

Output:

- `.gemini-agent/design/<run-id>/brief.json`;
- `.gemini-agent/design/<run-id>/DESIGN.md`;
- concise terminal summary.

The brief defines the target user, UX intent, visual direction, layout constraints, accessibility expectations, responsive behavior, implementation risk, and acceptance criteria.

### 2. Generate Or Edit Visual Candidates

Command:

```sh
gemini-agent design generate --brief .gemini-agent/design/<run-id>/brief.json --variants 3
```

Inputs:

- design brief;
- optional reference screenshots or brand assets;
- optional `--quality fast|pro`;
- optional `--aspect-ratio`;
- optional `--image-size`.

Output:

- generated candidate images under `.gemini-agent/design/<run-id>/candidates/`;
- candidate manifest with model, prompt hash, image size, aspect ratio, and generation status.

Routing:

- `--quality fast` uses `GEMINI_IMAGE_MODEL`.
- `--quality pro` uses `GEMINI_IMAGE_PRO_MODEL`.

### 3. Produce Perception Artifacts

Command:

```sh
gemini-agent design perceive --file screenshot.png --brief .gemini-agent/design/<run-id>/brief.json --provider auto
```

Inputs:

- screenshot, wireframe, or generated candidate;
- optional explicit target list;
- optional design brief.

Output:

- `perception.json`;
- optional `regions.json`;
- optional `layout-map.json`;
- optional palette mask and decoded layer PNGs when the selected provider emits RGB masks;
- quality metadata.

Provider behavior:

- `auto` first chooses `palette-mask` when explicit targets are present.
- `auto` chooses `gemini-vision` for general UI region/layout summaries.
- `vision-banana` is available only when configured and should fail clearly when missing.

The perception schema should represent:

- major UI regions;
- likely component boundaries;
- hierarchy and attention order;
- spacing/layout observations;
- visual inconsistencies;
- implementation-relevant constraints;
- optional mask/layer asset paths relative to the run directory.

### 4. Create A Reviewable Frontend Prototype

Command:

```sh
gemini-agent design prototype --run .gemini-agent/design/<run-id> --candidate candidate-a --target-stack html
```

Inputs:

- design brief;
- selected candidate image or screenshot;
- perception artifacts;
- optional target stack hint: `html`, `react`, `tailwind`, or `auto`.

Output:

- `prototype/manifest.json`;
- `prototype/preview.html` for MVP static previews;
- optional `prototype/component.*` snippet for framework-specific drafts;
- `prototype/review-notes.md`.

The prototype is a user-review artifact. It lets the user inspect layout, spacing, copy, color direction, and interaction affordances before Codex edits the real project. In the MVP, the safest default is static HTML/CSS/JS because it can be opened directly and does not require dependency installation. Framework-specific snippets are allowed only as non-authoritative drafts.

Prototype code rules:

- Generated prototype files are written only under `.gemini-agent/design/<run-id>/prototype/`.
- The command never writes to `src/`, app directories, package manifests, or production assets.
- The prototype may include inline CSS and minimal inline JS for reviewable interactions.
- External network assets are disallowed unless the user explicitly provides or approves them.
- The prototype manifest records model, stack, source candidate, generated files, limitations, and whether Codex integration is recommended.

Codex uses the prototype as an additional implementation reference, not as a patch to paste blindly. During later implementation, Codex should compare the prototype against the real codebase, preserve local design-system conventions, and decide which parts to integrate, rewrite, or discard.

### 5. Create Codex Handoff

Command:

```sh
gemini-agent design handoff --run .gemini-agent/design/<run-id> --candidate candidate-a
```

Output:

- `handoff.json`;
- `codex-tasks.md`;
- concise terminal summary.

The handoff is the contract between Gemini and Codex. It should incorporate the brief, perception artifacts, selected candidate, and optional prototype code summary. It should be specific enough to reduce repeated media inspection during implementation, while still allowing Codex to re-open screenshots, design assets, or prototype files when the task is visually ambiguous:

- target files or likely file search hints;
- components to add or edit;
- design tokens and CSS variables;
- layout constraints;
- responsive breakpoints;
- interaction states;
- assets to use or generate;
- verification commands;
- screenshot targets;
- acceptance criteria.

Gemini may propose code snippets inside the prototype or handoff, but Codex remains responsible for editing files, running checks, adapting to the repository architecture, and deciding whether the code fits the project.

### 6. Run The Codex Implementation Loop

Command:

```sh
gemini-agent design loop --run .gemini-agent/design/<run-id> --actual-screenshot after.png --max-iterations 2
```

MVP behavior:

- read `handoff.json` and `codex-tasks.md`;
- print the Codex execution checklist;
- accept manual target and actual screenshot paths;
- call `artifact-review` in comparison mode for target vs actual screenshots;
- write `loop-review.json`.

The command should not directly modify source files in the MVP. Codex executes the handoff in the normal editing workflow. A later version may add tighter Codex desktop integration, but this spec keeps execution authority with Codex.

Manual screenshot behavior:

- If `--actual-screenshot` is missing, print the next Codex task checklist and exit with a resumable status instead of waiting indefinitely.
- If `--target-screenshot` is missing, use the selected candidate image when available.
- If both screenshots are present, run a bounded `artifact-review` comparison.
- `loop-review.json` records whether the loop used manual screenshots, candidate fallback, or optional browser capture.

Optional browser capture:

- `--url` enables browser screenshot capture only when the runtime already provides a browser automation capability.
- Browser automation is an optional integration, not a required package dependency for the MVP.
- Optional browser automation must be detected behind an isolated dynamic import or runtime capability check.
- Missing, partially installed, launch-failing, or native-binary-failing browser automation is wrapped in `try`/`catch` and returns a manual screenshot fallback warning instead of crashing the command.
- Capture failure falls back to the manual screenshot path and writes a clear warning.

Cost controls:

- `--dry-run` prints the planned model calls and expected artifacts without calling Gemini.
- `--max-cost-usd <n>` stops before a model call when estimated cost would exceed the budget.
- Cost estimates use a bundled conservative pricing table plus optional operator override config.
- If the bundled table and override config cannot produce an estimate for a configured model, budget-gated commands fail closed unless the user passes `--allow-unknown-cost`.
- `--max-iterations` is bounded to 1-3 and defaults to 2.
- `--quality pro` is never selected automatically inside `design loop`; the user must request it in `design generate`.

## Architecture

### New Modules

- `src/design-brief.mjs`: design brief input normalization, prompt construction, schema validation, artifact writing.
- `src/design-generate.mjs`: Nano Banana request construction, image response extraction, candidate manifest writing.
- `src/design-perceive.mjs`: provider selection, palette-mask adapter, gemini-vision adapter, future vision-banana adapter.
- `src/design-prototype.mjs`: isolated frontend prototype generation, prototype manifest validation, static preview artifact writing.
- `src/design-handoff.mjs`: structured handoff schema, Codex task markdown generation.
- `src/design-loop.mjs`: bounded loop orchestration, screenshot artifact references, artifact-review calls.
- `src/design-model-router.mjs`: explicit model routing for design and image workflows.

### Reused Modules

- `src/palette-mask.mjs` remains the seed provider for RGB mask generation and layer decoding.
- `src/artifact-review.mjs` remains the review and visual diff engine.
- `src/artifact-store.mjs` writes design run artifacts.
- `src/telemetry-capture.mjs` records safe design command metadata.
- `src/input-collector.mjs` handles local image inputs.

### Artifact Layout

```text
.gemini-agent/design/<run-id>/
  brief.json
  DESIGN.md
  candidates/
    candidate-a.png
    candidate-b.png
    manifest.json
  perceive/
    perception.json
    regions.json
    layout-map.json
    palette_mask.png
    layers/
  prototype/
    manifest.json
    preview.html
    component.*
    review-notes.md
  handoff.json
  codex-tasks.md
  loop-review.json
```

Run id rules:

- Run ids are generated by the tool using an ISO-like timestamp plus a short random suffix.
- User-supplied run paths are resolved and validated to remain under `.gemini-agent/design/`.
- Run ids must match `^[0-9TzZ._-]+-[A-Za-z0-9]{6,}$` after normalization.
- Path traversal segments such as `..`, absolute paths inside run ids, path separators inside run ids, null bytes, and control characters are rejected.
- Resolved run paths must pass a `path.resolve` plus `path.relative` containment check proving they are direct descendants of `.gemini-agent/design/`.
- Concurrent runs write to unique directories created with atomic exclusive directory creation and never reuse an existing run directory unless the command is explicitly resuming that run.

## Data Contracts

### `brief.json`

Required fields:

- `goal`;
- `target_user`;
- `screens`;
- `visual_direction`;
- `design_system`;
- `accessibility`;
- `responsive_requirements`;
- `acceptance_criteria`;
- `implementation_risks`.

### `perception.json`

Required fields:

- `provider`;
- `source`;
- `regions`;
- `hierarchy`;
- `layout_observations`;
- `implementation_constraints`;
- `confidence`;
- `warnings`.

`regions` entries include stable ids, labels, bounding-box estimates when available, role, importance, and optional layer/mask references.

### `regions.json`

Required fields:

- `source`;
- `coordinate_space`;
- `regions`;
- `warnings`.

Each region includes:

- `id`;
- `label`;
- `role`;
- `importance`;
- `bbox` as nullable normalized coordinates `{ "x": number, "y": number, "width": number, "height": number }`;
- `mask_ref` as a relative path or null;
- `confidence`.

Coordinate standard:

- All bounding boxes use normalized image coordinates from `0.0` to `1.0`.
- `x` and `y` are the top-left corner.
- `width` and `height` are extents in the same normalized coordinate space.
- Providers that return pixel coordinates must also provide the source image dimensions and normalize before writing `regions.json`.
- Unknown coordinates must be `null`, not guessed.

Dimension extraction:

- PNG and JPEG dimensions should be read with the existing image decoding stack already used by `palette-split`.
- WEBP dimensions should use a small, well-tested dependency or the existing image decoding stack if it gains WEBP support.
- The MVP should not hand-roll RIFF/VP8/VP8L/VP8X parsing unless fixtures cover lossy, lossless, extended, animated, and corrupted WEBP headers.
- Dimension extraction failures are warnings unless the selected provider requires pixel-to-normalized conversion.
- Zero or negative dimensions are invalid and force null coordinates plus a warning.

### `layout-map.json`

Required fields:

- `source`;
- `viewport`;
- `grid`;
- `spacing`;
- `alignment`;
- `responsive_risks`;
- `warnings`.

`layout-map.json` is descriptive in the MVP. It should not claim pixel-perfect measurement unless the provider returns explicit coordinates.

### `handoff.json`

Required fields:

- `run_id`;
- `selected_candidate`;
- `implementation_summary`;
- `file_hints`;
- `component_tasks`;
- `style_tokens`;
- `responsive_tasks`;
- `asset_tasks`;
- `verification`;
- `open_questions`;
- `risk_notes`.

### `prototype/manifest.json`

Required fields:

- `run_id`;
- `selected_candidate`;
- `target_stack`;
- `model`;
- `files`;
- `preview_entry`;
- `review_notes`;
- `limitations`;
- `integration_recommendation`.

Prototype file paths must be relative to the `prototype/` directory. Absolute paths and path traversal are rejected.

## CLI Shape

```text
gemini-agent design brief [--stdin|--file <path>] [--screenshot <path>] [--context-pack <path>|--auto-context-pack] [--write-artifact]
gemini-agent design generate --brief <path> [--reference <path> ...] [--variants <n>] [--quality fast|pro] [--aspect-ratio <ratio>] [--image-size <size>] [--dry-run] [--max-cost-usd <n>]
gemini-agent design perceive --file <path> [--brief <path>] [--target <name: description> ...] [--provider auto|palette-mask|gemini-vision|vision-banana]
gemini-agent design prototype --run <path> [--candidate <id>] [--target-stack html|react|tailwind|auto] [--dry-run] [--max-cost-usd <n>]
gemini-agent design handoff --run <path> [--candidate <id>] [--target-stack react|html|tailwind|auto]
gemini-agent design loop --run <path> [--url <url>] [--target-screenshot <path>] [--actual-screenshot <path>] [--max-iterations <n>] [--dry-run] [--max-cost-usd <n>]
gemini-agent design doctor [--json]
```

## Error Handling

- Missing Gemini auth returns the existing auth guidance.
- Missing dedicated Vision Banana configuration returns: `Vision Banana provider is not configured; use --provider gemini-vision or configure VISION_BANANA_ENDPOINT.`
- Image generation with no image parts in the response fails with a clear message and preserves the request manifest without raw prompt exposure in normal logs.
- Prototype generation with invalid or unsafe file paths fails before writing any prototype files.
- Prototype generation must write to a temporary directory first, validate the manifest, then atomically move into `prototype/`.
- Invalid handoff schema fails before Codex execution guidance is printed.
- `design loop` requires `--max-iterations` between 1 and 3; default is 2.
- `design loop` with no actual screenshot exits with a resumable manual-screenshot instruction instead of blocking.
- Screenshot capture failures should still allow manual screenshot paths.
- Cost budget exhaustion writes a partial artifact manifest and exits before the next model call when the configurable estimate is above budget.
- Cost estimates are conservative soft gates, not billing guarantees. Pricing and model token accounting use a bundled conservative table plus configurable overrides so operators can update costs without source changes.
- Missing, corrupted, or incomplete pricing data for the selected model fails closed for budget-gated commands unless `--allow-unknown-cost` is present.
- Rate limits and transient API failures preserve completed artifacts and recommend the next resumable command.
- Model availability failures preserve completed artifacts and recommend `design doctor` plus the relevant environment/configuration key.
- Unsafe run ids or run paths are rejected before any filesystem writes.

## Telemetry

Design commands should record safe aggregate metadata:

- command;
- workflow stage;
- selected provider;
- actual model;
- media MIME/kind/byte metadata;
- candidate count;
- prototype target stack;
- prototype file count;
- image size/aspect ratio;
- run artifact presence;
- latency stages;
- token usage when available;
- structured score coverage and numeric scores when available.

Ordinary summaries must not print:

- raw prompt;
- raw response;
- absolute local file paths;
- original media file names;
- image bytes;
- event ids or batch ids.

Raw telemetry remains governed by existing explicit raw-content configuration and credential masking.

## Testing

Unit tests:

- model router resolves default, design, fast image, and pro image routes.
- `design brief` validates schema and writes `brief.json` and `DESIGN.md`.
- `design generate` extracts inline image responses and writes candidate manifests.
- `design perceive --provider palette-mask` delegates to palette-mask behavior and records provider metadata.
- `design perceive --provider vision-banana` fails clearly when unconfigured.
- `design prototype` validates generated manifest, writes static preview artifacts under `prototype/`, and rejects path traversal.
- `design handoff` validates required implementation fields and writes markdown tasks.
- `design loop` enforces bounded iteration count.
- `design loop` exits cleanly with a resumable message when manual screenshots are required.
- `regions.json` and `layout-map.json` schemas validate required fields and nullable normalized coordinates.
- model router doctor reports configured model ids, missing environment settings, and probe success/failure without exposing secrets.
- run-id generation, validation, path containment with `path.relative`, and concurrent run directory creation are deterministic under test.
- image dimension extraction covers PNG/JPEG/WEBP and safely degrades on invalid dimensions.
- fallback model routing validates required capabilities before a model is accepted for structured design commands.

CLI tests:

- help includes all design subcommands.
- invalid provider and invalid quality values produce clear errors.
- design commands do not require unrelated telemetry config.
- `--dry-run` prints planned calls without invoking the fake Gemini provider.
- `--max-cost-usd` blocks calls that exceed the configurable estimated budget.
- `--url` without browser automation returns a manual screenshot fallback message.
- partial browser automation installation or browser launch failure returns a manual screenshot fallback message.
- model availability errors preserve run state and do not silently fall back without `--allow-fallback`.
- missing or corrupted pricing config fails closed for budget-gated commands unless `--allow-unknown-cost` is present.

Telemetry tests:

- design commands record provider/model/stage metadata.
- prototype telemetry records target stack and file count without raw code content.
- summaries aggregate design workflow usage without exposing raw paths, prompts, responses, or image names.

Integration tests:

- fake image provider produces deterministic candidate files.
- fake perception provider produces deterministic `perception.json`.
- fake prototype provider produces deterministic `prototype/preview.html` and manifest without touching production source files.
- fake artifact-review comparison produces a loop review without network access.
- manual screenshot loop can resume from a run directory after Codex writes an actual screenshot.
- rate-limit, partial response, and corrupted inline image payload fakes preserve resumable run state.
- coordinate normalization tests cover pixel and normalized provider outputs for multiple image sizes, including invalid zero and negative dimensions.
- WEBP dimension tests cover each supported dependency/parser fixture class or explicitly document unsupported formats with null-coordinate degradation.
- concurrent design runs create isolated artifact directories.

## Rollout

1. Add schemas, model router, and CLI help with no network behavior.
2. Implement `design perceive --provider palette-mask` by reusing `palette-split`.
3. Implement `design brief` and `design handoff` with structured text outputs.
4. Implement `design prototype` as an isolated static HTML preview workflow.
5. Implement `design generate` against the Gemini image API.
6. Implement bounded `design loop` using manual screenshot paths first.
7. Add optional browser screenshot automation later.
8. Add `provider=vision-banana` only when a real endpoint or model id is configured.

## Acceptance Criteria

- `gemini-agent design perceive --provider palette-mask` can produce perception artifacts from an image using the existing Nano Banana mask workflow.
- `gemini-agent design prototype` can write an isolated preview users can inspect without modifying production source.
- `gemini-agent design handoff` can turn a brief plus perception artifacts into `handoff.json` and `codex-tasks.md`.
- For a scoped UI task, Codex can use the generated handoff as the primary implementation guide without asking Gemini to edit files directly.
- `artifact-review` can compare target and actual screenshots after implementation.
- Telemetry reports design workflow usage safely.
- Vision Banana provider absence does not block the MVP.

## Open Decisions

- Whether `DESIGN.md` should be stored only inside `.gemini-agent/design/<run-id>/` or optionally copied to the project root.
- Whether `gemini-3-pro-image` should be opt-in only or automatically selected for UI candidates with substantial in-image text.
