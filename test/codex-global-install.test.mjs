import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACTIVE_POLICY_BLOCK,
  applyCodexGlobalInstall,
  planCodexGlobalInstall,
} from "../src/codex-global-install.mjs";

const START = "BEGIN GEMINI AGENT ACTIVE POLICY";
const END = "END GEMINI AGENT ACTIVE POLICY";

async function tempHome() {
  return mkdtemp(join(tmpdir(), "gemini-agent-codex-global-"));
}

function modeBits(stats) {
  return stats.mode & 0o777;
}

test("dry-run plans next content without writing target", async () => {
  const home = await tempHome();
  await mkdir(join(home, ".codex"), { recursive: true });
  const target = join(home, ".codex", "AGENTS.md");
  await writeFile(target, "# Existing\n");

  const result = await applyCodexGlobalInstall({ home, mode: "active", write: false });

  assert.equal(result.changed, true);
  assert.equal(result.targetPath, target);
  assert.match(result.nextContent, new RegExp(START));
  assert.match(result.nextContent, /context-pack/);
  assert.equal(result.backupPath, null);
  assert.equal(await readFile(target, "utf8"), "# Existing\n");
});

test("write is idempotent and creates a single backup for the changed write", async () => {
  const home = await tempHome();
  await mkdir(join(home, ".codex"), { recursive: true });
  const target = join(home, ".codex", "AGENTS.md");
  await writeFile(target, "# Existing\n");

  const first = await applyCodexGlobalInstall({
    home,
    mode: "active",
    write: true,
    now: new Date("2026-05-31T10:00:00Z"),
  });
  const second = await applyCodexGlobalInstall({
    home,
    mode: "active",
    write: true,
    now: new Date("2026-05-31T10:01:00Z"),
  });

  assert.equal(first.changed, true);
  assert.ok(first.backupPath);
  assert.equal(second.changed, false);
  assert.equal(second.backupPath, null);
  assert.equal((await readdir(join(home, ".codex", "backups"))).length, 1);
  assert.match(await readFile(target, "utf8"), /recursion guard/i);
  assert.equal(modeBits(await stat(target)), 0o600);
  assert.equal(modeBits(await stat(first.backupPath)), 0o600);
  assert.equal(modeBits(await stat(join(home, ".codex"))), 0o700);
  assert.equal(modeBits(await stat(join(home, ".codex", "backups"))), 0o700);
});

test("existing marker block is replaced instead of appended", async () => {
  const home = await tempHome();
  await mkdir(join(home, ".codex"), { recursive: true });
  const target = join(home, ".codex", "AGENTS.md");
  await writeFile(target, [
    "# Existing",
    "",
    `<!-- ${START} -->`,
    "old generated content",
    `<!-- ${END} -->`,
    "",
    "user notes",
    "",
  ].join("\n"));

  const plan = await planCodexGlobalInstall({ home, mode: "active" });

  assert.doesNotMatch(plan.nextContent, /old generated content/);
  assert.equal((plan.nextContent.match(new RegExp(START, "g")) ?? []).length, 1);
  assert.match(plan.nextContent, /^# Existing/);
  assert.match(plan.nextContent, /user notes/);
});

test("write creates AGENTS.md when it does not exist", async () => {
  const home = await tempHome();

  const result = await applyCodexGlobalInstall({ home, mode: "active", write: true });

  assert.equal(result.changed, true);
  assert.ok(result.backupPath);
  assert.match(await readFile(join(home, ".codex", "AGENTS.md"), "utf8"), new RegExp(START));
});

test("active policy names commands, recursion guard, priorities, and runtime model", () => {
  for (const name of ["context-pack", "artifact-review", "plan-critique", "patch-precheck", "diff-review", "research-brief"]) {
    assert.match(ACTIVE_POLICY_BLOCK, new RegExp(name));
  }
  assert.match(ACTIVE_POLICY_BLOCK, /recursion guard/i);
  assert.match(ACTIVE_POLICY_BLOCK, /user instructions > Superpowers process gates > Codex execution\/verification > gemini-agent advice/);
  assert.match(ACTIVE_POLICY_BLOCK, /gemini-3\.5-flash/);
});

test("unknown mode fails", async () => {
  await assert.rejects(
    planCodexGlobalInstall({ home: await tempHome(), mode: "passive" }),
    /Unknown install-codex-global mode: passive/,
  );
});
