import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  collectTextInput,
  currentGitDiff,
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
  assert.deepEqual(calls, [
    ["git", ["diff", "--no-ext-diff"], { cwd: "/repo" }],
  ]);
});

test("detectArtifactMime accepts design.PNG, photo.jpeg, mock.webp, paper.pdf", () => {
  assert.equal(detectArtifactMime("design.PNG"), "image/png");
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
