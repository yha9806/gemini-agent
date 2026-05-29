# Raw Telemetry Intranet Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and verify an intranet raw telemetry loop for `gemini-agent`, including raw prompt/response capture, durable local queueing, active flush/validation commands, and a local receiver at `127.0.0.1:8787`.

**Architecture:** Add focused telemetry modules under `src/` and keep existing Gemini commands stable. Client telemetry writes raw events into a permission-restricted local queue, flushes batches to a receiver, and validates delivery through `/metrics`. The receiver stores raw JSONL plus a SQLite index using local `node:sqlite`.

**Tech Stack:** Node.js ESM, `node:test`, `node:sqlite`, `zod`, built-in `fetch`, built-in `http`, existing `@google/genai` client.

---

## Verified Local Runtime Facts

- Local Node is `25.9.0`.
- `node:sqlite` is available in this workspace.
- Existing tests pass with `npm test`.
- Runtime Gemini calls remain fixed to `gemini-3.5-flash`.

## File Structure

- Modify `package.json`
  - Add `gemini-agent-telemetry-receiver` bin.

- Create `bin/gemini-agent-telemetry-receiver`
  - Node wrapper for receiver CLI.

- Create `src/telemetry-schemas.mjs`
  - Zod schemas for config, raw events, batches, receiver ACKs, metrics.
  - Credential masking helpers.
  - Event truncation helper.

- Create `src/telemetry-config.mjs`
  - Read/write `.gemini-agent/telemetry/config.json`.
  - Endpoint validation.
  - Telemetry token resolution.
  - Raw-mode preflight errors and warning text.

- Create `src/telemetry-queue.mjs`
  - Permission-restricted telemetry directories.
  - One-file-per-event queue.
  - In-memory writer queue.
  - Lockfile-protected flush claims.
  - State tracking, queue byte accounting, sent pruning.

- Create `src/telemetry-sender.mjs`
  - Build batches from queue events.
  - POST to receiver with timeout.
  - Preserve queue on failure.
  - Fetch receiver metrics.
  - Implement validate flow.

- Create `src/telemetry-capture.mjs`
  - Capture Gemini prompt/response/error metadata.
  - Drain on process exit and signals.
  - Safe no-op behavior when disabled.

- Create `src/telemetry-receiver.mjs`
  - HTTP routes: `/health`, `/ingest`, `/metrics`, `/dashboard`.
  - JSONL storage and SQLite index.
  - Token enforcement and loopback debug override.
  - Storage cap, daily rotation, pruning, clock skew marking.

- Create `src/telemetry-receiver-cli.mjs`
  - Parse receiver command args and start HTTP server.

- Modify `src/gemini-client.mjs`
  - Capture raw prompt/response around `generateText` and `generateJson`.
  - Keep fake response behavior testable.

- Modify `src/cli.mjs`
  - Add `telemetry` command group.
  - Add usage text.
  - Drain telemetry before normal process exit.

- Modify `README.md`
  - Document telemetry commands and intranet receiver.

- Create tests:
  - `test/telemetry-schemas.test.mjs`
  - `test/telemetry-config.test.mjs`
  - `test/telemetry-queue.test.mjs`
  - `test/telemetry-sender.test.mjs`
  - `test/telemetry-receiver.test.mjs`
  - `test/telemetry-capture.test.mjs`

- Modify tests:
  - `test/gemini-client.test.mjs`
  - `test/cli.test.mjs`
  - `test/package.test.mjs`

---

### Task 1: Telemetry Package Entry And Schemas

**Files:**
- Modify: `package.json`
- Create: `bin/gemini-agent-telemetry-receiver`
- Create: `src/telemetry-schemas.mjs`
- Create: `test/telemetry-schemas.test.mjs`
- Modify: `test/package.test.mjs`

- [ ] **Step 1: Write failing package/bin tests**

Update `test/package.test.mjs` package executable test to include:

```js
assert.equal(pkg.bin["gemini-agent-telemetry-receiver"], "./bin/gemini-agent-telemetry-receiver");
await access(new URL("bin/gemini-agent-telemetry-receiver", root), constants.X_OK);
await access(new URL("src/telemetry-receiver-cli.mjs", root), constants.R_OK);
```

Run:

```bash
node --test test/package.test.mjs
```

Expected: FAIL because the new bin and receiver CLI do not exist.

- [ ] **Step 2: Write failing schema tests**

Create `test/telemetry-schemas.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import {
  maskCredentialText,
  normalizeTelemetryBatch,
  normalizeTelemetryConfig,
  normalizeTelemetryEvent,
  truncateTelemetryText,
} from "../src/telemetry-schemas.mjs";

test("normalizes raw telemetry config", () => {
  const config = normalizeTelemetryConfig({
    enabled: true,
    level: "raw",
    endpoint: "http://127.0.0.1:8787/ingest",
    token_env: "GEMINI_AGENT_TELEMETRY_TOKEN",
    schedule: "daily@09:00",
    max_event_bytes: 1024,
    max_queue_bytes: 4096,
    created_at: "2026-05-29T09:00:00.000Z",
    updated_at: "2026-05-29T09:00:00.000Z",
  });
  assert.equal(config.level, "raw");
  assert.equal(config.endpoint, "http://127.0.0.1:8787/ingest");
});

test("normalizes event and masks credential-shaped raw text", () => {
  const event = normalizeTelemetryEvent({
    schema_version: 1,
    event_id: "evt_test",
    trace_id: "trace_test",
    deployment_id: "dep_test",
    project_id: "gemini-agent",
    source: "cli",
    command: "ask",
    model: "gemini-3.5-flash",
    prompt: "Authorization: Bearer abc.def.ghi",
    response: "GEMINI_API_KEY=AIzaSyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    status: "success",
    error_type: null,
    latency_ms: 12,
    created_at: "2026-05-29T09:00:00.000Z",
    payload: {
      prompt_truncated: false,
      response_truncated: false,
      multimodal: [],
    },
  });
  assert.equal(event.prompt, "Authorization: [MASKED]");
  assert.equal(event.response, "GEMINI_API_KEY=[MASKED]");
});

test("normalizes batch", () => {
  const batch = normalizeTelemetryBatch({
    schema_version: 1,
    batch_id: "batch_test",
    deployment_id: "dep_test",
    scheduled_for: "2026-05-29T09:00:00.000Z",
    sent_at: "2026-05-29T09:00:01.000Z",
    events: [{
      schema_version: 1,
      event_id: "evt_test",
      trace_id: "trace_test",
      deployment_id: "dep_test",
      project_id: "gemini-agent",
      source: "cli",
      command: "ask",
      model: "gemini-3.5-flash",
      prompt: "hello",
      response: "world",
      status: "success",
      error_type: null,
      latency_ms: 1,
      created_at: "2026-05-29T09:00:00.000Z",
      payload: { prompt_truncated: false, response_truncated: false, multimodal: [] },
    }],
  });
  assert.equal(batch.events.length, 1);
});

test("truncates text by byte limit without splitting utf8 characters", () => {
  const ascii = truncateTelemetryText("abcdef", 3);
  assert.equal(ascii.text, "abc");
  assert.equal(ascii.truncated, true);

  const unicode = truncateTelemetryText("a你b", 2);
  assert.equal(unicode.text, "a");
  assert.equal(unicode.truncated, true);

  const malformed = Buffer.from([0xe4, 0xbd]).toString("utf8");
  assert.doesNotThrow(() => truncateTelemetryText(malformed, 1));
});

test("masks documented credential patterns", () => {
  assert.equal(maskCredentialText("Authorization: Bearer secret-token"), "Authorization: [MASKED]");
  assert.equal(maskCredentialText("X_API_KEY=secret-token"), "X_API_KEY=[MASKED]");
  assert.equal(maskCredentialText('{"token":"secret-token"}'), '{"token":"[MASKED]"}');
});
```

Run:

```bash
node --test test/telemetry-schemas.test.mjs
```

Expected: FAIL with missing module/export errors.

- [ ] **Step 3: Add receiver bin and package entry**

Modify `package.json` bin:

```json
"bin": {
  "gemini-agent": "./bin/gemini-agent",
  "gemini-agent-mcp": "./bin/gemini-agent-mcp",
  "gemini-agent-telemetry-receiver": "./bin/gemini-agent-telemetry-receiver"
}
```

Create `bin/gemini-agent-telemetry-receiver`:

```js
#!/usr/bin/env node
import "../src/telemetry-receiver-cli.mjs";
```

Make executable:

```bash
chmod +x bin/gemini-agent-telemetry-receiver
```

Create temporary `src/telemetry-receiver-cli.mjs`:

```js
console.error("gemini-agent telemetry receiver requires receiver module wiring.");
process.exitCode = 1;
```

- [ ] **Step 4: Implement telemetry schemas**

Create `src/telemetry-schemas.mjs`:

