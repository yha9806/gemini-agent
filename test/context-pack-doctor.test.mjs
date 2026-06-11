import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runContextPackDoctor } from "../src/context-pack-doctor.mjs";

function contextPack({ generatedAt = "2026-06-11T00:00:00.000Z", metadata = {} } = {}) {
  return {
    kind: "context_pack",
    source_summary: ["source"],
    project_facts: ["fact"],
    relevant_files: [{ path: "README.md", why_relevant: "root documentation" }],
    open_questions: [],
    risks: [],
    recommended_codex_actions: [],
    limitations: [],
    metadata: {
      model: "gemini-3.5-flash",
      generated_at: generatedAt,
      sources: ["README.md"],
      omitted_sources: [],
      ...metadata,
    },
  };
}

async function writeLatestContextPack(cwd, value) {
  const dir = join(cwd, ".gemini-agent", "context");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "latest.json"), `${JSON.stringify(value, null, 2)}\n`);
}

test("runContextPackDoctor reports invalid context pack JSON without exposing raw content", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-context-doctor-invalid-"));
  await mkdir(join(cwd, ".gemini-agent", "context"), { recursive: true });
  await writeFile(join(cwd, ".gemini-agent", "context", "latest.json"), "{not json");

  const result = await runContextPackDoctor({ cwd });

  assert.equal(result.ok, false);
  assert.equal(result.status, "invalid");
  assert.equal(result.exists, true);
  assert.equal(result.reason, "invalid_json");
  assert.match(result.recommended_action, /context-pack --bootstrap --write-artifact/);
  assert.equal(Object.hasOwn(result, "raw_content"), false);
});

test("runContextPackDoctor reports stale packs when generated_at exceeds max age", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-context-doctor-stale-"));
  await writeLatestContextPack(cwd, contextPack({ generatedAt: "2026-06-09T00:00:00.000Z" }));

  const result = await runContextPackDoctor({
    cwd,
    now: new Date("2026-06-11T12:00:00.000Z"),
    maxAgeHours: 24,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "stale");
  assert.equal(result.exists, true);
  assert.equal(result.generated_at, "2026-06-09T00:00:00.000Z");
  assert.equal(result.age_hours, 60);
  assert.match(result.recommended_action, /context-pack --bootstrap --write-artifact/);
});

test("runContextPackDoctor reports ready packs when valid and recent", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-context-doctor-ready-"));
  await writeLatestContextPack(cwd, contextPack({ generatedAt: "2026-06-11T08:00:00.000Z" }));

  const result = await runContextPackDoctor({
    cwd,
    now: new Date("2026-06-11T12:00:00.000Z"),
    maxAgeHours: 24,
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "ready");
  assert.equal(result.exists, true);
  assert.equal(result.generated_at, "2026-06-11T08:00:00.000Z");
  assert.equal(result.age_hours, 4);
  assert.match(result.recommended_action, /--auto-context-pack/);
});

test("runContextPackDoctor reports stale packs when git head metadata mismatches", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-context-doctor-head-"));
  await writeLatestContextPack(cwd, contextPack({
    generatedAt: "2026-06-11T08:00:00.000Z",
    metadata: { git_head: "old-head" },
  }));

  const result = await runContextPackDoctor({
    cwd,
    now: new Date("2026-06-11T12:00:00.000Z"),
    maxAgeHours: 24,
    runner: async (command, args) => {
      assert.equal(command, "git");
      if (args[1] === "--show-toplevel") return { stdout: `${cwd}\n` };
      if (args[1] === "HEAD") return { stdout: "new-head\n" };
      throw new Error(`unexpected git args: ${args.join(" ")}`);
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "stale");
  assert.equal(result.git_head_status, "mismatch");
  assert.equal(result.context_pack_git_head, "old-head");
  assert.equal(result.current_git_head, "new-head");
});

test("runContextPackDoctor reports stale packs when git head metadata is missing in a git repo", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-context-doctor-head-missing-"));
  await writeLatestContextPack(cwd, contextPack({ generatedAt: "2026-06-11T08:00:00.000Z" }));

  const result = await runContextPackDoctor({
    cwd,
    now: new Date("2026-06-11T12:00:00.000Z"),
    maxAgeHours: 24,
    runner: async (command, args) => {
      assert.equal(command, "git");
      if (args[1] === "--show-toplevel") return { stdout: `${cwd}\n` };
      if (args[1] === "HEAD") return { stdout: "current-head\n" };
      throw new Error(`unexpected git args: ${args.join(" ")}`);
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "stale");
  assert.equal(result.git_head_status, "missing");
  assert.equal(result.context_pack_git_head, null);
  assert.equal(result.current_git_head, "current-head");
});
