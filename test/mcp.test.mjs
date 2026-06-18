import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const fakeContextPack = JSON.stringify({
  kind: "context_pack",
  source_summary: ["mcp context ok"],
  project_facts: ["MCP can package context"],
  relevant_files: [{ path: "stdin", why_relevant: "provided input" }],
  open_questions: [],
  risks: [],
  recommended_codex_actions: ["continue with implementation"],
  limitations: ["selected input only"],
  metadata: {
    model: "gemini-3.5-flash",
    generated_at: "2026-05-28T00:00:00.000Z",
    sources: [],
    omitted_sources: [],
  },
});

const fakeArtifactReview = JSON.stringify({
  kind: "artifact_review",
  artifact_type: "image",
  summary: ["mcp artifact ok"],
  important_details: ["Artifact is readable"],
  design_or_research_findings: ["Layout is clear"],
  implementation_hints_for_codex: ["Keep existing styles"],
  risks_or_ambiguities: [],
  questions_for_user: [],
  limitations: ["Single image only"],
  metadata: {
    model: "gemini-3.5-flash",
    generated_at: "2026-05-28T00:00:00.000Z",
    sources: [],
    omitted_sources: [],
  },
});

const fakeDesignBrief = JSON.stringify({
  kind: "design_brief",
  run_id: "20260614T120000000Z-fakeid",
  goal: "Improve dashboard",
  target_user: "Operator",
  screens: [],
  visual_direction: ["quiet"],
  design_system: { tokens: [] },
  accessibility: [],
  responsive_requirements: [],
  acceptance_criteria: [],
  implementation_risks: [],
  metadata: {},
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

test("mcp server exposes design draft tool and latest design resource", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-mcp-design-"));
  const transport = new StdioClientTransport({
    command: "node",
    args: [new URL("../bin/gemini-agent-mcp", import.meta.url).pathname],
    cwd: dir,
    env: {
      ...process.env,
      GEMINI_API_KEY: "fake-key",
      GEMINI_AGENT_FAKE_RESPONSE: fakeDesignBrief,
      GEMINI_AGENT_ALLOW_FAKE_RESPONSE: "1",
    },
  });
  const client = new Client({ name: "gemini-agent-test", version: "0.1.0" });
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "gemini_design_draft"));
    const result = await client.callTool({
      name: "gemini_design_draft",
      arguments: {
        input: "Design a dashboard",
        cwd: dir,
        skip_generate: true,
        skip_prototype: true,
        skip_handoff: true,
      },
    });
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.status, "success");
    assert.match(parsed.run_dir, /\.gemini-agent\/design\//);
    assert.match(await readFile(join(parsed.run_dir, "draft-summary.json"), "utf8"), /design_draft_summary/);
    const resources = await client.listResources();
    assert.ok(resources.resources.some((resource) => resource.uri === "gemini-agent://design/latest"));
    const latest = await client.readResource({ uri: "gemini-agent://design/latest" });
    assert.match(latest.contents[0].text, /design_draft_summary/);
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("mcp design draft rejects symlink reference escapes before credentials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-mcp-design-"));
  const outside = await mkdtemp(join(tmpdir(), "gemini-agent-mcp-design-outside-"));
  await writeFile(join(outside, "secret.png"), "secret");
  await symlink(join(outside, "secret.png"), join(dir, "linked.png"));
  const transport = new StdioClientTransport({
    command: "node",
    args: [new URL("../bin/gemini-agent-mcp", import.meta.url).pathname],
    cwd: dir,
    env: { ...process.env, GEMINI_API_KEY: "" },
  });
  const client = new Client({ name: "gemini-agent-test", version: "0.1.0" });
  await client.connect(transport);
  try {
    const result = await client.callTool({
      name: "gemini_design_draft",
      arguments: {
        input: "Design with reference",
        cwd: dir,
        references: ["linked.png"],
        skip_generate: true,
        skip_prototype: true,
        skip_handoff: true,
      },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Reference path must stay inside cwd/);
    assert.doesNotMatch(result.content[0].text, /Gemini API key/);
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("mcp plan critique rejects oversized input before credentials", async () => {
  const transport = new StdioClientTransport({
    command: "node",
    args: [new URL("../bin/gemini-agent-mcp", import.meta.url).pathname],
    env: {
      ...process.env,
      GEMINI_API_KEY: "",
    },
  });
  const client = new Client({ name: "gemini-agent-test", version: "0.1.0" });
  await client.connect(transport);
  try {
    const result = await client.callTool({
      name: "gemini_plan_critique",
      arguments: { input: "123456", max_input_bytes: 5 },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /plan-critique input exceeds 5 bytes/);
    assert.doesNotMatch(result.content[0].text, /Gemini API key/);
  } finally {
    await client.close();
  }
});

test("mcp server exposes context pack tool and latest context resource", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-mcp-"));
  await mkdir(join(dir, ".gemini-agent", "context"), { recursive: true });
  await writeFile(join(dir, ".gemini-agent", "context", "latest.json"), `${fakeContextPack}\n`);

  const transport = new StdioClientTransport({
    command: "node",
    args: [new URL("../bin/gemini-agent-mcp", import.meta.url).pathname],
    cwd: dir,
    env: {
      ...process.env,
      GEMINI_API_KEY: "fake-key",
      GEMINI_AGENT_FAKE_RESPONSE: fakeContextPack,
      GEMINI_AGENT_ALLOW_FAKE_RESPONSE: "1",
    },
  });
  const client = new Client({ name: "gemini-agent-test", version: "0.1.0" });
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    assert.ok(names.includes("gemini_context_pack"));

    const result = await client.callTool({
      name: "gemini_context_pack",
      arguments: { input: "notes", cwd: dir },
    });
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.kind, "context_pack");
    assert.deepEqual(parsed.source_summary, ["mcp context ok"]);

    const resources = await client.listResources();
    const resourceUris = resources.resources.map((resource) => resource.uri);
    assert.ok(resourceUris.includes("gemini-agent://context/latest"));
    assert.ok(resourceUris.includes("gemini-agent://policy/current"));
    assert.ok(resourceUris.includes("gemini-agent://reviews/latest"));

    const resource = await client.readResource({ uri: "gemini-agent://context/latest" });
    assert.match(resource.contents[0].text, /mcp context ok/);
  } finally {
    await client.close();
  }
});

