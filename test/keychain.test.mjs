import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDeleteArgs,
  buildFindArgs,
  buildSaveArgs,
  getApiKeyFromKeychain,
  getApiKeyFromEnv,
  redactSecret,
  resolveApiKey,
  saveApiKeyToKeychain,
} from "../src/keychain.mjs";

async function withEmptyPath(callback) {
  const originalPath = process.env.PATH;
  process.env.PATH = "";
  try {
    return await callback();
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
  }
}

test("reads API key from environment without trimming internal characters", () => {
  assert.equal(getApiKeyFromEnv({ GEMINI_API_KEY: "  abc-123  " }), "abc-123");
  assert.equal(getApiKeyFromEnv({ GOOGLE_API_KEY: "  google-123  " }), "google-123");
  assert.equal(getApiKeyFromEnv({ GEMINI_API_KEY: " gemini-123 ", GOOGLE_API_KEY: " google-123 " }), "gemini-123");
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

test("save failure does not expose the key in thrown errors", async () => {
  const secret = "secret-abc-123";
  const runner = async () => {
    throw new Error(`security add-generic-password -w ${secret} failed`);
  };

  await withEmptyPath(async () => {
    await assert.rejects(
      saveApiKeyToKeychain(` ${secret} `, { account: "alice", platform: "darwin", runner }),
      (error) => {
        assert.equal(error.message.includes(secret), false);
        assert.match(error.message, /\[REDACTED\]/);
        return true;
      },
    );
  });
});

test("keychain lookup can use an injected runner", async () => {
  const calls = [];
  const runner = async (command, args, options) => {
    calls.push({ command, args, options });
    return { stdout: " key-from-runner \n" };
  };

  const key = await withEmptyPath(() => getApiKeyFromKeychain({ account: "alice", platform: "darwin", runner }));

  assert.equal(key, "key-from-runner");
  assert.deepEqual(calls, [
    {
      command: "security",
      args: buildFindArgs("alice"),
      options: { encoding: "utf8" },
    },
  ]);
});

test("resolveApiKey can use injected runner after environment lookup", async () => {
  const result = await withEmptyPath(() => resolveApiKey({
    env: {},
    account: "alice",
    platform: "darwin",
    runner: async () => ({ stdout: " keychain-key \n" }),
  }));

  assert.deepEqual(result, { ok: true, source: "keychain", key: "keychain-key" });
});

test("non-darwin keychain lookup returns null without runner calls", async () => {
  let called = false;
  const key = await getApiKeyFromKeychain({
    account: "alice",
    platform: "linux",
    runner: async () => {
      called = true;
      return { stdout: "unused" };
    },
  });

  assert.equal(key, null);
  assert.equal(called, false);
});
