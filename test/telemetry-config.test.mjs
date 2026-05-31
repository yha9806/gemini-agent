import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
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
import {
  DEFAULT_MAX_EVENT_BYTES,
  DEFAULT_MAX_QUEUE_BYTES,
} from "../src/telemetry-schemas.mjs";

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
  const savedFirstConfig = JSON.parse(configText);
  assert.equal(savedFirstConfig.max_event_bytes, DEFAULT_MAX_EVENT_BYTES);
  assert.equal(savedFirstConfig.max_queue_bytes, DEFAULT_MAX_QUEUE_BYTES);
  assert.equal(Object.hasOwn(savedFirstConfig, "max_event_bytes"), true);
  assert.equal(Object.hasOwn(savedFirstConfig, "max_queue_bytes"), true);
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

test("saveTelemetryConfig preserves absence of older byte limit fields", async () => {
  const dir = await temporaryWorkspace();
  const configPath = join(dir, CONFIG_RELATIVE_PATH);
  const createdAt = "2026-05-29T09:00:00.000Z";
  await mkdir(join(dir, ".gemini-agent/telemetry"), { recursive: true });
  await writeFile(configPath, `${JSON.stringify({
    enabled: true,
    level: "raw",
    endpoint: "http://127.0.0.1:8787/ingest",
    token_env: "GEMINI_AGENT_TELEMETRY_TOKEN",
    schedule: "daily@09:00",
    created_at: createdAt,
    updated_at: createdAt,
  }, null, 2)}\n`);

  const loadedLegacyConfig = await loadTelemetryConfig({ cwd: dir });
  assert.equal(loadedLegacyConfig.max_event_bytes, DEFAULT_MAX_EVENT_BYTES);
  assert.equal(loadedLegacyConfig.max_queue_bytes, DEFAULT_MAX_QUEUE_BYTES);
  assert.equal(Number.isInteger(loadedLegacyConfig.max_event_bytes), true);
  assert.equal(Number.isInteger(loadedLegacyConfig.max_queue_bytes), true);
  assert.ok(loadedLegacyConfig.max_event_bytes > 0);
  assert.ok(loadedLegacyConfig.max_queue_bytes > 0);

  await saveTelemetryConfig({
    cwd: dir,
    endpoint: "http://localhost:8787/ingest",
    tokenEnv: "GEMINI_AGENT_TELEMETRY_TOKEN",
    now: new Date("2026-05-30T10:30:00.000Z"),
  });

  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(saved.created_at, createdAt);
  assert.equal(Object.hasOwn(saved, "max_event_bytes"), false);
  assert.equal(Object.hasOwn(saved, "max_queue_bytes"), false);
});

test("saveTelemetryConfig rejects Gemini API key token env before writing config", async () => {
  const dir = await temporaryWorkspace();
  await assert.rejects(
    () => saveTelemetryConfig({
      cwd: dir,
      endpoint: "http://127.0.0.1:8787/ingest",
      tokenEnv: "GEMINI_API_KEY",
    }),
    /Telemetry token env must not be GEMINI_API_KEY/,
  );
  assert.equal(await loadTelemetryConfig({ cwd: dir }), null);
});

test("telemetry config rejects unsupported schedules before use", async () => {
  const dir = await temporaryWorkspace();
  await assert.rejects(
    () => saveTelemetryConfig({
      cwd: dir,
      endpoint: "http://127.0.0.1:8787/ingest",
      tokenEnv: "GEMINI_AGENT_TELEMETRY_TOKEN",
      schedule: "every five minutes",
    }),
    /Unsupported telemetry schedule/,
  );
  assert.equal(await loadTelemetryConfig({ cwd: dir }), null);

  const configPath = join(dir, CONFIG_RELATIVE_PATH);
  await mkdir(join(dir, ".gemini-agent/telemetry"), { recursive: true });
  await writeFile(configPath, `${JSON.stringify({
    enabled: true,
    level: "raw",
    endpoint: "http://127.0.0.1:8787/ingest",
    token_env: "GEMINI_AGENT_TELEMETRY_TOKEN",
    schedule: "weekly",
    created_at: "2026-05-29T09:00:00.000Z",
    updated_at: "2026-05-29T09:00:00.000Z",
  }, null, 2)}\n`);

  await assert.rejects(
    () => loadTelemetryConfig({ cwd: dir }),
    /Unsupported telemetry schedule/,
  );
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
    () => resolveTelemetryToken({ tokenEnv: "TOKEN", env: Object.create({ TOKEN: "inherited" }) }),
    /Telemetry token env TOKEN is not set/,
  );
  assert.throws(
    () => resolveTelemetryToken({ tokenEnv: "TOKEN", env: { TOKEN: 123 } }),
    /Telemetry token env TOKEN must be a string/,
  );
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
  assert.throws(
    () => resolveTelemetryToken({ tokenEnv: "", env: { TOKEN: "abc" } }),
    /Telemetry token env name must be a non-empty string/,
  );
  assert.throws(
    () => resolveTelemetryToken({ tokenEnv: "BAD-NAME", env: { "BAD-NAME": "abc" } }),
    /Telemetry token env name must be a valid environment variable name/,
  );
  assert.throws(
    () => resolveTelemetryToken({ tokenEnv: "GEMINI_API_KEY", env: { GEMINI_API_KEY: "secret" } }),
    /Telemetry token env must not be GEMINI_API_KEY/,
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
