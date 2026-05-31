# Gemini Context Coprocessor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a v1 Gemini context coprocessor that can generate compact context packs and image-first artifact reviews for Codex while keeping Codex/Superpowers as the execution authority.

**Architecture:** Keep the existing CLI/MCP/review-gate architecture. Add focused modules for structured coprocessor schemas, input collection, local artifact storage, context-pack generation, and artifact-review generation. MCP resources read local generated artifacts without network calls.

**Tech Stack:** Node.js ESM, `node:test`, `@google/genai@2.6.0`, `@modelcontextprotocol/sdk@1.29.0`, `zod`.

---

## Verified Local SDK Facts

- `@google/genai@2.6.0` exports `GoogleGenAI`, `Type`, `createPartFromBase64`, `createPartFromText`, and `createPartFromUri` in this workspace.
- The installed TypeScript definitions expose `ai.files.upload`, `ai.files.get`, and `ai.files.delete`.
- `gemini-3.5-flash` is the project runtime model and has already passed the repository's live smoke test through `npm run test:live`.
- Existing `src/schemas.mjs` already imports `Type` from `@google/genai`; new Gemini schemas should use the existing import.

## Scope

This plan implements v1 from [the design spec](../specs/2026-05-28-gemini-context-coprocessor-design.md).

Included:

- `context-pack` CLI command.
- `artifact-review` CLI command with inline image support for PNG/JPEG/WEBP.
- PDF detection with a clear unsupported error until Files API behavior is implemented in a later task.
- Local artifact writes under `.gemini-agent/`.
- `.gemini-agent/` added to `.gitignore`.
- MCP tools for context-pack and artifact-review.
- MCP resources for latest local context/artifact/review/policy.
- TDD coverage for schemas, collectors, storage, CLI, MCP, and Gemini call contracts.

Deferred:

- Video.
- Batch API.
- Explicit context caching.
- Repository-wide indexing.
- Automatic router.
- Gemini file upload for PDFs.

## File Structure

- Modify `.gitignore`
  - Add `.gemini-agent/`.

- Modify `src/schemas.mjs`
  - Add `ContextPackZodSchema`, `ArtifactReviewZodSchema`.
  - Add Gemini JSON schemas for context pack and artifact review.
  - Add `normalizeContextPack`, `normalizeArtifactReview`, `contextPackToPrettyJson`, `artifactReviewToPrettyJson`.

- Modify `src/prompts.mjs`
  - Add `buildContextPackPrompt`.
  - Add `buildArtifactReviewPrompt`.
  - Keep `buildGatePrompt` unchanged for existing gates.

- Modify `src/gemini-client.mjs`
  - Add a generic `generateJson` helper for structured JSON calls.
  - Refactor `generateReview` to use `generateJson`.
  - Add `generateContextPack`.
  - Add `generateArtifactReview`.
  - Add optional `contents` support so artifact review can send multimodal parts.

- Create `src/artifact-store.mjs`
  - Own `.gemini-agent/` artifact paths.
  - Write timestamped JSON and atomically update `latest.json`.
  - Read latest artifacts for MCP resources.

- Create `src/input-collector.mjs`
  - Read text from stdin content, file paths, and current git diff.
  - Enforce text cap.
  - Detect image/PDF artifact file types with strict extension allowlist.
  - Build Gemini content parts for inline images with `createPartFromBase64`.

- Create `src/context-pack.mjs`
  - Orchestrate context-pack prompt, Gemini call, metadata attachment, artifact write.

- Create `src/artifact-review.mjs`
  - Orchestrate artifact-review prompt, image parts, Gemini call, metadata attachment, artifact write.

- Modify `src/cli.mjs`
  - Add `context-pack` and `artifact-review` commands.

- Modify `src/mcp-server.mjs`
  - Add `gemini_context_pack` and `gemini_artifact_review` tools.
  - Add resources for latest context pack, artifact review, review, and policy.

- Create `test/artifact-store.test.mjs`
  - Storage and atomic write tests.

- Create `test/input-collector.test.mjs`
  - Text and artifact input tests.

- Create `test/context-pack.test.mjs`
  - Context-pack core tests.

- Create `test/artifact-review.test.mjs`
  - Artifact-review core tests.

- Modify `test/prompts-and-schema.test.mjs`
  - New schema/prompt tests.

- Modify `test/gemini-client.test.mjs`
  - Structured JSON and multimodal request tests.

- Modify `test/cli.test.mjs`
  - New CLI command tests.

- Modify `test/mcp.test.mjs`
  - New MCP tool/resource tests.

- Modify `README.md`
  - Document new commands and v1 limitations.

---

### Task 1: Add Coprocessor Schemas And Prompts

**Files:**
- Modify: `src/schemas.mjs`
- Modify: `src/prompts.mjs`
- Modify: `test/prompts-and-schema.test.mjs`

- [ ] **Step 1: Write failing schema and prompt tests**

Add these imports to `test/prompts-and-schema.test.mjs`:

```js
import {
  normalizeArtifactReview,
  normalizeContextPack,
  contextPackToPrettyJson,
  artifactReviewToPrettyJson,
} from "../src/schemas.mjs";
import { buildArtifactReviewPrompt, buildContextPackPrompt } from "../src/prompts.mjs";
```

Add these tests:

```js
test("normalizes valid context pack JSON", () => {
  const pack = normalizeContextPack({
    kind: "context_pack",
    source_summary: ["CLI and MCP project"],
    project_facts: ["Runtime model is fixed"],
    relevant_files: [{ path: "src/cli.mjs", why_relevant: "CLI command routing" }],
    open_questions: [],
    risks: ["No artifact support yet"],
    recommended_codex_actions: ["Add tests first"],
    limitations: ["Only saw selected files"],
    metadata: {
      model: "gemini-3.5-flash",
      generated_at: "2026-05-28T12:00:00.000Z",
      sources: ["src/cli.mjs"],
    },
  });

  assert.equal(pack.kind, "context_pack");
  assert.equal(pack.relevant_files[0].path, "src/cli.mjs");
  assert.match(contextPackToPrettyJson(pack), /context_pack/);
});

test("normalizes valid artifact review JSON", () => {
  const review = normalizeArtifactReview({
    kind: "artifact_review",
    artifact_type: "image",
    summary: ["A dashboard screenshot"],
    important_details: ["Primary CTA is low contrast"],
    design_or_research_findings: ["Hierarchy needs work"],
    implementation_hints_for_codex: ["Use existing button component"],
    risks_or_ambiguities: ["Cannot inspect hover state"],
    questions_for_user: [],
    limitations: ["Single image only"],
    metadata: {
      model: "gemini-3.5-flash",
      generated_at: "2026-05-28T12:00:00.000Z",
      sources: ["design.png"],
    },
  });

  assert.equal(review.kind, "artifact_review");
  assert.equal(review.artifact_type, "image");
  assert.match(artifactReviewToPrettyJson(review), /artifact_review/);
});

test("builds context pack prompt with policy and source manifest", () => {
  const prompt = buildContextPackPrompt({
    input: "README says this is a Gemini review gate.",
    sources: ["README.md"],
    policy: { project: "gemini-agent", rules: ["Do not edit files from Gemini."] },
  });

  assert.match(prompt, /context pack/i);
  assert.match(prompt, /README\.md/);
  assert.match(prompt, /Do not edit files/);
  assert.match(prompt, /recommended_codex_actions/);
});

test("builds artifact review prompt with artifact kind and policy", () => {
  const prompt = buildArtifactReviewPrompt({
    artifactKind: "ui",
    sources: ["design.png"],
    policy: { project: "gemini-agent", rules: ["Keep Codex as execution authority."] },
  });

  assert.match(prompt, /artifact review/i);
  assert.match(prompt, /ui/);
  assert.match(prompt, /design\.png/);
  assert.match(prompt, /implementation_hints_for_codex/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
node --test test/prompts-and-schema.test.mjs
```

