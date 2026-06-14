import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
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

test("prototype relative paths cannot escape prototype directory", () => {
  assert.equal(assertPrototypeRelativePath("preview.html"), "preview.html");
  assert.throws(() => assertPrototypeRelativePath("../src/app.js"), /Prototype file path must stay/);
  assert.throws(() => assertPrototypeRelativePath("/tmp/preview.html"), /Prototype file path must stay/);
});