test("mcp context pack validates empty input before credentials", async () => {
  const transport = new StdioClientTransport({
    command: "node",
    args: [new URL("../bin/gemini-agent-mcp", import.meta.url).pathname],
    env: {
      ...process.env,
      GEMINI_API_KEY: "",
    },
  });
  const client = new Client({ name: "gemini-agent-test", version: "0.1.0" });
  await client.connect(transport);
  try {
    const result = await client.callTool({
      name: "gemini_context_pack",
      arguments: { input: "   \n" },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Context input is empty/);
    assert.doesNotMatch(result.content[0].text, /Gemini API key/);
  } finally {
    await client.close();
  }
});

test("mcp artifact review validates local artifact before credentials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-mcp-"));
  await writeFile(join(dir, "archive.zip"), "zip");

  const transport = new StdioClientTransport({
    command: "node",
    args: [new URL("../bin/gemini-agent-mcp", import.meta.url).pathname],
    cwd: dir,
    env: {
      ...process.env,
      GEMINI_API_KEY: "",
    },
  });
  const client = new Client({ name: "gemini-agent-test", version: "0.1.0" });
  await client.connect(transport);
  try {
    const result = await client.callTool({
      name: "gemini_artifact_review",
      arguments: { file: "archive.zip", cwd: dir },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Unsupported artifact type/);
    assert.doesNotMatch(result.content[0].text, /Gemini API key/);
  } finally {
    await client.close();
  }
});

test("mcp server exposes latest artifact review resource", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-mcp-"));
  await mkdir(join(dir, ".gemini-agent", "artifacts"), { recursive: true });
  await writeFile(join(dir, ".gemini-agent", "artifacts", "latest.json"), `${fakeArtifactReview}\n`);

  const transport = new StdioClientTransport({
    command: "node",
    args: [new URL("../bin/gemini-agent-mcp", import.meta.url).pathname],
    cwd: dir,
    env: {
      ...process.env,
      GEMINI_API_KEY: "fake-key",
      GEMINI_AGENT_FAKE_RESPONSE: fakeArtifactReview,
      GEMINI_AGENT_ALLOW_FAKE_RESPONSE: "1",
    },
  });
  const client = new Client({ name: "gemini-agent-test", version: "0.1.0" });
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    assert.ok(names.includes("gemini_artifact_review"));

    const resources = await client.listResources();
    assert.ok(resources.resources.some((resource) => resource.uri === "gemini-agent://artifact-reviews/latest"));

    const resource = await client.readResource({ uri: "gemini-agent://artifact-reviews/latest" });
    assert.match(resource.contents[0].text, /mcp artifact ok/);
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