Expected: FAIL with missing exports for `normalizeContextPack`, `normalizeArtifactReview`, `buildContextPackPrompt`, and `buildArtifactReviewPrompt`.

- [ ] **Step 3: Implement schemas in `src/schemas.mjs`**

Add after `ReviewZodSchema`:

```js
export const ContextPackZodSchema = z.object({
  kind: z.literal("context_pack"),
  source_summary: z.array(z.string()).default([]),
  project_facts: z.array(z.string()).default([]),
  relevant_files: z.array(z.object({
    path: z.string(),
    why_relevant: z.string(),
  })).default([]),
  open_questions: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  recommended_codex_actions: z.array(z.string()).default([]),
  limitations: z.array(z.string()).default([]),
  metadata: z.object({
    model: z.string(),
    generated_at: z.string(),
    sources: z.array(z.string()).default([]),
    omitted_sources: z.array(z.string()).default([]),
  }).passthrough(),
});

export const ArtifactReviewZodSchema = z.object({
  kind: z.literal("artifact_review"),
  artifact_type: z.enum(["image", "pdf", "design", "diagram", "research"]),
  summary: z.array(z.string()).default([]),
  important_details: z.array(z.string()).default([]),
  design_or_research_findings: z.array(z.string()).default([]),
  implementation_hints_for_codex: z.array(z.string()).default([]),
  risks_or_ambiguities: z.array(z.string()).default([]),
  questions_for_user: z.array(z.string()).default([]),
  limitations: z.array(z.string()).default([]),
  metadata: z.object({
    model: z.string(),
    generated_at: z.string(),
    sources: z.array(z.string()).default([]),
    omitted_sources: z.array(z.string()).default([]),
  }).passthrough(),
});
```

Add Gemini schemas:

```js
export const GeminiContextPackSchema = {
  type: Type.OBJECT,
  properties: {
    kind: { type: Type.STRING, enum: ["context_pack"] },
    source_summary: { type: Type.ARRAY, items: { type: Type.STRING } },
    project_facts: { type: Type.ARRAY, items: { type: Type.STRING } },
    relevant_files: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          path: { type: Type.STRING },
          why_relevant: { type: Type.STRING },
        },
        required: ["path", "why_relevant"],
      },
    },
    open_questions: { type: Type.ARRAY, items: { type: Type.STRING } },
    risks: { type: Type.ARRAY, items: { type: Type.STRING } },
    recommended_codex_actions: { type: Type.ARRAY, items: { type: Type.STRING } },
    limitations: { type: Type.ARRAY, items: { type: Type.STRING } },
    metadata: {
      type: Type.OBJECT,
      properties: {
        model: { type: Type.STRING },
        generated_at: { type: Type.STRING },
        sources: { type: Type.ARRAY, items: { type: Type.STRING } },
        omitted_sources: { type: Type.ARRAY, items: { type: Type.STRING } },
      },
      required: ["model", "generated_at", "sources", "omitted_sources"],
    },
  },
  required: [
    "kind",
    "source_summary",
    "project_facts",
    "relevant_files",
    "open_questions",
    "risks",
    "recommended_codex_actions",
    "limitations",
    "metadata",
  ],
};

export const GeminiArtifactReviewSchema = {
  type: Type.OBJECT,
  properties: {
    kind: { type: Type.STRING, enum: ["artifact_review"] },
    artifact_type: { type: Type.STRING, enum: ["image", "pdf", "design", "diagram", "research"] },
    summary: { type: Type.ARRAY, items: { type: Type.STRING } },
    important_details: { type: Type.ARRAY, items: { type: Type.STRING } },
    design_or_research_findings: { type: Type.ARRAY, items: { type: Type.STRING } },
    implementation_hints_for_codex: { type: Type.ARRAY, items: { type: Type.STRING } },
    risks_or_ambiguities: { type: Type.ARRAY, items: { type: Type.STRING } },
    questions_for_user: { type: Type.ARRAY, items: { type: Type.STRING } },
    limitations: { type: Type.ARRAY, items: { type: Type.STRING } },
    metadata: {
      type: Type.OBJECT,
      properties: {
        model: { type: Type.STRING },
        generated_at: { type: Type.STRING },
        sources: { type: Type.ARRAY, items: { type: Type.STRING } },
        omitted_sources: { type: Type.ARRAY, items: { type: Type.STRING } },
      },
      required: ["model", "generated_at", "sources", "omitted_sources"],
    },
  },
  required: [
    "kind",
    "artifact_type",
    "summary",
    "important_details",
    "design_or_research_findings",
    "implementation_hints_for_codex",
    "risks_or_ambiguities",
    "questions_for_user",
    "limitations",
    "metadata",
  ],
};
```

Add normalizers near `normalizeReview`:

```js
export function normalizeContextPack(value) {
  const parsed = ContextPackZodSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Invalid context pack JSON: ${parsed.error.message}`);
  }
  return parsed.data;
}

