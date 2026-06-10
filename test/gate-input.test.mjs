import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  readLimitedContextPackFile,
} from "../src/gate-input.mjs";

const contextPack = {
  kind: "context_pack",
  source_summary: ["The CLI routes gate commands."],
  project_facts: ["Runtime review model is gemini-3.5-flash."],
  relevant_files: [{ path: "src/cli.mjs", why_relevant: "Gate input parsing lives here." }],
  open_questions: ["Should the gate use only compact context?"],
  risks: ["Oversized inputs waste review tokens."],
  recommended_codex_actions: ["Use compact context before broad review."],
  limitations: ["Generated from selected files only."],
  metadata: {
    model: "gemini-3.5-flash",
    generated_at: "2026-06-10T00:00:00.000Z",
    sources: ["src/cli.mjs"],
    omitted_sources: [],
  },
};

test("readLimitedContextPackFile validates and formats compact context for gates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-gate-input-"));
  const path = join(dir, "context.json");
  await writeFile(path, JSON.stringify(contextPack));

  const result = await readLimitedContextPackFile(path, {
    gate: "plan_critique",
    command: "plan-critique",
    limitBytes: 4096,
  });

  assert.match(result.inputText, /--- Context pack ---/);
  assert.match(result.inputText, /The CLI routes gate commands\./);
  assert.match(result.inputText, /src\/cli\.mjs: Gate input parsing lives here\./);
  assert.equal(result.inputBytes, Buffer.byteLength(result.inputText, "utf8"));
});

test("readLimitedContextPackFile rejects invalid JSON before gate generation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-gate-input-"));
  const path = join(dir, "context.json");
  await writeFile(path, "{bad json");

  await assert.rejects(
    () => readLimitedContextPackFile(path, {
      gate: "plan_critique",
      command: "plan-critique",
      limitBytes: 4096,
    }),
    /Invalid context pack JSON/,
  );
});

test("readLimitedContextPackFile enforces byte limits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-gate-input-"));
  const path = join(dir, "context.json");
  await writeFile(path, JSON.stringify(contextPack));

  await assert.rejects(
    () => readLimitedContextPackFile(path, {
      gate: "plan_critique",
      command: "plan-critique",
      limitBytes: 10,
    }),
    /plan-critique input exceeds 10 bytes/,
  );
});
