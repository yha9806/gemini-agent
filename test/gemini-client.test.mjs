import assert from "node:assert/strict";
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
