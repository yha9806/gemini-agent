import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  generateArtifactReview,
  generateContextPack,
  generateJson,
  generateReview,
  generateText,
  getDefaultModel,
} from "../src/gemini-client.mjs";
import { GeminiArtifactReviewSchema, GeminiContextPackSchema } from "../src/schemas.mjs";
import { resetTelemetryCaptureForTests } from "../src/telemetry-capture.mjs";
import { saveTelemetryConfig } from "../src/telemetry-config.mjs";
import { telemetryQueueDirs } from "../src/telemetry-queue.mjs";

async function tempDir() {
  return mkdtemp(join(tmpdir(), "gemini-agent-client-"));
}

async function readPendingTelemetryEvents(cwd) {
  const files = await readdir(telemetryQueueDirs(cwd).pending);
  return Promise.all(files.sort().map(async (file) => (
    JSON.parse(await readFile(join(telemetryQueueDirs(cwd).pending, file), "utf8"))
  )));
}

test("uses stable default model", () => {
  assert.equal(getDefaultModel({}), "gemini-3.5-flash");
  assert.equal(getDefaultModel({ GEMINI_AGENT_MODEL: "gemini-2.5-flash" }), "gemini-3.5-flash");
});

test("generates normalized review through fake client", async () => {
  const review = await generateReview({
    apiKey: "fake-key",
    prompt: "review this",
    makeAi: () => ({
      models: {
        async generateContent(request) {
          assert.equal(request.model, "gemini-3.5-flash");
          assert.equal(request.contents, "review this");
          assert.equal(request.config.temperature, 0.2);
          assert.equal(request.config.responseMimeType, "application/json");
          assert.ok(request.config.responseSchema);
          return {
            text: JSON.stringify({
              verdict: "pass",
              top_risks: [],
              missing_tests: [],
              unsafe_claims: [],
              suggested_changes: [],
              notes: ["ok"],
            }),
          };
        },
      },
    }),
  });
  assert.equal(review.verdict, "pass");
  assert.deepEqual(review.notes, ["ok"]);
});

test("generateReview ignores caller-provided contents and sends prompt", async () => {
  const review = await generateReview({
    apiKey: "fake-key",
    prompt: "review prompt",
    contents: [{ text: "caller override" }],
    makeAi: () => ({
      models: {
        async generateContent(request) {
          assert.equal(request.contents, "review prompt");
          return {
            text: JSON.stringify({
              verdict: "pass",
              top_risks: [],
              missing_tests: [],
              unsafe_claims: [],
              suggested_changes: [],
              notes: [],
            }),
          };
        },
      },
    }),
  });

  assert.equal(review.verdict, "pass");
});

test("generateJson sends structured JSON request and normalizes response", async () => {
  const result = await generateJson({
    apiKey: "fake-key",
    prompt: "build context",
    responseSchema: GeminiContextPackSchema,
    normalize(value) {
      assert.deepEqual(value, { kind: "context_pack" });
      return { ok: value.kind };
    },
    makeAi: () => ({
      models: {
        async generateContent(request) {
          assert.equal(request.model, "gemini-3.5-flash");
          assert.equal(request.contents, "build context");
          assert.equal(request.config.responseMimeType, "application/json");
          assert.equal(request.config.responseSchema, GeminiContextPackSchema);
          return { text: JSON.stringify({ kind: "context_pack" }) };
        },
      },
    }),
  });

  assert.deepEqual(result, { ok: "context_pack" });
});

test("generateJson forwards maxOutputTokens when provided", async () => {
  const result = await generateJson({
    apiKey: "fake-key",
    prompt: "build concise context",
    responseSchema: GeminiContextPackSchema,
    maxOutputTokens: 768,
    normalize(value) {
      assert.deepEqual(value, { kind: "context_pack" });
      return { ok: value.kind };
    },
    makeAi: () => ({
      models: {
        async generateContent(request) {
          assert.equal(request.config.maxOutputTokens, 768);
          assert.equal(request.config.temperature, 0.2);
          assert.equal(request.config.responseMimeType, "application/json");
          assert.equal(request.config.responseSchema, GeminiContextPackSchema);
          return { text: JSON.stringify({ kind: "context_pack" }) };
        },
      },
    }),
  });

  assert.deepEqual(result, { ok: "context_pack" });
});

