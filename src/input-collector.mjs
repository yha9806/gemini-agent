import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { promisify } from "node:util";
import { createPartFromBase64 } from "@google/genai";

export const DEFAULT_TEXT_LIMIT_BYTES = 4 * 1024 * 1024;
export const DEFAULT_IMAGE_LIMIT_BYTES = 20 * 1024 * 1024;

const execFileAsync = promisify(execFile);

const ARTIFACT_MIME_BY_EXTENSION = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".pdf", "application/pdf"],
]);

function hasPngMagic(buffer) {
  return buffer.subarray(0, 8).equals(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
}

function hasJpegMagic(buffer) {
  return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}

function hasWebpMagic(buffer) {
  return (
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  );
}

function magicMatchesMime(buffer, mimeType) {
  if (mimeType === "image/png") return hasPngMagic(buffer);
  if (mimeType === "image/jpeg") return hasJpegMagic(buffer);
  if (mimeType === "image/webp") return hasWebpMagic(buffer);
  return false;
}

function labelledSection(source, text) {
  return `--- Source: ${source} ---\n${text.trim()}`;
}

export async function currentGitDiff({
  cwd = process.cwd(),
  runner = execFileAsync,
} = {}) {
  const { stdout } = await runner("git", ["diff", "--no-ext-diff"], { cwd });
  return stdout;
}

export async function collectTextInput({
  stdinText = "",
  files = [],
  diff = false,
  cwd = process.cwd(),
  maxTextBytes = DEFAULT_TEXT_LIMIT_BYTES,
  runner,
} = {}) {
  const sections = [];
  const sources = [];

  if (stdinText.trim()) {
    sections.push(labelledSection("stdin", stdinText));
    sources.push("stdin");
  }

  for (const filePath of files) {
    const content = await readFile(filePath, "utf8");
    if (!content.trim()) continue;

    sections.push(labelledSection(filePath, content));
    sources.push(filePath);
  }

  if (diff) {
    const diffText = await currentGitDiff({ cwd, runner });
    if (diffText.trim()) {
      sections.push(labelledSection("git diff", diffText));
      sources.push("git diff");
    }
  }

  if (sections.length === 0) {
    throw new Error("Context input is empty.");
  }

  const input = `${sections.join("\n\n")}\n`;
  const sizeBytes = Buffer.byteLength(input, "utf8");
  if (sizeBytes > maxTextBytes) {
    throw new Error(`Context input exceeds ${maxTextBytes} bytes.`);
  }

  return { input, sources, omittedSources: [], sizeBytes };
}

export function detectArtifactMime(path) {
  const mimeType = ARTIFACT_MIME_BY_EXTENSION.get(extname(path).toLowerCase());

  if (!mimeType) {
    throw new Error("Unsupported artifact type.");
  }

  return mimeType;
}

export async function imagePartFromFile(
  path,
  { maxImageBytes = DEFAULT_IMAGE_LIMIT_BYTES } = {},
) {
  const mimeType = detectArtifactMime(path);
  if (!mimeType.startsWith("image/")) {
    throw new Error("Only PNG, JPEG, and WEBP artifacts can be inlined.");
  }

  const { size } = await stat(path);
  if (size > maxImageBytes) {
    throw new Error(`Image artifact exceeds ${maxImageBytes} bytes.`);
  }

  const content = await readFile(path);
  if (!magicMatchesMime(content, mimeType)) {
    throw new Error("File does not match claimed image MIME.");
  }

  return createPartFromBase64(content.toString("base64"), mimeType);
}
