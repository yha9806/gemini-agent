import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveWorkspaceFilePath } from "../src/workspace-paths.mjs";

test("resolveWorkspaceFilePath accepts relative files inside cwd", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "workspace-paths-"));
  try {
    await mkdir(join(cwd, "screens"), { recursive: true });
    await writeFile(join(cwd, "screens", "home.png"), "png");
    const result = await resolveWorkspaceFilePath("screens/home.png", { cwd });
    assert.equal(result.endsWith("/screens/home.png"), true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("resolveWorkspaceFilePath rejects absolute paths and dot-dot traversal", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "workspace-paths-"));
  try {
    await assert.rejects(
      () => resolveWorkspaceFilePath("/tmp/outside.png", { cwd }),
      /Reference paths must be relative/,
    );
    await assert.rejects(
      () => resolveWorkspaceFilePath("../outside.png", { cwd }),
      /Reference path must stay inside cwd/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("resolveWorkspaceFilePath rejects symlink escapes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "workspace-paths-"));
  const outside = await mkdtemp(join(tmpdir(), "workspace-paths-outside-"));
  try {
    await writeFile(join(outside, "secret.png"), "secret");
    await symlink(join(outside, "secret.png"), join(cwd, "linked.png"));
    await assert.rejects(
      () => resolveWorkspaceFilePath("linked.png", { cwd }),
      /Reference path must stay inside cwd/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("resolveWorkspaceFilePath reports missing reference files clearly", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "workspace-paths-"));
  try {
    await assert.rejects(
      () => resolveWorkspaceFilePath("missing.png", { cwd }),
      /Reference file not found/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
