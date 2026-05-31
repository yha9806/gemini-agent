# gemini-agent

Global Gemini review gate for Codex.

## Commands

```bash
./bin/gemini-agent auth status
./bin/gemini-agent ask "Reply with exactly: gemini-agent-ok"
./bin/gemini-agent diff-review --stdin
./bin/gemini-agent context-pack --stdin
./bin/gemini-agent artifact-review --file design.png --kind ui
./bin/gemini-agent telemetry enable --level raw --endpoint http://127.0.0.1:8787/ingest --token-env GEMINI_AGENT_TELEMETRY_TOKEN --confirm-raw-content
./bin/gemini-agent telemetry status
./bin/gemini-agent telemetry validate --endpoint http://127.0.0.1:8787/ingest --token-env GEMINI_AGENT_TELEMETRY_TOKEN --confirm-raw-content
./bin/gemini-agent telemetry flush
./bin/gemini-agent telemetry tick
./bin/gemini-agent telemetry disable
./bin/gemini-agent telemetry purge
./bin/gemini-agent-telemetry-receiver --host 127.0.0.1 --port 8787 --storage ./.telemetry-data --token-env GEMINI_AGENT_TELEMETRY_TOKEN
# MCP stdio entrypoint for Codex/MCP clients, not a standalone shell command:
./bin/gemini-agent-mcp
```

## Safety

- Credentials are read from `GEMINI_API_KEY` or macOS Keychain service `GEMINI_API_KEY`.
- Runtime Gemini calls use `gemini-3.5-flash`.
- `auth status` reports only availability and source; it never prints the key.
- Gate commands reject empty input before resolving credentials.
- Fake responses require explicit `GEMINI_AGENT_ALLOW_FAKE_RESPONSE=1`.
- Project policy is discovered from `.gemini-agent-policy.json`.
- `context-pack` creates compact structured summaries for Codex; it does not edit source files. With `--write-artifact`, it ensures `.gemini-agent/` is ignored and writes JSON under `.gemini-agent/context/`.
- `artifact-review` supports PNG/JPEG/WEBP inline image review in v1.
- Generated local artifacts live under `.gemini-agent/`, which is kept ignored by git.
- Telemetry raw mode is explicit and requires `--confirm-raw-content`.
- Raw telemetry stores prompts and responses after mandatory credential-pattern masking. Masking is best-effort and does not guarantee complete PII or secret removal.
- Loopback HTTP endpoints are allowed for local telemetry validation; non-loopback telemetry endpoints require HTTPS.
- Telemetry uses a separate ingestion token from `GEMINI_AGENT_TELEMETRY_TOKEN` or another `--token-env` value. It never uses `GEMINI_API_KEY`.
- `gemini-agent-telemetry-receiver` is for low-volume intranet validation. If Node prints experimental `node:sqlite` warnings, run it with `NODE_NO_WARNINGS=1`.
- PDF, video, batch, explicit cache, and automatic routing are deferred.

## Verified Locally

- `npm test` passes.
- `gemini-agent auth status` reads `GEMINI_API_KEY` from macOS Keychain.
- `gemini-agent ask "Reply with exactly: gemini-agent-ok"` returns `gemini-agent-ok`.
- `gemini-agent diff-review --stdin` returns structured JSON from Gemini.
- `node --test test/mcp.test.mjs` passes for stdio MCP transport.
- Codex MCP config can point at `gemini-agent-mcp` for the `gemini-agent` server.
