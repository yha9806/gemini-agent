import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACTIVE_POLICY_BLOCK,
  applyCodexGlobalInstall,
  planCodexGlobalInstall,
} from "../src/codex-global-install.mjs";

const START = "BEGIN GEMINI AGENT ACTIVE POLICY";
const END = "END GEMINI AGENT ACTIVE POLICY";
const START_MARKER = `<!-- ${START} -->`;
const END_MARKER = `<!-- ${END} -->`;

async function tempHome() {
  return mkdtemp(join(tmpdir(), "gemini-agent-codex-global-"));
}

function modeBits(stats) {
  return stats.mode & 0o777;
}

async function makeSymlinkOrSkip(t, target, path, type) {
  try {
    await symlink(target, path, type);
    return true;
  } catch (error) {
    if (process.platform === "win32" || error.code === "EPERM") {
      t.skip("symlink creation is not available on this platform");
      return false;
    }
    throw error;
  }
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

test("malformed marker blocks fail closed without writing", async () => {
  const cases = [
    ["begin without end", ["# Existing", START_MARKER, "must stay"].join("\n")],
    ["end without begin", ["# Existing", END_MARKER, "must stay"].join("\n")],
    ["nested markers", ["# Existing", START_MARKER, "outer", START_MARKER, "inner", END_MARKER, END_MARKER, "must stay"].join("\n")],
    ["duplicate blocks", ["# Existing", START_MARKER, "one", END_MARKER, START_MARKER, "two", END_MARKER, "must stay"].join("\n")],
  ];

  for (const [name, content] of cases) {
    const home = await tempHome();
    await mkdir(join(home, ".codex"), { recursive: true });
    const target = join(home, ".codex", "AGENTS.md");
    await writeFile(target, `${content}\n`);

    await assert.rejects(
      applyCodexGlobalInstall({ home, mode: "active", write: true }),
      /Malformed GEMINI AGENT ACTIVE POLICY marker block.*manual/i,
      name,
    );
    assert.equal(await readFile(target, "utf8"), `${content}\n`);
  }
});

test("write creates AGENTS.md when it does not exist", async () => {
  const home = await tempHome();

  const result = await applyCodexGlobalInstall({ home, mode: "active", write: true });

  assert.equal(result.changed, true);
  assert.ok(result.backupPath);
  assert.match(await readFile(join(home, ".codex", "AGENTS.md"), "utf8"), new RegExp(START));
});

test("write backs up the latest apply-time target content", async () => {
  const home = await tempHome();
  await mkdir(join(home, ".codex"), { recursive: true });
  const target = join(home, ".codex", "AGENTS.md");
  await writeFile(target, "# Original\n");

  await planCodexGlobalInstall({ home, mode: "active" });
  await writeFile(target, "# Changed after plan\n");

  const result = await applyCodexGlobalInstall({ home, mode: "active", write: true });

  assert.ok(result.backupPath);
  assert.equal(await readFile(result.backupPath, "utf8"), "# Changed after plan\n");
});

test("existing target backup is the actual file replaced during install", async () => {
  const home = await tempHome();
  await mkdir(join(home, ".codex"), { recursive: true });
  const target = join(home, ".codex", "AGENTS.md");
  await writeFile(target, "# Existing\n");
  const originalStats = await stat(target);

  const result = await applyCodexGlobalInstall({ home, mode: "active", write: true });
  const backupStats = await stat(result.backupPath);

  assert.equal(await readFile(result.backupPath, "utf8"), "# Existing\n");
  assert.equal(backupStats.dev, originalStats.dev);
  assert.equal(backupStats.ino, originalStats.ino);
});

test("race-created target during commit is not overwritten", async () => {
  const home = await tempHome();
  const target = join(home, ".codex", "AGENTS.md");

  await assert.rejects(
    applyCodexGlobalInstall({
      home,
      mode: "active",
      write: true,
      testHooks: {
        beforeCommit: async () => {
          await writeFile(target, "race-created target\n");
        },
      },
    }),
    /changed during install|created during install|retry/i,
  );
  assert.equal(await readFile(target, "utf8"), "race-created target\n");
});

test("race-modified existing target during commit is not overwritten", async () => {
  const home = await tempHome();
  await mkdir(join(home, ".codex"), { recursive: true });
  const target = join(home, ".codex", "AGENTS.md");
  await writeFile(target, "# Existing\n");

  await assert.rejects(
    applyCodexGlobalInstall({
      home,
      mode: "active",
      write: true,
      testHooks: {
        beforeCommit: async () => {
          await writeFile(target, "# Race modified\n");
        },
      },
    }),
    /changed during install|retry/i,
  );
  assert.equal(await readFile(target, "utf8"), "# Race modified\n");
});

test("target AGENTS.md symlink is rejected without following it", async (t) => {
  const home = await tempHome();
  await mkdir(join(home, ".codex"), { recursive: true });
  const outsideTarget = join(home, "outside.md");
  await writeFile(outsideTarget, "outside stays unchanged\n");
  if (!await makeSymlinkOrSkip(t, outsideTarget, join(home, ".codex", "AGENTS.md"), "file")) return;

  await assert.rejects(
    applyCodexGlobalInstall({ home, mode: "active", write: true }),
    /symlink/i,
  );
  assert.equal(await readFile(outsideTarget, "utf8"), "outside stays unchanged\n");
});

test(".codex symlink is rejected", async (t) => {
  const home = await tempHome();
  const linkedDir = join(home, "linked-codex");
  await mkdir(linkedDir);
  if (!await makeSymlinkOrSkip(t, linkedDir, join(home, ".codex"), "dir")) return;

  await assert.rejects(
    applyCodexGlobalInstall({ home, mode: "active", write: true }),
    /symlink/i,
  );
});

test("backups symlink is rejected", async (t) => {
  const home = await tempHome();
  await mkdir(join(home, ".codex"), { recursive: true });
  await writeFile(join(home, ".codex", "AGENTS.md"), "# Existing\n");
  const linkedBackups = join(home, "linked-backups");
  await mkdir(linkedBackups);
  if (!await makeSymlinkOrSkip(t, linkedBackups, join(home, ".codex", "backups"), "dir")) return;

  await assert.rejects(
    applyCodexGlobalInstall({ home, mode: "active", write: true }),
    /symlink/i,
  );
});

test("active policy names commands, recursion guard, priorities, and runtime model", () => {
  for (const name of ["context-pack", "artifact-review", "plan-critique", "patch-precheck", "diff-review", "research-brief"]) {
    assert.match(ACTIVE_POLICY_BLOCK, new RegExp(name));
  }
  assert.match(ACTIVE_POLICY_BLOCK, /recursion guard/i);
  assert.match(ACTIVE_POLICY_BLOCK, /user instructions > Superpowers process gates > Codex execution\/verification > gemini-agent advice/);
  assert.match(ACTIVE_POLICY_BLOCK, /gemini-3\.5-flash/);
  assert.match(ACTIVE_POLICY_BLOCK, /external Gemini API calls/i);
  assert.match(ACTIVE_POLICY_BLOCK, /sensitive\/customer\/credential content/i);
});

test("active policy tells Codex how to safely reuse context packs for gates", () => {
  assert.match(ACTIVE_POLICY_BLOCK, /--context-pack <path>/);
  assert.match(ACTIVE_POLICY_BLOCK, /--auto-context-pack/);
  assert.match(ACTIVE_POLICY_BLOCK, /context-pack --bootstrap --write-artifact/);
  assert.match(ACTIVE_POLICY_BLOCK, /diff-review --smart-diff/);
  assert.match(ACTIVE_POLICY_BLOCK, /diff-review --auto-context-pack --diff/);
  assert.doesNotMatch(ACTIVE_POLICY_BLOCK, /For current branch review, prefer `gemini-agent diff-review --auto-context-pack --diff`/);
  assert.match(ACTIVE_POLICY_BLOCK, /\.gemini-agent\/context\/latest\.json/);
  assert.match(ACTIVE_POLICY_BLOCK, /project root/i);
  assert.match(ACTIVE_POLICY_BLOCK, /automatically runs `gemini-agent context-pack --bootstrap --write-artifact` first when the project-root pack is missing/i);
  assert.match(ACTIVE_POLICY_BLOCK, /stale or unrelated/i);
  assert.match(ACTIVE_POLICY_BLOCK, /refresh/i);
  assert.match(ACTIVE_POLICY_BLOCK, /narrow current input/i);
  for (const gate of ["plan-critique", "patch-precheck", "diff-review", "research-brief"]) {
    assert.match(ACTIVE_POLICY_BLOCK, new RegExp(`${gate}[\\s\\S]*--context-pack|--context-pack[\\s\\S]*${gate}`));
  }
});

test("unknown mode fails", async () => {
  await assert.rejects(
    planCodexGlobalInstall({ home: await tempHome(), mode: "passive" }),
    /Unknown install-codex-global mode: passive/,
  );
});