export function normalizeArtifactReview(value) {
  const parsed = ArtifactReviewZodSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Invalid artifact review JSON: ${parsed.error.message}`);
  }
  return parsed.data;
}

export function contextPackToPrettyJson(pack) {
  return `${JSON.stringify(normalizeContextPack(pack), null, 2)}\n`;
}

export function artifactReviewToPrettyJson(review) {
  return `${JSON.stringify(normalizeArtifactReview(review), null, 2)}\n`;
}
```

- [ ] **Step 4: Implement prompts in `src/prompts.mjs`**

Add these exports after `buildGatePrompt`:

```js
function renderSourceList(sources = []) {
  return sources.length ? sources.map((source) => `- ${source}`).join("\n") : "- stdin";
}

export function buildContextPackPrompt({ input, sources = [], policy = null }) {
  if (!input || !input.trim()) throw new Error("Context input is empty.");
  return [
    "You are Gemini acting as a context compression coprocessor for Codex.",
    "",
    "Create a compact context pack. Codex will use this instead of reading all raw inputs.",
    "Preserve facts, risks, relevant files, open questions, and recommended next actions.",
    "Do not claim the context is complete or lossless.",
    "",
    "Project policy:",
    renderPolicy(policy),
    "",
    "Sources:",
    renderSourceList(sources),
    "",
    "Return only JSON with this exact shape:",
    JSON.stringify({
      kind: "context_pack",
      source_summary: ["string"],
      project_facts: ["string"],
      relevant_files: [{ path: "string", why_relevant: "string" }],
      open_questions: ["string"],
      risks: ["string"],
      recommended_codex_actions: ["string"],
      limitations: ["string"],
      metadata: {
        model: "string",
        generated_at: "ISO-8601 string",
        sources: ["string"],
        omitted_sources: ["string"],
      },
    }, null, 2),
    "",
    "Input:",
    input,
  ].join("\n");
}

export function buildArtifactReviewPrompt({ artifactKind = "image", sources = [], policy = null }) {
  return [
    "You are Gemini acting as a multimodal design and research coprocessor for Codex.",
    "",
    `Artifact kind: ${artifactKind}`,
    "Analyze the attached artifact and produce compact findings Codex can use.",
    "Focus on visual details, design or research implications, implementation hints, risks, ambiguities, and questions for the user.",
    "Do not invent details that are not visible or present in the artifact.",
    "",
    "Project policy:",
    renderPolicy(policy),
    "",
    "Sources:",
    renderSourceList(sources),
    "",
    "Return only JSON with this exact shape:",
    JSON.stringify({
      kind: "artifact_review",
      artifact_type: "image | pdf | design | diagram | research",
      summary: ["string"],
      important_details: ["string"],
      design_or_research_findings: ["string"],
      implementation_hints_for_codex: ["string"],
      risks_or_ambiguities: ["string"],
      questions_for_user: ["string"],
      limitations: ["string"],
      metadata: {
        model: "string",
        generated_at: "ISO-8601 string",
        sources: ["string"],
        omitted_sources: ["string"],
      },
    }, null, 2),
  ].join("\n");
}
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
node --test test/prompts-and-schema.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add src/schemas.mjs src/prompts.mjs test/prompts-and-schema.test.mjs
git commit -m "feat: add coprocessor schemas and prompts"
```

---

### Task 2: Add Generic Structured Gemini Calls

**Files:**
- Modify: `src/gemini-client.mjs`
- Modify: `test/gemini-client.test.mjs`

- [ ] **Step 1: Write failing tests for generic JSON generation**

Add imports in `test/gemini-client.test.mjs`:

```js
import {
  GeminiContextPackSchema,
  GeminiArtifactReviewSchema,
} from "../src/schemas.mjs";
```

Update the existing import from `src/gemini-client.mjs` to include:

```js
generateJson,
generateContextPack,
generateArtifactReview,
```

Add tests:

```js
test("generateJson sends structured JSON request and normalizes response", async () => {
  const result = await generateJson({
    apiKey: "fake-key",
    prompt: "compress this",
    responseSchema: GeminiContextPackSchema,
    normalize: (value) => ({ ok: value.kind }),
    makeAi: () => ({
      models: {
        async generateContent(request) {
          assert.equal(request.model, "gemini-3.5-flash");
          assert.equal(request.contents, "compress this");
          assert.equal(request.config.responseMimeType, "application/json");
          assert.equal(request.config.responseSchema, GeminiContextPackSchema);
          return { text: JSON.stringify({ kind: "context_pack" }) };
        },
      },
    }),
  });

  assert.deepEqual(result, { ok: "context_pack" });
});

test("generateContextPack uses fake response only when explicitly allowed", async () => {
  const fake = JSON.stringify({
    kind: "context_pack",
    source_summary: ["summary"],
    project_facts: [],
    relevant_files: [],
    open_questions: [],
    risks: [],
    recommended_codex_actions: [],
    limitations: [],
    metadata: {
      model: "gemini-3.5-flash",
      generated_at: "2026-05-28T12:00:00.000Z",
      sources: ["stdin"],
      omitted_sources: [],
    },
  });

  const pack = await generateContextPack({
    apiKey: "fake-key",
    prompt: "compress",
    env: { GEMINI_AGENT_FAKE_RESPONSE: fake },
    allowFakeResponse: true,
    makeAi: assert.fail,
  });

  assert.equal(pack.kind, "context_pack");
  assert.deepEqual(pack.source_summary, ["summary"]);
});

test("generateContextPack rejects incomplete structured JSON", async () => {
  await assert.rejects(
    () => generateContextPack({
      apiKey: "fake-key",
      prompt: "compress",
      makeAi: () => ({
        models: {
          async generateContent() {
            return { text: JSON.stringify({ kind: "context_pack" }) };
          },
        },
      }),
    }),
    /Invalid context pack JSON/,
  );
});

test("generateArtifactReview sends multimodal contents", async () => {
  const contents = [
    { inlineData: { mimeType: "image/png", data: "abc" } },
    { text: "review this artifact" },
  ];

  const review = await generateArtifactReview({
    apiKey: "fake-key",
    contents,
    makeAi: () => ({
      models: {
        async generateContent(request) {
          assert.equal(request.model, "gemini-3.5-flash");
          assert.deepEqual(request.contents, contents);
          assert.equal(request.config.responseMimeType, "application/json");
          assert.equal(request.config.responseSchema, GeminiArtifactReviewSchema);
          return {
            text: JSON.stringify({
              kind: "artifact_review",
              artifact_type: "image",
              summary: ["summary"],
              important_details: [],
              design_or_research_findings: [],
              implementation_hints_for_codex: [],
              risks_or_ambiguities: [],
              questions_for_user: [],
              limitations: [],
              metadata: {
                model: "gemini-3.5-flash",
                generated_at: "2026-05-28T12:00:00.000Z",
                sources: ["design.png"],
                omitted_sources: [],
              },
            }),
          };
        },
      },
    }),
  });

  assert.equal(review.kind, "artifact_review");
});

test("generateJson redacts API key from structured generation errors", async () => {
  const apiKey = "fake-secret-key";

  await assert.rejects(
    () => generateJson({
      apiKey,
      prompt: "compress",
      responseSchema: GeminiContextPackSchema,
      normalize: (value) => value,
      makeAi: () => ({
        models: {
          async generateContent() {
            throw new Error(`request failed for ${apiKey}`);
          },
        },
      }),
    }),
    (error) => {
      assert.match(error.message, /Gemini API request failed:/);
      assert.doesNotMatch(error.message, new RegExp(apiKey));
      assert.match(error.message, /\[REDACTED\]/);
      return true;
    },
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test test/gemini-client.test.mjs
```

Expected: FAIL with missing exports for `generateJson`, `generateContextPack`, or `generateArtifactReview`.

- [ ] **Step 3: Implement generic structured generation**

In `src/gemini-client.mjs`, update imports:

```js
import {
  GeminiArtifactReviewSchema,
  GeminiContextPackSchema,
  GeminiReviewSchema,
  normalizeArtifactReview,
  normalizeContextPack,
  normalizeReview,
  parseJsonObject,
} from "./schemas.mjs";
```

Add this helper before `generateReview`:

```js
function parseFakeJson(env, allowFakeResponse, normalize) {
  if (allowFakeResponse && env.GEMINI_AGENT_FAKE_RESPONSE) {
    return normalize(parseJsonObject(env.GEMINI_AGENT_FAKE_RESPONSE));
  }
  return null;
}

export async function generateJson({
  apiKey,
  prompt,
  contents = prompt,
  responseSchema,
  normalize,
  env = process.env,
  allowFakeResponse = false,
  model = getDefaultModel(),
  makeAi = makeGoogleGenAI,
  temperature = 0.2,
}) {
  if (!apiKey) throw new Error("Gemini API key is missing.");
  const hasPrompt = typeof prompt === "string" ? prompt.trim() : true;
  if (!hasPrompt) throw new Error("Prompt is empty.");

  const fake = parseFakeJson(env, allowFakeResponse, normalize);
  if (fake) return fake;

  let response;
  try {
    const ai = makeAi(apiKey);
    response = await ai.models.generateContent({
      model,
      contents,
      config: {
        temperature,
        responseMimeType: "application/json",
        responseSchema,
      },
    });
  } catch (error) {
    throw requestError(error, apiKey);
  }

  return normalize(parseJsonObject(response.text || ""));
}
```

Replace `generateReview` body with:

```js
export async function generateReview({
  apiKey,
  prompt,
  env = process.env,
  allowFakeResponse = false,
  model = getDefaultModel(),
  makeAi = makeGoogleGenAI,
  temperature = 0.2,
}) {
  return generateJson({
    apiKey,
    prompt,
    responseSchema: GeminiReviewSchema,
    normalize: normalizeReview,
    env,
    allowFakeResponse,
    model,
    makeAi,
    temperature,
  });
}
```

Add:

```js
export async function generateContextPack(options) {
  return generateJson({
    ...options,
    responseSchema: GeminiContextPackSchema,
    normalize: normalizeContextPack,
  });
}

export async function generateArtifactReview(options) {
  return generateJson({
    ...options,
    responseSchema: GeminiArtifactReviewSchema,
    normalize: normalizeArtifactReview,
  });
}
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
node --test test/gemini-client.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/gemini-client.mjs test/gemini-client.test.mjs
git commit -m "feat: add structured gemini generation helpers"
```

---

### Task 3: Add Local Artifact Store

**Files:**
- Modify: `.gitignore`
- Create: `src/artifact-store.mjs`
- Create: `test/artifact-store.test.mjs`

- [ ] **Step 1: Write failing artifact-store tests**

Create `test/artifact-store.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureArtifactGitignore,
  readLatestArtifact,
  writeJsonArtifact,
} from "../src/artifact-store.mjs";

test("writeJsonArtifact writes timestamped file and latest atomically", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-store-"));
  const now = new Date("2026-05-28T12:00:00.000Z");
  const artifact = { kind: "context_pack", value: 1 };

  const result = await writeJsonArtifact({
    cwd: dir,
    category: "context",
    artifact,
    now,
  });

  assert.match(result.latestPath, /\.gemini-agent\/context\/latest\.json$/);
  assert.match(result.timestampedPath, /2026-05-28T120000000Z-context\.json$/);

  const latest = JSON.parse(await readFile(result.latestPath, "utf8"));
  const timestamped = JSON.parse(await readFile(result.timestampedPath, "utf8"));
  assert.deepEqual(latest, artifact);
  assert.deepEqual(timestamped, artifact);
});

test("readLatestArtifact returns null when latest artifact is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-store-"));
  const artifact = await readLatestArtifact({ cwd: dir, category: "context" });
  assert.equal(artifact, null);
});

test("ensureArtifactGitignore appends gemini artifact directory once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-store-"));
  const gitignore = join(dir, ".gitignore");
  await writeFile(gitignore, "node_modules/\n");

  await ensureArtifactGitignore(dir);
  await ensureArtifactGitignore(dir);

  const content = await readFile(gitignore, "utf8");
  assert.match(content, /node_modules\/\n/);
  assert.equal(content.split(".gemini-agent/").length - 1, 1);
});

test("writeJsonArtifact surfaces filesystem errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-store-"));
  await writeFile(join(dir, ".gemini-agent"), "not a directory");

  await assert.rejects(
    () => writeJsonArtifact({
      cwd: dir,
      category: "context",
      artifact: { kind: "context_pack" },
    }),
    /ENOTDIR|EEXIST/,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test test/artifact-store.test.mjs
```

Expected: FAIL because `src/artifact-store.mjs` does not exist.

- [ ] **Step 3: Implement `.gitignore` change**

Append this line to `.gitignore`:

```gitignore
.gemini-agent/
```

- [ ] **Step 4: Implement `src/artifact-store.mjs`**

Create:

```js
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ARTIFACT_ROOT = ".gemini-agent";

function stamp(now = new Date()) {
  return now.toISOString().replace(/[-:]/g, "").replace(".", "");
}

export function artifactDirectory({ cwd = process.cwd(), category }) {
  return join(cwd, ARTIFACT_ROOT, category);
}

export async function ensureArtifactGitignore(cwd = process.cwd()) {
  const gitignorePath = join(cwd, ".gitignore");
  let content = "";
  try {
    content = await readFile(gitignorePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  if (content.split(/\r?\n/).includes(`${ARTIFACT_ROOT}/`)) return false;

  const prefix = content && !content.endsWith("\n") ? "\n" : "";
  await writeFile(gitignorePath, `${content}${prefix}${ARTIFACT_ROOT}/\n`);
  return true;
}

export async function writeJsonArtifact({ cwd = process.cwd(), category, artifact, now = new Date() }) {
  if (!category || !category.trim()) throw new Error("Artifact category is empty.");
  const dir = artifactDirectory({ cwd, category });
  await mkdir(dir, { recursive: true });

  const body = `${JSON.stringify(artifact, null, 2)}\n`;
  const timestampedPath = join(dir, `${stamp(now)}-${category}.json`);
  const latestPath = join(dir, "latest.json");
  const tmpPath = join(dir, `latest.json.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);

  await writeFile(timestampedPath, body);
  await writeFile(tmpPath, body);
  await rename(tmpPath, latestPath);

  return { latestPath, timestampedPath };
}

