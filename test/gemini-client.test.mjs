import assert from "node:assert/strict";
import test from "node:test";
import { generateReview, generateText, getDefaultModel } from "../src/gemini-client.mjs";

test("uses stable default model", () => {
  assert.equal(getDefaultModel({}), "gemini-2.5-pro");
  assert.equal(getDefaultModel({ GEMINI_AGENT_MODEL: "gemini-2.5-flash" }), "gemini-2.5-flash");
});

test("generates normalized review through fake client", async () => {
  const review = await generateReview({
    apiKey: "fake-key",
    prompt: "review this",
    makeAi: () => ({
      models: {
        async generateContent(request) {
          assert.equal(request.model, "gemini-2.5-pro");
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

test("generates trimmed text through fake client with injected default model", async () => {
  let seenApiKey;
  const text = await generateText({
    apiKey: "fake-key",
    prompt: "say hi",
    env: { GEMINI_AGENT_MODEL: "gemini-2.5-flash" },
    temperature: 0.7,
    makeAi: (apiKey) => {
      seenApiKey = apiKey;
      return {
        models: {
          async generateContent(request) {
            assert.equal(request.model, "gemini-2.5-flash");
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
