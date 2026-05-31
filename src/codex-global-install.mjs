import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const START = "<!-- BEGIN GEMINI AGENT ACTIVE POLICY -->";
const END = "<!-- END GEMINI AGENT ACTIVE POLICY -->";

export const ACTIVE_POLICY_BLOCK = `${START}
## Gemini Agent Active Policy

Use gemini-agent actively when it can reduce Codex token consumption or add Gemini multimodal, design, context, research, or review judgment. Runtime Gemini calls should use \`gemini-3.5-flash\` unless a user or project policy says otherwise.

- \`context-pack\`: ask gemini-agent to compress large source context, diffs, logs, notes, or repository slices before Codex spends tokens reading everything.
- \`artifact-review\`: ask gemini-agent to inspect screenshots, UI states, diagrams, images, PDFs, and design artifacts before Codex changes code.
- \`plan-critique\`: ask gemini-agent to critique implementation plans, migration plans, or risky architecture choices before Codex edits.
- \`patch-precheck\`: ask gemini-agent to precheck broad or risky patch approaches before Codex applies them.
- \`diff-review\`: ask gemini-agent to review finished diffs before commits, releases, or handoff when an independent review would reduce risk.
- \`research-brief\`: ask gemini-agent for compact sourced research briefs when current or external context is useful.

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

function replaceMarkerBlock(content, block) {
  const startIndex = content.indexOf(START);
  const endIndex = content.indexOf(END);

  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    const before = content.slice(0, startIndex).replace(/[ \t]+$/u, "");
    const rawAfter = content.slice(endIndex + END.length);
    const after = rawAfter.trim() ? rawAfter.replace(/^\n*/u, "\n") : "";
    return `${before}${block}${after}`.replace(/\n{3,}/gu, "\n\n");
  }

  const prefix = content.trimEnd();
  if (!prefix) return block;
  return `${prefix}\n\n${block}`;
}

export async function planCodexGlobalInstall({ home, mode = "active" } = {}) {
  assertSupportedMode(mode);
  if (!home) throw new Error("home is required.");

  const targetPath = join(home, ".codex", "AGENTS.md");
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
} = {}) {
  const plan = await planCodexGlobalInstall({ home, mode });
  if (!write || !plan.changed) {
    return { ...plan, backupPath: null };
  }

  const codexDir = join(home, ".codex");
  const backupsDir = join(codexDir, "backups");
  await mkdir(backupsDir, { recursive: true, mode: 0o700 });
  await chmod(codexDir, 0o700);
  await chmod(backupsDir, 0o700);

  const stamp = now.toISOString().replace(/[:.]/gu, "-");
  const backupPath = join(backupsDir, `AGENTS.md.${stamp}.${randomUUID()}.bak`);
  await writeFile(backupPath, plan.currentContent, { mode: 0o600 });
  await chmod(backupPath, 0o600);

  const tmpPath = join(codexDir, `.AGENTS.md.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(tmpPath, plan.nextContent, { mode: 0o600 });
  await chmod(tmpPath, 0o600);
  await rename(tmpPath, plan.targetPath);
  await chmod(plan.targetPath, 0o600);

  return { ...plan, backupPath };
}