export async function readLatestArtifact({ cwd = process.cwd(), category }) {
  const latestPath = join(artifactDirectory({ cwd, category }), "latest.json");
  try {
    return JSON.parse(await readFile(latestPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
node --test test/artifact-store.test.mjs test/package.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add .gitignore src/artifact-store.mjs test/artifact-store.test.mjs
git commit -m "feat: add local artifact storage"
```

---

### Task 4: Add Text Input Collector

**Files:**
- Create: `src/input-collector.mjs`
- Create: `test/input-collector.test.mjs`

- [ ] **Step 1: Write failing tests for text and artifact collection**

Create `test/input-collector.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectTextInput,
  detectArtifactMime,
  imagePartFromFile,
} from "../src/input-collector.mjs";

test("collectTextInput combines stdin text and file content with source labels", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-input-"));
  const filePath = join(dir, "note.md");
  await writeFile(filePath, "file text");

  const result = await collectTextInput({
    stdinText: "stdin text",
    files: [filePath],
    maxTextBytes: 1024,
  });

  assert.match(result.input, /Source: stdin/);
  assert.match(result.input, /stdin text/);
  assert.match(result.input, /Source: .*note\.md/);
  assert.match(result.input, /file text/);
  assert.deepEqual(result.sources, ["stdin", filePath]);
  assert.deepEqual(result.omittedSources, []);
});

test("collectTextInput rejects empty input", async () => {
  await assert.rejects(
    () => collectTextInput({ stdinText: "   ", files: [] }),
    /Context input is empty/,
  );
});

test("collectTextInput enforces text byte cap before Gemini calls", async () => {
  await assert.rejects(
    () => collectTextInput({ stdinText: "abcdef", files: [], maxTextBytes: 3 }),
    /Context input exceeds 3 bytes/,
  );
});

test("detectArtifactMime accepts supported image extensions case-insensitively", () => {
  assert.equal(detectArtifactMime("design.PNG"), "image/png");
  assert.equal(detectArtifactMime("photo.jpeg"), "image/jpeg");
  assert.equal(detectArtifactMime("mock.webp"), "image/webp");
  assert.equal(detectArtifactMime("paper.pdf"), "application/pdf");
});

test("detectArtifactMime rejects unsupported or extensionless files", () => {
  assert.throws(() => detectArtifactMime("archive.zip"), /Unsupported artifact file type/);
  assert.throws(() => detectArtifactMime("README"), /Unsupported artifact file type/);
});

test("imagePartFromFile returns inline base64 image part", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-input-"));
  const imagePath = join(dir, "design.png");
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  await writeFile(imagePath, pngBytes);

  const part = await imagePartFromFile(imagePath, { maxImageBytes: 1024 });

  assert.equal(part.inlineData.mimeType, "image/png");
  assert.equal(part.inlineData.data, pngBytes.toString("base64"));
});

test("imagePartFromFile rejects files whose bytes do not match the extension", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-input-"));
  const imagePath = join(dir, "design.png");
  await writeFile(imagePath, Buffer.from("not a png"));

  await assert.rejects(
    () => imagePartFromFile(imagePath, { maxImageBytes: 1024 }),
    /does not match image\/png/,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test test/input-collector.test.mjs
```

Expected: FAIL because `src/input-collector.mjs` does not exist.

- [ ] **Step 3: Implement `src/input-collector.mjs`**

Create:

```js
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { promisify } from "node:util";
import { createPartFromBase64 } from "@google/genai";

const execFileAsync = promisify(execFile);
export const DEFAULT_TEXT_LIMIT_BYTES = 4 * 1024 * 1024;
export const DEFAULT_IMAGE_LIMIT_BYTES = 20 * 1024 * 1024;

const MIME_BY_EXTENSION = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".pdf", "application/pdf"],
]);

