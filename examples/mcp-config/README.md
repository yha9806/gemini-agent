# MCP Config

Use this when connecting `gemini-agent` to Codex or another MCP client.

## Config Snippet

Replace `/absolute/path/to/gemini-agent` with your checked-out repository path:

```json
{
  "mcpServers": {
    "gemini-agent": {
      "command": "/absolute/path/to/gemini-agent/bin/gemini-agent-mcp"
    }
  }
}
```

## Useful Tools

- `gemini_auth_status`
- `gemini_context_pack`
- `gemini_plan_critique`
- `gemini_patch_precheck`
- `gemini_diff_review`
- `gemini_research_brief`
- `gemini_artifact_review`
- `gemini_design_draft`

## Useful Resources

- `gemini-agent://context/latest`
- `gemini-agent://reviews/latest`
- `gemini-agent://artifact-reviews/latest`
- `gemini-agent://design/latest`
- `gemini-agent://policy/current`

The MCP server exposes review and artifact workflows. It does not make Codex or
the host client edit, test, commit, or deploy automatically.
