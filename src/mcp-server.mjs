import { fstatSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runArtifactReview } from "./artifact-review.mjs";
import { readLatestArtifact } from "./artifact-store.mjs";
import { runContextPack } from "./context-pack.mjs";
import { resolveApiKey } from "./keychain.mjs";
import { generateReview } from "./gemini-client.mjs";
import {
  collectTextInput,
  detectArtifactMime,
  imagePartFromFile,
  resolveCwdFilePath,
} from "./input-collector.mjs";
import { loadProjectPolicy, renderPolicy } from "./policies.mjs";
import { buildGatePrompt } from "./prompts.mjs";
import {
  assertGateInputWithinLimit,
  defaultGateInputLimitBytes,
  gateInputMetadata,
  parseMaxInputBytes,
} from "./gate-input.mjs";
import { artifactReviewToPrettyJson, contextPackToPrettyJson, reviewToPrettyJson } from "./schemas.mjs";

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

function allowFakeResponse(env = process.env) {
  const allowed = env.GEMINI_AGENT_ALLOW_FAKE_RESPONSE === "1";
  if (env.GEMINI_AGENT_FAKE_RESPONSE && !allowed) {
    throw new Error("Fake Gemini responses require GEMINI_AGENT_ALLOW_FAKE_RESPONSE=1.");
  }
  return allowed;
}

async function requireApiKey() {
  const key = await resolveApiKey();
  if (!key.ok) throw new Error("Gemini API key is not configured.");
  return key.key;
}

function jsonResource(uri, value) {
  return {
    contents: [{
      uri,
      mimeType: "application/json",
      text: `${JSON.stringify(value, null, 2)}\n`,
    }],
  };
}

function textResource(uri, text) {
  return {
    contents: [{
      uri,
      mimeType: "text/plain",
      text: `${text.replace(/\s*$/, "")}\n`,
    }],
  };
}

function missingResource(category) {
  return {
    kind: "missing",
    message: `No latest ${category} artifact found.`,
  };
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

async function runReviewTool(gate, input, cwd = process.cwd(), maxInputBytes = null) {
  if (!input || !input.trim()) throw new Error("Gate input is empty.");
  const inputBytes = Buffer.byteLength(input, "utf8");
  const limitBytes = maxInputBytes ?? defaultGateInputLimitBytes(gate);
  assertGateInputWithinLimit({
    gate,
    inputBytes,
    limitBytes,
  });
  const fakeAllowed = allowFakeResponse();
  const apiKey = await requireApiKey();
  const policy = await loadProjectPolicy(cwd);
  const prompt = buildGatePrompt({ gate, input, policy });
  const review = await generateReview({
    apiKey,
    prompt,
    allowFakeResponse: fakeAllowed,
    env: process.env,
    telemetry: {
      cwd,
      source: "mcp",
      command: gate,
      metadata: gateInputMetadata({ gate, inputBytes, limitBytes }),
    },
  });
  return textContent(reviewToPrettyJson(review));
}

async function prevalidateArtifactInput(file, cwd = process.cwd()) {
  const resolvedFile = resolveCwdFilePath(file, { cwd });
  const mimeType = detectArtifactMime(file);

  if (mimeType === "application/pdf") {
    throw new Error("PDF artifact review requires Files API support.");
  }

  await imagePartFromFile(resolvedFile);
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
        max_input_bytes: z.number().int().positive().optional(),
      },
    },
    async ({ input, cwd, max_input_bytes }) => {
      const limit = max_input_bytes === undefined
        ? null
        : parseMaxInputBytes(String(max_input_bytes), "max_input_bytes");
      return runReviewTool(gate, input, cwd, limit);
    },
  );
}

server.registerTool(
  "gemini_context_pack",
  {
    title: "Gemini Context Pack",
    description: "Compress selected context into a structured pack for Codex.",
    inputSchema: {
      input: z.string().min(1),
      cwd: z.string().optional(),
      write_artifact: z.boolean().optional(),
    },
  },
  async ({ input, cwd, write_artifact }) => {
    const cwdValue = cwd || process.cwd();
    const collected = await collectTextInput({ stdinText: input, cwd: cwdValue });
    const fakeAllowed = allowFakeResponse();
    const apiKey = await requireApiKey();
    const pack = await runContextPack({
      apiKey,
      cwd: cwdValue,
      collected,
      env: process.env,
      allowFakeResponse: fakeAllowed,
      writeArtifact: Boolean(write_artifact),
      telemetry: { cwd: cwdValue, source: "mcp", command: "gemini_context_pack" },
    });
    return textContent(contextPackToPrettyJson(pack));
  },
);

server.registerTool(
  "gemini_artifact_review",
  {
    title: "Gemini Artifact Review",
    description: "Analyze an artifact and return a compact structured review.",
    inputSchema: {
      file: z.string().min(1),
      kind: z.string().optional(),
      cwd: z.string().optional(),
      write_artifact: z.boolean().optional(),
    },
  },
  async ({ file, kind, cwd, write_artifact }) => {
    const cwdValue = cwd || process.cwd();
    await prevalidateArtifactInput(file, cwdValue);
    const fakeAllowed = allowFakeResponse();
    const apiKey = await requireApiKey();
    const review = await runArtifactReview({
      apiKey,
      cwd: cwdValue,
      file,
      artifactKind: kind || "image",
      env: process.env,
      allowFakeResponse: fakeAllowed,
      writeArtifact: Boolean(write_artifact),
      telemetry: { cwd: cwdValue, source: "mcp", command: "gemini_artifact_review" },
    });
    return textContent(artifactReviewToPrettyJson(review));
  },
);

server.registerResource(
  "gemini_context_latest",
  "gemini-agent://context/latest",
  {
    title: "Latest Gemini Context Pack",
    description: "Latest local context pack generated by gemini-agent.",
    mimeType: "application/json",
  },
  async (uri) => {
    const artifact = await readLatestArtifact({ cwd: process.cwd(), category: "context" });
    return jsonResource(uri.href, artifact || missingResource("context"));
  },
);

server.registerResource(
  "gemini_artifact_review_latest",
  "gemini-agent://artifact-reviews/latest",
  {
    title: "Latest Gemini Artifact Review",
    description: "Latest local artifact review generated by gemini-agent.",
    mimeType: "application/json",
  },
  async (uri) => {
    const artifact = await readLatestArtifact({ cwd: process.cwd(), category: "artifacts" });
    return jsonResource(uri.href, artifact || missingResource("artifact review"));
  },
);

server.registerResource(
  "gemini_policy_current",
  "gemini-agent://policy/current",
  {
    title: "Current Gemini Agent Policy",
    description: "Current rendered local gemini-agent policy.",
    mimeType: "text/plain",
  },
  async (uri) => {
    const policy = await loadProjectPolicy(process.cwd());
    return textResource(uri.href, renderPolicy(policy));
  },
);

server.registerResource(
  "gemini_review_latest",
  "gemini-agent://reviews/latest",
  {
    title: "Latest Gemini Review",
    description: "Latest local review generated by gemini-agent.",
    mimeType: "application/json",
  },
  async (uri) => {
    const artifact = await readLatestArtifact({ cwd: process.cwd(), category: "reviews" });
    return jsonResource(uri.href, artifact || missingResource("review"));
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