function section(source, text) {
  return [`--- Source: ${source} ---`, text].join("\n");
}

export async function currentGitDiff({ cwd = process.cwd(), runner = execFileAsync } = {}) {
  const { stdout } = await runner("git", ["diff", "--no-ext-diff"], { cwd, encoding: "utf8" });
  return stdout;
}

export async function collectTextInput({
  stdinText = "",
  files = [],
  diff = false,
  cwd = process.cwd(),
  maxTextBytes = DEFAULT_TEXT_LIMIT_BYTES,
  runner = execFileAsync,
} = {}) {
  const chunks = [];
  const sources = [];
  const omittedSources = [];

  if (stdinText && stdinText.trim()) {
    chunks.push(section("stdin", stdinText));
    sources.push("stdin");
  }

  for (const file of files) {
    const text = await readFile(file, "utf8");
    if (text.trim()) {
      chunks.push(section(file, text));
      sources.push(file);
    }
  }

  if (diff) {
    const text = await currentGitDiff({ cwd, runner });
    if (text.trim()) {
      chunks.push(section("git diff", text));
      sources.push("git diff");
    }
  }

  const input = chunks.join("\n\n").trim();
  if (!input) throw new Error("Context input is empty.");
  const size = Buffer.byteLength(input, "utf8");
  if (size > maxTextBytes) {
    throw new Error(`Context input exceeds ${maxTextBytes} bytes.`);
  }

  return { input, sources, omittedSources, sizeBytes: size };
}

export function detectArtifactMime(path) {
  const mime = MIME_BY_EXTENSION.get(extname(path).toLowerCase());
  if (!mime) throw new Error(`Unsupported artifact file type: ${path}`);
  return mime;
}

function bytesMatchMime(buffer, mimeType) {
  if (mimeType === "image/png") {
    return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (mimeType === "image/jpeg") {
    return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (mimeType === "image/webp") {
    return buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP";
  }
  if (mimeType === "application/pdf") {
    return buffer.subarray(0, 5).toString("ascii") === "%PDF-";
  }
  return false;
}

export async function imagePartFromFile(path, { maxImageBytes = DEFAULT_IMAGE_LIMIT_BYTES } = {}) {
  const mimeType = detectArtifactMime(path);
  if (!mimeType.startsWith("image/")) throw new Error(`Artifact is not an inline image: ${path}`);
  const info = await stat(path);
  if (info.size > maxImageBytes) {
    throw new Error(`Image artifact exceeds ${maxImageBytes} bytes: ${path}`);
  }
  const buffer = await readFile(path);
  if (!bytesMatchMime(buffer, mimeType)) {
    throw new Error(`Artifact bytes do not match ${mimeType}: ${path}`);
  }
  const data = buffer.toString("base64");
  return createPartFromBase64(data, mimeType);
}
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
node --test test/input-collector.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/input-collector.mjs test/input-collector.test.mjs
git commit -m "feat: add coprocessor input collection"
```

---

### Task 5: Add Context-Pack Core Workflow

**Files:**
- Create: `src/context-pack.mjs`
- Create: `test/context-pack.test.mjs`

- [ ] **Step 1: Write failing core context-pack tests**

Create `test/context-pack.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runContextPack } from "../src/context-pack.mjs";

const fakePack = {
  kind: "context_pack",
  source_summary: ["summary"],
  project_facts: ["fact"],
  relevant_files: [{ path: "stdin", why_relevant: "provided input" }],
  open_questions: [],
  risks: [],
  recommended_codex_actions: ["write tests"],
  limitations: ["selected input only"],
  metadata: {
    model: "gemini-3.5-flash",
    generated_at: "2000-01-01T00:00:00.000Z",
    sources: [],
    omitted_sources: [],
  },
};

test("runContextPack builds prompt, calls Gemini, attaches metadata, and writes artifact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-context-"));
  let seenPrompt = "";

  const pack = await runContextPack({
    apiKey: "fake-key",
    cwd: dir,
    stdinText: "project notes",
    now: new Date("2026-05-28T12:00:00.000Z"),
    generate: async ({ prompt }) => {
      seenPrompt = prompt;
      return fakePack;
    },
    writeArtifact: true,
  });

  assert.match(seenPrompt, /project notes/);
  assert.equal(pack.metadata.model, "gemini-3.5-flash");
  assert.equal(pack.metadata.generated_at, "2026-05-28T12:00:00.000Z");
  assert.deepEqual(pack.metadata.sources, ["stdin"]);

  const latest = JSON.parse(await readFile(join(dir, ".gemini-agent/context/latest.json"), "utf8"));
  assert.equal(latest.kind, "context_pack");
});

test("runContextPack rejects empty input before generate is called", async () => {
  await assert.rejects(
    () => runContextPack({
      apiKey: "fake-key",
      stdinText: " ",
      generate: assert.fail,
    }),
    /Context input is empty/,
  );
});

