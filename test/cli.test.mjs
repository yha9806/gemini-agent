import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const bin = new URL("../bin/gemini-agent", import.meta.url).pathname;
const fakeReview = JSON.stringify({
  verdict: "pass",
  top_risks: [],
  missing_tests: [],
  unsafe_claims: [],
  suggested_changes: [],
  notes: ["fake ok"],
});

test("auth status reports env source without exposing key", async () => {
  const { stdout } = await execFileAsync(bin, ["auth", "status"], {
    env: { ...process.env, GEMINI_API_KEY: "secret-value" },
  });
  assert.match(stdout, /"ok": true/);
  assert.match(stdout, /"source": "env"/);
  assert.doesNotMatch(stdout, /secret-value/);
});

test("diff-review accepts file input and prints JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));
  const diffPath = join(dir, "change.diff");
  await writeFile(diffPath, "diff --git a/a b/a\n+hello\n");
  const { stdout } = await execFileAsync(bin, ["diff-review", "--file", diffPath], {
    cwd: dir,
    env: {
      ...process.env,
      GEMINI_API_KEY: "fake-key",
      GEMINI_AGENT_ALLOW_FAKE_RESPONSE: "1",
      GEMINI_AGENT_FAKE_RESPONSE: fakeReview,
    },
  });
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.verdict, "pass");
  assert.deepEqual(parsed.notes, ["fake ok"]);
});

test("diff-review rejects missing file path", async () => {
  await assert.rejects(
    execFileAsync(bin, ["diff-review", "--file"], {
      env: { ...process.env, GEMINI_API_KEY: "fake-key" },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /--file requires a path\./);
      return true;
    },
  );
});

test("diff-review rejects empty file input before review generation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));
  const diffPath = join(dir, "empty.diff");
  await writeFile(diffPath, "");
  await assert.rejects(
    execFileAsync(bin, ["diff-review", "--file", diffPath], {
      cwd: dir,
      env: { ...process.env, GEMINI_API_KEY: "fake-key" },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Gate input is empty\./);
      return true;
    },
  );
});

test("diff-review does not use fake response without explicit allow flag", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));
  const diffPath = join(dir, "change.diff");
  await writeFile(diffPath, "diff --git a/a b/a\n+hello\n");
  await assert.rejects(
    execFileAsync(bin, ["diff-review", "--file", diffPath], {
      cwd: dir,
      env: {
        ...process.env,
        GEMINI_API_KEY: "fake-key",
        GEMINI_AGENT_FAKE_RESPONSE: fakeReview,
      },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.doesNotMatch(error.stdout, /fake ok/);
      assert.match(error.stderr, /GEMINI_AGENT_ALLOW_FAKE_RESPONSE=1/);
      return true;
    },
  );
});

test("auth set requires an interactive TTY", async () => {
  await assert.rejects(
    execFileAsync(bin, ["auth", "set"], {
      input: "secret-value\n",
      env: process.env,
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /auth set requires an interactive TTY\./);
      assert.doesNotMatch(error.stdout, /secret-value/);
      assert.doesNotMatch(error.stderr, /secret-value/);
      return true;
    },
  );
});
