import { lstat, open } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MEDIA_MIME_BY_EXTENSION = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".pdf", "application/pdf"],
]);

export function mediaBasename(value) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = new URL(value);
    const path = url.protocol === "file:" ? fileURLToPath(url) : url.pathname;
    const name = basename(decodeURIComponent(path));
    return name || undefined;
  } catch {
    const name = basename(value);
    return name || undefined;
  }
}

export function inferMediaMime(value) {
  const name = mediaBasename(value) ?? `${value ?? ""}`;
  return MEDIA_MIME_BY_EXTENSION.get(extname(name).toLowerCase()) ?? undefined;
}

function inferMediaMimeFromMagic(buffer) {
  if (!Buffer.isBuffer(buffer)) return undefined;
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buffer.subarray(0, 4).toString("ascii") === "RIFF"
    && buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (buffer.subarray(0, 5).toString("ascii") === "%PDF-") {
    return "application/pdf";
  }
  return undefined;
}

function isInsideRoot(path, root) {
  const relativePath = relative(root, path);
  return Boolean(relativePath) && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

export function resolveLocalMediaPath(value, { root } = {}) {
  if (typeof value !== "string" || !value.trim() || typeof root !== "string" || !root.trim()) {
    return null;
  }
  const resolvedRoot = resolve(root);
  let candidate;
  try {
    const url = new URL(value);
    if (url.protocol !== "file:") return null;
    candidate = fileURLToPath(url);
  } catch {
    candidate = isAbsolute(value) ? value : resolve(resolvedRoot, value);
  }
  const resolvedCandidate = resolve(candidate);
  return isInsideRoot(resolvedCandidate, resolvedRoot) ? resolvedCandidate : null;
}

export async function localMediaByteSize(value, { root } = {}) {
  const path = resolveLocalMediaPath(value, { root });
  if (!path) return undefined;
  try {
    const info = await lstat(path);
    return info.isFile() ? info.size : undefined;
  } catch {
    return undefined;
  }
}

async function localMediaMagicMime(value, { root } = {}) {
  const path = resolveLocalMediaPath(value, { root });
  if (!path) return undefined;
  let handle;
  try {
    const info = await lstat(path);
    if (!info.isFile()) return undefined;
    handle = await open(path, "r");
    const buffer = Buffer.alloc(16);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return inferMediaMimeFromMagic(buffer.subarray(0, bytesRead));
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function mediaReferenceMetadata(value, { root } = {}) {
  if (typeof value !== "string" || !value.trim()) return null;
  const metadata = {};
  const name = mediaBasename(value);
  const inferredMimeType = inferMediaMime(value) ?? await localMediaMagicMime(value, { root });
  const byteSize = await localMediaByteSize(value, { root });
  if (inferredMimeType) metadata.mime_type = inferredMimeType;
  if (byteSize !== undefined) metadata.byte_size = byteSize;
  if (name) metadata.basename = name;
  return Object.keys(metadata).length ? metadata : null;
}