```js
import { z } from "zod";

export const TELEMETRY_SCHEMA_VERSION = 1;
export const DEFAULT_MAX_EVENT_BYTES = 1024 * 1024;
export const DEFAULT_MAX_QUEUE_BYTES = 50 * 1024 * 1024;

const IsoString = z.string().datetime({ offset: true });

export const TelemetryConfigZodSchema = z.object({
  enabled: z.boolean(),
  level: z.literal("raw"),
  endpoint: z.string().url(),
  token_env: z.string().min(1),
  schedule: z.string().default("daily@09:00"),
  max_event_bytes: z.number().int().positive().default(DEFAULT_MAX_EVENT_BYTES),
  max_queue_bytes: z.number().int().positive().default(DEFAULT_MAX_QUEUE_BYTES),
  created_at: IsoString,
  updated_at: IsoString,
});

export const TelemetryEventZodSchema = z.object({
  schema_version: z.literal(TELEMETRY_SCHEMA_VERSION),
  event_id: z.string().min(1),
  trace_id: z.string().min(1),
  deployment_id: z.string().min(1),
  project_id: z.string().min(1),
  source: z.enum(["cli", "mcp", "validate"]),
  command: z.string().min(1),
  model: z.literal("gemini-3.5-flash"),
  prompt: z.string(),
  response: z.string(),
  status: z.enum(["success", "error"]),
  error_type: z.string().nullable().default(null),
  latency_ms: z.number().int().nonnegative(),
  created_at: IsoString,
  payload: z.object({
    prompt_truncated: z.boolean().default(false),
    response_truncated: z.boolean().default(false),
    multimodal: z.array(z.object({
      mime_type: z.string().optional(),
      byte_size: z.number().int().nonnegative().optional(),
      basename: z.string().optional(),
      sha256: z.string().optional(),
    })).default([]),
  }).default({ prompt_truncated: false, response_truncated: false, multimodal: [] }),
});

export const TelemetryBatchZodSchema = z.object({
  schema_version: z.literal(TELEMETRY_SCHEMA_VERSION),
  batch_id: z.string().min(1),
  deployment_id: z.string().min(1),
  scheduled_for: IsoString,
  sent_at: IsoString,
  events: z.array(TelemetryEventZodSchema).min(1),
});

const MASK_PATTERNS = [
  {
    name: "authorization-header",
    pattern: /Authorization:\s*(?:Bearer|Basic)\s+[^\r\n]+/gi,
    replacement: "Authorization: [MASKED]",
  },
  {
    name: "env-secret-assignment",
    pattern: /([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD))=([^\s"'`]+)/g,
    replacement: "$1=[MASKED]",
  },
  {
    name: "json-secret-field",
    pattern: /"((?:api_?key|token|secret|password))"\s*:\s*"[^"]*"/gi,
    replacement: "\"$1\":\"[MASKED]\"",
  },
  {
    name: "gemini-api-key",
    pattern: /AIzaSy[A-Za-z0-9_-]{20,}/g,
    replacement: "[MASKED]",
  },
];

export function credentialMaskPatterns() {
  return MASK_PATTERNS.map(({ name, pattern }) => ({ name, pattern: pattern.source }));
}

export function maskCredentialText(value) {
  let text = `${value ?? ""}`;
  for (const { pattern, replacement } of MASK_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

export function truncateTelemetryText(value, maxBytes = DEFAULT_MAX_EVENT_BYTES) {
  const text = `${value ?? ""}`;
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return { text: buffer.subarray(0, end).toString("utf8"), truncated: true };
}

export function normalizeTelemetryConfig(value) {
  return TelemetryConfigZodSchema.parse(value);
}

export function normalizeTelemetryEvent(value) {
  const parsed = TelemetryEventZodSchema.parse(value);
  return {
    ...parsed,
    prompt: maskCredentialText(parsed.prompt),
    response: maskCredentialText(parsed.response),
  };
}

export function normalizeTelemetryBatch(value) {
  const parsed = TelemetryBatchZodSchema.parse(value);
  return {
    ...parsed,
    events: parsed.events.map((event) => normalizeTelemetryEvent(event)),
  };
}
```

- [ ] **Step 5: Run tests and commit**

Run:

```bash
node --test test/telemetry-schemas.test.mjs test/package.test.mjs
npm test
```

Expected: schema and package tests pass; full suite passes.

Commit:

```bash
git add package.json bin/gemini-agent-telemetry-receiver src/telemetry-schemas.mjs src/telemetry-receiver-cli.mjs test/telemetry-schemas.test.mjs test/package.test.mjs
git commit -m "feat: add telemetry schemas and receiver entrypoint"
```

---

### Task 2: Telemetry Config And Endpoint Validation

**Files:**
- Create: `src/telemetry-config.mjs`
- Create: `test/telemetry-config.test.mjs`

- [ ] **Step 1: Write failing config tests**

Create `test/telemetry-config.test.mjs`:

```js
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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

test("saves and loads telemetry config with secure file mode", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-telemetry-config-"));
  const now = new Date("2026-05-29T09:00:00.000Z");
  const config = await saveTelemetryConfig({
    cwd: dir,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: "GEMINI_AGENT_TELEMETRY_TOKEN",
    schedule: "daily@09:00",
    now,
  });
  assert.equal(config.enabled, true);
  assert.equal(config.level, "raw");
  assert.equal(config.created_at, now.toISOString());
  assert.deepEqual(await loadTelemetryConfig({ cwd: dir }), config);
  assert.match(await readFile(join(dir, ".gemini-agent/telemetry/config.json"), "utf8"), /127\.0\.0\.1/);
});

test("endpoint validation allows loopback http and rejects non-loopback http", () => {
  assert.equal(validateTelemetryEndpoint("http://127.0.0.1:8787/ingest").href, "http://127.0.0.1:8787/ingest");
  assert.equal(validateTelemetryEndpoint("http://localhost:8787/ingest").hostname, "localhost");
  assert.throws(
    () => validateTelemetryEndpoint("http://192.168.1.10:8787/ingest"),
    /Non-loopback telemetry endpoints must use HTTPS/,
  );
  assert.equal(validateTelemetryEndpoint("https://vulcaart.art/api/gemini-agent/telemetry/ingest").protocol, "https:");
});

test("raw confirmation and warning are explicit", () => {
  assert.match(rawTelemetryWarning(), /raw prompt\/response/i);
  assert.throws(() => assertRawConfirmation(false), /--confirm-raw-content is required/);
  assert.doesNotThrow(() => assertRawConfirmation(true));
});

test("resolveTelemetryToken rejects missing and empty tokens", () => {
  assert.equal(resolveTelemetryToken({ tokenEnv: "TOKEN", env: { TOKEN: "abc" } }), "abc");
  assert.throws(() => resolveTelemetryToken({ tokenEnv: "TOKEN", env: { TOKEN: "" } }), /Telemetry token env TOKEN is empty/);
  assert.throws(() => resolveTelemetryToken({ tokenEnv: "TOKEN", env: {} }), /Telemetry token env TOKEN is not set/);
});

test("loadTelemetryConfig reports corrupted JSON clearly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-telemetry-config-"));
  await saveTelemetryConfig({
    cwd: dir,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: "GEMINI_AGENT_TELEMETRY_TOKEN",
  });
  await writeFile(join(dir, ".gemini-agent/telemetry/config.json"), "{bad json\n");
  await assert.rejects(
    () => loadTelemetryConfig({ cwd: dir }),
    /Telemetry config is not valid JSON/,
  );
});
```

Run:

```bash
node --test test/telemetry-config.test.mjs
```

Expected: FAIL with missing module/export errors.

- [ ] **Step 2: Implement config module**

Create `src/telemetry-config.mjs`:

```js
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeTelemetryConfig } from "./telemetry-schemas.mjs";

const TELEMETRY_ROOT = ".gemini-agent/telemetry";
const CONFIG_FILE = "config.json";

function telemetryDir(cwd) {
  return join(cwd, TELEMETRY_ROOT);
}

function configPath(cwd) {
  return join(telemetryDir(cwd), CONFIG_FILE);
}

function isLoopbackHostname(hostname) {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
}

export function validateTelemetryEndpoint(endpoint) {
  const url = new URL(endpoint);
  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
    throw new Error("Non-loopback telemetry endpoints must use HTTPS.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Telemetry endpoint must use HTTP or HTTPS.");
  }
  return url;
}

export function rawTelemetryWarning() {
  return [
    "Raw prompt/response telemetry may capture credentials, personal information, source code, customer data, and other sensitive content.",
    "Obvious credential patterns are masked, but raw mode still stores prompt and response text.",
  ].join(" ");
}

export function assertRawConfirmation(confirmed) {
  if (!confirmed) throw new Error("--confirm-raw-content is required for raw telemetry.");
}

export function resolveTelemetryToken({ tokenEnv, env = process.env }) {
  const value = env[tokenEnv];
  if (value === undefined) throw new Error(`Telemetry token env ${tokenEnv} is not set.`);
  if (!String(value).trim()) throw new Error(`Telemetry token env ${tokenEnv} is empty.`);
  return value;
}

export async function loadTelemetryConfig({ cwd = process.cwd() } = {}) {
  const path = configPath(cwd);
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  try {
    return normalizeTelemetryConfig(JSON.parse(raw));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`Telemetry config is not valid JSON: ${path}`);
    throw error;
  }
}

export async function saveTelemetryConfig({
  cwd = process.cwd(),
  endpoint,
  tokenEnv,
  schedule = "daily@09:00",
  now = new Date(),
} = {}) {
  validateTelemetryEndpoint(endpoint);
  const dir = telemetryDir(cwd);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const previous = await loadTelemetryConfig({ cwd });
  const createdAt = previous?.created_at || now.toISOString();
  const config = normalizeTelemetryConfig({
    enabled: true,
    level: "raw",
    endpoint,
    token_env: tokenEnv,
    schedule,
    max_event_bytes: previous?.max_event_bytes,
    max_queue_bytes: previous?.max_queue_bytes,
    created_at: createdAt,
    updated_at: now.toISOString(),
  });
  await writeFile(configPath(cwd), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return config;
}
```

- [ ] **Step 3: Run tests and commit**

Run:

```bash
node --test test/telemetry-config.test.mjs test/telemetry-schemas.test.mjs
npm test
```

Expected: all pass.

Commit:

```bash
git add src/telemetry-config.mjs test/telemetry-config.test.mjs
git commit -m "feat: add telemetry config validation"
```

---

### Task 3: Durable Telemetry Queue

**Files:**
- Create: `src/telemetry-queue.mjs`
- Create: `test/telemetry-queue.test.mjs`

- [ ] **Step 1: Write failing queue tests**

Create `test/telemetry-queue.test.mjs`:

```js
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  appendTelemetryEvent,
  claimTelemetryBatch,
  completeTelemetryBatch,
  failTelemetryBatch,
  loadTelemetryState,
  pruneSentTelemetry,
  telemetryQueueDirs,
  withTelemetryQueueLock,
} from "../src/telemetry-queue.mjs";

