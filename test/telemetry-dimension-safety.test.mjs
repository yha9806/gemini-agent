import assert from "node:assert/strict";
import test from "node:test";
import {
  hasEmailLikeIdentifier,
  hasLocalPathLikeIdentifier,
  hasPhoneLikeIdentifier,
  hasUnsafeTelemetryDimensionContent,
  isScopedPackageName,
  TELEMETRY_USER_LABEL_SENSITIVE_MESSAGE,
} from "../src/telemetry-dimension-safety.mjs";

test("telemetry dimension safety detects scoped packages without treating them as paths", () => {
  assert.equal(isScopedPackageName("@vulca/platform"), true);
  assert.equal(isScopedPackageName("@bad/path/extra"), false);
  assert.equal(hasUnsafeTelemetryDimensionContent("@vulca/platform"), true);
  assert.equal(hasUnsafeTelemetryDimensionContent("@vulca/platform", { allowScopedPackage: true }), false);
});

test("telemetry dimension safety flags PII, credentials, and path-like strings", () => {
  assert.equal(hasEmailLikeIdentifier("person@example.com"), true);
  assert.equal(hasLocalPathLikeIdentifier("/Users/alice/project"), true);
  assert.equal(hasLocalPathLikeIdentifier("https://example.com/product/path"), false);
  assert.equal(hasPhoneLikeIdentifier("call +1 (415) 555-1212"), true);
  assert.equal(hasPhoneLikeIdentifier("version 1.2.3"), false);
  assert.equal(hasPhoneLikeIdentifier("123-45-6789"), true);
  assert.equal(hasUnsafeTelemetryDimensionContent("/Users/alice/project"), true);
  assert.equal(hasUnsafeTelemetryDimensionContent("vision Authorization: Bearer secret-token"), true);
  assert.equal(hasUnsafeTelemetryDimensionContent("+1 (415) 555-1212"), true);
  assert.equal(hasUnsafeTelemetryDimensionContent("123-45-6789"), true);
  assert.equal(hasUnsafeTelemetryDimensionContent("emoart-challenge"), false);
  assert.equal(
    TELEMETRY_USER_LABEL_SENSITIVE_MESSAGE,
    "Telemetry user label must not contain paths, credentials, or phone-like identifiers.",
  );
});
