import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertRawConfirmation,
  loadTelemetryConfig,
  rawTelemetryWarning,
  resolveTelemetryToken,
  saveTelemetryConfig,
  validateTelemetryEndpoint,
} from "../src/telemetry-config.mjs";

const CONFIG_RELATIVE_PATH = ".gemini-agent/telemetry/config.json";

async function temporaryWorkspace() {
  return mkdtemp(join(tmpdir(), "gemini-agent-telemetry-config-"));
}

function modeBits(stats) {
  return stats.mode & 0o777;
}

test("loadTelemetryConfig returns null when telemetry config is missing", async () => {
  const dir = await temporaryWorkspace();
  assert.equal(await loadTelemetryConfig({ cwd: dir }), null);
});

test("saveTelemetryConfig saves and loads raw config with secure modes and preserved created_at", async () => {
  const dir = await temporaryWorkspace();
  const firstNow = new Date("2026-05-29T09:00:00.000Z");
  const secondNow = new Date("2026-05-30T10:30:00.000Z");

  const firstConfig = await saveTelemetryConfig({
    cwd: dir,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: "GEMINI_AGENT_TELEMETRY_TOKEN",
    schedule: "daily@09:00",
    now: firstNow,
  });

  assert.equal(firstConfig.enabled, true);
  assert.equal(firstConfig.level, "raw");
  assert.equal(firstConfig.endpoint, "http://127.0.0.1:8787/ingest");
  assert.equal(firstConfig.token_env, "GEMINI_AGENT_TELEMETRY_TOKEN");
  assert.equal(firstConfig.created_at, firstNow.toISOString());
  assert.equal(firstConfig.updated_at, firstNow.toISOString());

  const configPath = join(dir, CONFIG_RELATIVE_PATH);
  const configText = await readFile(configPath, "utf8");
  assert.match(configText, /"level": "raw"/);
  assert.match(configText, /127\.0\.0\.1/);
  assert.equal(modeBits(await stat(join(dir, ".gemini-agent/telemetry"))), 0o700);
  assert.equal(modeBits(await stat(configPath)), 0o600);

  await writeFile(configPath, `${JSON.stringify({
    ...firstConfig,
    max_event_bytes: 2048,
    max_queue_bytes: 8192,
  }, null, 2)}\n`);

  const secondConfig = await saveTelemetryConfig({
    cwd: dir,
    endpoint: "http://localhost:8787/ingest",
    tokenEnv: "GEMINI_AGENT_TELEMETRY_TOKEN",
    schedule: "daily@10:30",
    now: secondNow,
  });

  assert.equal(secondConfig.endpoint, "http://localhost:8787/ingest");
  assert.equal(secondConfig.schedule, "daily@10:30");
  assert.equal(secondConfig.created_at, firstNow.toISOString());
  assert.equal(secondConfig.updated_at, secondNow.toISOString());
  assert.equal(secondConfig.max_event_bytes, 2048);
  assert.equal(secondConfig.max_queue_bytes, 8192);
  assert.deepEqual(await loadTelemetryConfig({ cwd: dir }), secondConfig);
  assert.equal(modeBits(await stat(configPath)), 0o600);
});

test("validateTelemetryEndpoint allows loopback HTTP and rejects non-loopback HTTP", () => {
  assert.equal(
    validateTelemetryEndpoint("http://127.0.0.1:8787/ingest").href,
    "http://127.0.0.1:8787/ingest",
  );
  assert.equal(validateTelemetryEndpoint("http://localhost:8787/ingest").hostname, "localhost");
  assert.throws(
    () => validateTelemetryEndpoint("http://192.168.1.10:8787/ingest"),
    /Non-loopback telemetry endpoints must use HTTPS/,
  );
  assert.equal(
    validateTelemetryEndpoint("https://vulcaart.art/api/gemini-agent/telemetry/ingest").protocol,
    "https:",
  );
  assert.throws(
    () => validateTelemetryEndpoint("ftp://127.0.0.1/ingest"),
    /Telemetry endpoint must use HTTP or HTTPS/,
  );
});

test("rawTelemetryWarning and assertRawConfirmation are explicit about raw content risk", () => {
  const warning = rawTelemetryWarning();
  assert.match(warning, /raw prompt\/response/i);
  assert.match(warning, /best-effort/i);
  assert.match(warning, /obvious patterns/i);
  assert.match(warning, /not complete removal/i);
  assert.throws(
    () => assertRawConfirmation(false),
    /--confirm-raw-content is required.*raw prompt\/response/i,
  );
  assert.doesNotThrow(() => assertRawConfirmation(true));
});

test("resolveTelemetryToken rejects missing and empty token env values", () => {
  assert.equal(resolveTelemetryToken({ tokenEnv: "TOKEN", env: { TOKEN: "abc" } }), "abc");
  assert.throws(
    () => resolveTelemetryToken({ tokenEnv: "TOKEN", env: { TOKEN: "" } }),
    /Telemetry token env TOKEN is empty/,
  );
  assert.throws(
    () => resolveTelemetryToken({ tokenEnv: "TOKEN", env: { TOKEN: "   " } }),
    /Telemetry token env TOKEN is empty/,
  );
  assert.throws(
    () => resolveTelemetryToken({ tokenEnv: "TOKEN", env: {} }),
    /Telemetry token env TOKEN is not set/,
  );
});

test("loadTelemetryConfig reports corrupted JSON clearly", async () => {
  const dir = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd: dir,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: "GEMINI_AGENT_TELEMETRY_TOKEN",
  });
  const configPath = join(dir, CONFIG_RELATIVE_PATH);
  await writeFile(configPath, "{bad json\n");
  await assert.rejects(
    () => loadTelemetryConfig({ cwd: dir }),
    { message: `Telemetry config is not valid JSON: ${configPath}` },
  );
});