const event = {
  schema_version: 1,
  event_id: "evt_queue",
  trace_id: "trace_queue",
  deployment_id: "dep_queue",
  project_id: "gemini-agent",
  source: "cli",
  command: "ask",
  model: "gemini-3.5-flash",
  prompt: "hello",
  response: "world",
  status: "success",
  error_type: null,
  latency_ms: 1,
  created_at: "2026-05-29T09:00:00.000Z",
  payload: { prompt_truncated: false, response_truncated: false, multimodal: [] },
};

test("appendTelemetryEvent writes one pending event with secure mode", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-queue-"));
  const result = await appendTelemetryEvent({ cwd, event });
  assert.match(result.path, /pending\/evt_queue\.json$/);
  assert.deepEqual(JSON.parse(await readFile(result.path, "utf8")).event_id, "evt_queue");
  assert.equal((await stat(result.path)).mode & 0o777, 0o600);
});

test("claim, complete, and fail batch move files safely", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-queue-"));
  await appendTelemetryEvent({ cwd, event });
  const claimed = await claimTelemetryBatch({ cwd, batchSize: 10, now: new Date("2026-05-29T09:00:00.000Z") });
  assert.equal(claimed.events.length, 1);
  assert.equal((await readdir(telemetryQueueDirs(cwd).pending)).length, 0);
  await failTelemetryBatch({ cwd, batchId: claimed.batchId });
  assert.equal((await readdir(telemetryQueueDirs(cwd).pending)).length, 1);
  const claimedAgain = await claimTelemetryBatch({ cwd, batchSize: 10, now: new Date("2026-05-29T09:01:00.000Z") });
  await completeTelemetryBatch({ cwd, batchId: claimedAgain.batchId, now: new Date("2026-05-29T09:02:00.000Z") });
  assert.equal((await readdir(join(telemetryQueueDirs(cwd).sent, "2026-05-29"))).length, 1);
});

test("lock prevents concurrent flush claims", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-queue-"));
  let entered = false;
  await withTelemetryQueueLock({ cwd }, async () => {
    await assert.rejects(
      () => withTelemetryQueueLock({ cwd, staleMs: 60_000 }, async () => {
        entered = true;
      }),
      /Telemetry queue is locked/,
    );
  });
  assert.equal(entered, false);
});

test("stale lock can be reclaimed after timeout", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-queue-"));
  await appendTelemetryEvent({ cwd, event });
  const dirs = telemetryQueueDirs(cwd);
  await writeFile(dirs.lock, JSON.stringify({ pid: 999999, created_at: "2026-05-29T08:00:00.000Z" }), { mode: 0o600 });
  const old = new Date(Date.now() - 60_000);
  await utimes(dirs.lock, old, old);

  await assert.doesNotReject(
    () => withTelemetryQueueLock({ cwd, staleMs: 30_000 }, async () => "ok"),
  );
});

test("appendTelemetryEvent drops oldest pending files above max queue bytes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-queue-"));
  await appendTelemetryEvent({ cwd, event: { ...event, event_id: "evt_001" }, maxQueueBytes: 500 });
  await appendTelemetryEvent({ cwd, event: { ...event, event_id: "evt_002" }, maxQueueBytes: 500 });
  assert.deepEqual((await readdir(telemetryQueueDirs(cwd).pending)).sort(), ["evt_002.json"]);
  const state = await loadTelemetryState({ cwd });
  assert.equal(state.dropped_old_count, 1);
  assert.ok(state.queue_bytes <= 500);
});

test("pruneSentTelemetry removes old sent files", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-queue-"));
  await appendTelemetryEvent({ cwd, event });
  const claimed = await claimTelemetryBatch({ cwd, batchSize: 1, now: new Date("2026-05-20T09:00:00.000Z") });
  await completeTelemetryBatch({ cwd, batchId: claimed.batchId, now: new Date("2026-05-20T09:00:00.000Z") });
  const pruned = await pruneSentTelemetry({ cwd, now: new Date("2026-05-29T09:00:00.000Z"), keepDays: 7, maxSentBytes: 1024 });
  assert.equal(pruned.removed_files, 1);
});

test("state tracks drop counters", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-queue-"));
  const state = await loadTelemetryState({ cwd });
  assert.equal(state.dropped_old_count, 0);
  assert.equal(state.dropped_memory_count, 0);
});
```

Run:

```bash
node --test test/telemetry-queue.test.mjs
```

Expected: FAIL with missing module/export errors.

- [ ] **Step 2: Implement queue module**

Create `src/telemetry-queue.mjs` with these exported functions:

```js
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_MAX_QUEUE_BYTES, normalizeTelemetryEvent } from "./telemetry-schemas.mjs";

const ROOT = ".gemini-agent/telemetry";

export function telemetryQueueDirs(cwd = process.cwd()) {
  const root = join(cwd, ROOT);
  const queue = join(root, "queue");
  return {
    root,
    queue,
    pending: join(queue, "pending"),
    inflight: join(queue, "inflight"),
    sent: join(queue, "sent"),
    tmp: join(queue, "tmp"),
    lock: join(queue, ".flush.lock"),
    state: join(root, "state.json"),
  };
}

async function ensureQueueDirs(cwd) {
  const dirs = telemetryQueueDirs(cwd);
  for (const path of [dirs.root, dirs.queue, dirs.pending, dirs.inflight, dirs.sent, dirs.tmp]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
  }
  return dirs;
}

