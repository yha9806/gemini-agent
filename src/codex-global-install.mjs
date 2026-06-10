import { chmod, link, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const START = "<!-- BEGIN GEMINI AGENT ACTIVE POLICY -->";
const END = "<!-- END GEMINI AGENT ACTIVE POLICY -->";

export const ACTIVE_POLICY_BLOCK = `${START}
## Gemini Agent Active Policy

Use gemini-agent actively when it can reduce Codex token consumption or add Gemini multimodal, design, context, research, or review judgment. Runtime Gemini calls should use \`gemini-3.5-flash\` unless a user or project policy says otherwise.

Only send large source, diffs, logs, images, PDFs, or other content to gemini-agent when user instructions, project policy, or the current telemetry/raw-content configuration permits external Gemini API calls and sending that relevant content. Sensitive/customer/credential content must follow project data policy; ask the user first when the policy is unclear.

- \`context-pack\`: ask gemini-agent to compress large source context, diffs, logs, notes, or repository slices before Codex spends tokens reading everything.
- \`artifact-review\`: ask gemini-agent to inspect screenshots, UI states, diagrams, images, PDFs, and design artifacts before Codex changes code.
- \`plan-critique\`: ask gemini-agent to critique implementation plans, migration plans, or risky architecture choices before Codex edits.
- \`patch-precheck\`: ask gemini-agent to precheck broad or risky patch approaches before Codex applies them.
- \`diff-review\`: ask gemini-agent to review finished diffs before commits, releases, or handoff when an independent review would reduce risk.
- \`research-brief\`: ask gemini-agent for compact sourced research briefs when current or external context is useful.

Context-pack reuse: when a relevant context pack already exists, pass it to \`plan-critique\`, \`patch-precheck\`, \`diff-review\`, or \`research-brief\` instead of resending the same raw project slice. Prefer \`--auto-context-pack\` for the project root artifact \`.gemini-agent/context/latest.json\`, or \`--context-pack <path>\` for a specific pack. If the pack is missing, stale, or unrelated to the current task, run \`gemini-agent context-pack --bootstrap --write-artifact\` from the project root to regenerate it from the bounded root-file allowlist and current git diff. Add only narrow current input on stdin or \`--diff\` when the gate needs fresh details beyond the pack, and keep combined input bounded.

Priority: user instructions > Superpowers process gates > Codex execution/verification > gemini-agent advice.
Codex remains the execution authority for direct edits, tests, verification, commits, rollback decisions, and final claims. Gemini-agent gives advice and summaries; it does not directly edit, test, or commit.
Recursion guard: do not call gemini-agent merely to review or summarize another gemini-agent response unless the user explicitly asks or a project gate requires it.
${END}
`;

function assertSupportedMode(mode) {
  if (mode !== "active") {
    throw new Error(`Unknown install-codex-global mode: ${mode}`);
  }
}

async function readExisting(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

function markerError() {
  return new Error("Malformed GEMINI AGENT ACTIVE POLICY marker block. Please manually repair ~/.codex/AGENTS.md before running install-codex-global.");
}

function markerIndexes(content, marker) {
  const indexes = [];
  let offset = 0;
  while (offset < content.length) {
    const index = content.indexOf(marker, offset);
    if (index === -1) break;
    indexes.push(index);
    offset = index + marker.length;
  }
  return indexes;
}

function replaceMarkerBlock(content, block) {
  const startIndexes = markerIndexes(content, START);
  const endIndexes = markerIndexes(content, END);

  if (startIndexes.length === 0 && endIndexes.length === 0) {
    const prefix = content.trimEnd();
    if (!prefix) return block;
    return `${prefix}\n\n${block}`;
  }

  if (
    startIndexes.length !== 1
    || endIndexes.length !== 1
    || endIndexes[0] <= startIndexes[0]
  ) {
    throw markerError();
  }

  const before = content.slice(0, startIndexes[0]).replace(/[ \t]+$/u, "");
  const rawAfter = content.slice(endIndexes[0] + END.length);
  const after = rawAfter.trim() ? rawAfter.replace(/^\n*/u, "\n") : "";
  return `${before}${block}${after}`.replace(/\n{3,}/gu, "\n\n");
}

async function maybeLstat(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function assertSafeExistingPath(stats, label, expectedType) {
  if (!stats) return;
  if (stats.isSymbolicLink()) {
    throw new Error(`${label} must not be a symlink.`);
  }
  if (expectedType === "directory" && !stats.isDirectory()) {
    throw new Error(`${label} must be a directory.`);
  }
  if (expectedType === "file" && !stats.isFile()) {
    throw new Error(`${label} must be a regular file.`);
  }
}

async function assertSafePlanPaths({ codexDir, backupsDir, targetPath }) {
  const codexStats = await maybeLstat(codexDir);
  assertSafeExistingPath(codexStats, "~/.codex", "directory");
  const backupsStats = await maybeLstat(backupsDir);
  assertSafeExistingPath(backupsStats, "~/.codex/backups", "directory");
  const targetStats = await maybeLstat(targetPath);
  assertSafeExistingPath(targetStats, "~/.codex/AGENTS.md", "file");
}

async function ensureSafeDirectory(path, label) {
  const stats = await maybeLstat(path);
  assertSafeExistingPath(stats, label, "directory");
  if (!stats) {
    await mkdir(path, { mode: 0o700 });
  }
  await chmod(path, 0o700);
}

function sameTargetState(before, after) {
  if (!before && !after) return true;
  if (!before || !after) return false;
  return (
    before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs
  );
}

async function readCurrentTarget(targetPath) {
  const beforeStats = await maybeLstat(targetPath);
  assertSafeExistingPath(beforeStats, "~/.codex/AGENTS.md", "file");
  const currentContent = await readExisting(targetPath);
  const afterStats = await maybeLstat(targetPath);
  assertSafeExistingPath(afterStats, "~/.codex/AGENTS.md", "file");
  if (!sameTargetState(beforeStats, afterStats)) {
    throw new Error("~/.codex/AGENTS.md changed during install. Please retry install-codex-global.");
  }
  return { currentContent, targetStats: afterStats };
}

function changedDuringInstallError() {
  return new Error("~/.codex/AGENTS.md changed during install. Please retry install-codex-global.");
}

function createdDuringInstallError() {
  return new Error("~/.codex/AGENTS.md was created during install. Please retry install-codex-global.");
}

async function restoreBackupIfTargetMissing({ backupPath, targetPath }) {
  const targetStats = await maybeLstat(targetPath);
  if (targetStats) return false;
  await rename(backupPath, targetPath);
  await chmod(targetPath, 0o600);
  return true;
}

async function moveCurrentTargetToBackup({ targetPath, backupPath, targetStats, currentContent }) {
  try {
    await rename(targetPath, backupPath);
  } catch (error) {
    if (error.code === "ENOENT") throw changedDuringInstallError();
    throw error;
  }
  const backupStats = await maybeLstat(backupPath);
  assertSafeExistingPath(backupStats, "~/.codex/AGENTS.md backup", "file");
  await chmod(backupPath, 0o600);
  const backupContent = await readFile(backupPath, "utf8");
  if (!sameTargetState(targetStats, backupStats) || backupContent !== currentContent) {
    await restoreBackupIfTargetMissing({ backupPath, targetPath });
    throw changedDuringInstallError();
  }
}

async function linkTmpToTargetNoClobber({ tmpPath, targetPath }) {
  try {
    await link(tmpPath, targetPath);
  } catch (error) {
    if (error.code === "EEXIST") throw createdDuringInstallError();
    throw error;
  }
  await chmod(targetPath, 0o600);
}

export async function planCodexGlobalInstall({ home, mode = "active" } = {}) {
  assertSupportedMode(mode);
  if (!home) throw new Error("home is required.");

  const targetPath = join(home, ".codex", "AGENTS.md");
  await assertSafePlanPaths({
    codexDir: join(home, ".codex"),
    backupsDir: join(home, ".codex", "backups"),
    targetPath,
  });
  const currentContent = await readExisting(targetPath);
  const nextContent = replaceMarkerBlock(currentContent, ACTIVE_POLICY_BLOCK);

  return {
    targetPath,
    currentContent,
    nextContent,
    changed: currentContent !== nextContent,
  };
}

export async function applyCodexGlobalInstall({
  home,
  mode = "active",
  write = false,
  now = new Date(),
  testHooks = {},
} = {}) {
  assertSupportedMode(mode);
  if (!home) throw new Error("home is required.");
  const codexDir = join(home, ".codex");
  const backupsDir = join(codexDir, "backups");
  const targetPath = join(codexDir, "AGENTS.md");

  if (!write) {
    return { ...(await planCodexGlobalInstall({ home, mode })), backupPath: null };
  }

  await ensureSafeDirectory(codexDir, "~/.codex");
  await ensureSafeDirectory(backupsDir, "~/.codex/backups");

  const { currentContent, targetStats } = await readCurrentTarget(targetPath);
  const nextContent = replaceMarkerBlock(currentContent, ACTIVE_POLICY_BLOCK);
  const changed = currentContent !== nextContent;
  const result = {
    targetPath,
    currentContent,
    nextContent,
    changed,
  };
  if (!changed) {
    return { ...result, backupPath: null };
  }

  const stamp = now.toISOString().replace(/[:.]/gu, "-");
  const backupPath = join(backupsDir, `AGENTS.md.${stamp}.${randomUUID()}.bak`);

  const tmpPath = join(codexDir, `.AGENTS.md.${process.pid}.${randomUUID()}.tmp`);
  let targetMovedToBackup = false;
  try {
    await writeFile(tmpPath, nextContent, { mode: 0o600, flag: "wx" });
    await chmod(tmpPath, 0o600);
    await testHooks.beforeCommit?.({ backupPath, targetPath, tmpPath });

    if (targetStats) {
      await moveCurrentTargetToBackup({ targetPath, backupPath, targetStats, currentContent });
      targetMovedToBackup = true;
    } else {
      await writeFile(backupPath, "", { mode: 0o600, flag: "wx" });
      await chmod(backupPath, 0o600);
    }

    await linkTmpToTargetNoClobber({ tmpPath, targetPath });
    await rm(tmpPath, { force: true });
  } catch (error) {
    await rm(tmpPath, { force: true });
    if (targetMovedToBackup) {
      const targetNow = await maybeLstat(targetPath);
      if (!targetNow) {
        await restoreBackupIfTargetMissing({ backupPath, targetPath });
      }
    }
    throw error;
  }

  return { ...result, backupPath };
}
