# Quick Diff Review

Use this when you want a second opinion on local changes before committing.

## Prerequisites

- Run commands from a git repository.
- Set `GEMINI_API_KEY` or run `gemini-agent auth set`.
- Keep private data out of the diff unless your project policy allows sending it
  to Gemini.

## Commands

```bash
./bin/gemini-agent auth status
./bin/gemini-agent context-pack --bootstrap --write-artifact
./bin/gemini-agent diff-review --smart-diff
```

`--smart-diff` reviews the current git diff with the project-root context pack.
If the pack is missing, it bootstraps one first.

## Expected Shape

The command returns structured JSON:

```json
{
  "verdict": "pass",
  "top_risks": [],
  "missing_tests": [],
  "unsafe_claims": [],
  "suggested_changes": [],
  "notes": []
}
```

Use the output as review input. Codex or the operator remains responsible for
edits, tests, commits, and final decisions.
