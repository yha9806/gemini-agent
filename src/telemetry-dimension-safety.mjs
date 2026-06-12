export const TELEMETRY_USER_LABEL_SENSITIVE_MESSAGE =
  "Telemetry user label must not contain paths, credentials, or phone-like identifiers.";

const EMAIL_PATTERN = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const CREDENTIAL_PATTERN =
  /\b(?:authorization|bearer|api[_ -]?key|secret|password|passwd|credential|private[_ -]?key|access[_ -]?token|refresh[_ -]?token)\b/i;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:[\\/]/;
const LOCAL_PATH_PATTERN =
  /(^|[\s"'`(:])(?:~[\\/]|\.{1,2}[\\/]|\/(?:Users|home|tmp|var|private|Volumes|etc|opt|usr|mnt|workspace)[^\s"'`<>]*|[A-Za-z]:[\\/][^\s"'`<>]*)/;
const SSN_PATTERN = /\b\d{3}-\d{2}-\d{4}\b/;
const EMBEDDED_PHONE_PATTERN = /(?:^|[^\d])(\+?\d[\d(). -]{5,}\d)(?=$|[^\d])/g;

export function hasEmailLikeIdentifier(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return EMAIL_PATTERN.test(text);
}

export function isScopedPackageName(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return /^@[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(text);
}

function hasDimensionPathLikeIdentifier(text, { allowScopedPackage }) {
  if (allowScopedPackage && isScopedPackageName(text)) return false;
  return text.startsWith("~")
    || WINDOWS_ABSOLUTE_PATH_PATTERN.test(text)
    || /(^|[\\/])\.\.([\\/]|$)/.test(text)
    || /[\\/]/.test(text);
}

export function hasLocalPathLikeIdentifier(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return LOCAL_PATH_PATTERN.test(text);
}

export function hasPhoneLikeIdentifier(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (SSN_PATTERN.test(text)) return true;
  for (const match of text.matchAll(EMBEDDED_PHONE_PATTERN)) {
    const candidate = match[1].replace(/\s+/g, "");
    const digitCount = (candidate.match(/\d/g) ?? []).length;
    if (digitCount < 7) continue;
    if (candidate.startsWith("+") || /[().-]/.test(candidate) || /^\d+$/.test(candidate)) {
      return true;
    }
  }
  return false;
}

export function hasUnsafeTelemetryDimensionContent(
  value,
  { allowScopedPackage = false, includeEmail = true } = {},
) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return false;
  if (includeEmail && hasEmailLikeIdentifier(text)) return true;
  return CREDENTIAL_PATTERN.test(text)
    || hasDimensionPathLikeIdentifier(text, { allowScopedPackage })
    || hasPhoneLikeIdentifier(text);
}
