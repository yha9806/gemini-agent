import assert from "node:assert/strict";
import test from "node:test";
import { generateReview, getDefaultModel } from "../src/gemini-client.mjs";

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
          assert.equal(request.config.responseMimeType, "application/json");
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