test("runContextPack rejects missing files before generate is called", async () => {
  await assert.rejects(
    () => runContextPack({
      apiKey: "fake-key",
      files: ["/path/that/does/not/exist.md"],
      generate: assert.fail,
    }),
    /ENOENT/,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test test/context-pack.test.mjs
```

Expected: FAIL because `src/context-pack.mjs` does not exist.

- [ ] **Step 3: Implement `src/context-pack.mjs`**

Create:

```js
import { getDefaultModel, generateContextPack } from "./gemini-client.mjs";
import { writeJsonArtifact } from "./artifact-store.mjs";
import { collectTextInput } from "./input-collector.mjs";
import { loadProjectPolicy } from "./policies.mjs";
import { buildContextPackPrompt } from "./prompts.mjs";
import { normalizeContextPack } from "./schemas.mjs";

export async function runContextPack({
  apiKey,
  cwd = process.cwd(),
  stdinText = "",
  files = [],
  diff = false,
  collected = null,
  env = process.env,
  allowFakeResponse = false,
  now = new Date(),
  writeArtifact = false,
  generate = generateContextPack,
} = {}) {
  const context = collected || await collectTextInput({ stdinText, files, diff, cwd });
  const policy = await loadProjectPolicy(cwd);
  const prompt = buildContextPackPrompt({
    input: context.input,
    sources: context.sources,
    policy,
  });

  const generated = await generate({
    apiKey,
    prompt,
    env,
    allowFakeResponse,
  });

  const pack = normalizeContextPack({
    ...generated,
    metadata: {
      ...generated.metadata,
      model: getDefaultModel(),
      generated_at: now.toISOString(),
      sources: context.sources,
      omitted_sources: context.omittedSources,
    },
  });

  if (writeArtifact) {
    await writeJsonArtifact({ cwd, category: "context", artifact: pack, now });
  }

  return pack;
}
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
node --test test/context-pack.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/context-pack.mjs test/context-pack.test.mjs
git commit -m "feat: add context pack workflow"
```

---

### Task 6: Add Context-Pack CLI Command

**Files:**
- Modify: `src/cli.mjs`
- Modify: `test/cli.test.mjs`

- [ ] **Step 1: Write failing CLI tests**

In `test/cli.test.mjs`, add:

```js
const fakeContextPack = JSON.stringify({
  kind: "context_pack",
  source_summary: ["cli summary"],
  project_facts: [],
  relevant_files: [],
  open_questions: [],
  risks: [],
  recommended_codex_actions: ["next action"],
  limitations: [],
  metadata: {
    model: "gemini-3.5-flash",
    generated_at: "2026-05-28T12:00:00.000Z",
    sources: ["stdin"],
    omitted_sources: [],
  },
});

test("context-pack accepts stdin and prints JSON", async () => {
  const { stdout } = await execFileAsync(bin, ["context-pack", "--stdin"], {
    input: "project notes",
    env: {
      ...process.env,
      GEMINI_API_KEY: "fake-key",
      GEMINI_AGENT_ALLOW_FAKE_RESPONSE: "1",
      GEMINI_AGENT_FAKE_RESPONSE: fakeContextPack,
    },
  });

  const parsed = JSON.parse(stdout);
  assert.equal(parsed.kind, "context_pack");
  assert.deepEqual(parsed.source_summary, ["cli summary"]);
  assert.deepEqual(parsed.metadata.sources, ["stdin"]);
});

test("context-pack rejects empty input before auth lookup", async () => {
  await assert.rejects(
    execFileAsync(bin, ["context-pack", "--stdin"], {
      input: " ",
      env: { PATH: process.env.PATH },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Context input is empty/);
      assert.doesNotMatch(error.stderr, /Gemini API key/);
      return true;
    },
  );
});

test("context-pack rejects missing file before auth lookup", async () => {
  await assert.rejects(
    execFileAsync(bin, ["context-pack", "--file", "/path/that/does/not/exist.md"], {
      env: { PATH: process.env.PATH },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /ENOENT/);
      assert.doesNotMatch(error.stderr, /Gemini API key/);
      return true;
    },
  );
});
```

- [ ] **Step 2: Run CLI tests to verify failure**

Run:

```bash
node --test test/cli.test.mjs
```

Expected: FAIL with `Unknown command: context-pack`.

- [ ] **Step 3: Implement CLI parsing**

In `src/cli.mjs`, import:

```js
import { runContextPack } from "./context-pack.mjs";
import { collectTextInput } from "./input-collector.mjs";
import { contextPackToPrettyJson } from "./schemas.mjs";
```

Add to usage:

```js
"  gemini-agent context-pack (--file <path>... | --stdin | --diff | <text>)",
```

Add helper:

```js
function parseCommonInputArgs(args) {
  const files = [];
  const passthrough = [];
  let useStdin = false;
  let diff = false;
  let writeArtifact = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--file") {
      const path = args[++i];
      if (!path) throw new Error("--file requires a path.");
      files.push(path);
    } else if (arg === "--stdin") {
      useStdin = true;
    } else if (arg === "--diff") {
      diff = true;
    } else if (arg === "--write-artifact") {
      writeArtifact = true;
    } else {
      passthrough.push(arg);
    }
  }

  return { files, useStdin, diff, writeArtifact, text: passthrough.join(" ").trim() };
}
```

Add command handler before gate commands:

```js
if (command === "context-pack") {
  const parsed = parseCommonInputArgs(args);
  const stdinText = parsed.useStdin ? await readStdin() : parsed.text;
  const collected = await collectTextInput({
    stdinText,
    files: parsed.files,
    diff: parsed.diff,
    cwd: process.cwd(),
  });
  const key = await resolveApiKey();
  if (!key.ok) throw new Error("Gemini API key is not configured. Run: gemini-agent auth set");
  const pack = await runContextPack({
    apiKey: key.key,
    cwd: process.cwd(),
    collected,
    env: process.env,
    allowFakeResponse: allowFakeResponse(process.env),
    writeArtifact: parsed.writeArtifact,
  });
  output.write(contextPackToPrettyJson(pack));
  return;
}
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
node --test test/cli.test.mjs test/context-pack.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/cli.mjs test/cli.test.mjs
git commit -m "feat: add context pack cli"
```

---

### Task 7: Add Image-First Artifact Review Core

**Files:**
- Create: `src/artifact-review.mjs`
- Create: `test/artifact-review.test.mjs`

- [ ] **Step 1: Write failing artifact-review tests**

Create `test/artifact-review.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runArtifactReview } from "../src/artifact-review.mjs";

const fakeReview = {
  kind: "artifact_review",
  artifact_type: "image",
  summary: ["summary"],
  important_details: ["detail"],
  design_or_research_findings: [],
  implementation_hints_for_codex: ["hint"],
  risks_or_ambiguities: [],
  questions_for_user: [],
  limitations: ["single artifact"],
  metadata: {
    model: "gemini-3.5-flash",
    generated_at: "2000-01-01T00:00:00.000Z",
    sources: [],
    omitted_sources: [],
  },
};

test("runArtifactReview sends image part and prompt part", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-artifact-"));
  const imagePath = join(dir, "design.png");
  await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

  let seenContents;
  const review = await runArtifactReview({
    apiKey: "fake-key",
    cwd: dir,
    file: imagePath,
    artifactKind: "ui",
    now: new Date("2026-05-28T12:00:00.000Z"),
    generate: async ({ contents }) => {
      seenContents = contents;
      return fakeReview;
    },
    writeArtifact: true,
  });

  assert.equal(seenContents.length, 2);
  assert.equal(seenContents[0].inlineData.mimeType, "image/png");
  assert.match(seenContents[1].text, /artifact review/i);
  assert.equal(review.kind, "artifact_review");
  assert.deepEqual(review.metadata.sources, [imagePath]);

  const latest = JSON.parse(await readFile(join(dir, ".gemini-agent/artifacts/latest.json"), "utf8"));
  assert.equal(latest.kind, "artifact_review");
});

test("runArtifactReview rejects PDF with explicit unsupported runtime error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-artifact-"));
  const pdfPath = join(dir, "paper.pdf");
  await writeFile(pdfPath, Buffer.from("%PDF-1.7"));

  await assert.rejects(
    () => runArtifactReview({
      apiKey: "fake-key",
      cwd: dir,
      file: pdfPath,
      generate: assert.fail,
    }),
    /PDF artifact review requires Files API support/,
  );
});

