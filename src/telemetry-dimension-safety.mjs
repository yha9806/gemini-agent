export const TELEMETRY_USER_LABEL_SENSITIVE_MESSAGE =
  "Telemetry user label must not contain paths, credentials, or phone-like identifiers.";

const EMAIL_PATTERN = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const CREDENTIAL_PATTERN =
  /\b(?:authorization|bearer|api[_ -]?key|secret|password|passwd|credential|private[_ -]?key|access[_ -]?token|refresh[_ -]?token)\b/i;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:[\\/]/;
const SSN_PATTERN = /\b\d{3}-\d{2}-\d{4}\b/;

export function hasEmailLikeIdentifier(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return EMAIL_PATTERN.test(text);
}

export function isScopedPackageName(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return /^@[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(text);
}

function hasPathLikeIdentifier(text, { allowScopedPackage }) {
  if (allowScopedPackage && isScopedPackageName(text)) return false;
  return text.startsWith("~")
    || WINDOWS_ABSOLUTE_PATH_PATTERN.test(text)
    || /(^|[\\/])\.\.([\\/]|$)/.test(text)
    || /[\\/]/.test(text);
}

function hasPhoneLikeIdentifier(text) {
  if (SSN_PATTERN.test(text)) return true;
  const compact = text.replace(/\s+/g, "");
  const digitCount = (compact.match(/\d/g) ?? []).length;
  if (digitCount < 7) return false;
  if (!/^\+?[\d().-]+$/.test(compact)) return false;
  return compact.startsWith("+") || /[().-]/.test(compact) || /^\d+$/.test(compact);
}

export function hasUnsafeTelemetryDimensionContent(
  value,
  { allowScopedPackage = false, includeEmail = true } = {},
) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return false;
  if (includeEmail && hasEmailLikeIdentifier(text)) return true;
  return CREDENTIAL_PATTERN.test(text)
    || hasPathLikeIdentifier(text, { allowScopedPackage })
    || hasPhoneLikeIdentifier(text);
}
