import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDeleteArgs,
  buildFindArgs,
  buildSaveArgs,
  getApiKeyFromEnv,
  redactSecret,
} from "../src/keychain.mjs";

test("reads API key from environment without trimming internal characters", () => {
  assert.equal(getApiKeyFromEnv({ GEMINI_API_KEY: "  abc-123  " }), "abc-123");
  assert.equal(getApiKeyFromEnv({}), null);
});

test("builds macOS security command arguments", () => {
  assert.deepEqual(buildFindArgs("alice"), ["find-generic-password", "-a", "alice", "-s", "GEMINI_API_KEY", "-w"]);
  assert.deepEqual(buildSaveArgs("alice", "k"), ["add-generic-password", "-U", "-a", "alice", "-s", "GEMINI_API_KEY", "-w", "k"]);
  assert.deepEqual(buildDeleteArgs("alice"), ["delete-generic-password", "-a", "alice", "-s", "GEMINI_API_KEY"]);
});

test("redacts secret values from messages", () => {
  assert.equal(redactSecret("prefix abc-123 suffix", "abc-123"), "prefix [REDACTED] suffix");
  assert.equal(redactSecret("prefix suffix", ""), "prefix suffix");
});