test("runArtifactReview rejects missing image files before generate is called", async () => {
  await assert.rejects(
    () => runArtifactReview({
      apiKey: "fake-key",
      file: "/path/that/does/not/exist.png",
      generate: assert.fail,
    }),
    /ENOENT/,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test test/artifact-review.test.mjs
```

Expected: FAIL because `src/artifact-review.mjs` does not exist.

- [ ] **Step 3: Implement `src/artifact-review.mjs`**

Create:

```js
import { createPartFromText } from "@google/genai";
import { getDefaultModel, generateArtifactReview } from "./gemini-client.mjs";
import { writeJsonArtifact } from "./artifact-store.mjs";
import { detectArtifactMime, imagePartFromFile } from "./input-collector.mjs";
import { loadProjectPolicy } from "./policies.mjs";
import { buildArtifactReviewPrompt } from "./prompts.mjs";
import { normalizeArtifactReview } from "./schemas.mjs";

function artifactTypeFromKind(artifactKind, mimeType) {
  if (artifactKind === "ui" || artifactKind === "design") return "design";
  if (artifactKind === "architecture") return "diagram";
  if (artifactKind === "research") return "research";
  if (mimeType === "application/pdf") return "pdf";
  return "image";
}

export async function runArtifactReview({
  apiKey,
  cwd = process.cwd(),
  file,
  artifactKind = "image",
  env = process.env,
  allowFakeResponse = false,
  now = new Date(),
  writeArtifact = false,
  generate = generateArtifactReview,
} = {}) {
  if (!file) throw new Error("--file requires a path.");
  const mimeType = detectArtifactMime(file);
  if (mimeType === "application/pdf") {
    throw new Error("PDF artifact review requires Files API support and is not enabled in this runtime.");
  }

  const policy = await loadProjectPolicy(cwd);
  const prompt = buildArtifactReviewPrompt({
    artifactKind,
    sources: [file],
    policy,
  });
  const contents = [
    await imagePartFromFile(file),
    createPartFromText(prompt),
  ];

  const generated = await generate({
    apiKey,
    prompt,
    contents,
    env,
    allowFakeResponse,
  });

  const review = normalizeArtifactReview({
    ...generated,
    artifact_type: artifactTypeFromKind(artifactKind, mimeType),
    metadata: {
      ...generated.metadata,
      model: getDefaultModel(),
      generated_at: now.toISOString(),
      sources: [file],
      omitted_sources: [],
    },
  });

  if (writeArtifact) {
    await writeJsonArtifact({ cwd, category: "artifacts", artifact: review, now });
  }

  return review;
}
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
node --test test/artifact-review.test.mjs test/input-collector.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/artifact-review.mjs test/artifact-review.test.mjs
git commit -m "feat: add image artifact review workflow"
```

---

### Task 8: Add Artifact-Review CLI Command

**Files:**
- Modify: `src/cli.mjs`
- Modify: `test/cli.test.mjs`

- [ ] **Step 1: Write failing CLI tests**

In `test/cli.test.mjs`, add:

```js
const fakeArtifactReview = JSON.stringify({
  kind: "artifact_review",
  artifact_type: "image",
  summary: ["artifact summary"],
  important_details: [],
  design_or_research_findings: [],
  implementation_hints_for_codex: ["implementation hint"],
  risks_or_ambiguities: [],
  questions_for_user: [],
  limitations: [],
  metadata: {
    model: "gemini-3.5-flash",
    generated_at: "2026-05-28T12:00:00.000Z",
    sources: ["design.png"],
    omitted_sources: [],
  },
});

test("artifact-review accepts image file and prints JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));
  const imagePath = join(dir, "design.png");
  await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

  const { stdout } = await execFileAsync(bin, ["artifact-review", "--file", imagePath, "--kind", "ui"], {
    cwd: dir,
    env: {
      ...process.env,
      GEMINI_API_KEY: "fake-key",
      GEMINI_AGENT_ALLOW_FAKE_RESPONSE: "1",
      GEMINI_AGENT_FAKE_RESPONSE: fakeArtifactReview,
    },
  });

  const parsed = JSON.parse(stdout);
  assert.equal(parsed.kind, "artifact_review");
  assert.equal(parsed.artifact_type, "design");
  assert.deepEqual(parsed.summary, ["artifact summary"]);
});

test("artifact-review rejects unsupported artifact before auth lookup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));
  const filePath = join(dir, "archive.zip");
  await writeFile(filePath, "zip");

  await assert.rejects(
    execFileAsync(bin, ["artifact-review", "--file", filePath], {
      cwd: dir,
      env: { PATH: process.env.PATH },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Unsupported artifact file type/);
      assert.doesNotMatch(error.stderr, /Gemini API key/);
      return true;
    },
  );
});

test("artifact-review rejects missing image file before auth lookup", async () => {
  await assert.rejects(
    execFileAsync(bin, ["artifact-review", "--file", "/path/that/does/not/exist.png"], {
      env: { PATH: process.env.PATH },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /ENOENT/);
      assert.doesNotMatch(error.stderr, /Gemini API key/);
      return true;
    },
  );
});
```

- [ ] **Step 2: Run CLI tests to verify failure**

Run:

```bash
node --test test/cli.test.mjs
```

Expected: FAIL with `Unknown command: artifact-review`.

- [ ] **Step 3: Implement CLI command**

In `src/cli.mjs`, import:

```js
import { runArtifactReview } from "./artifact-review.mjs";
import { detectArtifactMime, imagePartFromFile } from "./input-collector.mjs";
import { artifactReviewToPrettyJson } from "./schemas.mjs";
```

Add to usage:

```js
"  gemini-agent artifact-review --file <path> [--kind image|ui|design|architecture|research]",
```

Add helper:

```js
function parseArtifactArgs(args) {
  let file = null;
  let artifactKind = "image";
  let writeArtifact = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--file") {
      file = args[++i];
      if (!file) throw new Error("--file requires a path.");
    } else if (arg === "--kind") {
      artifactKind = args[++i] || "image";
    } else if (arg === "--write-artifact") {
      writeArtifact = true;
    } else {
      throw new Error(`Unknown artifact-review argument: ${arg}`);
    }
  }

  return { file, artifactKind, writeArtifact };
}
```

Add command handler before gate commands:

```js
if (command === "artifact-review") {
  const parsed = parseArtifactArgs(args);
  if (!parsed.file) throw new Error("--file requires a path.");
  const mimeType = detectArtifactMime(parsed.file);
  if (mimeType === "application/pdf") {
    throw new Error("PDF artifact review requires Files API support and is not enabled in this runtime.");
  }
  await imagePartFromFile(parsed.file);
  const key = await resolveApiKey();
  if (!key.ok) throw new Error("Gemini API key is not configured. Run: gemini-agent auth set");
  const review = await runArtifactReview({
    apiKey: key.key,
    cwd: process.cwd(),
    file: parsed.file,
    artifactKind: parsed.artifactKind,
    env: process.env,
    allowFakeResponse: allowFakeResponse(process.env),
    writeArtifact: parsed.writeArtifact,
  });
  output.write(artifactReviewToPrettyJson(review));
  return;
}
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
node --test test/cli.test.mjs test/artifact-review.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/cli.mjs test/cli.test.mjs
git commit -m "feat: add artifact review cli"
```

---

### Task 9: Add MCP Tools And Resources

**Files:**
- Modify: `src/mcp-server.mjs`
- Modify: `test/mcp.test.mjs`

- [ ] **Step 1: Write failing MCP tests**

In `test/mcp.test.mjs`, import temp helpers:

```js
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
```

Add fake context pack:

```js
const fakeContextPack = JSON.stringify({
  kind: "context_pack",
  source_summary: ["mcp context ok"],
  project_facts: [],
  relevant_files: [],
  open_questions: [],
  risks: [],
  recommended_codex_actions: [],
  limitations: [],
  metadata: {
    model: "gemini-3.5-flash",
    generated_at: "2026-05-28T12:00:00.000Z",
    sources: ["input"],
    omitted_sources: [],
  },
});
```

Add test:

```js
test("mcp server exposes context pack tool and latest context resource", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-mcp-"));
  await mkdir(join(dir, ".gemini-agent/context"), { recursive: true });
  await writeFile(join(dir, ".gemini-agent/context/latest.json"), `${fakeContextPack}\n`);

  const transport = new StdioClientTransport({
    command: "node",
    args: [new URL("../bin/gemini-agent-mcp", import.meta.url).pathname],
    env: {
      ...process.env,
      GEMINI_API_KEY: "fake-key",
      GEMINI_AGENT_FAKE_RESPONSE: fakeContextPack,
      GEMINI_AGENT_ALLOW_FAKE_RESPONSE: "1",
    },
    cwd: dir,
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
    assert.ok(resources.resources.some((resource) => resource.uri === "gemini-agent://context/latest"));

    const resource = await client.readResource({ uri: "gemini-agent://context/latest" });
    assert.match(resource.contents[0].text, /mcp context ok/);
  } finally {
    await client.close();
  }
});
```

- [ ] **Step 2: Run MCP tests to verify failure**

Run:

```bash
node --test test/mcp.test.mjs
```

Expected: FAIL because `gemini_context_pack` and resource registration do not exist.

- [ ] **Step 3: Implement MCP tools and resources**

In `src/mcp-server.mjs`, import:

```js
import { runContextPack } from "./context-pack.mjs";
import { runArtifactReview } from "./artifact-review.mjs";
import { readLatestArtifact } from "./artifact-store.mjs";
import { contextPackToPrettyJson, artifactReviewToPrettyJson } from "./schemas.mjs";
```

Add:

```js
function jsonResource(uri, value) {
  return {
    contents: [{
      uri,
      mimeType: "application/json",
      text: `${JSON.stringify(value, null, 2)}\n`,
    }],
  };
}

