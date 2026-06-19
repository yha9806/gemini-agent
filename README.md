# gemini-agent

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
![Node.js >=22](https://img.shields.io/badge/node-%3E%3D22-339933)
![Interfaces: CLI + MCP](https://img.shields.io/badge/interfaces-CLI%20%2B%20MCP-blue)
![Telemetry: opt-in](https://img.shields.io/badge/telemetry-opt--in-lightgrey)

Local-first Gemini coprocessor for Codex and agentic coding workflows.

Use `gemini-agent` when Codex is doing the work, but you want Gemini to provide
bounded judgment before you spend more context or commit a change: compact large
repo slices, review diffs, critique plans, check screenshots and UI artifacts,
draft design handoff artifacts, and analyze opt-in telemetry. Codex, or the
human operator, remains the execution authority for editing files, running
tests, committing, deploying, and making final release decisions.

The project is public and MIT licensed, but the npm package is intentionally
marked `"private": true` to avoid accidental registry publishing. Use it from a
checked-out repository or a local npm link.

![CLI focused help](docs/assets/cli-focused-help.svg)

## 30-Second Fit Check

| Use it when... | Reach for something else when... |
| --- | --- |
| You want a second model to review plans, patches, diffs, screenshots, or design artifacts before Codex acts. | You want an autonomous coding agent that directly edits files for you. |
| You need reusable context packs instead of repeatedly pasting large source, logs, notes, or diffs into a model. | You only need one-off Gemini chat from a terminal. |
| You want local-first artifacts and explicit human/Codex ownership of final release decisions. | You want a hosted PR review bot to comment automatically on every pull request. |

Fastest useful command after setup:

```bash
./bin/gemini-agent diff-review --smart-diff
```

## First Run

Requires Node.js 22 or newer and a Gemini API key. This path installs the repo,
verifies credentials, proves Gemini access, and runs the first review gate:

```bash
git clone https://github.com/yha9806/gemini-agent.git
cd gemini-agent
npm install
export GEMINI_API_KEY="..."
./bin/gemini-agent auth status
./bin/gemini-agent ask "Reply with exactly: gemini-agent-ok"
./bin/gemini-agent diff-review --smart-diff
```

On macOS, you can store the key in Keychain instead of exporting it:

```bash
./bin/gemini-agent auth set
./bin/gemini-agent auth status
```

`auth status` reports only whether a key is available and where it came from.
It never prints the key. If `diff-review --smart-diff` has no context pack yet,
it bootstraps one before returning structured review JSON.

Copyable source examples live under `examples/`:

- [Quick diff review](examples/quick-diff-review/README.md): review local git
  changes with `diff-review --smart-diff`.
- [Visual gate](examples/visual-gate/README.md): run screenshot smoke checks
  and target-vs-actual review.
- [MCP config](examples/mcp-config/README.md): connect `gemini-agent-mcp` to
  Codex or another MCP client.

Default help is intentionally short. Use `--help-all` for the complete operator
surface, and focused help for workflow-specific details:

```bash
./bin/gemini-agent --help
./bin/gemini-agent --help-all
./bin/gemini-agent diff-review --help
./bin/gemini-agent context-pack --help
./bin/gemini-agent visual gate --help
```

## Why Use It?

| When you need to... | Run this first | What comes back |
| --- | --- | --- |
| Keep Codex from rereading a large repo slice | `context-pack --bootstrap --write-artifact` | A reusable `.gemini-agent/context/latest.json` summary |
| Get a second opinion before committing | `diff-review --smart-diff` | Structured risks, missing tests, unsafe claims, and suggested changes |
| Check whether a UI screenshot looks shippable | `visual gate --actual-screenshot after.png --kind ui --json` | A pass, caution, or block result with safe visual notes |
| Turn a design brief into implementation guidance | `design draft --stdin --target-stack html` | A design run with candidates, prototype, and Codex handoff artifacts |
| Understand opt-in usage and reliability | `telemetry report --global --json` | Aggregate health, economics, latency, context reuse, and quality signals |

![Workflow overview](docs/assets/workflow-overview.svg)

## What It Is Not

`gemini-agent` is not another autonomous coding agent. It is a local
coprocessor that gives Codex or another operator compact context, review
judgment, multimodal inspection, and design handoff artifacts.

| Adjacent product | Best known for | How `gemini-agent` is different |
| --- | --- | --- |
| [OpenAI Codex CLI](https://github.com/openai/codex) | A local terminal coding agent that can read, edit, and run code | `gemini-agent` does not edit source; it reviews, summarizes, and produces local artifacts for Codex |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | Direct Gemini access from the terminal with built-in tools and MCP support | `gemini-agent` narrows Gemini usage to review gates, context packs, visual checks, and design workflows |
| [Aider](https://github.com/Aider-AI/aider) | AI pair programming inside a git repository | `gemini-agent` is a second-opinion and artifact pipeline, not a pair-programming editor |
| [Repomix](https://github.com/yamadashy/repomix) | Packing repositories into AI-friendly files | `gemini-agent` creates reusable Gemini-generated context packs and feeds them into review gates |
| [CodeRabbit](https://docs.coderabbit.ai/cli) and [Greptile](https://www.greptile.com/docs/introduction) | Context-aware code review for local changes or pull requests | `gemini-agent` is local-first, manual or MCP-triggered, and keeps final execution authority with Codex or the user |

## Requirements

- Node.js 22 or newer.
- A Gemini API key available as `GEMINI_API_KEY`, `GOOGLE_API_KEY`, or, on
  macOS, stored by `gemini-agent auth set` in Keychain service
  `GEMINI_API_KEY`.
- Optional image model environment variables for design/image routes:
  `GEMINI_IMAGE_MODEL` for fast image generation and `GEMINI_IMAGE_PRO_MODEL`
  for pro-quality design generation.

Runtime text and review calls default to `gemini-3.5-flash`. Image and design
generation use the explicit image model variables above.

## Common Workflows

```mermaid
flowchart TD
  start["What do you need?"]
  start --> contextNeed["Large source, logs, notes, or diff context"]
  start --> reviewNeed["Second opinion on a plan, patch, or diff"]
  start --> visualNeed["Screenshot, UI, diagram, or design judgment"]
  start --> designNeed["Design brief to implementation handoff"]
  start --> telemetryNeed["Usage, cost, reliability, or raw-governance report"]

  contextNeed --> contextCmd["context-pack --bootstrap --write-artifact"]
  reviewNeed --> reviewCmd["diff-review --smart-diff\nplan-critique --stdin\npatch-precheck --diff"]
  visualNeed --> visualCmd["artifact-review --file design.png --kind ui\nvisual gate --actual-screenshot after.png --json"]
  designNeed --> designCmd["design draft --stdin --variants 2 --target-stack html"]
  telemetryNeed --> telemetryCmd["telemetry summary/economics/priorities/report --global"]
```

### Review The Current Diff

Use this before committing risky or release-bound changes:

```bash
./bin/gemini-agent diff-review --smart-diff
```

`--smart-diff` reviews the current git diff with a reusable project context
pack. If `.gemini-agent/context/latest.json` is missing, it first bootstraps one
with:

```bash
./bin/gemini-agent context-pack --bootstrap --write-artifact
```

When you already have a relevant context pack, this explicit form is equivalent:

```bash
./bin/gemini-agent diff-review --auto-context-pack --diff
```

Other review gates use the same input model:

```bash
./bin/gemini-agent plan-critique --stdin
./bin/gemini-agent patch-precheck --diff
./bin/gemini-agent research-brief --file notes.md
```

Gate commands accept `--file`, `--stdin`, `--diff`, direct text, `--context-pack
<path>`, and `--auto-context-pack`. Oversized raw inputs print retry guidance so
you can create or reuse a context pack instead of raising byte limits blindly.

### Compress Project Context

```bash
./bin/gemini-agent context-pack --bootstrap --write-artifact
./bin/gemini-agent context-pack --doctor --json
```

Context packs are compact structured summaries for Codex. They are written
under `.gemini-agent/context/`, which is ignored by git.

### Review Screenshots And Artifacts

```bash
./bin/gemini-agent artifact-review --file design.png --kind ui
./bin/gemini-agent artifact-review --file design.png --kind ui --review-depth quick
./bin/gemini-agent artifact-review --file before.png --file after.png --kind ui --review-mode comparison
```

For implementation checks, use the visual gate:

```bash
./bin/gemini-agent visual gate --actual-screenshot after.png --kind ui --smoke-only --json
./bin/gemini-agent visual gate --target-screenshot target.png --actual-screenshot after.png --kind ui --risk design-implementation --json
```

`visual gate` combines local screenshot smoke checks with optional Gemini review
and returns a pass, caution, or block-style result. Visual gate outputs and
telemetry do not expose raw prompts, raw responses, local paths, media file
names, or image bytes in ordinary outputs.

### Draft Design Work

Design commands write reviewable artifacts under `.gemini-agent/design/<run-id>/`.
They do not edit your source tree.

```bash
./bin/gemini-agent design brief --stdin --write-artifact
./bin/gemini-agent design draft --stdin --variants 2 --quality fast --target-stack html
./bin/gemini-agent design generate --run .gemini-agent/design/<run-id> --variants 2 --quality fast
./bin/gemini-agent design perceive --run .gemini-agent/design/<run-id> --file screenshot.png --target "hero: main area"
./bin/gemini-agent design prototype --run .gemini-agent/design/<run-id> --target-stack html
./bin/gemini-agent design handoff --run .gemini-agent/design/<run-id>
./bin/gemini-agent design loop --run .gemini-agent/design/<run-id> --target-screenshot target.png --actual-screenshot after.png
./bin/gemini-agent design doctor --json
```

The design loop keeps Codex as the source-editing authority. Gemini provides
briefs, candidates, perception notes, prototype drafts, handoff artifacts, and
target-vs-actual feedback.

### Use With Codex

To install the active global Codex policy block, dry-run first:

```bash
./bin/gemini-agent install-codex-global --mode active --dry-run
./bin/gemini-agent install-codex-global --mode active --write
```

The installer updates `~/.codex/AGENTS.md`, writes a backup before changes, and
defaults to dry-run behavior unless `--write` is present.

### Use As An MCP Server

`gemini-agent-mcp` is a stdio MCP server entrypoint for Codex and other MCP
clients. It is not a standalone shell command.

Example MCP command path:

```json
{
  "mcpServers": {
    "gemini-agent": {
      "command": "/absolute/path/to/gemini-agent/bin/gemini-agent-mcp"
    }
  }
}
```

The MCP server exposes review tools, context packing, artifact review, design
drafting, and resources for the latest local artifacts:

- `gemini_auth_status`
- `gemini_plan_critique`, `gemini_patch_precheck`, `gemini_diff_review`,
  `gemini_research_brief`
- `gemini_context_pack`
- `gemini_artifact_review`
- `gemini_design_draft`
- `gemini-agent://context/latest`
- `gemini-agent://reviews/latest`
- `gemini-agent://artifact-reviews/latest`
- `gemini-agent://design/latest`
- `gemini-agent://policy/current`

## Telemetry

Telemetry is opt-in. Raw telemetry mode can capture prompts and responses, so it
requires `--confirm-raw-content` and should be enabled only when your project
data policy permits it.

Basic status and reports:

```bash
./bin/gemini-agent telemetry status --global
./bin/gemini-agent telemetry summary --global
./bin/gemini-agent telemetry summary --global --json
./bin/gemini-agent telemetry economics --global
./bin/gemini-agent telemetry priorities --global
./bin/gemini-agent telemetry report --global --json
```

Advanced raw governance, scheduler, delivery validation, and local receiver
workflows are documented in [docs/telemetry.md](docs/telemetry.md).

## Release Notes

The current source release is documented in
[docs/release/v0.1.0.md](docs/release/v0.1.0.md). The package is intentionally
private, so GitHub releases are source releases rather than npm publication
events. Maintainers can use
[docs/release/post-release-checklist.md](docs/release/post-release-checklist.md)
after publishing a GitHub release.

## Safety Model

- Gemini gives advice, summaries, structured reviews, and design artifacts.
  Codex or the operator remains responsible for edits, tests, commits, and final
  decisions.
- Credentials are read from `GEMINI_API_KEY`, `GOOGLE_API_KEY`, or macOS
  Keychain. `auth status` never prints secret values.
- Project policy is discovered from `.gemini-agent-policy.json` when present.
- Generated context, review, design, and telemetry working artifacts live under
  `.gemini-agent/`, which is ignored by git.
- Raw telemetry stores prompts and responses after best-effort
  credential-pattern masking. Masking is not a complete PII or secret removal
  guarantee.
- `--confirm-raw-content` is an explicit acknowledgement that raw prompts and
  responses may be stored locally or sent to the configured telemetry receiver.
- Telemetry summary, economics, priorities, and report commands aggregate usage,
  latency, context reuse, visual gate outcomes, multimodal coverage, and
  structured-response diagnostics without printing raw prompts, raw responses,
  local paths, event ids, batch ids, media file names, or image bytes in ordinary
  output.
- Fake responses require `GEMINI_AGENT_ALLOW_FAKE_RESPONSE=1`.

## Development

```bash
npm install
npm test
```

Optional live smoke test:

```bash
GEMINI_AGENT_RUN_LIVE_TESTS=1 npm run test:live
```

The live test calls Gemini and requires credentials. Normal `npm test` uses
Node's built-in test runner, keeps live Gemini smoke tests skipped, and should
not require a Gemini API key.

Before contributing, run the focused command you changed plus `npm test`. Keep
`.gemini-agent/`, `node_modules/`, generated screenshots, raw exports, and local
telemetry stores out of commits unless a test fixture explicitly requires them.

See [CONTRIBUTING.md](CONTRIBUTING.md) for pull request expectations and
[SECURITY.md](SECURITY.md) for vulnerability reporting and data-handling
guidance.

## License

MIT. See [LICENSE](LICENSE).
