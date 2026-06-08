import { lstat } from "node:fs/promises";
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