export async function loadTelemetryState({ cwd = process.cwd() } = {}) {
  const dirs = await ensureQueueDirs(cwd);
  try {
    return JSON.parse(await readFile(dirs.state, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return {
      dropped_old_count: 0,
      dropped_memory_count: 0,
      queue_bytes: 0,
      sent_success_count: 0,
      sent_failure_count: 0,
      last_sent_at: null,
    };
  }
}

async function saveTelemetryState({ cwd, state }) {
  const dirs = await ensureQueueDirs(cwd);
  await writeFile(dirs.state, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  return state;
}

async function pendingFilesWithSizes(dirs) {
  const names = (await readdir(dirs.pending)).filter((name) => name.endsWith(".json")).sort();
  const files = [];
  for (const name of names) {
    const path = join(dirs.pending, name);
    const info = await stat(path);
    files.push({ name, path, size: info.size, mtimeMs: info.mtimeMs });
  }
  return files;
}

async function enforceQueueLimit({ dirs, state, maxQueueBytes }) {
  if (state.queue_bytes <= maxQueueBytes) return state;
  for (const file of (await pendingFilesWithSizes(dirs)).sort((left, right) => left.mtimeMs - right.mtimeMs)) {
    if (state.queue_bytes <= maxQueueBytes) break;
    await rm(file.path, { force: true });
    state.queue_bytes = Math.max(0, state.queue_bytes - file.size);
    state.dropped_old_count += 1;
  }
  return state;
}

export async function appendTelemetryEvent({ cwd = process.cwd(), event, maxQueueBytes = DEFAULT_MAX_QUEUE_BYTES }) {
  return withTelemetryQueueLock({ cwd }, async () => {
    const dirs = await ensureQueueDirs(cwd);
    const normalized = normalizeTelemetryEvent(event);
    const body = `${JSON.stringify(normalized)}\n`;
    const tmpPath = join(dirs.tmp, `${normalized.event_id}-${process.pid}-${randomUUID()}.tmp`);
    const pendingPath = join(dirs.pending, `${normalized.event_id}.json`);
    await writeFile(tmpPath, body, { mode: 0o600, flag: "wx" });
    await rename(tmpPath, pendingPath);
    const state = await loadTelemetryState({ cwd });
    state.queue_bytes += Buffer.byteLength(body);
    await enforceQueueLimit({ dirs, state, maxQueueBytes });
    await saveTelemetryState({ cwd, state });
    return { path: pendingPath, event: normalized };
  });
}

async function readPendingEvents(dirs, limit) {
  const names = (await readdir(dirs.pending)).filter((name) => name.endsWith(".json")).sort().slice(0, limit);
  const events = [];
  for (const name of names) {
    const path = join(dirs.pending, name);
    const body = await readFile(path, "utf8");
    events.push({ name, path, size: Buffer.byteLength(body), event: JSON.parse(body) });
  }
  return events;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireTelemetryQueueLock(dirs, staleMs, { retries = 20, retryDelayMs = 25 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const token = `${process.pid}-${randomUUID()}`;
    const body = JSON.stringify({ pid: process.pid, token, created_at: new Date().toISOString() });
    try {
      await writeFile(dirs.lock, body, { mode: 0o600, flag: "wx" });
      return token;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const ageMs = Date.now() - (await stat(dirs.lock)).mtimeMs;
    if (ageMs < staleMs) {
      if (attempt === retries) throw new Error("Telemetry queue is locked.");
      await sleep(retryDelayMs);
      continue;
    }
    const before = await readFile(dirs.lock, "utf8").catch(() => "");
    await rm(dirs.lock, { force: true });
    try {
      await writeFile(dirs.lock, JSON.stringify({ pid: process.pid, token, created_at: new Date().toISOString(), reclaimed_from: before }), { mode: 0o600, flag: "wx" });
      return token;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      await sleep(retryDelayMs);
    }
  }
  throw new Error("Telemetry queue is locked.");
}

async function releaseTelemetryQueueLock(dirs, token) {
  const current = JSON.parse(await readFile(dirs.lock, "utf8").catch(() => "{}"));
  if (current.token === token) await rm(dirs.lock, { force: true });
}

export async function withTelemetryQueueLock({ cwd = process.cwd(), staleMs = 30_000, retries = 20, retryDelayMs = 25 } = {}, fn) {
  const dirs = await ensureQueueDirs(cwd);
  const token = await acquireTelemetryQueueLock(dirs, staleMs, { retries, retryDelayMs });
  try {
    return await fn();
  } finally {
    await releaseTelemetryQueueLock(dirs, token);
  }
}

export async function claimTelemetryBatch({ cwd = process.cwd(), batchSize = 100, now = new Date() } = {}) {
  return withTelemetryQueueLock({ cwd }, async () => {
    const dirs = await ensureQueueDirs(cwd);
    const batchId = `batch_${now.toISOString().replace(/[:.]/g, "")}_${randomUUID()}`;
    const batchDir = join(dirs.inflight, batchId);
    await mkdir(batchDir, { recursive: true, mode: 0o700 });
    const pending = await readPendingEvents(dirs, batchSize);
    for (const item of pending) {
      await rename(item.path, join(batchDir, item.name));
    }
    const state = await loadTelemetryState({ cwd });
    state.queue_bytes = Math.max(0, state.queue_bytes - pending.reduce((sum, item) => sum + item.size, 0));
    await saveTelemetryState({ cwd, state });
    return { batchId, batchDir, events: pending.map((item) => item.event) };
  });
}

export async function completeTelemetryBatch({ cwd = process.cwd(), batchId, now = new Date() }) {
  const dirs = await ensureQueueDirs(cwd);
  const batchDir = join(dirs.inflight, batchId);
  const dayDir = join(dirs.sent, now.toISOString().slice(0, 10));
  await mkdir(dayDir, { recursive: true, mode: 0o700 });
  for (const name of await readdir(batchDir)) {
    await rename(join(batchDir, name), join(dayDir, name));
  }
  await rm(batchDir, { recursive: true, force: true });
}

export async function failTelemetryBatch({ cwd = process.cwd(), batchId }) {
  const dirs = await ensureQueueDirs(cwd);
  const batchDir = join(dirs.inflight, batchId);
  for (const name of await readdir(batchDir)) {
    await rename(join(batchDir, name), join(dirs.pending, name));
  }
  await rm(batchDir, { recursive: true, force: true });
}

export async function pruneSentTelemetry({ cwd = process.cwd(), now = new Date(), keepDays = 7, maxSentBytes = 100 * 1024 * 1024 } = {}) {
  const dirs = await ensureQueueDirs(cwd);
  let removed = 0;
  const cutoff = new Date(now.getTime() - keepDays * 24 * 60 * 60 * 1000);
  for (const day of await readdir(dirs.sent).catch(() => [])) {
    if (new Date(`${day}T00:00:00.000Z`) < cutoff) {
      const dayPath = join(dirs.sent, day);
      removed += (await readdir(dayPath).catch(() => [])).length;
      await rm(dayPath, { recursive: true, force: true });
    }
  }
  return { removed_files: removed, max_sent_bytes: maxSentBytes };
}
```

- [ ] **Step 3: Run tests and commit**

Run:

```bash
node --test test/telemetry-queue.test.mjs test/telemetry-schemas.test.mjs
npm test
```

Expected: all pass.

Commit:

```bash
git add src/telemetry-queue.mjs test/telemetry-queue.test.mjs
git commit -m "feat: add telemetry durable queue"
```

---

### Task 4: Telemetry Sender And Validate Flow

**Files:**
- Create: `src/telemetry-sender.mjs`
- Create: `test/telemetry-sender.test.mjs`

- [ ] **Step 1: Write failing sender tests**

Create `test/telemetry-sender.test.mjs`:

```js
import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendTelemetryEvent, telemetryQueueDirs } from "../src/telemetry-queue.mjs";
import { flushTelemetryQueue, receiverMetrics, runTelemetryValidation } from "../src/telemetry-sender.mjs";

const event = {
  schema_version: 1,
  event_id: "evt_send",
  trace_id: "trace_send",
  deployment_id: "dep_send",
  project_id: "gemini-agent",
  source: "cli",
  command: "ask",
  model: "gemini-3.5-flash",
  prompt: "hello",
  response: "world",
  status: "success",
  error_type: null,
  latency_ms: 1,
  created_at: "2026-05-29T09:00:00.000Z",
  payload: { prompt_truncated: false, response_truncated: false, multimodal: [] },
};

test("flushTelemetryQueue sends batch and completes queue", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-sender-"));
  await appendTelemetryEvent({ cwd, event });
  let seenRequest;
  const result = await flushTelemetryQueue({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    token: "token",
    fetchImpl: async (url, request) => {
      seenRequest = { url, request };
      return new Response(JSON.stringify({ ok: true, batch_id: "batch", received_count: 1, received_at: "2026-05-29T09:00:01.000Z" }), { status: 200 });
    },
    now: new Date("2026-05-29T09:00:00.000Z"),
  });
  assert.equal(result.sent_count, 1);
  assert.equal(seenRequest.url, "http://127.0.0.1:8787/ingest");
  assert.equal(seenRequest.request.headers.Authorization, "Bearer token");
  assert.equal((await readdir(telemetryQueueDirs(cwd).pending)).length, 0);
});

test("flushTelemetryQueue preserves pending queue on receiver failure", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-sender-"));
  await appendTelemetryEvent({ cwd, event });
  await assert.rejects(
    () => flushTelemetryQueue({
      cwd,
      endpoint: "http://127.0.0.1:8787/ingest",
      token: "token",
      fetchImpl: async () => new Response("down", { status: 503 }),
    }),
    /Telemetry receiver returned 503/,
  );
  assert.equal((await readdir(telemetryQueueDirs(cwd).pending)).length, 1);
});

test("receiverMetrics fetches /metrics", async () => {
  const metrics = await receiverMetrics({
    endpoint: "http://127.0.0.1:8787/ingest",
    token: "token",
    fetchImpl: async (url) => {
      assert.equal(url, "http://127.0.0.1:8787/metrics");
      return new Response(JSON.stringify({ ok: true, received_events: 1 }), { status: 200 });
    },
  });
  assert.equal(metrics.received_events, 1);
});

test("runTelemetryValidation creates, flushes, and confirms event", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-sender-"));
  const result = await runTelemetryValidation({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    token: "token",
    prompt: "validation prompt",
    askGemini: async () => "validation response",
    fetchImpl: async (url, request) => {
      if (url.endsWith("/ingest")) {
        const body = JSON.parse(request.body);
        assert.equal(body.events[0].prompt, "validation prompt");
        assert.equal(body.events[0].response, "validation response");
        return new Response(JSON.stringify({ ok: true, batch_id: body.batch_id, received_count: 1, received_at: new Date().toISOString() }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, received_events: 1, received_batches: 1 }), { status: 200 });
    },
  });
  assert.equal(result.ok, true);
});
```

Run:

```bash
node --test test/telemetry-sender.test.mjs
```

Expected: FAIL with missing module/export errors.

- [ ] **Step 2: Implement sender**

Create `src/telemetry-sender.mjs`:

```js
import { appendTelemetryEvent, claimTelemetryBatch, completeTelemetryBatch, failTelemetryBatch } from "./telemetry-queue.mjs";
import { normalizeTelemetryBatch } from "./telemetry-schemas.mjs";
import { validateTelemetryEndpoint } from "./telemetry-config.mjs";
import { getDefaultModel } from "./gemini-client.mjs";

function metricsUrl(endpoint) {
  const url = new URL(endpoint);
  url.pathname = url.pathname.replace(/\/ingest\/?$/, "/metrics");
  return url.href;
}

async function fetchWithTimeout(fetchImpl, url, request, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...request, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function flushTelemetryQueue({
  cwd = process.cwd(),
  endpoint,
  token,
  fetchImpl = fetch,
  now = new Date(),
  timeoutMs = 5000,
  batchSize = 100,
} = {}) {
  validateTelemetryEndpoint(endpoint);
  const claimed = await claimTelemetryBatch({ cwd, batchSize, now });
  if (claimed.events.length === 0) return { ok: true, sent_count: 0 };
  const batch = normalizeTelemetryBatch({
    schema_version: 1,
    batch_id: claimed.batchId,
    deployment_id: claimed.events[0].deployment_id,
    scheduled_for: now.toISOString(),
    sent_at: now.toISOString(),
    events: claimed.events,
  });
  try {
    const response = await fetchWithTimeout(fetchImpl, endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(batch),
    }, timeoutMs);
    if (!response.ok) throw new Error(`Telemetry receiver returned ${response.status}.`);
    const ack = await response.json();
    if (!ack.ok) throw new Error("Telemetry receiver did not acknowledge the batch.");
    await completeTelemetryBatch({ cwd, batchId: claimed.batchId, now });
    return { ok: true, sent_count: batch.events.length, batch_id: claimed.batchId, ack };
  } catch (error) {
    await failTelemetryBatch({ cwd, batchId: claimed.batchId });
    throw error;
  }
}

export async function receiverMetrics({ endpoint, token, fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  validateTelemetryEndpoint(endpoint);
  const response = await fetchWithTimeout(fetchImpl, metricsUrl(endpoint), {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  }, timeoutMs);
  if (!response.ok) throw new Error(`Telemetry metrics returned ${response.status}.`);
  return response.json();
}

export async function runTelemetryValidation({
  cwd = process.cwd(),
  endpoint,
  token,
  prompt = "gemini-agent telemetry validation: reply with telemetry-ok",
  askGemini,
  fetchImpl = fetch,
  now = new Date(),
} = {}) {
  const started = Date.now();
  const response = await askGemini(prompt);
  const event = {
    schema_version: 1,
    event_id: `evt_validate_${now.getTime()}`,
    trace_id: `trace_validate_${now.getTime()}`,
    deployment_id: "local-validation",
    project_id: "gemini-agent",
    source: "validate",
    command: "telemetry validate",
    model: getDefaultModel(),
    prompt,
    response,
    status: "success",
    error_type: null,
    latency_ms: Date.now() - started,
    created_at: now.toISOString(),
    payload: { prompt_truncated: false, response_truncated: false, multimodal: [] },
  };
  await appendTelemetryEvent({ cwd, event });
  const flush = await flushTelemetryQueue({ cwd, endpoint, token, fetchImpl, now });
  const metrics = await receiverMetrics({ endpoint, token, fetchImpl });
  return { ok: metrics.received_events >= flush.sent_count, flush, metrics };
}
```

- [ ] **Step 3: Run tests and commit**

Run:

```bash
node --test test/telemetry-sender.test.mjs test/telemetry-queue.test.mjs
npm test
```

Expected: all pass.

Commit:

```bash
git add src/telemetry-sender.mjs test/telemetry-sender.test.mjs
git commit -m "feat: add telemetry sender"
```

---

### Task 5: Local Telemetry Receiver

**Files:**
- Create: `src/telemetry-receiver.mjs`
- Replace: `src/telemetry-receiver-cli.mjs`
- Create: `test/telemetry-receiver.test.mjs`

- [ ] **Step 1: Write failing receiver tests**

Create `test/telemetry-receiver.test.mjs`:

```js
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTelemetryReceiver } from "../src/telemetry-receiver.mjs";

const batch = {
  schema_version: 1,
  batch_id: "batch_receiver",
  deployment_id: "dep_receiver",
  scheduled_for: "2026-05-29T09:00:00.000Z",
  sent_at: "2026-05-29T09:00:01.000Z",
  events: [{
    schema_version: 1,
    event_id: "evt_receiver",
    trace_id: "trace_receiver",
    deployment_id: "dep_receiver",
    project_id: "gemini-agent",
    source: "cli",
    command: "ask",
    model: "gemini-3.5-flash",
    prompt: "hello",
    response: "world",
    status: "success",
    error_type: null,
    latency_ms: 1,
    created_at: "2026-05-29T09:00:00.000Z",
    payload: { prompt_truncated: false, response_truncated: false, multimodal: [] },
  }],
};

async function withReceiver(fn) {
  const storage = await mkdtemp(join(tmpdir(), "gemini-agent-receiver-"));
  const receiver = await createTelemetryReceiver({
    host: "127.0.0.1",
    port: 0,
    storage,
    token: "token",
  });
  await receiver.start();
  try {
    const address = receiver.server.address();
    return await fn({ receiver, storage, baseUrl: `http://127.0.0.1:${address.port}` });
  } finally {
    await receiver.stop();
  }
}

test("receiver exposes health, ingest help, metrics, and dashboard", async () => {
  await withReceiver(async ({ baseUrl }) => {
    assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
    assert.match(await (await fetch(`${baseUrl}/ingest`)).text(), /POST \/ingest/);
    assert.equal((await fetch(`${baseUrl}/metrics`, { headers: { Authorization: "Bearer token" } })).status, 200);
    assert.match(await (await fetch(`${baseUrl}/dashboard`, { headers: { Authorization: "Bearer token" } })).text(), /Telemetry Receiver/);
  });
});

test("receiver requires token by default", async () => {
  await withReceiver(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(batch),
    });
    assert.equal(response.status, 401);
  });
});

