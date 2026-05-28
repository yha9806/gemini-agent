import { fstatSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolveApiKey } from "./keychain.mjs";
import { generateReview } from "./gemini-client.mjs";
import { loadProjectPolicy } from "./policies.mjs";
import { buildGatePrompt } from "./prompts.mjs";
import { reviewToPrettyJson } from "./schemas.mjs";

if (fstatSync(0).isCharacterDevice()) {
  console.error("gemini-agent MCP server requires an MCP stdio client; standalone mode is not implemented.");
  process.exit(1);
}

const server = new McpServer({
  name: "gemini-agent",
  version: "0.1.0",
});

function textContent(value) {
  return { content: [{ type: "text", text: value }] };
}

server.registerTool(
  "gemini_auth_status",
  {
    title: "Gemini Auth Status",
    description: "Report whether Gemini API credentials are configured without revealing the key.",
    inputSchema: {},
  },
  async () => {
    const result = await resolveApiKey();
    return textContent(`${JSON.stringify({ ok: result.ok, source: result.source }, null, 2)}\n`);
  },
);

async function runReviewTool(gate, input, cwd = process.cwd()) {
  if (!input || !input.trim()) throw new Error("Gate input is empty.");
  const key = await resolveApiKey();
  if (!key.ok) throw new Error("Gemini API key is not configured.");
  const policy = await loadProjectPolicy(cwd);
  const prompt = buildGatePrompt({ gate, input, policy });
  const review = await generateReview({
    apiKey: key.key,
    prompt,
    allowFakeResponse: process.env.GEMINI_AGENT_ALLOW_FAKE_RESPONSE === "1",
    env: process.env,
  });
  return textContent(reviewToPrettyJson(review));
}

for (const [name, gate, description] of [
  ["gemini_plan_critique", "plan_critique", "Critique an implementation plan before code is written."],
  ["gemini_patch_precheck", "patch_precheck", "Review intended patch scope before edits."],
  ["gemini_diff_review", "diff_review", "Review a git diff after edits and before commit."],
  ["gemini_research_brief", "research_brief", "Produce a concise sourced research brief."],
]) {
  server.registerTool(
    name,
    {
      title: name,
      description,
      inputSchema: {
        input: z.string().min(1),
        cwd: z.string().optional(),
      },
    },
    async ({ input, cwd }) => runReviewTool(gate, input, cwd),
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
