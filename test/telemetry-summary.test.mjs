import assert from "node:assert/strict";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { saveTelemetryConfig } from "../src/telemetry-config.mjs";
import { runTelemetrySummary } from "../src/telemetry-summary.mjs";

const TOKEN_ENV = "GEMINI_AGENT_TELEMETRY_TOKEN";

async function temporaryWorkspace() {
  return mkdtemp(join(tmpdir(), "gemini-agent-telemetry-summary-"));
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

test("runTelemetrySummary rejects when telemetry is not enabled", async () => {
  const cwd = await temporaryWorkspace();

  await assert.rejects(
    runTelemetrySummary({ cwd, scope: "local" }),
    /Telemetry is not enabled/,
  );
});

test("runTelemetrySummary returns a zero summary for an enabled empty queue without creating queue dirs", async () => {
  const cwd = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });

  const result = await runTelemetrySummary({
    cwd,
    scope: "local",
    now: new Date("2026-06-04T10:00:00.000Z"),
  });

  assert.equal(result.scope, "local");
  assert.equal(result.storage_cwd, cwd);
  assert.equal(result.generated_at, "2026-06-04T10:00:00.000Z");
  assert.deepEqual(result.event_counts, {
    total: 0,
    pending: 0,
    inflight: 0,
    sent: 0,
    failed: 0,
    quarantine: 0,
    invalid: 0,
  });
  assert.equal(result.usage.total_tokens, 0);
  assert.equal(result.raw_content.prompt_events, 0);
  assert.deepEqual(result.top_projects, []);
  assert.deepEqual(result.top_commands, []);
  assert.equal(await pathExists(join(cwd, ".gemini-agent/telemetry/queue")), false);
});
