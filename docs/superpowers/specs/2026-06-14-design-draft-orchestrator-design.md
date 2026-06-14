# Design Draft Orchestrator

## Summary

Add a small orchestration layer that turns the existing design commands into one active design-to-first-draft workflow.

Today `gemini-agent` is used mostly as a reviewer. Local telemetry shows strong usage of `diff-review`, `plan-critique`, `context-pack`, and `artifact-review`, while active design commands are barely used: `design-brief` and `design-generate` have only a few events, and `design-prototype`, `design-handoff`, and `design-loop` have no observed local usage. The underlying design modules exist, but the product entry points do not guide Codex or MCP clients into using them.

The MVP should add `gemini-agent design draft` as the safe default active-design path. It should compose `design brief`, `design generate`, optional `design perceive`, `design prototype`, and `design handoff` into one resumable run under `.gemini-agent/design/<run-id>/`. Gemini produces design reasoning, visual candidates, isolated prototype files, and Codex-ready handoff artifacts. Codex remains responsible for reading the handoff, editing the real repository, running tests, capturing screenshots, reviewing diffs, and committing.

## Goals

- Make active design and first-version drafting easy enough that Codex uses it before implementation, not only after implementation for review.
- Reduce fragmentation by giving users and MCP clients one high-level command for the common design workflow.
- Keep the existing low-level design commands intact for advanced or resumable use.
- Expose active design through MCP so other Codex sessions can call it without shell-specific glue.
- Update the global active policy so UI, product-page, prototype, and visual implementation requests route through the design workflow.
- Preserve the safety boundary: Gemini can write only draft artifacts under `.gemini-agent/design/`; Codex integrates into the real codebase.
- Improve telemetry so the product can measure design adoption separately from review adoption.

## Non-Goals

- Do not let Gemini directly edit production source files.
- Do not remove `artifact-review`, `palette-split`, `design perceive`, `design prototype`, `design handoff`, or `design loop`.
- Do not rewrite the entire CLI parser in this slice.
- Do not merge telemetry summary, report, priorities, and readiness commands in this slice.
- Do not require a configured Vision Banana endpoint for the default workflow.
- Do not claim that Nano Banana fallback output is the dedicated Vision Banana paper model.
- Do not automatically commit or deploy Codex-integrated changes.

## Current Fragmentation

### Product Entry Points

The CLI has complete design subcommands:

- `design brief`
- `design generate`
- `design perceive`
- `design prototype`
- `design handoff`
- `design loop`
- `design doctor`

The MCP server exposes only review-oriented tools:

- auth status
- plan critique
- patch precheck
- diff review
- research brief
- context pack
- artifact review

This mismatch explains why Codex sessions can call `gemini-agent` globally but mostly use it for review.

### Global Active Policy

The global active policy tells Codex when to use context compression, artifact review, plan critique, patch precheck, diff review, and research. It does not define an active design route for first-version UI/product work.

The policy should make design intent explicit:

- For UI, visual, product-page, prototype, layout, or design-system implementation tasks, call `gemini-agent design draft` before Codex starts repository edits when external Gemini calls and content sharing are permitted.
- If a relevant design run already exists, call `design handoff` or read the latest design run instead of creating a new draft.
- After Codex implementation, capture a screenshot and call `design loop` or `artifact-review` for target-vs-actual feedback.

### Visual Capabilities

The visual layer has several useful but overlapping commands:

- `artifact-review`: structured visual critique and design scorecard.
- `palette-split`: target mask generation and layer extraction.
- `design perceive`: screenshot/candidate region understanding.
- `design loop`: target-vs-actual implementation review.

They are not redundant at the engine level. They are fragmented at the workflow level. `design draft` should choose sensible defaults and record which lower-level routes it used.

## Proposed User Workflow

### 1. Active Draft

Command:

```sh
gemini-agent design draft --stdin --variants 2 --quality fast --target-stack html
```

Inputs:

- natural language product or UI request;
- optional `--file <path>` for a prompt file;
- optional `--reference <image>` for screenshot, wireframe, moodboard, or existing UI;
- optional `--context-pack <path>` or `--auto-context-pack`;
- optional `--target <name: description>` for explicit perception targets;
- optional `--variants <1-4>`;
- optional `--quality fast|pro`;
- optional `--target-stack html|react|tailwind|auto`;
- optional `--skip-generate`, `--skip-prototype`, or `--skip-handoff` for partial runs.

Outputs:

- `.gemini-agent/design/<run-id>/brief.json`
- `.gemini-agent/design/<run-id>/DESIGN.md`
- optional candidate images under `candidates/`
- optional perception artifacts under `perceive/`
- isolated prototype files under `prototype/`
- `handoff.json`
- `codex-tasks.md`
- `draft-summary.json`