test("structured and text generation ignore caller model overrides", async () => {
  await generateJson({
    apiKey: "fake-key",
    prompt: "build context",
    model: "gemini-2.5-flash",
    responseSchema: GeminiContextPackSchema,
    normalize: (value) => value,
    makeAi: () => ({
      models: {
        async generateContent(request) {
          assert.equal(request.model, "gemini-3.5-flash");
          return { text: JSON.stringify({ kind: "context_pack" }) };
        },
      },
    }),
  });

  await generateText({
    apiKey: "fake-key",
    prompt: "say hi",
    model: "gemini-2.5-flash",
    makeAi: () => ({
      models: {
        async generateContent(request) {
          assert.equal(request.model, "gemini-3.5-flash");
          return { text: "ok" };
        },
      },
    }),
  });
});

test("generateContextPack uses fake response only when explicitly allowed", async () => {
  const env = {
    GEMINI_AGENT_FAKE_RESPONSE: JSON.stringify({
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
        generated_at: "2026-05-28T00:00:00Z",
        sources: [],
        omitted_sources: [],
      },
    }),
  };

  const pack = await generateContextPack({
    apiKey: "fake-key",
    prompt: "build context",
    env,
    allowFakeResponse: true,
    makeAi: assert.fail,
  });

  assert.equal(pack.kind, "context_pack");
  assert.deepEqual(pack.source_summary, ["summary"]);

  await assert.rejects(
    () => generateContextPack({
      apiKey: "fake-key",
      prompt: "build context",
      env,
      makeAi: () => ({
        models: {
          async generateContent() {
            throw new Error("live context path");
          },
        },
      }),
    }),
    /live context path/,
  );
});

test("generateContextPack rejects incomplete structured JSON", async () => {
  await assert.rejects(
    () => generateContextPack({
      apiKey: "fake-key",
      prompt: "build context",
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
    { inlineData: { mimeType: "image/png", data: "abcd" } },
    { text: "review this artifact" },
  ];

  const review = await generateArtifactReview({
    apiKey: "fake-key",
    prompt: "review artifact",
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
                generated_at: "2026-05-28T00:00:00Z",
                sources: [],
                omitted_sources: [],
              },
            }),
          };
        },
      },
    }),
  });

  assert.equal(review.kind, "artifact_review");
  assert.equal(review.artifact_type, "image");
});

test("generateArtifactReview reports safe design scorecard telemetry metadata", async () => {
  let seenMetadata = null;

  const review = await generateArtifactReview({
    apiKey: "fake-key",
    prompt: "review artifact",
    contents: [{ text: "review artifact" }],
    allowFakeResponse: true,
    env: {
      GEMINI_AGENT_FAKE_RESPONSE: JSON.stringify({
        kind: "artifact_review",
        artifact_type: "design",
        summary: ["summary"],
        important_details: [],
        design_or_research_findings: [],
        implementation_hints_for_codex: [],
        risks_or_ambiguities: [],
        questions_for_user: [],
        limitations: [],
        design_scorecard: {
          overall_score: 82,
          visual_hierarchy_score: 90,
          clarity_score: 84,
          accessibility_score: 72,
          consistency_score: 80,
          implementation_readiness_score: 78,
          strengths: ["Private strengths should stay out of telemetry metadata"],
          issues: ["Private issues should stay out of telemetry metadata"],
          recommended_actions: ["Private action should stay out of telemetry metadata"],
        },
        metadata: {
          model: "gemini-3.5-flash",
          generated_at: "2026-05-28T00:00:00Z",
          sources: [],
          omitted_sources: [],
        },
      }),
    },
    telemetry: {
      cwd: await tempDir(),
      command: "artifact-review",
      capture: async (event) => {
        seenMetadata = event.metadata;
      },
    },
  });

  assert.equal(review.design_scorecard.overall_score, 82);
  assert.deepEqual(seenMetadata.design_scorecard, {
    overall_score: 82,
    visual_hierarchy_score: 90,
    clarity_score: 84,
    accessibility_score: 72,
    consistency_score: 80,
    implementation_readiness_score: 78,
  });
  assert.doesNotMatch(JSON.stringify(seenMetadata), /Private/);
});

