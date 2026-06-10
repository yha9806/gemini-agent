import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { promisify, TextDecoder } from "node:util";
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

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

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

function sectionSize(source, byteLength) {
  return Buffer.byteLength(`--- Source: ${source} ---\n`, "utf8") + byteLength + 2;
}

function assertInsideCwd(resolvedCwd, resolvedFilePath) {
  const relativePath = relative(resolvedCwd, resolvedFilePath);
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error("File path must stay within cwd.");
  }
}

export function resolveCwdFilePath(filePath, { cwd = process.cwd() } = {}) {
  const path = String(filePath ?? "");
  if (!path || path.includes("\0")) {
    throw new Error("File path must be a relative path within cwd.");
  }
  if (isAbsolute(path)) {
    throw new Error("File path must be relative to cwd.");
  }

  const resolvedCwd = resolve(cwd);
  const resolvedFilePath = resolve(resolvedCwd, path);
  assertInsideCwd(resolvedCwd, resolvedFilePath);
  return resolvedFilePath;
}

function decodeUtf8FileContent(buffer, source) {
  if (buffer.includes(0)) {
    throw new Error(`File appears to be binary: ${source}`);
  }

  try {
    return utf8Decoder.decode(buffer);
  } catch {
    throw new Error(`File is not valid UTF-8 text: ${source}`);
  }
}

export async function currentGitDiff({
  cwd = process.cwd(),
  runner = execFileAsync,
} = {}) {
  const { stdout } = await runner("git", ["diff", "--no-ext-diff"], {
    cwd,
    encoding: "utf8",
    maxBuffer: DEFAULT_TEXT_LIMIT_BYTES + 64 * 1024,
  });
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
  let estimatedSizeBytes = 0;

  if (stdinText.trim()) {
    sections.push(labelledSection("stdin", stdinText));
    sources.push("stdin");
    estimatedSizeBytes += sectionSize("stdin", Buffer.byteLength(stdinText, "utf8"));
    if (estimatedSizeBytes > maxTextBytes) {
      throw new Error(`Context input exceeds ${maxTextBytes} bytes.`);
    }
  }

  for (const filePath of files) {
    const resolvedFilePath = resolveCwdFilePath(filePath, { cwd });
    const { size } = await stat(resolvedFilePath);
    if (size > maxTextBytes || estimatedSizeBytes + sectionSize(filePath, size) > maxTextBytes) {
      throw new Error(`Context input exceeds ${maxTextBytes} bytes.`);
    }

    const content = decodeUtf8FileContent(await readFile(resolvedFilePath), filePath);
    if (!content.trim()) continue;

    sections.push(labelledSection(filePath, content));
    sources.push(filePath);
    estimatedSizeBytes += sectionSize(filePath, Buffer.byteLength(content, "utf8"));
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

export async function imagePartWithMetadataFromFile(
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

  return {
    part: createPartFromBase64(content.toString("base64"), mimeType),
    metadata: {
      mime_type: mimeType,
      byte_size: size,
    },
  };
}

export async function imagePartFromFile(
  path,
  options = {},
) {
  return (await imagePartWithMetadataFromFile(path, options)).part;
}