test("receiver accepts batch and writes JSONL plus metrics", async () => {
  await withReceiver(async ({ baseUrl, storage }) => {
    const response = await fetch(`${baseUrl}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer token" },
      body: JSON.stringify(batch),
    });
    assert.equal(response.status, 200);
    const ack = await response.json();
    assert.equal(ack.received_count, 1);
    const metrics = await (await fetch(`${baseUrl}/metrics`, { headers: { Authorization: "Bearer token" } })).json();
    assert.equal(metrics.received_events, 1);
    assert.match(await readFile(join(storage, "raw", "2026-05-29.jsonl"), "utf8"), /evt_receiver/);
  });
});

test("receiver prunes raw JSONL files above storage cap while keeping SQLite metrics", async () => {
  const storage = await mkdtemp(join(tmpdir(), "gemini-agent-receiver-"));
  const receiver = await createTelemetryReceiver({
    host: "127.0.0.1",
    port: 0,
    storage,
    token: "token",
    maxRawBytes: 1,
  });
  await receiver.start();
  try {
    const address = receiver.server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${baseUrl}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer token" },
      body: JSON.stringify(batch),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await readdir(join(storage, "raw")), []);
    const metrics = await (await fetch(`${baseUrl}/metrics`, { headers: { Authorization: "Bearer token" } })).json();
    assert.equal(metrics.received_events, 1);
  } finally {
    await receiver.stop();
  }
});

test("receiver rejects request bodies above configured limit", async () => {
  const storage = await mkdtemp(join(tmpdir(), "gemini-agent-receiver-"));
  const receiver = await createTelemetryReceiver({
    host: "127.0.0.1",
    port: 0,
    storage,
    token: "token",
    maxBodyBytes: 16,
  });
  await receiver.start();
  try {
    const address = receiver.server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${baseUrl}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer token" },
      body: JSON.stringify(batch),
    });
    assert.equal(response.status, 413);
  } finally {
    await receiver.stop();
  }
});

test("receiver marks clock skew warnings", async () => {
  await withReceiver(async ({ baseUrl }) => {
    const skewed = { ...batch, sent_at: "2999-01-01T00:00:00.000Z", batch_id: "batch_skew" };
    await fetch(`${baseUrl}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer token" },
      body: JSON.stringify(skewed),
    });
    const metrics = await (await fetch(`${baseUrl}/metrics`, { headers: { Authorization: "Bearer token" } })).json();
    assert.equal(metrics.clock_skew_warnings, 1);
  });
});
```

Run:

```bash
node --test test/telemetry-receiver.test.mjs
```

Expected: FAIL with missing module/export errors.

- [ ] **Step 2: Implement receiver module**

Create `src/telemetry-receiver.mjs`:

```js
import { createServer } from "node:http";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { normalizeTelemetryBatch } from "./telemetry-schemas.mjs";

function json(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(`${JSON.stringify(value, null, 2)}\n`);
}

function payloadTooLarge() {
  const error = new Error("Telemetry request body is too large.");
  error.statusCode = 413;
  return error;
}

async function readJson(req, { maxBodyBytes }) {
  const contentLength = Number(req.headers["content-length"] || 0);
  if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) throw payloadTooLarge();
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBodyBytes) throw payloadTooLarge();
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function authorize(req, { token, allowUnauthenticatedLoopback }) {
  if (allowUnauthenticatedLoopback) return true;
  return req.headers.authorization === `Bearer ${token}`;
}