The terminal output should print only concise safe paths, selected model routes, run id, next Codex command hints, and warnings. It must not print raw prompt/response text unless the user explicitly uses governed raw telemetry workflows.

### 2. Codex Integration

Codex reads:

```sh
.gemini-agent/design/<run-id>/codex-tasks.md
.gemini-agent/design/<run-id>/handoff.json
.gemini-agent/design/<run-id>/prototype/manifest.json
```

Codex then edits the real project using normal repository discipline:

- inspect existing code and design system;
- implement only the selected tasks;
- run tests and build checks;
- start the dev server when relevant;
- capture screenshots for visual verification;
- call `design loop` or `artifact-review` for visual feedback;
- run `diff-review --smart-diff` before commit or handoff when risk warrants it.

### 3. Visual Loop

Command:

```sh
gemini-agent design loop --run .gemini-agent/design/<run-id> --actual-screenshot after.png
```

If a target screenshot exists in the run, the loop compares target and actual. If no target screenshot exists, it uses the design brief, selected candidate, prototype manifest, and actual screenshot to produce implementation feedback.

## CLI Design

### New Command

Add:

```sh
gemini-agent design draft [--stdin|--file <path>|text] [options]
```

The command should live in a new module, for example `src/design-draft.mjs`, so `src/cli.mjs` only parses arguments and delegates execution. This is the first CLI de-risking slice; it should not attempt a full CLI refactor.

### Draft Options

Supported MVP options:

- `--stdin`
- `--file <path>`
- positional text prompt
- `--reference <path>` repeatable
- `--target <name: description>` repeatable
- `--variants <1-4>` default `1`
- `--quality fast|pro` default `fast`
- `--target-stack html|react|tailwind|auto` default `html`
- `--skip-generate`
- `--skip-perceive`
- `--skip-prototype`
- `--skip-handoff`
- `--json`

`--skip-prototype` should not imply `--skip-handoff`; handoff can still be generated from brief, candidates, and perception.

`--skip-generate` should require at least one reference image or an existing run with candidate material if prototype generation needs visual context.

### Resumability

The MVP can support only new runs. Resuming an existing run can remain an explicit lower-level workflow through `design generate`, `design perceive`, `design prototype`, and `design handoff`.

Partial failures must not assume the user can infer recovery steps. When a draft stops after one or more completed steps, `draft-summary.json` should include exact next commands using the generated run path and should mark whether each command is safe to retry. This keeps recovery deterministic even before orchestrator-level `--resume` exists.

A later version can add:

```sh
gemini-agent design draft --run .gemini-agent/design/<run-id> --resume
```

## MCP Design

Expose active design through MCP without granting direct repository write access.

### `gemini_design_draft`

Inputs:

- `input`: required string
- `cwd`: optional string
- `references`: optional array of relative file paths
- `targets`: optional array of `name: description` strings
- `variants`: optional integer
- `quality`: optional `fast|pro`
- `target_stack`: optional `html|react|tailwind|auto`
- `skip_generate`: optional boolean
- `skip_perceive`: optional boolean
- `skip_prototype`: optional boolean
- `skip_handoff`: optional boolean

Output:

- JSON text with run id, run directory, produced artifact paths, selected model routes, and next Codex actions.

Path handling:

- `cwd` must resolve to a real directory.
- `references` must be relative paths.
- resolved reference paths must stay inside `cwd`.
- symlinked reference paths that escape `cwd` must be rejected.
- the tool must not accept output paths from MCP callers in the MVP.

### `gemini_design_latest`

Resource URI:

```text
gemini-agent://design/latest
```

Returns the latest design run summary or a missing-resource object.

### `gemini_design_handoff_latest`

Resource URI:

```text
gemini-agent://design/handoff/latest
```

Returns latest `handoff.json` and `codex-tasks.md` metadata when present. It should not inline large prototype files unless a later explicit resource is added.

## Model Routing

`design draft` should use the existing model router:

- brief, prototype, and handoff: `GEMINI_DESIGN_MODEL`, currently configured locally as `gemini-3.1-pro-preview`;
- image generation fast path: `GEMINI_IMAGE_MODEL`, currently configured locally as `gemini-3.1-flash-image`;
- image generation pro path: `GEMINI_IMAGE_PRO_MODEL`, currently configured locally as `gemini-3-pro-image`;
- default review and non-design gates continue to use `gemini-3.5-flash`.

If image models are missing and generation is requested, fail clearly with `design doctor` guidance. Do not silently downgrade to text-only if the user asked for visual candidates.

The default command requests generation. If `GEMINI_IMAGE_MODEL` is missing, `design draft` should fail before creating partial image work and print the exact alternatives:

- configure `GEMINI_IMAGE_MODEL`;
- run `gemini-agent design doctor --json`;
- retry with `--skip-generate` for a text-only brief, prototype, and handoff path when that is sufficient.

