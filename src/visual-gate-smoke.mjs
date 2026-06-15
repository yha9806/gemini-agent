import { stat } from "node:fs/promises";
import {
  DEFAULT_IMAGE_LIMIT_BYTES,
  detectArtifactMime,
  resolveCwdFilePath,
} from "./input-collector.mjs";
import { imageDimensions } from "./design-image-dimensions.mjs";

const SAFE_ROLES = new Set(["target", "actual", "before", "after", "viewport"]);
const SUPPORTED_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

function safeRole(role) {
  return SAFE_ROLES.has(role) ? role : "actual";
}

function check(name, status, evidence) {
  return { name, status, evidence };
}

function positiveIntegerOrNull(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function smokeStatus(checks) {
  if (checks.some((item) => item.status === "block")) return "block";
  if (checks.some((item) => item.status === "caution")) return "caution";
  return "pass";
}

async function collectOneScreenshot({
  cwd,
  entry,
  maxImageBytes,
  readDimensions,
}) {
  const role = safeRole(entry?.role);
  const checks = [];
  const mediaSummary = [];
  let resolvedPath;

  try {
    resolvedPath = resolveCwdFilePath(entry?.path, { cwd });
  } catch {
    checks.push(check("file_readable", "block", "screenshot path could not be resolved within cwd"));
    return { checks, mediaSummary };
  }

  let fileInfo;
  try {
    fileInfo = await stat(resolvedPath);
    if (!fileInfo.isFile()) {
      checks.push(check("file_readable", "block", "screenshot input is not a readable file"));
      return { checks, mediaSummary };
    }
    checks.push(check("file_readable", "pass", "screenshot file is readable"));
  } catch {
    checks.push(check("file_readable", "block", "screenshot file is missing or unreadable"));
    return { checks, mediaSummary };
  }

  const summary = {
    role,
    mime_type: null,
    byte_size: fileInfo.size,
    width: null,
    height: null,
    media_kind: "screenshot",
  };
  mediaSummary.push(summary);

  let mimeType;
  try {
    mimeType = detectArtifactMime(resolvedPath);
    if (!SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) {
      checks.push(check("mime_supported", "block", "screenshot media type is unsupported"));
      return { checks, mediaSummary };
    }
    summary.mime_type = mimeType;
    checks.push(check("mime_supported", "pass", "screenshot media type is supported"));
  } catch {
    checks.push(check("mime_supported", "block", "screenshot media type is unsupported"));
    return { checks, mediaSummary };
  }

  if (fileInfo.size > maxImageBytes) {
    checks.push(check("byte_size", "block", "screenshot exceeds image byte limit"));
    return { checks, mediaSummary };
  }
  checks.push(check("byte_size", "pass", "screenshot is within image byte limit"));

  try {
    const dimensions = await readDimensions(resolvedPath);
    summary.width = positiveIntegerOrNull(dimensions?.width);
    summary.height = positiveIntegerOrNull(dimensions?.height);
    checks.push(check("dimensions", "pass", "screenshot dimensions were inspected"));
  } catch {
    checks.push(check("dimensions", "caution", "screenshot dimensions could not be inspected"));
  }

  return { checks, mediaSummary };
}

export async function collectVisualGateSmoke({
  cwd = process.cwd(),
  screenshots = [],
  maxImageBytes = DEFAULT_IMAGE_LIMIT_BYTES,
  readDimensions = imageDimensions,
} = {}) {
  const entries = Array.isArray(screenshots) ? screenshots : [];
  const checks = [];
  const mediaSummary = [];

  if (entries.length === 0) {
    checks.push(check("screenshots_present", "block", "no screenshots were provided"));
    return {
      status: smokeStatus(checks),
      checks,
      media_summary: mediaSummary,
    };
  }

  for (const entry of entries) {
    const result = await collectOneScreenshot({
      cwd,
      entry,
      maxImageBytes,
      readDimensions,
    });
    checks.push(...result.checks);
    mediaSummary.push(...result.mediaSummary);
  }

  return {
    status: smokeStatus(checks),
    checks,
    media_summary: mediaSummary,
  };
}
