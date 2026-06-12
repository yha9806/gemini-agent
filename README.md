# gemini-agent

Global Gemini review gate for Codex.

## Commands

```bash
./bin/gemini-agent auth status
./bin/gemini-agent ask "Reply with exactly: gemini-agent-ok"
./bin/gemini-agent diff-review --stdin
./bin/gemini-agent diff-review --diff
./bin/gemini-agent diff-review --smart-diff
./bin/gemini-agent diff-review --auto-context-pack --diff
./bin/gemini-agent plan-critique --stdin --max-input-bytes 131072
./bin/gemini-agent plan-critique --context-pack .gemini-agent/context/latest.json
./bin/gemini-agent plan-critique --auto-context-pack --stdin
./bin/gemini-agent context-pack --bootstrap --write-artifact
./bin/gemini-agent context-pack --doctor --json
./bin/gemini-agent context-pack --stdin
./bin/gemini-agent artifact-review --file design.png --kind ui
./bin/gemini-agent artifact-review --file design.png --kind ui --review-depth quick
./bin/gemini-agent artifact-review --file design.png --kind ui --telemetry-purpose validation
./bin/gemini-agent artifact-review --file before.png --file after.png --kind ui --review-mode comparison
./bin/gemini-agent palette-split slide.png --target "product: the red product card" --target "chart: the blue chart panel" --output /tmp/palette-split
./bin/gemini-agent telemetry enable --global --level raw --endpoint http://127.0.0.1:8787/ingest --token-env GEMINI_AGENT_TELEMETRY_TOKEN --deployment-id gemini-agent-main --user-label local-admin --confirm-raw-content
./bin/gemini-agent telemetry status --global
./bin/gemini-agent telemetry summary --global
./bin/gemini-agent telemetry summary --global --json
./bin/gemini-agent telemetry raw inventory --global
./bin/gemini-agent telemetry raw inventory --global --json
./bin/gemini-agent telemetry raw preflight --global --batch-size 1 --json
./bin/gemini-agent telemetry raw export --global --state pending --output ./raw-export.jsonl --limit 100 --confirm-raw-content --json
./bin/gemini-agent telemetry raw reveal --global --state sent --limit 1 --confirm-raw-content --json
./bin/gemini-agent telemetry raw delete --global --state sent --event-id evt_example --confirm-raw-content --dry-run --json
./bin/gemini-agent telemetry raw prune --global --state sent --keep-days 30 --dry-run
./bin/gemini-agent telemetry raw prune --global --state sent --keep-days 30 --write --json
./bin/gemini-agent telemetry economics --global
./bin/gemini-agent telemetry economics --global --json
./bin/gemini-agent telemetry priorities --global
./bin/gemini-agent telemetry priorities --global --json
./bin/gemini-agent telemetry report --global
./bin/gemini-agent telemetry report --global --json
./bin/gemini-agent telemetry artifact-review quality-gate --global --json
./bin/gemini-agent telemetry multimodal repair-kind --global --correction-version media-kind-v1 --dry-run
./bin/gemini-agent telemetry multimodal repair-kind --global --correction-version media-kind-v1 --write --json
./bin/gemini-agent telemetry multimodal repair-metadata --global --correction-version media-v2 --dry-run
./bin/gemini-agent telemetry multimodal repair-metadata --global --correction-version media-v2 --write --json
./bin/gemini-agent telemetry validate --global --endpoint http://127.0.0.1:8787/ingest --token-env GEMINI_AGENT_TELEMETRY_TOKEN --deployment-id gemini-agent-main --confirm-raw-content
./bin/gemini-agent telemetry flush --global
./bin/gemini-agent telemetry quarantine inspect --global --json
./bin/gemini-agent telemetry quarantine retry --global --reason repeated_http_403_context_pack_payload --dry-run --batch-size 1
./bin/gemini-agent telemetry quarantine archive --global --reason repeated_http_403_context_pack_payload --dry-run --batch-size 1
./bin/gemini-agent telemetry tick --global --batch-size 1 --timeout-ms 20000
./bin/gemini-agent telemetry disable --global
./bin/gemini-agent telemetry purge --global
./bin/gemini-agent telemetry install-scheduler --global --target launchd --name gemini-agent-main --schedule daily@09:00 --batch-size 1 --timeout-ms 20000 --env-file ~/.gemini-agent/telemetry.env --dry-run
./bin/gemini-agent telemetry scheduler-status --target launchd --name gemini-agent-main
./bin/gemini-agent telemetry uninstall-scheduler --target launchd --name gemini-agent-main
./bin/gemini-agent-telemetry-receiver --host 127.0.0.1 --port 8787 --storage ./.telemetry-data --token-env GEMINI_AGENT_TELEMETRY_TOKEN
./bin/gemini-agent install-codex-global --mode active --dry-run
./bin/gemini-agent install-codex-global --mode active --write
# MCP stdio entrypoint for Codex/MCP clients, not a standalone shell command:
./bin/gemini-agent-mcp
```

