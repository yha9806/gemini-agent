import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureArtifactGitignore,
  readLatestArtifact,
  writeJsonArtifact,
} from "../src/artifact-store.mjs";

test("writeJsonArtifact writes timestamped file and latest atomically", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-store-"));
  const now = new Date("2026-05-28T12:00:00.000Z");
  const artifact = { kind: "context_pack", value: 1 };

  const result = await writeJsonArtifact({
    cwd: dir,
    category: "context",
    artifact,
    now,
  });

  assert.match(result.latestPath, /\.gemini-agent\/context\/latest\.json$/);
  assert.match(result.timestampedPath, /2026-05-28T120000000Z-context\.json$/);

  const latest = JSON.parse(await readFile(result.latestPath, "utf8"));
  const timestamped = JSON.parse(await readFile(result.timestampedPath, "utf8"));
  assert.deepEqual(latest, artifact);
  assert.deepEqual(timestamped, artifact);
});

test("writeJsonArtifact keeps same-timestamp artifacts distinct", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-store-"));
  const now = new Date("2026-05-28T12:00:00.000Z");
  const first = { kind: "context_pack", value: 1 };
  const second = { kind: "context_pack", value: 2 };

  const firstResult = await writeJsonArtifact({
    cwd: dir,
    category: "context",
    artifact: first,
    now,
  });
  const secondResult = await writeJsonArtifact({
    cwd: dir,
    category: "context",
    artifact: second,
    now,
  });

  assert.notEqual(firstResult.timestampedPath, secondResult.timestampedPath);
  assert.deepEqual(
    JSON.parse(await readFile(firstResult.timestampedPath, "utf8")),
    first,
  );
  assert.deepEqual(
    JSON.parse(await readFile(secondResult.timestampedPath, "utf8")),
    second,
  );
});

test("writeJsonArtifact rejects unsafe artifact categories", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-store-"));

  for (const category of ["", "..", "context/foo", "context\\foo"]) {
    await assert.rejects(
      () => writeJsonArtifact({
        cwd: dir,
        category,
        artifact: { kind: "context_pack" },
      }),
      /Artifact category must be a safe path segment/,
      category,
    );
  }
});

test("readLatestArtifact returns null when latest artifact is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-store-"));
  const artifact = await readLatestArtifact({ cwd: dir, category: "context" });
  assert.equal(artifact, null);
});

test("ensureArtifactGitignore appends gemini artifact directory once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-store-"));
  const gitignore = join(dir, ".gitignore");
  await writeFile(gitignore, "node_modules/\n");

  await ensureArtifactGitignore(dir);
  await ensureArtifactGitignore(dir);

  const content = await readFile(gitignore, "utf8");
  assert.match(content, /node_modules\/\n/);
  assert.equal(content.split(".gemini-agent/").length - 1, 1);
});

test("writeJsonArtifact surfaces filesystem errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-store-"));
  await writeFile(join(dir, ".gemini-agent"), "not a directory");

  await assert.rejects(
    () => writeJsonArtifact({
      cwd: dir,
      category: "context",
      artifact: { kind: "context_pack" },
    }),
    /ENOTDIR|EEXIST/,
  );
});