async function requireApiKey() {
  const key = await resolveApiKey();
  if (!key.ok) throw new Error("Gemini API key is not configured.");
  return key.key;
}
```

Register tool:

```js
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
    const apiKey = await requireApiKey();
    const pack = await runContextPack({
      apiKey,
      cwd: cwd || process.cwd(),
      stdinText: input,
      env: process.env,
      allowFakeResponse: process.env.GEMINI_AGENT_ALLOW_FAKE_RESPONSE === "1",
      writeArtifact: Boolean(write_artifact),
    });
    return textContent(contextPackToPrettyJson(pack));
  },
);
```

Register resource:

```js
server.registerResource(
  "gemini_context_latest",
  "gemini-agent://context/latest",
  {
    title: "Latest Gemini Context Pack",
    description: "Latest local context pack generated by gemini-agent.",
    mimeType: "application/json",
  },
  async (uri) => {
    const value = await readLatestArtifact({ cwd: process.cwd(), category: "context" });
    return jsonResource(uri.href, value || { kind: "missing", message: "No latest context pack found." });
  },
);
```

Add artifact tool/resource using the same pattern:

```js
server.registerTool(
  "gemini_artifact_review",
  {
    title: "Gemini Artifact Review",
    description: "Analyze an image artifact and return a compact structured review.",
    inputSchema: {
      file: z.string().min(1),
      kind: z.string().optional(),
      cwd: z.string().optional(),
      write_artifact: z.boolean().optional(),
    },
  },
  async ({ file, kind, cwd, write_artifact }) => {
    const apiKey = await requireApiKey();
    const review = await runArtifactReview({
      apiKey,
      cwd: cwd || process.cwd(),
      file,
      artifactKind: kind || "image",
      env: process.env,
      allowFakeResponse: process.env.GEMINI_AGENT_ALLOW_FAKE_RESPONSE === "1",
      writeArtifact: Boolean(write_artifact),
    });
    return textContent(artifactReviewToPrettyJson(review));
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
    const value = await readLatestArtifact({ cwd: process.cwd(), category: "artifacts" });
    return jsonResource(uri.href, value || { kind: "missing", message: "No latest artifact review found." });
  },
);
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
node --test test/mcp.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/mcp-server.mjs test/mcp.test.mjs
git commit -m "feat: expose coprocessor mcp tools"
```

---

### Task 10: Update README And Final Verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update README**

Add commands:

```md
./bin/gemini-agent context-pack --stdin
./bin/gemini-agent artifact-review --file design.png --kind ui
```

Add safety bullets:

```md
- `context-pack` creates compact structured summaries for Codex; it does not edit files.
- `artifact-review` supports PNG/JPEG/WEBP inline image review in v1.
- Generated local artifacts live under `.gemini-agent/`, which is ignored by git.
- PDF, video, batch, explicit cache, and automatic routing are deferred.
```

- [ ] **Step 2: Run full automated tests**

Run:

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 3: Run focused live text smoke test**

Run:

```bash
npm run test:live
```

Expected: `gemini-agent-ok`.

- [ ] **Step 4: Run a fake context-pack smoke test**

Run:

```bash
GEMINI_AGENT_ALLOW_FAKE_RESPONSE=1 \
GEMINI_AGENT_FAKE_RESPONSE='{"kind":"context_pack","source_summary":["ok"],"project_facts":[],"relevant_files":[],"open_questions":[],"risks":[],"recommended_codex_actions":[],"limitations":[],"metadata":{"model":"gemini-3.5-flash","generated_at":"2026-05-28T12:00:00.000Z","sources":["stdin"],"omitted_sources":[]}}' \
GEMINI_API_KEY=fake-key \
./bin/gemini-agent context-pack --stdin <<'EOF'
Summarize this project for Codex.
EOF
```

Expected: JSON with `"kind": "context_pack"`.

- [ ] **Step 5: Commit**

Run:

```bash
git add README.md
git commit -m "docs: document coprocessor commands"
```

---

## Final Verification Checklist

After all tasks:

- [ ] Run `npm test`.
- [ ] Run `npm run test:live`.
- [ ] Run fake `context-pack --stdin` smoke test.
- [ ] Run fake `artifact-review --file <png>` smoke test using a small test image file.
- [ ] Run `git status --short`.
- [ ] Run `./bin/gemini-agent diff-review --stdin` on the final diff before any release branch or PR.

## Implementation Notes

- Use TDD for every task. Do not write implementation before the failing test.
- Keep commits small and coherent, as required by `AGENTS.md`.
- Do not let Gemini edit files. Gemini is used for critique and structured generation only.
- Preserve the fixed runtime model `gemini-3.5-flash`.
- Keep live Gemini tests opt-in; unit tests should use fake clients or fake responses.