test("generateJson records Gemini generation stage without dropping caller latency stages", async () => {
  let seenMetadata = null;

  await generateReview({
    apiKey: "fake-key",
    prompt: "review plan",
    telemetry: {
      cwd: "/tmp/latency-project",
      command: "plan-critique",
      metadata: {
        latency_stages_ms: {
          media_prepare: 5,
          policy_prompt: 7,
          pre_gemini_total: 12,
        },
      },
      capture: async (event) => {
        seenMetadata = event.metadata;
      },
    },
    makeAi: () => ({
      models: {
        async generateContent() {
          return {
            text: JSON.stringify({
              verdict: "pass",
              top_risks: [],
              missing_tests: [],
              unsafe_claims: [],
              suggested_changes: [],
              notes: [],
            }),
          };
        },
      },
    }),
  });

  assert.equal(seenMetadata.latency_stages_ms.media_prepare, 5);
  assert.equal(seenMetadata.latency_stages_ms.policy_prompt, 7);
  assert.equal(seenMetadata.latency_stages_ms.pre_gemini_total, 12);
  assert.equal(Number.isSafeInteger(seenMetadata.latency_stages_ms.gemini_generation), true);
  assert.equal(seenMetadata.latency_stages_ms.gemini_generation >= 0, true);
});

test("generateJson keeps telemetry contents separate from Gemini request contents", async () => {
  const requestContents = [
    { inlineData: { mimeType: "image/png", data: "YWJjZA==" } },
    { text: "prompt" },
  ];
  const telemetryContents = [{ source: "checkout-screenshot.png" }];
  const cwd = await tempDir();
  let seenRequestContents = null;
  let seenTelemetryContents = null;

  const result = await generateJson({
    apiKey: "fake-key",
    prompt: "review screenshot",
    contents: requestContents,
    responseSchema: GeminiArtifactReviewSchema,
    normalize: (value) => value,
    telemetry: {
      cwd,
      command: "artifact-review",
      contents: telemetryContents,
      capture: async (event) => {
        seenTelemetryContents = event.contents;
      },
    },
    makeAi: () => ({
      models: {
        async generateContent(request) {
          seenRequestContents = request.contents;
          return {
            text: JSON.stringify({
              kind: "artifact_review",
              artifact_type: "design",
              summary: [],
              important_details: [],
              design_or_research_findings: [],
              implementation_hints_for_codex: [],
              risks_or_ambiguities: [],
              questions_for_user: [],
              limitations: [],
              metadata: {
                model: "gemini-3.5-flash",
                generated_at: "2026-06-10T00:00:00.000Z",
                sources: [],
                omitted_sources: [],
              },
            }),
          };
        },
      },
    }),
  });

  assert.equal(result.kind, "artifact_review");
  assert.equal(seenRequestContents, requestContents);
  assert.equal(seenTelemetryContents, telemetryContents);
});

test("generateJson forwards caller telemetry metadata", async () => {
  const captures = [];

  await generateReview({
    apiKey: "fake-key",
    prompt: "review plan",
    telemetry: {
      cwd: "/tmp/plan-project",
      source: "cli",
      command: "plan-critique",
      context: { session_id: "session-a" },
      outcome: { task_outcome: "success" },
      economics: { codex_tokens_saved_estimate: 1200 },
      metadata: {
        gate: "plan_critique",
        input_bytes: 42,
        input_limit_bytes: 131072,
      },
      capture: async (event) => captures.push(event),
    },
    makeAi: () => ({
      models: {
        async generateContent() {
          return {
            text: JSON.stringify({
              verdict: "pass",
              top_risks: [],
              missing_tests: [],
              unsafe_claims: [],
              suggested_changes: [],
              notes: [],
            }),
            usageMetadata: {
              promptTokenCount: 10,
              candidatesTokenCount: 2,
              totalTokenCount: 12,
            },
          };
        },
      },
    }),
  });

  assert.equal(captures.length, 1);
  assert.equal(captures[0].context.session_id, "session-a");
  assert.equal(captures[0].outcome.task_outcome, "success");
  assert.equal(captures[0].economics.codex_tokens_saved_estimate, 1200);
  assert.equal(captures[0].economics.input_tokens, 10);
  assert.equal(captures[0].economics.output_tokens, 2);
  assert.equal(captures[0].economics.total_tokens, 12);
  assert.equal(captures[0].metadata.gate, "plan_critique");
  assert.equal(captures[0].metadata.input_bytes, 42);
  assert.equal(captures[0].metadata.input_limit_bytes, 131072);
  assert.equal(Number.isSafeInteger(captures[0].metadata.latency_stages_ms.gemini_generation), true);
  assert.equal(captures[0].metadata.latency_stages_ms.gemini_generation >= 0, true);
});

