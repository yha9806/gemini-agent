import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MEDIA_MIME_BY_EXTENSION = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".svg", "image/svg+xml"],
  [".heic", "image/heic"],
  [".heif", "image/heif"],
  [".pdf", "application/pdf"],
]);

const MAGIC_BYTE_READ_LIMIT = 262;

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

export function inferMediaKind({ mimeType, reference } = {}) {
  const text = `${reference ?? ""}`.toLowerCase();
  if (mimeType === "application/pdf") return "document";
  if (/(figma|wireframe|mockup|prototype|design)/.test(text)) return "design";
  if (/(screenshot|screen[-_ ]?shot|screen_capture|capture)/.test(text)) return "screenshot";
  if (typeof mimeType === "string" && mimeType.startsWith("image/")) return "image";
  return "unknown";
}

export function syntheticMediaBasename(value, { salt = "unknown" } = {}) {
  const name = mediaBasename(value) ?? "media";
  const extension = extname(name).toLowerCase();
  const digest = createHash("sha256").update(`${salt}\0${name}`).digest("hex").slice(0, 12);
  return `media-${digest}${extension}`;
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

function isRemoteReference(value) {
  try {
    const url = new URL(value);
    return url.protocol !== "file:";
  } catch {
    return false;
  }
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

async function resolveSafeLocalMediaPath(value, { root } = {}) {
  const path = resolveLocalMediaPath(value, { root });
  if (!path) return null;
  try {
    const [resolvedRoot, resolvedPath] = await Promise.all([
      realpath(resolve(root)),
      realpath(path),
    ]);
    return isInsideRoot(resolvedPath, resolvedRoot) ? resolvedPath : null;
  } catch {
    return path;
  }
}

export async function localMediaByteSize(value, { root } = {}) {
  const path = await resolveSafeLocalMediaPath(value, { root });
  if (!path) return undefined;
  try {
    const info = await lstat(path);
    return info.isFile() ? info.size : undefined;
  } catch {
    return undefined;
  }
}

async function localMediaMagicMime(value, { root } = {}) {
  const path = await resolveSafeLocalMediaPath(value, { root });
  if (!path) return undefined;
  let handle;
  try {
    const info = await lstat(path);
    if (!info.isFile()) return undefined;
    handle = await open(path, "r");
    const buffer = Buffer.alloc(MAGIC_BYTE_READ_LIMIT);
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
  const resolvedRoot = typeof root === "string" && root.trim() ? resolve(root) : null;
  const localPath = resolvedRoot ? resolveLocalMediaPath(value, { root: resolvedRoot }) : null;
  if (resolvedRoot && !localPath && !isRemoteReference(value)) return null;
  if (localPath) {
    try {
      const info = await lstat(localPath);
      if (info.isSymbolicLink()) return null;
    } catch {
      // Missing files can still contribute extension-only metadata below.
    }
  }
  const metadata = {};
  const name = mediaBasename(value);
  const inferredMimeType = inferMediaMime(value) ?? await localMediaMagicMime(value, { root });
  const byteSize = await localMediaByteSize(value, { root });
  if (inferredMimeType) metadata.mime_type = inferredMimeType;
  if (byteSize !== undefined) metadata.byte_size = byteSize;
  if (name) metadata.basename = syntheticMediaBasename(name, { salt: resolvedRoot ?? "unknown" });
  metadata.media_kind = inferMediaKind({ mimeType: inferredMimeType, reference: value });
  return Object.keys(metadata).length ? metadata : null;
}
