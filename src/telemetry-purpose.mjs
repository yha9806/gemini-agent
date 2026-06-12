const TELEMETRY_PURPOSES = new Set(["production", "validation"]);

export function safeTelemetryPurpose(value) {
  const purpose = typeof value === "string" ? value.trim().toLowerCase() : "";
  return TELEMETRY_PURPOSES.has(purpose) ? purpose : "production";
}

export function assertTelemetryPurpose(value) {
  const purpose = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!TELEMETRY_PURPOSES.has(purpose)) {
    throw new Error("--telemetry-purpose must be production or validation.");
  }
  return purpose;
}

export function isValidationTelemetryEvent(event) {
  return safeTelemetryPurpose(event?.metadata?.telemetry_purpose) === "validation";
}
