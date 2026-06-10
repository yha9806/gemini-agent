# Smart Diff Review Context-Pack Warning Design

## Goal

Increase `diff-review` context-pack reuse without changing gate execution behavior. When a user runs a raw `diff-review` with enough input to waste Codex/Gemini context and a relevant project-root context pack is already available, the CLI should print a stronger stderr hint that names the concrete reuse command:

```bash
gemini-agent diff-review --auto-context-pack --diff
```

The current run must continue and stdout must remain the structured review JSON.

## Context

Telemetry shows `diff-review` is the highest ROI Gemini workflow, but context-pack reuse is still low. The current preflight warning already notices large raw gate input and suggests `context-pack --bootstrap --write-artifact` plus a generic `--auto-context-pack` retry. That is useful when a pack is missing, but weak when `.gemini-agent/context/latest.json` already exists and the user simply did not use it.

This design keeps the product conservative: no automatic context injection, no default behavior change, and no hidden extra content sent to Gemini.

## Recommended Approach

Use a smarter non-blocking warning.

When `runGate()` receives raw `diff-review` input and `metadata.context_pack_mode` is not `auto` or `explicit`, check whether `.gemini-agent/context/latest.json` can be discovered from the current project root. If it exists and the command used `--diff`, emit a specific stderr hint:

```text
diff-review can reuse the existing context pack; current run will continue. Prefer: gemini-agent diff-review --auto-context-pack --diff
```

If the pack does not exist, keep the current generic preflight message that suggests generating the context pack first.

## Scope

In scope:
- `diff-review --diff` raw input guidance.
- Stderr-only warning text.
- Safe telemetry metadata showing whether the smarter existing-pack hint was available.
- README and package tests documenting the preferred command.

Out of scope:
- Automatically adding `--auto-context-pack`.
- Generating a context pack during `diff-review`.
- Changing `plan-critique`, `patch-precheck`, or `research-brief` behavior.
- Exposing context-pack paths, raw prompt, raw response, or raw diff content in telemetry or summaries.

## Data Flow

1. `readGateInput()` continues to parse input and returns text plus safe metadata.
2. `runGate()` computes existing preflight metadata.
3. For `diff-review` only, `runGate()` checks for the project-root context pack without reading raw context contents for telemetry.
4. If a pack exists and the call is raw `--diff`, stderr prints the stronger preferred-command hint.
5. Telemetry metadata records only booleans, such as `context_pack_existing_hint: true`, not file paths.

## Error Handling

- Missing context pack must not fail the command.
- Invalid context pack must not be parsed by this hint path; existence is enough for guidance.
- Empty input, invalid flags, and oversized hard failures keep their current behavior.
- `--auto-context-pack` and `--context-pack` suppress the hint.
- stdout remains valid JSON for successful reviews.

## Testing

Unit and CLI tests should prove:
- Raw `diff-review --diff` with an existing `.gemini-agent/context/latest.json` prints the preferred command to stderr and still returns JSON.
- The same command without a context pack keeps the existing generic warning behavior.
- `diff-review --auto-context-pack --diff` suppresses the hint.
- Telemetry metadata records only safe booleans and no path.
- README/package tests document `diff-review --auto-context-pack --diff`.

## Risks

- The warning may be noisy if users intentionally want raw diff-only review. It remains non-blocking and only appears on large raw input.
- Existing-pack detection could be wrong in unusual nested workspaces. The hint should reuse the same project-root discovery path as `--auto-context-pack`.
- Higher reuse depends on Codex and users adopting the hint, so telemetry should keep measuring reuse rate after release.

## Success Criteria

- Focused CLI tests pass.
- Full `npm test` passes.
- `gemini-agent diff-review --auto-context-pack --diff` works on the implementation diff.
- Future `telemetry priorities --global` continues to show context-pack reuse rate so we can observe whether the hint changes behavior.