## Safety

- Credentials are read from `GEMINI_API_KEY`, `GOOGLE_API_KEY`, or macOS Keychain service `GEMINI_API_KEY`.
- Runtime text/review Gemini calls use `gemini-3.5-flash`; `palette-split` is an explicit image-generation workflow and uses `GEMINI_IMAGE_MODEL` or `gemini-3.1-flash-image`.
- `auth status` reports only availability and source; it never prints the key.
- Gate commands reject empty manual input before resolving credentials; `diff-review --smart-diff` may resolve credentials after collecting bootstrap context when it needs to create a missing context pack.
- Fake responses require explicit `GEMINI_AGENT_ALLOW_FAKE_RESPONSE=1`.
- Project policy is discovered from `.gemini-agent-policy.json`.
- `diff-review --diff` reads the current git diff directly, so Codex can run the high-ROI review gate without building a manual stdin pipe.
- `diff-review --smart-diff` reviews the current git diff with the project-root context pack; if `.gemini-agent/context/latest.json` is missing, it first bootstraps one with `context-pack --bootstrap --write-artifact`.
- `plan-critique` has a conservative default input byte limit to control review cost; gate commands also accept `--max-input-bytes <n>` for intentional overrides.
- Gate commands accept `--context-pack <path>` so Codex can ask Gemini to critique compact prior context instead of pasting large raw project slices again.
- Gate commands accept `--auto-context-pack` to reuse project-root `.gemini-agent/context/latest.json` explicitly without hand-writing the path.
- For current branch review, `diff-review --smart-diff` is the preferred short context-reuse path when `.gemini-agent/context/latest.json` is relevant or missing; `diff-review --auto-context-pack --diff` remains the explicit equivalent when the pack already exists.
- `context-pack --bootstrap --write-artifact` creates the project-root context artifact used by `--auto-context-pack` from a bounded root-file allowlist and current git diff.
- `context-pack --doctor` checks whether the project-root context pack is missing, invalid, stale, or tied to a different git HEAD without calling Gemini.
- Oversized gate failures print concrete `context-pack --bootstrap --write-artifact` and `--auto-context-pack` retry commands so Codex can switch to compact context before raising byte limits.
- Large raw gate calls print a non-blocking stderr preflight warning before Gemini credentials are resolved; stdout remains the structured review JSON.
- Large raw `diff-review --diff` calls with an existing context pack suggest `diff-review --smart-diff`; the current run continues and stdout remains JSON.
- Global active Codex policy tells sessions to use `diff-review --smart-diff` for current branch review, reuse project-root `.gemini-agent/context/latest.json` with gate `--auto-context-pack` or explicit `--context-pack`, and manually regenerate stale or unrelated packs.
- `context-pack` creates compact structured summaries for Codex; it does not edit source files. With `--write-artifact`, it ensures `.gemini-agent/` is ignored and writes JSON under `.gemini-agent/context/`.
- `artifact-review` supports PNG/JPEG/WEBP inline image review in v1, including bounded multi-file comparison for visual diff work.
- `artifact-review` returns a structured design scorecard with 0-100 visual hierarchy, clarity, accessibility, consistency, and implementation-readiness scores when the artifact supports design judgment.
- `artifact-review --review-depth quick` keeps the same JSON shape while asking Gemini for concise arrays, setting a lower output-token budget, and recording safe telemetry depth/mode metadata for latency comparison.
- quick single reviews use the 2048 output-token cohort while quick comparison reviews use the 4096 output-token cohort, so visual-diff style reviews have more room to return complete JSON without changing standard-mode fallback.
- `artifact-review --telemetry-purpose validation` marks canary or manual validation runs so delivery and latency health still count, while product multimodal, scorecard, depth, and economics usage-applicable metrics exclude that run.
- multi-file artifact-review records media metadata without printing raw image bytes in ordinary telemetry output.
- `palette-split` writes palette masks, decoded layers, a manifest, a quality scorecard, and a contact sheet to the explicit output directory selected by the caller.
- Generated context/review artifacts live under `.gemini-agent/`, which is kept ignored by git.
- Telemetry raw mode is explicit and requires `--confirm-raw-content`.
- Telemetry `--global` stores config and queue data under `~/.gemini-agent/telemetry`, so gemini-agent calls from different Codex project directories share one deployment queue.
- Raw telemetry transport encoding defaults to `auto`: `context-pack` and large raw payloads encode request/prompt/response raw fields as gzip+base64url in transit so front-end WAFs do not inspect raw source text; set `GEMINI_AGENT_TELEMETRY_RAW_ENCODING=off` only as a temporary compatibility fallback, or `always` to encode all raw events.
- Telemetry config stores a generated `install_id`; captured events add a pseudonymous hashed `workspace_id` derived from the project root when available and salted with local install metadata. `workspace_id` is not a secret. `--user-label` is optional, rejects email-shaped labels plus path, credential, and phone-like identifiers, and can be cleared with `--clear-user-label`.
- `telemetry summary` reports aggregate usage, queue health, project/workspace attribution, latency p50/p95/p99, palette-split quality, multimodal MIME/kind/byte coverage, and backfill media-manifest source adoption; it does not print raw prompt, response text, event ids, batch ids, paths, or media file names.
- Telemetry summary and report aggregate artifact-review design scorecard metrics and per-field score coverage from safe numeric metadata without exposing scorecard text, raw prompts, raw responses, event ids, paths, or media file names.
- Telemetry summary, economics, priorities, and report expose product-adjusted analytics: validation telemetry remains in health and delivery counts, while product multimodal, scorecard, depth, and product-adjusted economics exclude validation events.
- `telemetry backfill-artifacts` carries only allowlisted numeric/null artifact-review design scorecard fields into metadata, dropping strengths, issues, recommended actions, and unknown scorecard keys.
- Telemetry summary reports aggregate latency p50/p95/p99 by command so slow Gemini routes can be diagnosed without exposing raw prompts, responses, event ids, paths, or media file names.
- Telemetry summary aggregates safe latency stage attribution, including captured `gemini_generation` time and artifact-review `pre_gemini_total`, without exposing raw prompts, responses, event ids, paths, or media file names.
- Telemetry summary aggregates safe structured-response diagnostics, including response byte counts, JSON-envelope misses, and Gemini finish reasons, without exposing raw prompts, raw responses, event ids, paths, or media file names.
- Telemetry summary and economics aggregate context-pack preflight warning counts, smart-diff auto-bootstrap counts/rates, and context reuse rates without exposing raw gate input.
- Telemetry summary, economics, and priorities normalize legacy `gemini-*` command aliases into current command names so historical MCP/raw-v1 events and current CLI events share one semantic route.
- `telemetry raw inventory` reports local raw telemetry counts, bytes, truncation counts, multimodal counts, and credential-like aggregate signals; it does not print raw prompt, response text, event ids, batch ids, paths, or media file names.
- `telemetry raw preflight` reports pending raw upload batch risk before flushing, including aggregate credential/email/path/phone-like field counts; it does not send, move, delete, print raw prompt/response text, event ids, batch ids, paths, or media file names.
- `telemetry raw export` writes confirmed raw telemetry to a local JSONL file for local analysis; it requires `--confirm-raw-content`, never overwrites existing files, refuses telemetry queue paths, and does not print raw prompt/response text, event ids, batch ids, paths, or media file names to stdout.
- `telemetry raw reveal` prints confirmed, bounded raw telemetry to stdout for local inspection; it requires `--confirm-raw-content`, `--state pending|sent`, and a positive `--limit`.
- `telemetry raw delete` deletes confirmed local raw telemetry by event id with dry-run by default; it supports only `--state pending|sent`, requires `--confirm-raw-content`, and reports aggregate counts without raw prompt, response text, event ids, paths, or media file names.
- `telemetry raw prune` applies local sent-telemetry retention with dry-run by default; it only supports `--state sent`, uses UTC day buckets, and reports aggregate counts without raw prompt, response text, event ids, batch ids, paths, or media file names.
- Failed telemetry inspect can surface sanitized receiver diagnostics for front-end security blocks such as `receiver_waf_403`, including status, content type, HTML title, body hash, byte count, and marker labels without printing raw prompt/response content.
- `telemetry quarantine inspect` reports aggregate-only descriptors for quarantined events, including safe reason, command, project, byte counts, media count, payload/metadata keys, and event hash; it does not print raw prompt, response text, event ids, paths, or media file names.
- `telemetry quarantine retry` moves bounded, reason-filtered quarantined events back to pending after receiver policy fixes; it is dry-run by default, requires explicit `--write`, and reports only aggregate counts before the usual bounded flush path.
- `telemetry quarantine archive` moves bounded, reason-filtered quarantined events into local resolved quarantine storage after inspection; it is dry-run by default, requires explicit `--write`, and reports only aggregate counts and a generated bucket name.
- `telemetry economics` estimates Gemini cost, Codex token savings, and aggregate gate input byte metrics from usage metadata; it does not print raw prompt, response text, event ids, batch ids, or media file names.
- `telemetry priorities` combines aggregate economics, reliability, delivery, pending raw preflight governance, latency, instrumentation, and multimodal metadata signals into a development priority list; it does not print raw prompt, response text, event ids, batch ids, or media file names.
- Telemetry priorities use latency stage attribution to distinguish captured Gemini generation latency from pre-Gemini artifact-review work without exposing raw prompts, responses, event ids, paths, or media file names.
- Telemetry priorities use artifact-review design scorecard coverage, per-field score coverage, and average score to choose between scorecard capture work, design-quality calibration, and broader visual workflow expansion.
- Telemetry priorities and report surface aggregate structured response diagnostics such as missing JSON-envelope counts, `MAX_TOKENS` finish-reason counts, and affected base commands without exposing raw prompt, response text, event ids, paths, or media file names.
- `telemetry artifact-review quality-gate` reports aggregate quick-depth readiness, risky budget cohorts, and design scorecard coverage without exposing raw prompts, raw responses, event ids, paths, or media file names.
- Artifact-review quality gate separates Gemini generation latency readiness from scorecard coverage, so high generation p95 first recommends raising scorecard coverage when coverage is weak and only recommends prompt/schema slimming once scorecard coverage is healthy.
- Artifact-review quality gate and priorities distinguish the current active quick budget cohort from historical non-active cohorts, so old quick-depth failures stay visible without blocking current 2048-token routing when that active cohort is healthy.
- Latency priorities only use stage attribution when `gemini_generation` or `pre_gemini_total` has at least 5 command-level samples, avoiding overconfident conclusions from smoke-test or sparse stage data.
- Latency priorities initially require at least 5 samples and command p95 >= 10,000 ms before recommending profiling a slow Gemini route.
- `telemetry report` combines aggregate health, economics, context reuse, attribution, multimodal adoption, and top development priority into a product decision snapshot; it does not print raw prompt, response text, event ids, batch ids, paths, or media file names.
- `telemetry multimodal repair-kind` creates correction events for historical multimodal telemetry with missing media kinds; it is dry-run by default, does not rewrite existing telemetry files, and reports aggregate counts without raw prompt, response text, event ids, paths, or media file names.
- `telemetry multimodal repair-metadata` creates safe MIME and media-kind corrections for historical multimodal telemetry; it does not fabricate missing byte sizes, is dry-run by default, does not rewrite existing telemetry files, and reports aggregate counts without raw prompt, response text, event ids, paths, or media file names.
- The telemetry receiver `/metrics` and `/dashboard` endpoints expose product-adjusted analytics plus aggregate correction and palette-split quality metrics without raw event ids, prompts, responses, paths, or media file names.
- Raw telemetry stores prompts and responses after mandatory credential-pattern masking. Masking is best-effort and does not guarantee complete PII or secret removal.
- Loopback HTTP endpoints are allowed for local telemetry validation; non-loopback telemetry endpoints require HTTPS.
- Telemetry uses a separate ingestion token from `GEMINI_AGENT_TELEMETRY_TOKEN` or another `--token-env` value. It never uses `GEMINI_API_KEY`.
- Telemetry `--deployment-id` must match the deployment id configured in the receiver token map, for example `gemini-agent-main:<token>`.
- Scheduler files never store `GEMINI_API_KEY` or telemetry token values directly.
- macOS launchd activation defaults to `gui/<uid>`; use `--launchd-domain user` only when that session model is required.
- Global active Codex install defaults to dry-run behavior and writes a backup before changing global instructions.
- Release validation must keep the allowed runtime model at `gemini-3.5-flash` unless the project explicitly changes that policy.
- `gemini-agent-telemetry-receiver` is for low-volume intranet validation. If Node prints experimental `node:sqlite` warnings, run it with `NODE_NO_WARNINGS=1`.
- PDF, video, batch, explicit cache, and automatic routing are deferred.

## Verified Locally

- `npm test` passes.
- `gemini-agent auth status` reads `GEMINI_API_KEY` from macOS Keychain.
- `gemini-agent ask "Reply with exactly: gemini-agent-ok"` returns `gemini-agent-ok`.
- `gemini-agent diff-review --stdin` returns structured JSON from Gemini.
- `node --test test/mcp.test.mjs` passes for stdio MCP transport.
- Codex MCP config can point at `gemini-agent-mcp` for the `gemini-agent` server.