function initDb(path) {
  try {
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA busy_timeout=5000");
    db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL,
        trace_id TEXT NOT NULL,
        command TEXT NOT NULL,
        model TEXT NOT NULL,
        status TEXT NOT NULL,
        received_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        prompt TEXT NOT NULL,
        response TEXT NOT NULL,
        clock_skew_warning INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_events_received_at ON events(received_at);
      CREATE INDEX IF NOT EXISTS idx_events_trace_id ON events(trace_id);
      CREATE INDEX IF NOT EXISTS idx_events_command ON events(command);
      CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);
    `);
    return db;
  } catch (error) {
    throw new Error(`Telemetry receiver database unavailable: ${error.message}`);
  }
}

async function appendRaw(storage, receivedAt, batch) {
  const rawDir = join(storage, "raw");
  await mkdir(rawDir, { recursive: true, mode: 0o700 });
  await writeFile(join(rawDir, `${receivedAt.slice(0, 10)}.jsonl`), `${JSON.stringify({ received_at: receivedAt, ...batch })}\n`, { flag: "a", mode: 0o600 });
}

async function rawFilesWithSize(rawDir) {
  try {
    const names = (await readdir(rawDir)).filter((name) => name.endsWith(".jsonl"));
    const files = [];
    for (const name of names) {
      const path = join(rawDir, name);
      const info = await stat(path);
      files.push({ name, path, size: info.size, mtimeMs: info.mtimeMs });
    }
    return files;
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function pruneRawStorage(storage, maxRawBytes) {
  const rawDir = join(storage, "raw");
  const files = await rawFilesWithSize(rawDir);
  let total = files.reduce((sum, file) => sum + file.size, 0);
  let prunedFiles = 0;
  for (const file of files.sort((left, right) => left.mtimeMs - right.mtimeMs)) {
    if (total <= maxRawBytes) break;
    await rm(file.path, { force: true });
    total -= file.size;
    prunedFiles += 1;
  }
  return { raw_storage_bytes: total, raw_files_pruned: prunedFiles };
}

function insertEvents(db, batch, receivedAt) {
  const insert = db.prepare(`
    INSERT OR REPLACE INTO events
    (event_id, batch_id, trace_id, command, model, status, received_at, created_at, prompt, response, clock_skew_warning)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const sentMs = Date.parse(batch.sent_at);
  const receivedMs = Date.parse(receivedAt);
  const skewWarning = Number.isFinite(sentMs) && Math.abs(receivedMs - sentMs) > 60 * 60 * 1000 ? 1 : 0;
  db.exec("BEGIN");
  try {
    for (const event of batch.events) {
      insert.run(event.event_id, batch.batch_id, event.trace_id, event.command, event.model, event.status, receivedAt, event.created_at, event.prompt, event.response, skewWarning);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function metrics(db) {
  const count = db.prepare("SELECT COUNT(*) AS count FROM events").get().count;
  const batches = db.prepare("SELECT COUNT(DISTINCT batch_id) AS count FROM events").get().count;
  const last = db.prepare("SELECT received_at, batch_id, command, model, status FROM events ORDER BY received_at DESC LIMIT 1").get();
  const skew = db.prepare("SELECT COUNT(*) AS count FROM events WHERE clock_skew_warning = 1").get().count;
  return {
    ok: true,
    received_events: count,
    received_batches: batches,
    last_received_at: last?.received_at || null,
    last_batch_id: last?.batch_id || null,
    latest_event: last || null,
    clock_skew_warnings: skew,
  };
}

export async function createTelemetryReceiver({
  host = "127.0.0.1",
  port = 8787,
  storage,
  token,
  allowUnauthenticatedLoopback = false,
  maxRawBytes = 100 * 1024 * 1024,
  maxBodyBytes = 2 * 1024 * 1024,
} = {}) {
  await mkdir(storage, { recursive: true, mode: 0o700 });
  const db = initDb(join(storage, "telemetry.sqlite"));
  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") return json(res, 200, { ok: true });
      if (req.method === "GET" && req.url === "/ingest") return json(res, 200, { ok: true, message: "POST /ingest accepts telemetry batches." });
      if (!authorize(req, { token, allowUnauthenticatedLoopback })) return json(res, 401, { ok: false, error: "unauthorized" });
      if (req.method === "GET" && req.url === "/metrics") return json(res, 200, metrics(db));
      if (req.method === "GET" && req.url === "/dashboard") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf8" });
        res.end(`<h1>Telemetry Receiver</h1><pre>${JSON.stringify(metrics(db), null, 2)}</pre>`);
        return;
      }
      if (req.method === "POST" && req.url === "/ingest") {
        const receivedAt = new Date().toISOString();
        const batch = normalizeTelemetryBatch(await readJson(req, { maxBodyBytes }));
        await appendRaw(storage, receivedAt, batch);
        await pruneRawStorage(storage, maxRawBytes);
        insertEvents(db, batch, receivedAt);
        return json(res, 200, { ok: true, batch_id: batch.batch_id, received_count: batch.events.length, received_at: receivedAt });
      }
      return json(res, 404, { ok: false, error: "not found" });
    } catch (error) {
      return json(res, error.statusCode || 500, { ok: false, error: error.message });
    }
  });
  return {
    server,
    start: () => new Promise((resolve) => server.listen(port, host, resolve)),
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}
```

- [ ] **Step 3: Implement receiver CLI**

Replace `src/telemetry-receiver-cli.mjs`:

```js
import { createTelemetryReceiver } from "./telemetry-receiver.mjs";

function parseArgs(args) {
  const options = {
    host: "127.0.0.1",
    port: 8787,
    storage: ".telemetry-data",
    tokenEnv: "GEMINI_AGENT_TELEMETRY_TOKEN",
    allowUnauthenticatedLoopback: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--host") options.host = args[++index];
    else if (arg === "--port") options.port = Number(args[++index]);
    else if (arg === "--storage") options.storage = args[++index];
    else if (arg === "--token-env") options.tokenEnv = args[++index];
    else if (arg === "--allow-unauthenticated-loopback") options.allowUnauthenticatedLoopback = true;
    else throw new Error(`Unknown receiver argument: ${arg}`);
  }
  if (!options.allowUnauthenticatedLoopback) {
    options.token = process.env[options.tokenEnv];
  }
  if (!options.allowUnauthenticatedLoopback && !options.token) {
    throw new Error(`Receiver requires token env ${options.tokenEnv}.`);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const receiver = await createTelemetryReceiver(options);
await receiver.start();
console.error(`gemini-agent telemetry receiver listening on ${options.host}:${options.port}`);
```

- [ ] **Step 4: Run tests and commit**

Run:

```bash
node --test test/telemetry-receiver.test.mjs
npm test
```

Expected: all pass.

Commit:

```bash
git add src/telemetry-receiver.mjs src/telemetry-receiver-cli.mjs test/telemetry-receiver.test.mjs
git commit -m "feat: add local telemetry receiver"
```

---

### Task 6: Gemini Client Capture Hook

**Files:**
- Create: `src/telemetry-capture.mjs`
- Create: `test/telemetry-capture.test.mjs`
- Modify: `src/gemini-client.mjs`
- Modify: `test/gemini-client.test.mjs`

- [ ] **Step 1: Write failing capture tests**

Create `test/telemetry-capture.test.mjs`:

```js
import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  captureGeminiTelemetry,
  drainTelemetryCapture,
  resetTelemetryCaptureForTests,
} from "../src/telemetry-capture.mjs";
import { telemetryQueueDirs } from "../src/telemetry-queue.mjs";

test("captureGeminiTelemetry is no-op when telemetry is disabled", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-capture-"));
  await captureGeminiTelemetry({ cwd, command: "ask", prompt: "hello", response: "world", status: "success", latencyMs: 1 });
  await drainTelemetryCapture({ timeoutMs: 100 });
  assert.rejects(() => readdir(telemetryQueueDirs(cwd).pending), /ENOENT/);
});

test("captureGeminiTelemetry writes when config is enabled", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-capture-"));
  await import("../src/telemetry-config.mjs").then(({ saveTelemetryConfig }) => saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: "GEMINI_AGENT_TELEMETRY_TOKEN",
    now: new Date("2026-05-29T09:00:00.000Z"),
  }));
  await captureGeminiTelemetry({ cwd, command: "ask", prompt: "hello", response: "world", status: "success", latencyMs: 1 });
  await drainTelemetryCapture({ timeoutMs: 1000 });
  assert.equal((await readdir(telemetryQueueDirs(cwd).pending)).length, 1);
});

test("capture queue is bounded and can be reset for tests", async () => {
  resetTelemetryCaptureForTests();
  assert.doesNotThrow(() => resetTelemetryCaptureForTests());
});

test("captureGeminiTelemetry caches config lookup per cwd", async () => {
  resetTelemetryCaptureForTests();
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-capture-"));
  let loadCount = 0;
  const loadConfig = async () => {
    loadCount += 1;
    return null;
  };
  await captureGeminiTelemetry({ cwd, command: "ask", prompt: "one", response: "ok", status: "success", loadConfig });
  await captureGeminiTelemetry({ cwd, command: "ask", prompt: "two", response: "ok", status: "success", loadConfig });
  assert.equal(loadCount, 1);
});

test("captureGeminiTelemetry never throws when appending fails", async () => {
  resetTelemetryCaptureForTests();
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-capture-"));
  const loadConfig = async () => ({ enabled: true, level: "raw", max_queue_bytes: 1024 });
  const appendEvent = async () => {
    throw new Error("disk full");
  };
  await assert.doesNotReject(
    () => captureGeminiTelemetry({ cwd, command: "ask", prompt: "hello", response: "world", status: "success", loadConfig, appendEvent }),
  );
  await drainTelemetryCapture({ timeoutMs: 100 });
});

test("captureGeminiTelemetry queues concurrent events without lock loss", async () => {
  resetTelemetryCaptureForTests();
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-capture-"));
  await import("../src/telemetry-config.mjs").then(({ saveTelemetryConfig }) => saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: "GEMINI_AGENT_TELEMETRY_TOKEN",
  }));
  await Promise.all(Array.from({ length: 5 }, (_, index) => captureGeminiTelemetry({
    cwd,
    command: "ask",
    prompt: `prompt ${index}`,
    response: `response ${index}`,
    status: "success",
  })));
  await drainTelemetryCapture({ timeoutMs: 1000 });
  assert.equal((await readdir(telemetryQueueDirs(cwd).pending)).length, 5);
});
```

Run:

```bash
node --test test/telemetry-capture.test.mjs
```

Expected: FAIL with missing module/export errors.

- [ ] **Step 2: Write failing gemini client telemetry test**

Add to `test/gemini-client.test.mjs`:

```js
test("generateText reports raw prompt and response to telemetry hook", async () => {
  const captures = [];
  const text = await generateText({
    apiKey: "fake-key",
    prompt: "telemetry prompt",
    telemetry: {
      cwd: process.cwd(),
      command: "ask",
      capture: async (event) => captures.push(event),
    },
    makeAi: () => ({
      models: {
        async generateContent() {
          return { text: "telemetry response" };
        },
      },
    }),
  });
  assert.equal(text, "telemetry response");
  assert.equal(captures[0].prompt, "telemetry prompt");
  assert.equal(captures[0].response, "telemetry response");
  assert.equal(captures[0].status, "success");
});
```

Run:

```bash
node --test test/gemini-client.test.mjs
```

Expected: FAIL because `generateText` ignores telemetry.

- [ ] **Step 3: Implement capture module**

Create `src/telemetry-capture.mjs`:

```js
import { appendTelemetryEvent } from "./telemetry-queue.mjs";
import { loadTelemetryConfig } from "./telemetry-config.mjs";

