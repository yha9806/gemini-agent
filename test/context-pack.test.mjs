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
  let seenApiKey = "";
  let seenAllowFakeResponse = null;
  let seenTelemetry = null;

  const pack = await runContextPack({
    apiKey: "fake-key",
    cwd: dir,
    stdinText: "project notes",
    now: new Date("2026-05-28T12:00:00.000Z"),
    generate: async ({ apiKey, prompt, allowFakeResponse, telemetry }) => {
      seenApiKey = apiKey;
      seenPrompt = prompt;
      seenAllowFakeResponse = allowFakeResponse;
      seenTelemetry = telemetry;
      return fakePack;
    },
    writeArtifact: true,
  });

  assert.equal(seenApiKey, "fake-key");
  assert.equal(seenAllowFakeResponse, false);
  assert.deepEqual(seenTelemetry, { cwd: dir, source: "cli", command: "context-pack" });
  assert.match(seenPrompt, /project notes/);
  assert.match(seenPrompt, /stdin/);
  assert.equal(pack.metadata.model, "gemini-3.5-flash");
  assert.equal(pack.metadata.generated_at, "2026-05-28T12:00:00.000Z");
  assert.deepEqual(pack.metadata.sources, ["stdin"]);
  assert.deepEqual(pack.metadata.omitted_sources, []);

  const latest = JSON.parse(await readFile(join(dir, ".gemini-agent/context/latest.json"), "utf8"));
  assert.equal(latest.kind, "context_pack");
  assert.equal(latest.metadata.generated_at, "2026-05-28T12:00:00.000Z");
  assert.match(await readFile(join(dir, ".gitignore"), "utf8"), /\.gemini-agent\//);
});

test("runContextPack passes explicit telemetry override to generation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-context-"));
  const telemetry = { cwd: "/override", source: "mcp", command: "gemini_context_pack", awaitCapture: true };
  let seenTelemetry = null;

  await runContextPack({
    apiKey: "fake-key",
    cwd: dir,
    stdinText: "project notes",
    telemetry,
    generate: async ({ telemetry: generatedTelemetry }) => {
      seenTelemetry = generatedTelemetry;
      return fakePack;
    },
  });

  assert.equal(seenTelemetry, telemetry);
});

test("runContextPack records current git head metadata when available", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-context-"));

  const pack = await runContextPack({
    apiKey: "fake-key",
    cwd: dir,
    stdinText: "project notes",
    now: new Date("2026-05-28T12:00:00.000Z"),
    runner: async (command, args) => {
      assert.equal(command, "git");
      assert.deepEqual(args, ["rev-parse", "HEAD"]);
      return { stdout: "abc123\n" };
    },
    generate: async () => fakePack,
  });

  assert.equal(pack.metadata.git_head, "abc123");
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
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-context-"));
  await assert.rejects(
    () => runContextPack({
      apiKey: "fake-key",
      cwd: dir,
      files: ["missing.md"],
      generate: assert.fail,
    }),
    /ENOENT/,
  );
});

test("runContextPack rejects unsafe file paths before generate is called", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-context-"));

  await assert.rejects(
    () => runContextPack({
      apiKey: "fake-key",
      cwd: dir,
      files: [join(dir, "notes.md")],
      generate: assert.fail,
    }),
    /File path must be relative to cwd/,
  );

  await assert.rejects(
    () => runContextPack({
      apiKey: "fake-key",
      cwd: dir,
      files: ["../notes.md"],
      generate: assert.fail,
    }),
    /File path must stay within cwd/,
  );
});

test("runContextPack accepts pre-collected input and does not re-collect files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-context-"));
  let generated = false;

  const pack = await runContextPack({
    apiKey: "fake-key",
    cwd: dir,
    files: ["/path/that/does/not/exist.md"],
    collected: {
      input: "--- Source: fixture ---\npre-collected notes\n",
      sources: ["fixture"],
      omittedSources: ["too-large.md"],
    },
    now: new Date("2026-05-28T12:30:00.000Z"),
    generate: async ({ prompt }) => {
      generated = true;
      assert.match(prompt, /pre-collected notes/);
      return fakePack;
    },
  });

  assert.equal(generated, true);
  assert.deepEqual(pack.metadata.sources, ["fixture"]);
  assert.deepEqual(pack.metadata.omitted_sources, ["too-large.md"]);
});

test("runContextPack rejects generated invalid pack", async () => {
  await assert.rejects(
    () => runContextPack({
      apiKey: "fake-key",
      stdinText: "project notes",
      generate: async () => ({ kind: "artifact_review" }),
    }),
    /Invalid context pack JSON/,
  );
});
