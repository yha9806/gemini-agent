import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  collectTextInput,
  currentGitDiff,
  DEFAULT_IMAGE_LIMIT_BYTES,
  DEFAULT_TEXT_LIMIT_BYTES,
  detectArtifactMime,
  imagePartFromFile,
} from "../src/input-collector.mjs";

const pngBytes = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
]);

test("collectTextInput combines stdin text and file content with source labels", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-input-"));
  const filePath = join(dir, "notes.txt");
  await writeFile(filePath, "file context\n");

  const result = await collectTextInput({
    stdinText: "stdin context\n",
    files: [filePath],
    cwd: dir,
  });

  assert.match(result.input, /--- Source: stdin ---\nstdin context/);
  assert.match(
    result.input,
    new RegExp(
      `--- Source: ${filePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} ---\\nfile context`,
    ),
  );
  assert.deepEqual(result.sources, ["stdin", filePath]);
  assert.deepEqual(result.omittedSources, []);
  assert.equal(result.sizeBytes, Buffer.byteLength(result.input, "utf8"));
});

test("collectTextInput reads relative file paths from cwd", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-input-"));
  await writeFile(join(dir, "note.md"), "cwd relative context\n");

  const result = await collectTextInput({
    cwd: dir,
    files: ["note.md"],
  });

  assert.match(
    result.input,
    /--- Source: note\.md ---\ncwd relative context\n$/,
  );
  assert.deepEqual(result.sources, ["note.md"]);
});

test("collectTextInput rejects empty input", async () => {
  await assert.rejects(
    () => collectTextInput({ stdinText: "", files: [] }),
    /Context input is empty/,
  );
});

test("collectTextInput enforces byte cap", async () => {
  await assert.rejects(
    () => collectTextInput({ stdinText: "too large", maxTextBytes: 5 }),
    /Context input exceeds 5 bytes\./,
  );
});

test("collectTextInput includes labelled git diff from injected runner", async () => {
  const calls = [];
  const stdout = "diff --git a/src/app.mjs b/src/app.mjs\n+changed\n";

  const result = await collectTextInput({
    diff: true,
    cwd: "/repo",
    runner: async (...args) => {
      calls.push(args);
      return { stdout };
    },
  });

  assert.match(result.input, /--- Source: git diff ---\ndiff --git/);
  assert.match(result.input, /\+changed\n$/);
  assert.deepEqual(result.sources, ["git diff"]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 2), ["git", ["diff", "--no-ext-diff"]]);
  assert.equal(calls[0][2].cwd, "/repo");
  assert.equal(calls[0][2].encoding, "utf8");
  assert.ok(calls[0][2].maxBuffer >= DEFAULT_TEXT_LIMIT_BYTES);
});

test("currentGitDiff uses injected runner and returns stdout", async () => {
  const calls = [];
  const stdout = "diff --git a/file b/file\n";
  const result = await currentGitDiff({
    cwd: "/repo",
    runner: async (...args) => {
      calls.push(args);
      return { stdout };
    },
  });

  assert.equal(result, stdout);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 2), ["git", ["diff", "--no-ext-diff"]]);
  assert.equal(calls[0][2].cwd, "/repo");
  assert.equal(calls[0][2].encoding, "utf8");
  assert.ok(calls[0][2].maxBuffer >= DEFAULT_TEXT_LIMIT_BYTES);
});

test("currentGitDiff gives git diff a buffer at least as large as the text cap", async () => {
  const calls = [];

  await currentGitDiff({
    cwd: "/repo",
    runner: async (...args) => {
      calls.push(args);
      return { stdout: "" };
    },
  });

  assert.equal(calls.length, 1);
  assert.ok(calls[0][2].maxBuffer >= DEFAULT_TEXT_LIMIT_BYTES);
});

test("exports default text and image byte limits", () => {
  assert.equal(DEFAULT_TEXT_LIMIT_BYTES, 4 * 1024 * 1024);
  assert.equal(DEFAULT_IMAGE_LIMIT_BYTES, 20 * 1024 * 1024);
});

test("detectArtifactMime accepts design.PNG, photo.jpeg, mock.webp, paper.pdf", () => {
  assert.equal(detectArtifactMime("design.PNG"), "image/png");
  assert.equal(detectArtifactMime("photo.jpg"), "image/jpeg");
  assert.equal(detectArtifactMime("photo.jpeg"), "image/jpeg");
  assert.equal(detectArtifactMime("mock.webp"), "image/webp");
  assert.equal(detectArtifactMime("paper.pdf"), "application/pdf");
});

test("detectArtifactMime rejects archive.zip and README", () => {
  assert.throws(
    () => detectArtifactMime("archive.zip"),
    /Unsupported artifact type/,
  );
  assert.throws(() => detectArtifactMime("README"), /Unsupported artifact type/);
});

test("imagePartFromFile returns inline base64 image part using real PNG magic bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-image-"));
  const imagePath = join(dir, "design.png");
  await writeFile(imagePath, pngBytes);

  const part = await imagePartFromFile(imagePath);

  assert.deepEqual(part, {
    inlineData: {
      data: pngBytes.toString("base64"),
      mimeType: "image/png",
    },
  });
});

test("imagePartFromFile rejects files whose bytes do not match extension", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-image-"));
  const imagePath = join(dir, "design.png");
  await writeFile(imagePath, "not a png");

  await assert.rejects(
    () => imagePartFromFile(imagePath),
    /does not match claimed image MIME/,
  );
});

test("imagePartFromFile rejects PDF as not an inline image", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-image-"));
  const pdfPath = join(dir, "paper.pdf");
  await writeFile(pdfPath, "%PDF-1.7\n");

  await assert.rejects(
    () => imagePartFromFile(pdfPath),
    /Only PNG, JPEG, and WEBP artifacts can be inlined/,
  );
});

test("imagePartFromFile rejects oversized image before returning part", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-image-"));
  const imagePath = join(dir, "design.png");
  await writeFile(imagePath, pngBytes);

  await assert.rejects(
    () => imagePartFromFile(imagePath, { maxImageBytes: pngBytes.length - 1 }),
    /Image artifact exceeds 8 bytes\./,
  );
});
