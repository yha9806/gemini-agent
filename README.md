# gemini-agent

Global Gemini review gate for Codex.

## Commands

```bash
/Users/yhryzy/.codex/tools/gemini-agent/bin/gemini-agent auth status
/Users/yhryzy/.codex/tools/gemini-agent/bin/gemini-agent ask "Reply with exactly: gemini-agent-ok"
/Users/yhryzy/.codex/tools/gemini-agent/bin/gemini-agent diff-review --stdin
/Users/yhryzy/.codex/tools/gemini-agent/bin/gemini-agent-mcp
```

## Safety

- Credentials are read from `GEMINI_API_KEY` or macOS Keychain service `GEMINI_API_KEY`.
- `auth status` reports only availability and source; it never prints the key.
- Gate commands reject empty input before resolving credentials.
- Fake responses require explicit `GEMINI_AGENT_ALLOW_FAKE_RESPONSE=1`.
- Project policy is discovered from `.gemini-agent-policy.json`.

## Verified Locally

- `npm test` passes.
- `gemini-agent auth status` reads `GEMINI_API_KEY` from macOS Keychain.
- `gemini-agent ask "Reply with exactly: gemini-agent-ok"` returns `gemini-agent-ok`.
- `gemini-agent diff-review --stdin` returns structured JSON from Gemini.
- `node --test test/mcp.test.mjs` passes for stdio MCP transport.
- Codex MCP config contains `gemini_agent` and `gemini_docs`.
