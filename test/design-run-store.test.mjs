import assert from "node:assert/strict";
import test from "node:test";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  assertPrototypeRelativePath,
  createDesignRun,
  designRunRoot,
  readDesignRunId,
  resolveDesignRun,
  safeRunId,
  writeDesignJson,
  writePrototypeFiles,
} from "../src/design-run-store.mjs";

test("creates unique run directories under .gemini-agent/design", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "design-run-store-"));
  try {
    const first = await createDesignRun({ cwd, now: new Date("2026-06-14T12:00:00.000Z"), random: () => "abcdef" });
    const second = await createDesignRun({ cwd, now: new Date("2026-06-14T12:00:00.000Z"), random: () => "abcdeg" });
    assert.match(first.runId, /^20260614T120000000Z-[A-Za-z0-9]{6,}$/);
    assert.notEqual(first.runId, second.runId);
    assert.equal(relative(designRunRoot(cwd), first.dir).startsWith(".."), false);
    assert.equal(await readDesignRunId(first.dir), first.runId);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("rejects unsafe run ids and escaping paths", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "design-run-store-"));
  try {
    assert.throws(() => safeRunId("../bad"), /Unsafe design run id/);
    assert.throws(() => safeRunId("20260614T120000000Z-abc/def"), /Unsafe design run id/);
    assert.throws(() => safeRunId("20260614T120000000Z-abc\u0000def"), /Unsafe design run id/);
    assert.throws(() => resolveDesignRun({ cwd, run: "../outside" }), /Design run path must stay/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("writes JSON artifacts and prototype files atomically", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "design-run-store-"));
  try {
    const run = await createDesignRun({ cwd, now: new Date("2026-06-14T12:00:00.000Z"), random: () => "abcdef" });
    await writeDesignJson({ runDir: run.dir, relativePath: "brief.json", value: { run_id: run.runId, ok: true } });
    assert.deepEqual(JSON.parse(await readFile(join(run.dir, "brief.json"), "utf8")), { run_id: run.runId, ok: true });
    assert.equal(await readDesignRunId(run.dir), run.runId);

    await writePrototypeFiles({
      runDir: run.dir,
      files: {
        "preview.html": "<!doctype html><title>Preview</title>",
        "review-notes.md": "# Review\n",
      },
    });
    assert.deepEqual((await readdir(join(run.dir, "prototype"))).sort(), ["preview.html", "review-notes.md"]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("prototype writes publish complete versions by symlink pointer swap", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "design-run-store-"));
  try {
    const run = await createDesignRun({ cwd, now: new Date("2026-06-14T12:00:00.000Z"), random: () => "abcdef" });
    await writePrototypeFiles({
      runDir: run.dir,
      files: {
        "old.html": "<!doctype html><title>Old</title>",
        "shared.txt": "old",
      },
    });
    assert.equal((await lstat(join(run.dir, "prototype"))).isSymbolicLink(), true);

    await writePrototypeFiles({
      runDir: run.dir,
      files: {
        "new.html": "<!doctype html><title>New</title>",
        "shared.txt": "new",
      },
    });

    assert.equal((await lstat(join(run.dir, "prototype"))).isSymbolicLink(), true);
    assert.deepEqual((await readdir(join(run.dir, "prototype"))).sort(), ["new.html", "shared.txt"]);
    assert.equal(await readFile(join(run.dir, "prototype", "shared.txt"), "utf8"), "new");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("writePrototypeFiles rejects unmanaged prototype directories before writing a version", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "design-run-store-"));
  try {
    const run = await createDesignRun({ cwd, now: new Date("2026-06-14T12:00:00.000Z"), random: () => "abcdef" });
    await mkdir(join(run.dir, "prototype", "old"), { recursive: true });
    await writeFile(join(run.dir, "prototype", "old", "old.txt"), "legacy");

    await assert.rejects(
      () => writePrototypeFiles({ runDir: run.dir, files: { "preview.html": "<!doctype html>" } }),
      /unmanaged prototype directory|cannot safely replace/i,
    );

    assert.equal(await readFile(join(run.dir, "prototype", "old", "old.txt"), "utf8"), "legacy");
    assert.deepEqual(await readdir(join(run.dir, "prototype")), ["old"]);
    const prototypeStat = await lstat(join(run.dir, "prototype"));
    assert.equal(prototypeStat.isDirectory(), true);
    assert.equal(prototypeStat.isSymbolicLink(), false);
    await assert.rejects(() => lstat(join(run.dir, ".prototype-versions")), { code: "ENOENT" });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("writeDesignJson rejects symlinked path components inside run directory", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "design-run-store-"));
  const outside = await mkdtemp(join(tmpdir(), "design-run-store-outside-"));
  try {
    const run = await createDesignRun({ cwd, now: new Date("2026-06-14T12:00:00.000Z"), random: () => "abcdef" });
    await symlink(outside, join(run.dir, "link"));

    await assert.rejects(
      () => writeDesignJson({ runDir: run.dir, relativePath: "link/leak.json", value: { leaked: true } }),
      /Design artifact path must not include symlinks/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("failed writeDesignJson before rename preserves existing JSON artifact", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "design-run-store-"));
  try {
    const run = await createDesignRun({ cwd, now: new Date("2026-06-14T12:00:00.000Z"), random: () => "abcdef" });
    const target = join(run.dir, "brief.json");
    await writeDesignJson({ runDir: run.dir, relativePath: "brief.json", value: { version: "old" } });

    await assert.rejects(
      () => writeDesignJson({
        runDir: run.dir,
        relativePath: "brief.json",
        value: { version: "new" },
        testHooks: {
          beforeRename: () => {
            throw new Error("simulated interruption before rename");
          },
        },
      }),
      /simulated interruption before rename/,
    );

    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), { version: "old" });
    assert.deepEqual(
      (await readdir(run.dir)).filter((name) => name.includes(".tmp")),
      [],
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("createDesignRun rejects a symlinked design root", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "design-run-store-"));
  const outside = await mkdtemp(join(tmpdir(), "design-run-store-outside-"));
  try {
    await mkdir(join(cwd, ".gemini-agent"), { recursive: true });
    await symlink(outside, join(cwd, ".gemini-agent", "design"));

    await assert.rejects(
      () => createDesignRun({ cwd, now: new Date("2026-06-14T12:00:00.000Z"), random: () => "abcdef" }),
      /Design run path must not include symlinks/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("writePrototypeFiles rejects symlinked version storage", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "design-run-store-"));
  const outside = await mkdtemp(join(tmpdir(), "design-run-store-outside-"));
  try {
    const run = await createDesignRun({ cwd, now: new Date("2026-06-14T12:00:00.000Z"), random: () => "abcdef" });
    await symlink(outside, join(run.dir, ".prototype-versions"));

    await assert.rejects(
      () => writePrototypeFiles({ runDir: run.dir, files: { "preview.html": "<!doctype html>" } }),
      /Prototype version path must not include symlinks/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("failed prototype version write preserves existing published prototype", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "design-run-store-"));
  try {
    const run = await createDesignRun({ cwd, now: new Date("2026-06-14T12:00:00.000Z"), random: () => "abcdef" });
    await writePrototypeFiles({ runDir: run.dir, files: { "shared.txt": "old" } });

    await assert.rejects(
      () => writePrototypeFiles({
        runDir: run.dir,
        files: {
          "nested/file.txt": "new",
          "nested": "conflict",
        },
      }),
      /EISDIR|illegal operation|directory/i,
    );

    assert.equal(await readFile(join(run.dir, "prototype", "shared.txt"), "utf8"), "old");
    assert.deepEqual(await readdir(join(run.dir, "prototype")), ["shared.txt"]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("prototype relative paths cannot escape prototype directory", () => {
  assert.equal(assertPrototypeRelativePath("preview.html"), "preview.html");
  assert.throws(() => assertPrototypeRelativePath("../src/app.js"), /Prototype file path must stay/);
  assert.throws(() => assertPrototypeRelativePath("/tmp/preview.html"), /Prototype file path must stay/);
});