const pendingWrites = new Set();
const configCache = new Map();
let installedSignals = false;

function makeId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

async function cachedTelemetryConfig({ cwd, loadConfig }) {
  if (configCache.has(cwd)) return configCache.get(cwd);
  const config = await loadConfig({ cwd }).catch(() => null);
  configCache.set(cwd, config);
  return config;
}

export async function captureGeminiTelemetry({
  cwd = process.cwd(),
  command,
  source = "cli",
  prompt,
  response = "",
  status,
  errorType = null,
  latencyMs = 0,
  now = new Date(),
  loadConfig = loadTelemetryConfig,
  appendEvent = appendTelemetryEvent,
} = {}) {
  const config = await cachedTelemetryConfig({ cwd, loadConfig });
  if (!config?.enabled || config.level !== "raw") return { queued: false };
  const event = {
    schema_version: 1,
    event_id: makeId("evt"),
    trace_id: makeId("trace"),
    deployment_id: "local",
    project_id: "gemini-agent",
    source,
    command,
    model: "gemini-3.5-flash",
    prompt,
    response,
    status,
    error_type: errorType,
    latency_ms: latencyMs,
    created_at: now.toISOString(),
    payload: { prompt_truncated: false, response_truncated: false, multimodal: [] },
  };
  const write = appendEvent({ cwd, event, maxQueueBytes: config.max_queue_bytes }).catch(() => null);
  pendingWrites.add(write);
  write.finally(() => pendingWrites.delete(write));
  return { queued: true, event_id: event.event_id };
}

export async function drainTelemetryCapture({ timeoutMs = 2000 } = {}) {
  await Promise.race([
    Promise.allSettled([...pendingWrites]),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

export function installTelemetrySignalDrain({ enabled = process.env.GEMINI_AGENT_DISABLE_SIGNAL_DRAIN !== "1" } = {}) {
  if (!enabled) return;
  if (installedSignals) return;
  installedSignals = true;
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, async () => {
      await drainTelemetryCapture({ timeoutMs: 2000 });
      process.kill(process.pid, signal);
    });
  }
}

export function resetTelemetryCaptureForTests() {
  pendingWrites.clear();
  configCache.clear();
  installedSignals = false;
}
```

- [ ] **Step 4: Wire Gemini client**

Modify `src/gemini-client.mjs`:

```js
import { captureGeminiTelemetry } from "./telemetry-capture.mjs";
```

Add optional `telemetry` to `generateJson` and `generateText`. In both functions:

```js
const started = Date.now();
```

On success after parsing/returning text:

```js
if (telemetry?.capture) {
  await telemetry.capture({
    cwd: telemetry.cwd,
    command: telemetry.command || "gemini",
    prompt,
    response: response.text || "",
    status: "success",
    latencyMs: Date.now() - started,
  });
} else if (telemetry) {
  await captureGeminiTelemetry({
    cwd: telemetry.cwd,
    command: telemetry.command || "gemini",
    prompt,
    response: response.text || "",
    status: "success",
    latencyMs: Date.now() - started,
  });
}
```

On SDK error before throwing:

```js
if (telemetry) {
  await captureGeminiTelemetry({
    cwd: telemetry.cwd,
    command: telemetry.command || "gemini",
    prompt,
    response: "",
    status: "error",
    errorType: error instanceof Error ? error.name : "Error",
    latencyMs: Date.now() - started,
  });
}
```

Keep existing response parsing and model behavior unchanged.

- [ ] **Step 5: Run tests and commit**

Run:

```bash
node --test test/telemetry-capture.test.mjs test/gemini-client.test.mjs
npm test
```

Expected: all pass.

Commit:

```bash
git add src/telemetry-capture.mjs src/gemini-client.mjs test/telemetry-capture.test.mjs test/gemini-client.test.mjs
git commit -m "feat: capture gemini telemetry"
```

---

### Task 7: Telemetry CLI Commands

**Files:**
- Modify: `src/cli.mjs`
- Modify: `test/cli.test.mjs`

- [ ] **Step 1: Write failing CLI tests**

Add to `test/cli.test.mjs`:

```js
test("telemetry enable requires raw confirmation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));
  await assert.rejects(
    execFileAsync(bin, ["telemetry", "enable", "--level", "raw", "--endpoint", "http://127.0.0.1:8787/ingest"], {
      cwd: dir,
      env: { PATH: process.env.PATH },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /--confirm-raw-content is required/);
      return true;
    },
  );
});

test("telemetry enable writes config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));
  const { stdout } = await execFileAsync(bin, [
    "telemetry",
    "enable",
    "--level",
    "raw",
    "--endpoint",
    "http://127.0.0.1:8787/ingest",
    "--token-env",
    "GEMINI_AGENT_TELEMETRY_TOKEN",
    "--confirm-raw-content",
  ], { cwd: dir, env: { PATH: process.env.PATH } });
  assert.match(stdout, /raw telemetry enabled/i);
});

test("telemetry status prints config and queue state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));
  await execFileAsync(bin, [
    "telemetry", "enable",
    "--level", "raw",
    "--endpoint", "http://127.0.0.1:8787/ingest",
    "--token-env", "GEMINI_AGENT_TELEMETRY_TOKEN",
    "--confirm-raw-content",
  ], { cwd: dir, env: { PATH: process.env.PATH } });
  const { stdout } = await execFileAsync(bin, ["telemetry", "status"], { cwd: dir, env: { PATH: process.env.PATH } });
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.enabled, true);
  assert.equal(parsed.level, "raw");
});