test("generateJson redacts API key from structured generation errors", async () => {
  const apiKey = "fake-secret-key";

  await assert.rejects(
    () => generateJson({
      apiKey,
      prompt: "build context",
      responseSchema: GeminiContextPackSchema,
      normalize: (value) => value,
      makeAi: () => ({
        models: {
          async generateContent() {
            throw new Error(`structured request failed for ${apiKey}`);
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

test("generates trimmed text through fake client with default 3.5 Flash model", async () => {
  let seenApiKey;
  const text = await generateText({
    apiKey: "fake-key",
    prompt: "say hi",
    temperature: 0.7,
    makeAi: (apiKey) => {
      seenApiKey = apiKey;
      return {
        models: {
          async generateContent(request) {
            assert.equal(request.model, "gemini-3.5-flash");
            assert.equal(request.contents, "say hi");
            assert.deepEqual(request.config, { temperature: 0.7 });
            return { text: "  hello from Gemini  \n" };
          },
        },
      };
    },
  });

  assert.equal(seenApiKey, "fake-key");
  assert.equal(text, "hello from Gemini");
});

test("generateText reports raw prompt and response to telemetry hook", async () => {
  const captures = [];
  const text = await generateText({
    apiKey: "fake-key",
    prompt: "telemetry prompt",
    telemetry: {
      cwd: process.cwd(),
      command: "ask",
      capture: async (event) => captures.push(event),
    },
    makeAi: () => ({
      models: {
        async generateContent() {
          return { text: "  telemetry response  \n" };
        },
      },
    }),
  });

  assert.equal(text, "telemetry response");
  assert.equal(captures.length, 1);
  assert.equal(captures[0].prompt, "telemetry prompt");
  assert.equal(captures[0].response, "  telemetry response  \n");
  assert.equal(captures[0].status, "success");
  assert.equal(captures[0].model, "gemini-3.5-flash");
  assert.equal(captures[0].command, "ask");
  assert.equal(captures[0].source, "cli");
  assert.equal(captures[0].cwd, process.cwd());
  assert.equal(Number.isInteger(captures[0].latencyMs), true);
});

test("generateText reports Gemini usage metadata to telemetry hook", async () => {
  const captures = [];
  await generateText({
    apiKey: "fake-key",
    prompt: "usage prompt",
    telemetry: {
      command: "ask",
      capture: async (event) => captures.push(event),
    },
    makeAi: () => ({
      models: {
        async generateContent() {
          return {
            text: "usage response",
            usageMetadata: {
              promptTokenCount: 12,
              candidatesTokenCount: 34,
              totalTokenCount: 46,
            },
          };
        },
      },
    }),
  });

  assert.equal(captures.length, 1);
  assert.deepEqual(captures[0].economics, {
    input_tokens: 12,
    output_tokens: 34,
    total_tokens: 46,
  });
});

test("generateJson reports structured raw response to telemetry hook", async () => {
  const captures = [];
  const result = await generateJson({
    apiKey: "fake-key",
    prompt: "build context",
    responseSchema: GeminiContextPackSchema,
    normalize(value) {
      return { ok: value.kind };
    },
    telemetry: {
      cwd: "/tmp/project",
      source: "mcp",
      capture: async (event) => captures.push(event),
    },
    makeAi: () => ({
      models: {
        async generateContent() {
          return { text: JSON.stringify({ kind: "context_pack" }) };
        },
      },
    }),
  });

  assert.deepEqual(result, { ok: "context_pack" });
  assert.equal(captures.length, 1);
  assert.equal(captures[0].prompt, "build context");
  assert.equal(captures[0].response, JSON.stringify({ kind: "context_pack" }));
  assert.equal(captures[0].status, "success");
  assert.equal(captures[0].model, "gemini-3.5-flash");
  assert.equal(captures[0].command, "generate-json");
  assert.equal(captures[0].source, "mcp");
  assert.equal(captures[0].cwd, "/tmp/project");
  assert.equal(Number.isInteger(captures[0].latencyMs), true);
});

test("generateJson reports Gemini usage metadata on parse failures", async () => {
  const captures = [];
  await assert.rejects(
    () => generateJson({
      apiKey: "fake-key",
      prompt: "bad json",
      responseSchema: GeminiContextPackSchema,
      normalize: (value) => value,
      telemetry: {
        command: "context-pack",
        capture: async (event) => captures.push(event),
      },
      makeAi: () => ({
        models: {
          async generateContent() {
            return {
              text: "not json",
              usageMetadata: {
                promptTokenCount: 5,
                candidatesTokenCount: 6,
                totalTokenCount: 11,
              },
            };
          },
        },
      }),
    }),
    /Gemini response did not contain a JSON object/,
  );

  assert.equal(captures.length, 1);
  assert.equal(captures[0].status, "error");
  assert.deepEqual(captures[0].economics, {
    input_tokens: 5,
    output_tokens: 6,
    total_tokens: 11,
  });
});

test("generateJson captures parse and normalize failures as telemetry errors", async () => {
  const parseCaptures = [];
  await assert.rejects(
    () => generateJson({
      apiKey: "fake-key",
      prompt: "build context",
      responseSchema: GeminiContextPackSchema,
      normalize: (value) => value,
      telemetry: {
        cwd: "/tmp/context-project",
        source: "mcp",
        command: "context-pack",
        capture: async (event) => parseCaptures.push(event),
      },
      makeAi: () => ({
        models: {
          async generateContent() {
            return { text: "not json" };
          },
        },
      }),
    }),
    /Gemini response did not contain a JSON object/,
  );

  assert.equal(parseCaptures.length, 1);
  assert.equal(parseCaptures[0].response, "not json");
  assert.equal(parseCaptures[0].status, "error");
  assert.equal(parseCaptures[0].errorType, "Error");
  assert.equal(parseCaptures[0].command, "context-pack");

  const normalizeCaptures = [];
  await assert.rejects(
    () => generateJson({
      apiKey: "fake-key",
      prompt: "build context",
      responseSchema: GeminiContextPackSchema,
      normalize() {
        throw new TypeError("schema invalid");
      },
      telemetry: {
        cwd: "/tmp/context-project",
        source: "mcp",
        command: "context-pack",
        capture: async (event) => normalizeCaptures.push(event),
      },
      makeAi: () => ({
        models: {
          async generateContent() {
            return { text: JSON.stringify({ kind: "context_pack" }) };
          },
        },
      }),
    }),
    /schema invalid/,
  );

  assert.equal(normalizeCaptures.length, 1);
  assert.equal(normalizeCaptures[0].response, JSON.stringify({ kind: "context_pack" }));
  assert.equal(normalizeCaptures[0].status, "error");
  assert.equal(normalizeCaptures[0].errorType, "TypeError");
});

test("rejects missing API key and empty prompt", async () => {
  await assert.rejects(
    () => generateReview({ prompt: "review this", makeAi: assert.fail }),
    /Gemini API key is missing/,
  );
  await assert.rejects(
    () => generateReview({ apiKey: "fake-key", prompt: "   ", makeAi: assert.fail }),
    /Prompt is empty/,
  );
});

test("uses fake response only when explicitly allowed", async () => {
  const env = {
    GEMINI_AGENT_FAKE_RESPONSE: JSON.stringify({
      verdict: "caution",
      top_risks: ["risk"],
      missing_tests: [],
      unsafe_claims: [],
      suggested_changes: [],
      notes: ["fake"],
    }),
  };

  const review = await generateReview({
    apiKey: "fake-key",
    prompt: "review this",
    env,
    allowFakeResponse: true,
    makeAi: assert.fail,
  });

  assert.equal(review.verdict, "caution");
  assert.deepEqual(review.top_risks, ["risk"]);

  await assert.rejects(
    () => generateReview({
      apiKey: "fake-key",
      prompt: "review this",
      env,
      makeAi: () => ({
        models: {
          async generateContent() {
            throw new Error("live path");
          },
        },
      }),
    }),
    /live path/,
  );
});

test("rejects malformed fake and live review JSON", async () => {
  await assert.rejects(
    () => generateReview({
      apiKey: "fake-key",
      prompt: "review this",
      env: { GEMINI_AGENT_FAKE_RESPONSE: "not json" },
      allowFakeResponse: true,
      makeAi: assert.fail,
    }),
    /Gemini response did not contain a JSON object/,
  );

  await assert.rejects(
    () => generateReview({
      apiKey: "fake-key",
      prompt: "review this",
      makeAi: () => ({
        models: {
          async generateContent() {
            return { text: "not json" };
          },
        },
      }),
    }),
    /Gemini response did not contain a JSON object/,
  );
});

test("redacts API key from SDK errors", async () => {
  const apiKey = "fake-secret-key";

  await assert.rejects(
    () => generateReview({
      apiKey,
      prompt: "review this",
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

  await assert.rejects(
    () => generateText({
      apiKey,
      prompt: "say hi",
      makeAi: () => ({
        models: {
          async generateContent() {
            throw new Error(`text failed for ${apiKey}`);
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

test("SDK errors are captured before throwing redacted request errors", async () => {
  const apiKey = "fake-secret-key";
  const captures = [];

  await assert.rejects(
    () => generateText({
      apiKey,
      prompt: "say hi",
      telemetry: {
        command: "ask",
        capture: async (event) => captures.push(event),
      },
      makeAi: () => ({
        models: {
          async generateContent() {
            throw new TypeError(`text failed for ${apiKey}`);
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

  assert.equal(captures.length, 1);
  assert.equal(captures[0].prompt, "say hi");
  assert.equal(captures[0].response, "");
  assert.equal(captures[0].status, "error");
  assert.equal(captures[0].errorType, "TypeError");
  assert.equal(captures[0].model, "gemini-3.5-flash");
});

test("generateJson SDK errors are captured before throwing redacted request errors", async () => {
  const apiKey = "fake-secret-key";
  const captures = [];

  await assert.rejects(
    () => generateJson({
      apiKey,
      prompt: "build context",
      responseSchema: GeminiContextPackSchema,
      normalize: (value) => value,
      telemetry: {
        cwd: "/tmp/context-project",
        source: "mcp",
        command: "context-pack",
        capture: async (event) => captures.push(event),
      },
      makeAi: () => ({
        models: {
          async generateContent() {
            throw new TypeError(`structured failed for ${apiKey}`);
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

  assert.equal(captures.length, 1);
  assert.equal(captures[0].prompt, "build context");
  assert.equal(captures[0].response, "");
  assert.equal(captures[0].status, "error");
  assert.equal(captures[0].errorType, "TypeError");
  assert.equal(captures[0].model, "gemini-3.5-flash");
  assert.equal(captures[0].source, "mcp");
  assert.equal(captures[0].cwd, "/tmp/context-project");
  assert.equal(captures[0].command, "context-pack");
  assert.equal(Number.isInteger(captures[0].latencyMs), true);
});

test("generateJson awaits default SDK error capture before throwing", async () => {
  resetTelemetryCaptureForTests();
  const cwd = await tempDir();
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: "GEMINI_AGENT_TELEMETRY_TOKEN",
  });

  await assert.rejects(
    () => generateJson({
      apiKey: "fake-key",
      prompt: "build context",
      responseSchema: GeminiContextPackSchema,
      normalize: (value) => value,
      telemetry: {
        cwd,
        source: "mcp",
        command: "context-pack",
      },
      makeAi: () => ({
        models: {
          async generateContent() {
            throw new TypeError("structured failed");
          },
        },
      }),
    }),
    /Gemini API request failed: structured failed/,
  );

  const events = await readPendingTelemetryEvents(cwd);
  assert.equal(events.length, 1);
  assert.equal(events[0].prompt, "build context");
  assert.equal(events[0].response, "");
  assert.equal(events[0].status, "error");
  assert.equal(events[0].error_type, "TypeError");
  assert.equal(events[0].model, "gemini-3.5-flash");
  assert.equal(events[0].source, "mcp");
  assert.equal(events[0].command, "context-pack");
  assert.equal(Number.isInteger(events[0].latency_ms), true);
});

test("telemetry hook failures are swallowed", async () => {
  const text = await generateText({
    apiKey: "fake-key",
    prompt: "say hi",
    telemetry: {
      capture: async () => {
        throw new Error("telemetry unavailable");
      },
    },
    makeAi: () => ({
      models: {
        async generateContent() {
          return { text: "ok" };
        },
      },
    }),
  });

  assert.equal(text, "ok");

  await assert.rejects(
    () => generateJson({
      apiKey: "fake-key",
      prompt: "build context",
      responseSchema: GeminiContextPackSchema,
      normalize: (value) => value,
      telemetry: {
        capture: async () => {
          throw new Error("telemetry unavailable");
        },
      },
      makeAi: () => ({
        models: {
          async generateContent() {
            throw new Error("sdk failed");
          },
        },
      }),
    }),
    /Gemini API request failed: sdk failed/,
  );
});
