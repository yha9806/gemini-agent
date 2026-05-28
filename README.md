# gemini-agent

Global Gemini review gate for Codex.

## Commands

```bash
/Users/yhryzy/.codex/tools/gemini-agent/bin/gemini-agent auth status
/Users/yhryzy/.codex/tools/gemini-agent/bin/gemini-agent ask "Reply with exactly: gemini-agent-ok"
/Users/yhryzy/.codex/tools/gemini-agent/bin/gemini-agent diff-review --stdin
/Users/yhryzy/.codex/tools/gemini-agent/bin/gemini-agent context-pack --stdin
/Users/yhryzy/.codex/tools/gemini-agent/bin/gemini-agent artifact-review --file design.png --kind ui
# MCP stdio entrypoint for Codex/MCP clients, not a standalone shell command:
/Users/yhryzy/.codex/tools/gemini-agent/bin/gemini-agent-mcp
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
- PDF, video, batch, explicit cache, and automatic routing are deferred.

## Verified Locally

- `npm test` passes.
- `gemini-agent auth status` reads `GEMINI_API_KEY` from macOS Keychain.
- `gemini-agent ask "Reply with exactly: gemini-agent-ok"` returns `gemini-agent-ok`.
- `gemini-agent diff-review --stdin` returns structured JSON from Gemini.
- `node --test test/mcp.test.mjs` passes for stdio MCP transport.
- Codex MCP config can point at `gemini-agent-mcp` for the `gemini-agent` server.
