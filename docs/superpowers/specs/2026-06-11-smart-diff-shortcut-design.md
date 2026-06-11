# Smart Diff Shortcut Design

## Goal

Add an explicit `gemini-agent diff-review --smart-diff` shortcut that makes the high-ROI diff-review path easier to call with reusable project context while keeping Codex in control and preserving the existing safe defaults.

## Context

Telemetry shows `diff-review` is the strongest Gemini Agent delegation workflow:

- 506 observed `diff-review` events.
- 1,122,834 estimated Codex tokens saved.
- 99.6% observed success rate.
- Only 5.3% context-pack reuse on gate events.

The previous slice added a non-blocking warning when large raw `diff-review --diff` runs could reuse an existing context pack. That is useful, but it still requires users or agents to remember the longer `diff-review --auto-context-pack --diff` command. The next step should make the preferred path easier without changing existing defaults.

## Proposed Behavior

`gemini-agent diff-review --smart-diff` means:

1. Read the current git diff as the fresh input.
2. Require the project-root auto context pack at `.gemini-agent/context/latest.json`.
3. Combine the context pack and fresh diff through the existing gate input path.
4. Run the same `diff-review` review prompt and JSON output as other gate calls.
5. Record safe telemetry metadata that this was the smart shortcut.

The command should fail clearly if no context pack exists:

```text
No context pack found at <path>. Run gemini-agent context-pack --bootstrap --write-artifact from the project root before using --smart-diff.
```

It should not silently fall back to raw `--diff`, because the product goal is to build a measurable context-reuse habit rather than hide missing setup. This mirrors the existing `--auto-context-pack` safety boundary while providing a shorter, task-specific command.

## Non-Goals

- Do not make `--auto-context-pack` the default for `diff-review --diff`.
- Do not generate a context pack automatically inside `--smart-diff`.
- Do not change `plan-critique`, `patch-precheck`, or `research-brief`.
- Do not expose context pack paths, raw diffs, event ids, prompts, or responses in ordinary analytics output.
- Do not change Gemini model routing; runtime text review remains `gemini-3.5-flash`.

## CLI And Metadata

`--smart-diff` is valid only for `diff-review`.

Allowed:

```bash
gemini-agent diff-review --smart-diff
gemini-agent diff-review --smart-diff --max-input-bytes 8388608
```

Rejected:

```bash
gemini-agent plan-critique --smart-diff
gemini-agent diff-review --smart-diff --diff
gemini-agent diff-review --smart-diff --stdin
gemini-agent diff-review --smart-diff --file patch.diff
gemini-agent diff-review --smart-diff --context-pack pack.json
gemini-agent diff-review --smart-diff --auto-context-pack
```

Telemetry metadata should include:

```json
{
  "context_pack_mode": "auto",
  "fresh_input_mode": "smart-diff",
  "smart_diff_shortcut": true
}
```

This is enough for `telemetry economics` and `telemetry priorities` to measure adoption through existing context-loop fields without adding a new report.

## Error Handling

- Missing context pack: fail before Gemini API key lookup and point to `context-pack --bootstrap --write-artifact`.
- Invalid context pack JSON: reuse the existing invalid context pack error.
- Empty git diff: fail before Gemini API key lookup with the existing empty input behavior.
- Oversized combined input: reuse existing gate input limit errors and context-pack advisor.

## Testing

Add CLI tests for:

1. `diff-review --smart-diff` reads the current git diff, uses an existing context pack, prints JSON, and records safe metadata.
2. `diff-review --smart-diff` fails clearly when the context pack is missing and does not require credentials.
3. `diff-review --smart-diff` rejects conflicting input flags.
4. Non-`diff-review` gates reject `--smart-diff`.
5. README/package tests document the new shortcut.

## Rollout

This is an additive CLI shortcut. Existing workflows continue to work:

- `diff-review --diff` remains raw diff review.
- `diff-review --auto-context-pack --diff` remains the explicit reusable-context path.
- `diff-review --smart-diff` becomes the shorter recommended path for current branch review after a context pack exists.