If `VISION_BANANA_ENDPOINT` is missing, `design draft` should use the existing `palette-mask` or `artifact-review` fallback routes and record that the dedicated Vision Banana provider was not used.

## Telemetry

`design draft` should capture one top-level orchestration event:

- command: `design-draft`
- status: success or error
- model: default runtime model field remains compatible with receiver policy unless the schema is expanded;
- metadata:
  - `design_stage: draft`
  - `draft_steps_requested`
  - `draft_steps_completed`
  - `run_id_hash`
  - `variants`
  - `quality`
  - `target_stack`
  - `actual_design_model`
  - `actual_image_model`
  - `actual_image_pro_model` when used
  - `vision_banana_provider: configured|missing|waived`

Lower-level commands may keep their existing telemetry events. This creates both:

- workflow-level adoption: `design-draft`;
- step-level diagnostics: `design-brief`, `design-generate`, `palette-split`, `artifact-review`, `design-prototype`, `design-handoff`, `design-loop`.

Telemetry summaries should eventually add a design workflow section, but that can be a later implementation slice.

## Safety

- Generated draft code stays under `.gemini-agent/design/<run-id>/prototype/`.
- Before writing the first draft artifact, the orchestrator must ensure `.gemini-agent/` is ignored by git, reusing the existing artifact-store ignore behavior or an equivalent safe helper.
- `design draft` never writes to source directories, package manifests, public assets, config files, or git metadata.
- Prototype file writes must keep using managed path checks from `design-run-store`.
- MCP design tools must accept only relative reference paths resolved under `cwd`.
- MCP design tools must reject absolute paths, `..` traversal, and symlink escapes for every reference using physical path resolution against a physical `cwd`.
- Run ids must use the existing unique run directory creation path so concurrent drafts in the same workspace cannot collide or overwrite each other.
- Draft runs can include images and prototype files, so the command should print the run directory size when available and remind the user that draft artifacts are local review assets, not source files.
- Raw prompt/response capture follows existing raw telemetry configuration and governance.
- CLI output should avoid raw prompt text, response text, absolute local home paths, event ids, and media filenames when they are not needed.
- Codex must perform implementation, verification, and commit decisions.

## Error Handling

- Missing Gemini auth: fail before creating expensive downstream work when a required live step needs Gemini.
- Missing image model: fail when generation is requested; suggest `gemini-agent design doctor --json`.
- Missing Vision Banana endpoint: do not fail the default draft; record fallback unless the user explicitly requested `--provider vision-banana`.
- Prototype generation invalid JSON: preserve the run and write a resumable error summary if possible.
- Partial draft failure: write `draft-summary.json` with completed steps and next manual resume commands.
- Concurrent draft creation failure: retry through the existing unique run creation loop and fail closed if a unique run directory cannot be created.
- Draft storage growth: no automatic deletion in the MVP; surface local run size and leave cleanup policy to a later `design prune` or retention slice.

## Testing Strategy

Add focused tests before implementation:

- CLI help includes `design draft`.
- Argument parser accepts stdin, file, positional text, variants, quality, target stack, references, targets, and skip flags.
- `runDesignDraft` calls the expected lower-level runners in order.
- Missing image model fails when generation is enabled.
- Missing image model failure prints `design doctor` and `--skip-generate` guidance.
- `--skip-generate` can still create brief and handoff when enough non-image context exists.
- Draft summary records completed and skipped steps.
- Draft summary records safe retry or resume commands after partial failures.
- Draft creation ensures `.gemini-agent/` is ignored before writing local artifacts.
- MCP exposes `gemini_design_draft` and design resources.
- MCP rejects absolute reference paths, `..` traversal, and symlink escapes using real symlinks that point outside the workspace.
- Concurrent draft runs create distinct run directories and never overwrite each other.
- Orchestrator-generated runs remain compatible with low-level `design prototype` and `design handoff` commands.
- Global active policy includes active design routing and Codex safety boundaries.
- Existing full `npm test` remains green.

## Rollout Plan

1. Implement `runDesignDraft` as orchestration over existing design modules.
2. Add CLI parser and usage text for `design draft`.
3. Add MCP tool/resource exposure.
4. Update global active policy text.
5. Update README commands and safety notes.
6. Add telemetry metadata for `design-draft`.
7. Run full tests and a local fake-response smoke workflow.
8. Reinstall global active policy with `install-codex-global --mode active --write`.
9. Use telemetry to verify future design-draft adoption instead of relying on anecdotal usage.

## First Slice Recommendation

The first implementation slice should be limited to orchestration and entry points:

- `src/design-draft.mjs`
- CLI `design draft`
- MCP `gemini_design_draft`
- global active policy text
- README update
- tests for the new routing

Do not refactor the full CLI or telemetry suite in the same slice. The CLI is large enough that broad cleanup should happen only after characterization tests are in place.