test("telemetry flush rejects when telemetry is not enabled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));
  await assert.rejects(
    execFileAsync(bin, ["telemetry", "flush"], {
      cwd: dir,
      env: { PATH: process.env.PATH },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Telemetry is not enabled/);
      return true;
    },
  );
});
```

Run:

```bash
node --test test/cli.test.mjs
```

Expected: FAIL because telemetry command is unknown.

- [ ] **Step 2: Implement telemetry CLI parsing**

Modify `src/cli.mjs` imports:

```js
import { assertRawConfirmation, loadTelemetryConfig, rawTelemetryWarning, resolveTelemetryToken, saveTelemetryConfig } from "./telemetry-config.mjs";
import { drainTelemetryCapture, installTelemetrySignalDrain } from "./telemetry-capture.mjs";
import { flushTelemetryQueue, runTelemetryValidation } from "./telemetry-sender.mjs";
import { loadTelemetryState } from "./telemetry-queue.mjs";
```

Add usage lines:

```js
"  gemini-agent telemetry enable --level raw --endpoint <url> --token-env <env> --confirm-raw-content",
"  gemini-agent telemetry status",
"  gemini-agent telemetry preview",
"  gemini-agent telemetry flush",
"  gemini-agent telemetry tick",
"  gemini-agent telemetry validate --endpoint <url> --token-env <env> --confirm-raw-content",
"  gemini-agent telemetry disable",
"  gemini-agent telemetry purge",
```

Add parser:

```js
function parseTelemetryArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--level") options.level = args[++index];
    else if (arg === "--endpoint") options.endpoint = args[++index];
    else if (arg === "--token-env") options.tokenEnv = args[++index];
    else if (arg === "--schedule") options.schedule = args[++index];
    else if (arg === "--confirm-raw-content") options.confirmRawContent = true;
    else throw new Error(`Unknown telemetry argument: ${arg}`);
  }
  return options;
}
```

Add command handler:

```js
async function runTelemetry(args) {
  const [subcommand, ...rest] = args;
  const cwd = process.cwd();
  if (subcommand === "enable") {
    const options = parseTelemetryArgs(rest);
    if (options.level !== "raw") throw new Error("Only raw telemetry is supported in v1.");
    assertRawConfirmation(Boolean(options.confirmRawContent));
    if (!options.endpoint) throw new Error("--endpoint is required.");
    if (!options.tokenEnv) throw new Error("--token-env is required.");
    const config = await saveTelemetryConfig({
      cwd,
      endpoint: options.endpoint,
      tokenEnv: options.tokenEnv,
      schedule: options.schedule || "daily@09:00",
    });
    output.write(`${rawTelemetryWarning()}\nraw telemetry enabled: ${config.endpoint}\n`);
    return;
  }
  if (subcommand === "status") {
    const config = await loadTelemetryConfig({ cwd });
    const state = await loadTelemetryState({ cwd });
    output.write(`${JSON.stringify({ ...(config || { enabled: false }), state }, null, 2)}\n`);
    return;
  }
  if (subcommand === "flush" || subcommand === "tick") {
    const config = await loadTelemetryConfig({ cwd });
    if (!config?.enabled) throw new Error("Telemetry is not enabled.");
    const token = resolveTelemetryToken({ tokenEnv: config.token_env, env: process.env });
    const result = await flushTelemetryQueue({ cwd, endpoint: config.endpoint, token });
    output.write(`Flush success: ${result.sent_count} items sent\n`);
    return;
  }
  if (subcommand === "validate") {
    const options = parseTelemetryArgs(rest);
    assertRawConfirmation(Boolean(options.confirmRawContent));
    const endpoint = options.endpoint || "http://127.0.0.1:8787/ingest";
    const tokenEnv = options.tokenEnv || "GEMINI_AGENT_TELEMETRY_TOKEN";
    const token = resolveTelemetryToken({ tokenEnv, env: process.env });
    const fakeAllowed = allowFakeResponse(process.env);
    const askGemini = fakeAllowed && process.env.GEMINI_AGENT_FAKE_RESPONSE
      ? async () => process.env.GEMINI_AGENT_FAKE_RESPONSE
      : async (prompt) => {
        const key = await resolveApiKey();
        if (!key.ok) throw new Error("Gemini API key is not configured. Run: gemini-agent auth set");
        return generateText({ apiKey: key.key, prompt });
      };
    const result = await runTelemetryValidation({
      cwd,
      endpoint,
      token,
      askGemini,
    });
    output.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  throw new Error("Unknown telemetry command.");
}
```

In `main`, call `installTelemetrySignalDrain()` once near startup and route:

```js
if (command === "telemetry") {
  await runTelemetry(args);
  return;
}
```

Replace the Ctrl-C branch in `readSecret` so it does not call `process.exit()` directly:

```js
if (char === "\u0003") {
  output.write("\n");
  const error = new Error("Interrupted.");
  error.exitCode = 130;
  throw error;
}
```

In the final `main().catch(...)`, add a final drain:

```js
main()
  .finally(() => drainTelemetryCapture({ timeoutMs: 2000 }))
  .catch((error) => {
    console.error(error.message);
    process.exitCode = error.exitCode || 1;
  });
```

- [ ] **Step 3: Pass telemetry command context into Gemini calls**

Modify command calls:

```js
const text = await generateText({ apiKey: key.key, prompt, telemetry: { cwd: process.cwd(), command: "ask" } });
```

For gate commands:

```js
const review = await generateReview({ apiKey: key.key, prompt, allowFakeResponse: fakeAllowed, env: process.env, telemetry: { cwd, command } });
```

Modify `src/context-pack.mjs` so `runContextPack` accepts `telemetry = null` and passes it to `generate`:

```js
export async function runContextPack({
  apiKey,
  cwd = process.cwd(),
  stdinText = "",
  files = [],
  diff = false,
  collected = null,
  env = process.env,
  allowFakeResponse = false,
  now = new Date(),
  writeArtifact = false,
  telemetry = null,
  generate = generateContextPack,
} = {}) {
  // existing collection and prompt construction stay unchanged
  const generated = await generate({
    apiKey,
    prompt,
    env,
    allowFakeResponse,
    telemetry,
  });
  // existing normalization and artifact writing stay unchanged
}
```

Modify `src/artifact-review.mjs` so `runArtifactReview` accepts `telemetry = null` and passes it to `generate`:

```js
export async function runArtifactReview({
  apiKey,
  cwd = process.cwd(),
  file,
  artifactKind = "image",
  env = process.env,
  allowFakeResponse = false,
  now = new Date(),
  writeArtifact = false,
  telemetry = null,
  generate = generateArtifactReview,
} = {}) {
  // existing artifact validation and prompt construction stay unchanged
  const generated = await generate({
    apiKey,
    prompt,
    contents,
    env,
    allowFakeResponse,
    telemetry,
  });
  // existing normalization and artifact writing stay unchanged
}
```

In `src/cli.mjs`, pass explicit command names:

```js
const pack = await runContextPack({
  apiKey: key.key,
  cwd,
  collected,
  env: process.env,
  allowFakeResponse: fakeAllowed,
  writeArtifact,
  telemetry: { cwd, command: "context-pack" },
});

const review = await runArtifactReview({
  apiKey: key.key,
  cwd,
  file,
  artifactKind,
  env: process.env,
  allowFakeResponse: fakeAllowed,
  writeArtifact,
  telemetry: { cwd, command: "artifact-review" },
});
```

- [ ] **Step 4: Run tests and commit**

Run:

```bash
node --test test/cli.test.mjs test/gemini-client.test.mjs test/telemetry-sender.test.mjs
npm test
```

Expected: all pass.

Commit:

```bash
git add src/cli.mjs src/context-pack.mjs src/artifact-review.mjs test/cli.test.mjs
git commit -m "feat: add telemetry cli commands"
```

---

### Task 8: End-To-End Receiver Validation And Documentation

**Files:**
- Modify: `test/telemetry-receiver.test.mjs`
- Modify: `test/cli.test.mjs`
- Modify: `README.md`

- [ ] **Step 1: Add real E2E test**

Add to `test/cli.test.mjs`:

The current file already imports `execFile`, `spawn`, `promisify`, `mkdtemp`, `tmpdir`, and `join`; keep those imports and reuse the existing `execFileAsync` helper.

```js
async function freePort() {
  const { createServer } = await import("node:net");
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

test("telemetry validate sends raw prompt response to local receiver", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-e2e-"));
  const port = await freePort();
  const endpoint = `http://127.0.0.1:${port}/ingest`;
  const receiverBin = new URL("../bin/gemini-agent-telemetry-receiver", import.meta.url).pathname;
  const receiver = spawn(receiverBin, [
    "--host", "127.0.0.1",
    "--port", String(port),
    "--storage", join(dir, "receiver"),
  ], { env: { ...process.env, GEMINI_AGENT_TELEMETRY_TOKEN: "token" } });
  try {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const { stdout } = await execFileAsync(bin, [
      "telemetry",
      "validate",
      "--endpoint",
      endpoint,
      "--token-env",
      "GEMINI_AGENT_TELEMETRY_TOKEN",
      "--confirm-raw-content",
    ], {
      cwd: dir,
      env: {
        ...process.env,
        GEMINI_AGENT_ALLOW_FAKE_RESPONSE: "1",
        GEMINI_AGENT_FAKE_RESPONSE: "telemetry-ok",
        GEMINI_AGENT_TELEMETRY_TOKEN: "token",
      },
    });
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.ok, true);
    const metrics = await (await fetch(`http://127.0.0.1:${port}/metrics`, { headers: { Authorization: "Bearer token" } })).json();
    assert.ok(metrics.received_events >= 1);
  } finally {
    receiver.kill("SIGTERM");
  }
});
```

Run:

```bash
node --test test/cli.test.mjs
```

Expected: PASS and the test uses a dynamically allocated local port.

- [ ] **Step 2: Update README**

Add under commands:

```bash
/Users/yhryzy/.codex/tools/gemini-agent/bin/gemini-agent telemetry enable --level raw --endpoint http://127.0.0.1:8787/ingest --token-env GEMINI_AGENT_TELEMETRY_TOKEN --confirm-raw-content
/Users/yhryzy/.codex/tools/gemini-agent/bin/gemini-agent telemetry validate --endpoint http://127.0.0.1:8787/ingest --token-env GEMINI_AGENT_TELEMETRY_TOKEN --confirm-raw-content
/Users/yhryzy/.codex/tools/gemini-agent/bin/gemini-agent-telemetry-receiver --host 127.0.0.1 --port 8787 --storage ./.telemetry-data
```

Add safety bullets:

```md
- Raw telemetry mode is explicit and requires `--confirm-raw-content`.
- Raw telemetry stores prompt/response text after mandatory credential-pattern masking.
- Credential masking is best-effort and does not guarantee complete PII or secret removal from unstructured text.
- Loopback HTTP is allowed for local validation; non-loopback endpoints must use HTTPS.
- Telemetry uses a separate ingestion token and never reuses `GEMINI_API_KEY`.
- The local receiver is designed for low-volume intranet validation; `node:sqlite` warnings can be suppressed for local receiver runs with `NODE_NO_WARNINGS=1` if they interfere with test stderr.
```

- [ ] **Step 3: Run full local validation**

Run:

```bash
npm test
npm run test:live
GEMINI_AGENT_TELEMETRY_TOKEN=local-token ./bin/gemini-agent-telemetry-receiver --host 127.0.0.1 --port 8787 --storage /tmp/gemini-agent-telemetry-data
```

In another shell:

```bash
GEMINI_AGENT_TELEMETRY_TOKEN=local-token ./bin/gemini-agent telemetry validate \
  --endpoint http://127.0.0.1:8787/ingest \
  --token-env GEMINI_AGENT_TELEMETRY_TOKEN \
  --confirm-raw-content
curl -H 'Authorization: Bearer local-token' http://127.0.0.1:8787/metrics
curl -H 'Authorization: Bearer local-token' http://127.0.0.1:8787/dashboard
```

Expected:

- `npm test` passes.
- `npm run test:live` returns `gemini-agent-ok`.
- `telemetry validate` prints JSON with `"ok": true`.
- `/metrics` shows `received_events >= 1`.
- Browser at `http://127.0.0.1:8787/ingest` shows a receiver help response.

- [ ] **Step 4: Run Gemini final diff review**

Run:

```bash
git diff main...HEAD | ./bin/gemini-agent diff-review --stdin
```

Expected: `verdict` is `pass` or all findings are addressed.

- [ ] **Step 5: Commit**

```bash
git add README.md test/cli.test.mjs test/telemetry-receiver.test.mjs
git commit -m "docs: document raw telemetry validation"
```

---

## Final Verification Checklist

- [ ] `npm test`
- [ ] `npm run test:live`
- [ ] `gemini-agent-telemetry-receiver --host 127.0.0.1 --port 8787 --storage /tmp/gemini-agent-telemetry-data`
- [ ] `gemini-agent telemetry validate --endpoint http://127.0.0.1:8787/ingest --token-env GEMINI_AGENT_TELEMETRY_TOKEN --confirm-raw-content`
- [ ] Browser `GET http://127.0.0.1:8787/ingest`
- [ ] Browser or curl `GET http://127.0.0.1:8787/metrics`
- [ ] Browser `GET http://127.0.0.1:8787/dashboard`
- [ ] `git diff main...HEAD | ./bin/gemini-agent diff-review --stdin`
