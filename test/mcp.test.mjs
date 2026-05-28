import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const fakeReview = JSON.stringify({
  verdict: "pass",
  top_risks: [],
  missing_tests: [],
  unsafe_claims: [],
  suggested_changes: [],
  notes: ["mcp fake ok"],
});

test("mcp server exposes auth and diff review tools", async () => {
  const transport = new StdioClientTransport({
    command: "node",
    args: [new URL("../bin/gemini-agent-mcp", import.meta.url).pathname],
    env: {
      ...process.env,
      GEMINI_API_KEY: "fake-key",
      GEMINI_AGENT_FAKE_RESPONSE: fakeReview,
      GEMINI_AGENT_ALLOW_FAKE_RESPONSE: "1",
    },
  });
  const client = new Client({ name: "gemini-agent-test", version: "0.1.0" });
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    assert.ok(names.includes("gemini_auth_status"));
    assert.ok(names.includes("gemini_diff_review"));

    const result = await client.callTool({
      name: "gemini_diff_review",
      arguments: { input: "diff --git a/a b/a\n+hello\n" },
    });
    const text = result.content[0].text;
    const parsed = JSON.parse(text);
    assert.equal(parsed.verdict, "pass");
    assert.deepEqual(parsed.notes, ["mcp fake ok"]);
  } finally {
    await client.close();
  }
});

test("mcp server rejects fake response without explicit allow flag", async () => {
  const transport = new StdioClientTransport({
    command: "node",
    args: [new URL("../bin/gemini-agent-mcp", import.meta.url).pathname],
    env: {
      ...process.env,
      GEMINI_API_KEY: "fake-key",
      GEMINI_AGENT_FAKE_RESPONSE: fakeReview,
      GEMINI_AGENT_ALLOW_FAKE_RESPONSE: "",
    },
  });
  const client = new Client({ name: "gemini-agent-test", version: "0.1.0" });
  await client.connect(transport);
  try {
    const result = await client.callTool({
      name: "gemini_diff_review",
      arguments: { input: "diff --git a/a b/a\n+hello\n" },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Fake Gemini responses require GEMINI_AGENT_ALLOW_FAKE_RESPONSE=1/);
  } finally {
    await client.close();
  }
});
