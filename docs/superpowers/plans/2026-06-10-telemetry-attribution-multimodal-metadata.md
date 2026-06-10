# Telemetry Attribution And Multimodal Metadata v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enrich Gemini Agent telemetry with stable project/workspace attribution and safer multimodal metadata so local analytics can separate projects and measure media coverage without exposing raw content.

**Architecture:** Add a focused attribution resolver module, integrate it inside `captureGeminiTelemetry`, extend media metadata classification, and aggregate the new dimensions in `telemetry summary`. Keep sender/raw-v1 compatibility by using existing flexible metadata and media manifest shapes, while tests enforce aggregate-only outputs.

**Tech Stack:** Node.js ESM, `node:test`, local filesystem APIs, existing telemetry queue/config/schema modules.

---

## File Structure

- Create `src/telemetry-attribution.mjs`: resolve project/workspace attribution with bounded async root search, stable salt, sanitization, caching, and safe fallbacks.
- Create `test/telemetry-attribution.test.mjs`: unit tests for resolver precedence, safety, caching, salts, and fallback behavior.
- Modify `src/telemetry-capture.mjs`: call the resolver and merge attribution metadata without breaking explicit caller fields.
- Modify `test/telemetry-capture.test.mjs`: update expected workspace behavior and add capture integration cases.
- Modify `src/media-metadata.mjs`: add `media_kind`, synthetic basenames, extra MIME mappings, realpath containment, and header-read cap.
- Create `test/media-metadata.test.mjs`: focused tests for metadata inference and filesystem safety.
- Modify `src/telemetry-backfill.mjs`: include media kind and sanitized synthetic basenames in backfilled media manifests.
- Modify `test/telemetry-backfill.test.mjs`: update expected manifests and add fallback inference cases.
- Modify `src/telemetry-schemas.mjs`: allow optional `media_kind` on local telemetry multimodal items.
- Modify `test/telemetry-schemas.test.mjs`: assert schema normalization preserves valid `media_kind`.
- Modify `src/telemetry-summary.mjs`: aggregate top workspaces, top user labels, media-kind coverage, and new recommendations.
- Modify `test/telemetry-summary.test.mjs`: assert aggregate dimensions and no filename/path leakage.
- Modify `README.md` and `test/package.test.mjs`: document the enriched summary at a high level if README text changes are needed.

## Task 1: Attribution Resolver

**Files:**
- Create: `src/telemetry-attribution.mjs`
- Create: `test/telemetry-attribution.test.mjs`

- [ ] **Step 1: Write failing resolver tests**

Create `test/telemetry-attribution.test.mjs` with these test groups:

```js
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import {
  resetTelemetryAttributionCacheForTests,
  resolveTelemetryAttribution,
  sanitizeTelemetryDimension,
} from "../src/telemetry-attribution.mjs";

async function tempDir(prefix = "gemini-agent-attribution-") {
  return mkdtemp(join(tmpdir(), prefix));
}

test("sanitizeTelemetryDimension creates safe analytics tokens", () => {
  assert.equal(sanitizeTelemetryDimension("@vulca/platform"), "vulca-platform");
  assert.equal(sanitizeTelemetryDimension(" EmoArt Challenge "), "emoart-challenge");
  assert.equal(sanitizeTelemetryDimension("person@example.com", "fallback"), "fallback");
  assert.equal(sanitizeTelemetryDimension("../secret path", "fallback"), "secret-path");
  assert.equal(sanitizeTelemetryDimension("", "fallback"), "fallback");
});

test("resolveTelemetryAttribution prefers explicit and env values", async () => {
  resetTelemetryAttributionCacheForTests();
  const cwd = await tempDir();

  const explicit = await resolveTelemetryAttribution({
    cwd,
    projectId: "Explicit Project",
    context: { workspace_id: "ws_explicit" },
    installId: "install_alpha",
    env: { GEMINI_AGENT_PROJECT_ID: "env-project", GEMINI_AGENT_WORKSPACE_ID: "ws_env" },
  });
  assert.equal(explicit.project_id, "explicit-project");
  assert.equal(explicit.workspace_id, "ws_explicit");
  assert.equal(explicit.metadata.project_source, "explicit");
  assert.equal(explicit.metadata.workspace_source, "explicit");

  const fromEnv = await resolveTelemetryAttribution({
    cwd,
    installId: "install_alpha",
    env: { GEMINI_AGENT_PROJECT_ID: "Env Project", GEMINI_AGENT_WORKSPACE_ID: "ws_env" },
  });
  assert.equal(fromEnv.project_id, "env-project");
  assert.equal(fromEnv.workspace_id, "ws_env");
  assert.equal(fromEnv.metadata.project_source, "env");
  assert.equal(fromEnv.metadata.workspace_source, "env");
});

test("resolveTelemetryAttribution derives package project and stable workspace from root", async () => {
  resetTelemetryAttributionCacheForTests();
  const root = await tempDir();
  const nested = join(root, "packages", "app", "src");
  await mkdir(nested, { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "@vulca/platform" }));

  const first = await resolveTelemetryAttribution({
    cwd: nested,
    installId: "install_alpha",
    deploymentId: "dep_alpha",
    env: {},
  });
  const second = await resolveTelemetryAttribution({
    cwd: join(root, "packages"),
    installId: "install_alpha",
    deploymentId: "dep_alpha",
    env: {},
  });

  assert.equal(first.project_id, "vulca-platform");
  assert.match(first.workspace_id, /^ws_[a-f0-9]{24}$/);
  assert.equal(second.workspace_id, first.workspace_id);
  assert.equal(first.metadata.project_source, "package_json");
  assert.equal(first.metadata.workspace_source, "project_root_hash");
});

test("resolveTelemetryAttribution rejects generic roots and missing salts safely", async () => {
  resetTelemetryAttributionCacheForTests();
  const cwd = await tempDir("Documents-");
  await mkdir(join(cwd, ".git"), { recursive: true });

  const result = await resolveTelemetryAttribution({
    cwd,
    homeDir: cwd,
    env: {},
  });

  assert.equal(result.project_id, "gemini-agent");
  assert.equal(result.workspace_id, "ws_unknown");
  assert.equal(result.metadata.project_source, "default");
  assert.equal(result.metadata.workspace_source, "unknown");
  assert.doesNotMatch(JSON.stringify(result), new RegExp(basename(cwd)));
});

test("resolveTelemetryAttribution handles malformed package json and depth limits", async () => {
  resetTelemetryAttributionCacheForTests();
  const root = await tempDir();
  let cwd = root;
  for (let index = 0; index < 8; index += 1) {
    cwd = join(cwd, `level-${index}`);
  }
  await mkdir(cwd, { recursive: true });
  await writeFile(join(root, "package.json"), "{");

  const result = await resolveTelemetryAttribution({
    cwd,
    installId: "install_alpha",
    maxDepth: 3,
    env: {},
  });

  assert.equal(result.project_id, "gemini-agent");
  assert.match(result.workspace_id, /^ws_[a-f0-9]{24}$|^ws_unknown$/);
});

test("resolveTelemetryAttribution coalesces concurrent requests and bounds cache", async () => {
  resetTelemetryAttributionCacheForTests();
  const root = await tempDir();
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "coalesce-app" }));
  let readCount = 0;

  const readJson = async (path) => {
    readCount += 1;
    return JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(path, "utf8")));
  };

  const requests = Array.from({ length: 10 }, () => resolveTelemetryAttribution({
    cwd: root,
    installId: "install_alpha",
    env: {},
    fs: { readJson },
    cacheLimit: 2,
  }));
  const results = await Promise.all(requests);

  assert.equal(new Set(results.map((item) => item.project_id)).size, 1);
  assert.equal(results[0].project_id, "coalesce-app");
  assert.equal(readCount, 1);
});

test("resolveTelemetryAttribution does not permanently cache unexpected read failures", async () => {
  resetTelemetryAttributionCacheForTests();
  const root = await tempDir();
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "retry-app" }));
  let failed = false;
  const readJson = async (path) => {
    if (!failed) {
      failed = true;
      throw new Error("transient read failure");
    }
    return JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(path, "utf8")));
  };

  const first = await resolveTelemetryAttribution({
    cwd: root,
    installId: "install_alpha",
    env: {},
    fs: { readJson },
  });
  const second = await resolveTelemetryAttribution({
    cwd: root,
    installId: "install_alpha",
    env: {},
    fs: { readJson },
  });

  assert.equal(first.project_id, "gemini-agent");
  assert.equal(second.project_id, "retry-app");
});
```

- [ ] **Step 2: Run resolver tests to verify RED**

Run:

```bash
node --test test/telemetry-attribution.test.mjs
```

Expected: FAIL with module-not-found for `src/telemetry-attribution.mjs`.

- [ ] **Step 3: Implement `src/telemetry-attribution.mjs`**

Create the module with these exported functions:

```js
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, parse, resolve } from "node:path";

const DEFAULT_PROJECT_ID = "gemini-agent";
const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_CACHE_LIMIT = 256;
const GENERIC_ROOT_NAMES = new Set([
  "", "users", "home", "desktop", "documents", "downloads", "tmp", "var", "private", "volumes",
]);

let cache = new Map();

export function resetTelemetryAttributionCacheForTests() {
  cache = new Map();
}

export function sanitizeTelemetryDimension(value, fallback = DEFAULT_PROJECT_ID) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || /[^\s@]+@[^\s@]+\.[^\s@]+/.test(text)) return fallback;
  const normalized = text
    .replace(/^@/, "")
    .replace(/[\\/]+/g, "-")
    .replace(/[^A-Za-z0-9._ -]+/g, "-")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return normalized || fallback;
}

function stableSalt({ installId, deploymentId }) {
  if (typeof installId === "string" && installId.startsWith("install_")) return installId;
  if (typeof deploymentId === "string" && deploymentId && deploymentId !== "local") return deploymentId;
  return null;
}

function workspaceHash(path, salt) {
  return `ws_${createHash("sha256").update(`${salt}\0${path}`).digest("hex").slice(0, 24)}`;
}

async function safeRealpath(path) {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

async function defaultReadJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function rootCandidateAt(path) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return null;
    return info;
  } catch {
    return null;
  }
}

async function findProjectRoot({ cwd, maxDepth, readJson }) {
  let current = resolve(cwd);
  const home = parse(current).root;
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const packagePath = join(current, "package.json");
    const packageInfo = await rootCandidateAt(packagePath);
    if (packageInfo?.isFile()) {
      try {
        const pkg = await readJson(packagePath);
        return { root: await safeRealpath(current), packageName: pkg?.name, source: "package_json" };
      } catch {
        return { root: await safeRealpath(current), packageName: null, source: "package_json" };
      }
    }
    const gitInfo = await rootCandidateAt(join(current, ".git"));
    if (gitInfo?.isDirectory() || gitInfo?.isFile()) {
      return { root: await safeRealpath(current), packageName: null, source: "git_root" };
    }
    const next = dirname(current);
    if (next === current || current === home) break;
    current = next;
  }
  return { root: await safeRealpath(cwd), packageName: null, source: "cwd" };
}

function safeGitBasename(root, homeDir) {
  const name = basename(root);
  const normalized = name.toLowerCase();
  const resolvedHome = typeof homeDir === "string" ? resolve(homeDir) : resolve(homedir());
  if (resolvedHome && resolve(root) === resolvedHome) return null;
  if (GENERIC_ROOT_NAMES.has(normalized)) return null;
  return name;
}

function cacheKeyFor(options) {
  return JSON.stringify({
    cwd: resolve(options.cwd ?? process.cwd()),
    projectId: options.projectId ?? null,
    workspaceId: options.context?.workspace_id ?? null,
    envProject: options.env?.GEMINI_AGENT_PROJECT_ID ?? null,
    envWorkspace: options.env?.GEMINI_AGENT_WORKSPACE_ID ?? null,
    installId: options.installId ?? null,
    deploymentId: options.deploymentId ?? null,
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
  });
}

function remember(key, promise, cacheLimit) {
  if (cache.size >= cacheLimit && !cache.has(key)) {
    cache.delete(cache.keys().next().value);
  }
  cache.set(key, promise);
  return promise;
}

async function resolveTelemetryAttributionInner(options) {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const context = options.context && typeof options.context === "object" ? options.context : {};
  const explicitProject = sanitizeTelemetryDimension(options.projectId, "");
  const envProject = sanitizeTelemetryDimension(env.GEMINI_AGENT_PROJECT_ID, "");
  const explicitWorkspace = sanitizeTelemetryDimension(context.workspace_id, "");
  const envWorkspace = sanitizeTelemetryDimension(env.GEMINI_AGENT_WORKSPACE_ID, "");
  const readJson = options.fs?.readJson ?? defaultReadJson;

  const rootInfo = await findProjectRoot({
    cwd,
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    readJson,
  });
  const packageProject = sanitizeTelemetryDimension(rootInfo.packageName, "");
  const gitProject = rootInfo.source === "git_root"
    ? sanitizeTelemetryDimension(safeGitBasename(rootInfo.root, options.homeDir), "")
    : "";
  const project_id = explicitProject || envProject || packageProject || gitProject || DEFAULT_PROJECT_ID;
  const project_source = explicitProject ? "explicit"
    : envProject ? "env"
      : packageProject ? "package_json"
        : gitProject ? "git_root"
          : "default";

  const salt = stableSalt(options);
  const workspace_id = explicitWorkspace || envWorkspace || (salt ? workspaceHash(rootInfo.root, salt) : "ws_unknown");
  const workspace_source = explicitWorkspace ? "explicit"
    : envWorkspace ? "env"
      : salt && rootInfo.source !== "cwd" ? "project_root_hash"
        : salt ? "cwd_hash"
          : "unknown";

  return {
    project_id,
    workspace_id,
    metadata: { project_source, workspace_source },
  };
}

export async function resolveTelemetryAttribution(options = {}) {
  const cacheLimit = Number.isInteger(options.cacheLimit) && options.cacheLimit > 0
    ? options.cacheLimit
    : DEFAULT_CACHE_LIMIT;
  const key = cacheKeyFor(options);
  if (cache.has(key)) return cache.get(key);
  const promise = resolveTelemetryAttributionInner(options).catch(() => {
    cache.delete(key);
    return {
      project_id: DEFAULT_PROJECT_ID,
      workspace_id: "ws_unknown",
      metadata: { project_source: "default", workspace_source: "unknown" },
    };
  });
  return remember(key, promise, cacheLimit);
}
```

- [ ] **Step 4: Run resolver tests to verify GREEN**

Run:

```bash
node --test test/telemetry-attribution.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit resolver**

Run:

```bash
git add src/telemetry-attribution.mjs test/telemetry-attribution.test.mjs
git commit -m "feat: add telemetry attribution resolver"
```

## Task 2: Capture Integration

**Files:**
- Modify: `src/telemetry-capture.mjs`
- Modify: `test/telemetry-capture.test.mjs`

- [ ] **Step 1: Write failing capture integration tests**

Add tests after `captureGeminiTelemetry writes strict raw events when config is enabled`:

```js
test("captureGeminiTelemetry derives package attribution and salted workspace", async () => {
  resetTelemetryCaptureForTests();
  const cwd = await tempDir();
  const nested = join(cwd, "src", "feature");
  await mkdir(nested, { recursive: true });
  await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "@emoart/challenge" }));
  const config = await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: "GEMINI_AGENT_TELEMETRY_TOKEN",
    now: new Date("2026-06-10T09:00:00.000Z"),
  });

  await captureGeminiTelemetry({
    cwd: nested,
    command: "artifact-review",
    prompt: "review image",
    response: "ok",
    status: "success",
    latencyMs: 1,
    loadConfig: async () => ({ scope: "local", storageCwd: cwd, config }),
  });
  await drainTelemetryCapture({ timeoutMs: 1000 });

  const events = await readPendingEvents(cwd);
  assert.equal(events[0].project_id, "emoart-challenge");
  assert.match(events[0].context.workspace_id, /^ws_[a-f0-9]{24}$/);
  assert.equal(events[0].metadata.attribution.project_source, "package_json");
  assert.equal(events[0].metadata.attribution.workspace_source, "project_root_hash");
  assert.doesNotMatch(JSON.stringify(events[0].metadata.attribution), new RegExp(cwd));
});

test("captureGeminiTelemetry preserves explicit attribution metadata", async () => {
  resetTelemetryCaptureForTests();
  const cwd = await tempDir();
  const appended = [];

  await captureGeminiTelemetry({
    cwd,
    projectId: "Vulca Platform",
    context: { workspace_id: "ws_vulca", user_label: "operator" },
    command: "diff-review",
    prompt: "review",
    response: "ok",
    status: "success",
    loadConfig: async () => ({
      scope: "local",
      storageCwd: cwd,
      config: {
        enabled: true,
        level: "raw",
        deployment_id: "gemini-agent-main",
        install_id: "install_alpha",
        user_label: "config-user",
        max_queue_bytes: 1024 * 1024,
        max_event_bytes: 1024 * 1024,
      },
    }),
    appendEvent: async ({ event }) => appended.push(normalizeTelemetryEvent(event)),
  });

  assert.equal(appended[0].project_id, "vulca-platform");
  assert.equal(appended[0].context.workspace_id, "ws_vulca");
  assert.equal(appended[0].context.user_label, "operator");
  assert.equal(appended[0].metadata.attribution.project_source, "explicit");
  assert.equal(appended[0].metadata.attribution.workspace_source, "explicit");
});
```

Update the old `expectedWorkspaceId(cwd)` assertion to expect the new salted value. Keep a helper:

```js
function expectedWorkspaceId(cwd, installId) {
  return `ws_${createHash("sha256").update(`${installId}\0${cwd}`).digest("hex").slice(0, 24)}`;
}
```

- [ ] **Step 2: Run capture tests to verify RED**

Run:

```bash
node --test test/telemetry-capture.test.mjs --test-name-pattern "captureGeminiTelemetry"
```

Expected: FAIL because capture has not integrated the resolver and old workspace hash behavior remains.

- [ ] **Step 3: Integrate attribution in capture**

Modify `src/telemetry-capture.mjs`:

- import `resolveTelemetryAttribution`;
- call it in `captureGeminiTelemetryTask` after config resolution;
- pass `installId`, `deploymentId`, `projectId`, `context`, `cwd`, `home`, and `env`;
- send resolved values into `buildTelemetryEvent`;
- merge attribution metadata under `metadata.attribution`;
- preserve explicit caller metadata.

The shape should be:

```js
const attribution = await resolveTelemetryAttribution({
  cwd,
  homeDir: home,
  projectId,
  context,
  installId: config.install_id ?? null,
  deploymentId: resolvedDeploymentId,
});

const event = await buildTelemetryEvent({
  cwd,
  command,
  source,
  prompt,
  response,
  status,
  errorType,
  latencyMs,
  now,
  contents,
  deploymentId: resolvedDeploymentId,
  installId: config.install_id ?? null,
  userLabel: config.user_label ?? null,
  projectId: attribution.project_id,
  workspaceId: attribution.workspace_id,
  maxEventBytes: config.max_event_bytes,
  context,
  outcome,
  economics,
  metadata: {
    ...(metadata && typeof metadata === "object" ? metadata : {}),
    attribution: attribution.metadata,
  },
});
```

Update `buildTelemetryEvent` to accept `workspaceId`, and use:

```js
const resolvedWorkspaceId = providedContext.workspace_id ?? workspaceId ?? workspaceIdFromCwd(cwd);
```

The fallback helper can remain for legacy no-config or tests, but normal enabled telemetry should use the resolver.

- [ ] **Step 4: Run capture tests to verify GREEN**

Run:

```bash
node --test test/telemetry-capture.test.mjs --test-name-pattern "captureGeminiTelemetry"
```

Expected: PASS.

- [ ] **Step 5: Commit capture integration**

Run:

```bash
git add src/telemetry-capture.mjs test/telemetry-capture.test.mjs
git commit -m "feat: enrich telemetry capture attribution"
```

## Task 3: Media Metadata

**Files:**
- Modify: `src/media-metadata.mjs`
- Create: `test/media-metadata.test.mjs`
- Modify: `src/telemetry-schemas.mjs`
- Modify: `test/telemetry-schemas.test.mjs`

- [ ] **Step 1: Write failing media metadata tests**

Create `test/media-metadata.test.mjs`:

```js
import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  inferMediaKind,
  inferMediaMime,
  mediaReferenceMetadata,
  syntheticMediaBasename,
} from "../src/media-metadata.mjs";

async function tempDir() {
  return mkdtemp(join(tmpdir(), "gemini-agent-media-"));
}

test("inferMediaMime covers common image and document extensions", () => {
  assert.equal(inferMediaMime("mockup.svg"), "image/svg+xml");
  assert.equal(inferMediaMime("capture.gif"), "image/gif");
  assert.equal(inferMediaMime("photo.heic"), "image/heic");
  assert.equal(inferMediaMime("paper.pdf"), "application/pdf");
});

test("inferMediaKind classifies documents, screenshots, designs, and images", () => {
  assert.equal(inferMediaKind({ mimeType: "application/pdf", reference: "paper.pdf" }), "document");
  assert.equal(inferMediaKind({ mimeType: "image/png", reference: "checkout-screenshot.png" }), "screenshot");
  assert.equal(inferMediaKind({ mimeType: "image/png", reference: "figma-mockup.png" }), "design");
  assert.equal(inferMediaKind({ mimeType: "image/jpeg", reference: "photo.jpg" }), "image");
  assert.equal(inferMediaKind({ mimeType: null, reference: "notes.txt" }), "unknown");
});

test("syntheticMediaBasename masks original filenames with a non-public salt", () => {
  const first = syntheticMediaBasename("confidential-customer-screen.png", { salt: "install_alpha" });
  const second = syntheticMediaBasename("confidential-customer-screen.png", { salt: "install_alpha" });
  const differentSalt = syntheticMediaBasename("confidential-customer-screen.png", { salt: "install_beta" });
  assert.equal(first, second);
  assert.notEqual(first, differentSalt);
  assert.match(first, /^media-[a-f0-9]{12}\.png$/);
  assert.doesNotMatch(first, /confidential|customer|screen/);
});

test("mediaReferenceMetadata uses real files inside root and synthetic basename", async () => {
  const root = await tempDir();
  await mkdir(join(root, "outputs"), { recursive: true });
  const file = join(root, "outputs", "checkout-screenshot.png");
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  await writeFile(file, bytes);

  const metadata = await mediaReferenceMetadata("outputs/checkout-screenshot.png", { root });

  assert.equal(metadata.mime_type, "image/png");
  assert.equal(metadata.byte_size, bytes.length);
  assert.equal(metadata.media_kind, "screenshot");
  assert.match(metadata.basename, /^media-[a-f0-9]{12}\.png$/);
  assert.doesNotMatch(JSON.stringify(metadata), /checkout-screenshot/);
});

test("mediaReferenceMetadata rejects outside paths and symlinks", async () => {
  const root = await tempDir();
  const outside = await tempDir();
  await writeFile(join(outside, "secret.png"), "secret");
  await symlink(join(outside, "secret.png"), join(root, "linked.png"));

  assert.equal(await mediaReferenceMetadata(`../${outside.split("/").at(-1)}/secret.png`, { root }), null);
  assert.equal(await mediaReferenceMetadata("linked.png", { root }), null);
});
```

Add a schema test in `test/telemetry-schemas.test.mjs`:

```js
test("normalizes multimodal media kind without leaking filenames", () => {
  const event = normalizeTelemetryEvent({
    schema_version: 1,
    event_id: "evt_media_kind",
    trace_id: "trace_media_kind",
    deployment_id: "dep",
    project_id: "gemini-agent",
    source: "cli",
    command: "artifact-review",
    model: "gemini-3.5-flash",
    prompt: "prompt",
    response: "response",
    status: "success",
    error_type: null,
    latency_ms: 1,
    created_at: "2026-06-10T10:00:00.000Z",
    payload: {
      prompt_truncated: false,
      response_truncated: false,
      multimodal: [{ mime_type: "image/png", byte_size: 10, media_kind: "screenshot" }],
    },
    context: {},
    outcome: {},
    economics: {},
    metadata: {},
  });

  assert.equal(event.payload.multimodal[0].media_kind, "screenshot");
});
```

- [ ] **Step 2: Run media tests to verify RED**

Run:

```bash
node --test test/media-metadata.test.mjs test/telemetry-schemas.test.mjs --test-name-pattern "media|multimodal"
```

Expected: FAIL because `inferMediaKind`, synthetic basename, extra MIME mappings, and schema support are not present.

- [ ] **Step 3: Implement media metadata changes**

Modify `src/media-metadata.mjs`:

- add extension mappings for `.gif`, `.svg`, `.heic`, `.heif`;
- export `inferMediaKind`;
- export `syntheticMediaBasename`;
- use `realpath` in local path containment;
- keep `lstat` rejection for symlinks before size/header reads;
- cap magic-byte reads to 262 bytes;
- make `mediaReferenceMetadata` return synthetic basename plus `media_kind`.

Implementation details:

```js
export function inferMediaKind({ mimeType, reference } = {}) {
  const text = `${reference ?? ""}`.toLowerCase();
  if (mimeType === "application/pdf") return "document";
  if (/\b(figma|wireframe|mockup|prototype|design)\b/.test(text)) return "design";
  if (/\b(screenshot|screen-shot|screen_capture|capture)\b/.test(text)) return "screenshot";
  if (typeof mimeType === "string" && mimeType.startsWith("image/")) return "image";
  return "unknown";
}

export function syntheticMediaBasename(value, { salt = "unknown" } = {}) {
  const name = mediaBasename(value) ?? "media";
  const extension = extname(name).toLowerCase();
  const digest = createHash("sha256").update(`${salt}\0${name}`).digest("hex").slice(0, 12);
  return `media-${digest}${extension}`;
}
```

Modify `src/telemetry-schemas.mjs` multimodal item schema:

```js
const TelemetryMultimodalItemZodSchema = z.strictObject({
  mime_type: z.string().optional(),
  byte_size: z.number().int().nonnegative().optional(),
  basename: z.string().optional(),
  sha256: z.string().optional(),
  media_kind: z.enum(["screenshot", "design", "document", "image", "unknown"]).optional(),
});
```

- [ ] **Step 4: Run media tests to verify GREEN**

Run:

```bash
node --test test/media-metadata.test.mjs test/telemetry-schemas.test.mjs --test-name-pattern "media|multimodal"
```

Expected: PASS.

- [ ] **Step 5: Commit media metadata**

Run:

```bash
git add src/media-metadata.mjs src/telemetry-schemas.mjs test/media-metadata.test.mjs test/telemetry-schemas.test.mjs
git commit -m "feat: enrich multimodal media metadata"
```

## Task 4: Backfill Metadata Enrichment

**Files:**
- Modify: `src/telemetry-backfill.mjs`
- Modify: `test/telemetry-backfill.test.mjs`

- [ ] **Step 1: Write failing backfill tests**

Update expected media manifests in existing backfill tests to synthetic basenames and media kinds. Add this test:

```js
test("artifactReviewsToRawTelemetryBatch infers safe MIME and kind from sanitized outside sources", async () => {
  const projectRoot = await tempDir();
  const artifactsDir = join(projectRoot, ".gemini-agent", "artifacts");
  await mkdir(artifactsDir, { recursive: true });
  await writeArtifact(artifactsDir, "2026-06-03T145551114Z-artifacts.json", artifact({
    metadata: {
      model: "gemini-3.5-flash",
      generated_at: "2026-06-03T14:55:51.114Z",
      sources: ["/local/customer-documents/private-figma-mockup.svg"],
      omitted_sources: [],
    },
  }));

  const batch = await artifactReviewsToRawTelemetryBatch({
    artifactsDir,
    deploymentId: "gemini-agent-main",
    agentVersion: "0.1.0",
    batchId: "batch_backfill_safe_source_inference",
  });

  assert.equal(batch.events[0].media_manifest.length, 1);
  assert.equal(batch.events[0].media_manifest[0].mime_type, "image/svg+xml");
  assert.equal(batch.events[0].media_manifest[0].media_kind, "design");
  assert.match(batch.events[0].media_manifest[0].basename, /^media-[a-f0-9]{12}\.svg$/);
  assert.equal(Object.hasOwn(batch.events[0].media_manifest[0], "byte_size"), false);
  assert.doesNotMatch(JSON.stringify(batch.events[0].media_manifest), /customer|private|figma|mockup|local/);
});
```

- [ ] **Step 2: Run backfill tests to verify RED**

Run:

```bash
node --test test/telemetry-backfill.test.mjs
```

Expected: FAIL because manifests still include original basenames and no `media_kind`.

- [ ] **Step 3: Implement backfill enrichment**

Modify imports in `src/telemetry-backfill.mjs`:

```js
import {
  inferMediaKind,
  inferMediaMime,
  mediaReferenceMetadata,
  mediaBasename,
  syntheticMediaBasename,
} from "./media-metadata.mjs";
```

Update `sourceManifest` so each item:

- starts with `mediaReferenceMetadata(source, { root: projectRoot }) ?? {}`;
- infers `mime_type` from sanitized source if missing;
- sets `media_kind` with `inferMediaKind`;
- sets synthetic `basename`;
- includes `byte_size` only if known.

The item-building logic should follow:

```js
const safeSource = sanitizeBackfillValue(source);
const referenceMetadata = await mediaReferenceMetadata(source, { root: projectRoot }) ?? {};
const mimeType = referenceMetadata.mime_type ?? inferMediaMime(safeSource);
const item = {};
if (mimeType) item.mime_type = mimeType;
if (referenceMetadata.byte_size !== undefined) item.byte_size = referenceMetadata.byte_size;
item.basename = referenceMetadata.basename ?? syntheticMediaBasename(safeSource, { salt: projectRoot ?? deploymentId });
item.media_kind = referenceMetadata.media_kind ?? inferMediaKind({ mimeType, reference: safeSource });
manifest.push(item);
```

- [ ] **Step 4: Run backfill tests to verify GREEN**

Run:

```bash
node --test test/telemetry-backfill.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit backfill enrichment**

Run:

```bash
git add src/telemetry-backfill.mjs test/telemetry-backfill.test.mjs
git commit -m "feat: enrich telemetry backfill media metadata"
```

## Task 5: Summary Dimensions And Coverage

**Files:**
- Modify: `src/telemetry-summary.mjs`
- Modify: `test/telemetry-summary.test.mjs`

- [ ] **Step 1: Write failing summary tests**

Add a top dimensions test:

```js
test("runTelemetrySummary reports workspace and user label dimensions safely", async () => {
  const cwd = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });

  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(61, {
      context: { workspace_id: "ws_vulca", user_label: "vulca-operator", cwd: "[PATH]/vulca" },
    }),
  });
  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(62, {
      context: { workspace_id: "ws_vulca", user_label: "person@example.com", cwd: "[PATH]/vulca" },
    }),
  });

  const summary = await runTelemetrySummary({ cwd, scope: "local" });
  const text = formatTelemetrySummaryText(summary);

  assert.deepEqual(summary.top_workspaces, [
    { workspace_id: "ws_vulca", event_count: 2, success_count: 2, error_count: 0, unknown_count: 0 },
  ]);
  assert.deepEqual(summary.top_user_labels, [
    { user_label: "vulca-operator", event_count: 1, success_count: 1, error_count: 0, unknown_count: 0 },
  ]);
  assert.doesNotMatch(JSON.stringify(summary), /person@example.com|\[PATH\]/);
  assert.doesNotMatch(text, /person@example.com|\[PATH\]/);
});
```

Update `runTelemetrySummary aggregates multimodal metadata without exposing media file names` to expect:

```js
assert.deepEqual(summary.multimodal, {
  event_count: 2,
  item_count: 5,
  byte_count: 3712,
  unknown_mime_items: 1,
  unknown_byte_size_items: 1,
  unknown_kind_items: 1,
  media_items_with_mime: 4,
  media_items_with_byte_size: 4,
  media_items_with_kind: 4,
  top_media_mime: [
    { mime_type: "image/png", event_count: 1, item_count: 2, byte_count: 3072 },
    { mime_type: "application/pdf", event_count: 1, item_count: 1, byte_count: 0 },
    { mime_type: "image/jpeg", event_count: 1, item_count: 1, byte_count: 512 },
    { mime_type: "unknown", event_count: 1, item_count: 1, byte_count: 128 },
  ],
  top_media_kind: [
    { media_kind: "image", event_count: 2, item_count: 3, byte_count: 3584 },
    { media_kind: "document", event_count: 1, item_count: 1, byte_count: 0 },
    { media_kind: "unknown", event_count: 1, item_count: 1, byte_count: 128 },
  ],
});
```

Make the test input include `media_kind` values for known items.

- [ ] **Step 2: Run summary tests to verify RED**

Run:

```bash
node --test test/telemetry-summary.test.mjs --test-name-pattern "workspace|multimodal|correction"
```

Expected: FAIL because summary does not yet return workspace/user dimensions or media-kind coverage.

- [ ] **Step 3: Implement summary aggregation**

Modify `src/telemetry-summary.mjs`:

- add `workspaces`, `userLabels`, and `mediaKinds` maps to `createAccumulator`;
- update them in `addEvent`;
- add coverage counters to `zeroMultimodal`;
- count `media_items_with_mime`, `media_items_with_byte_size`, `media_items_with_kind`;
- add `top_media_kind` rows;
- add `top_workspaces` and `top_user_labels` to returned summary;
- keep text output concise and aggregate-only.

Use helper patterns already present for dimensions and MIME rows. Add:

```js
function updateMediaKind(map, mediaKind, byteSize, seenKinds) {
  const key = sanitizeDimension(mediaKind, "unknown");
  const item = map.get(key) ?? { key, event_count: 0, item_count: 0, byte_count: 0 };
  if (!seenKinds.has(key)) {
    item.event_count += 1;
    seenKinds.add(key);
  }
  item.item_count += 1;
  item.byte_count += byteSize;
  map.set(key, item);
}
```

Add `topMediaKind` equivalent to `topMediaMime`.

- [ ] **Step 4: Run summary tests to verify GREEN**

Run:

```bash
node --test test/telemetry-summary.test.mjs --test-name-pattern "workspace|multimodal|correction"
```

Expected: PASS.

- [ ] **Step 5: Commit summary aggregation**

Run:

```bash
git add src/telemetry-summary.mjs test/telemetry-summary.test.mjs
git commit -m "feat: summarize telemetry attribution and media coverage"
```

## Task 6: Documentation And Final Verification

**Files:**
- Modify: `README.md`
- Modify: `test/package.test.mjs`

- [ ] **Step 1: Update README tests if documentation changes**

If README gets a new line for summary attribution/media coverage, update `test/package.test.mjs` with:

```js
assert.match(readme, /telemetry summary.*workspace.*multimodal/is);
```

Keep this test only if README text is actually changed.

- [ ] **Step 2: Update README**

Add one short README bullet near telemetry summary:

```md
- `telemetry summary` reports aggregate usage, queue health, project/workspace attribution, palette-split quality, and multimodal MIME/kind/byte coverage; it does not print raw prompt, response text, event ids, batch ids, paths, or media file names.
```

- [ ] **Step 3: Run focused docs tests**

Run:

```bash
node --test test/package.test.mjs
```

Expected: PASS.

- [ ] **Step 4: Commit docs**

Run:

```bash
git add README.md test/package.test.mjs
git commit -m "docs: document telemetry attribution metadata"
```

- [ ] **Step 5: Run full verification**

Run:

```bash
git diff --check
npm test
./bin/gemini-agent telemetry summary --global --json | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const r=JSON.parse(s); console.log(JSON.stringify({event_count:r.status_counts?.event_count, top_workspaces:Array.isArray(r.top_workspaces), top_user_labels:Array.isArray(r.top_user_labels), multimodal_keys:Object.keys(r.multimodal || {}).sort()}, null, 2));})'
```

Expected:

- `git diff --check` exits 0.
- `npm test` exits 0.
- summary smoke output confirms `top_workspaces`, `top_user_labels`, and new multimodal keys exist.

- [ ] **Step 6: Run Gemini diff review**

Run:

```bash
git diff main...HEAD | ./bin/gemini-agent diff-review --stdin
```

Expected: `verdict: pass` or only non-blocking suggestions. If it reports a concrete bug, write a failing test, fix it, rerun targeted tests, rerun `npm test`, and rerun diff review.

- [ ] **Step 7: Flush telemetry generated during review**

Run:

```bash
./bin/gemini-agent telemetry doctor --global --json | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const r=JSON.parse(s);const q=r.queue||{};console.log(JSON.stringify({pending:q.pending?.count??q.pending_count??null,failed:q.failed?.count??q.failed_count??null,quarantine:q.quarantine?.count??q.quarantine_count??null},null,2));})'
./bin/gemini-agent telemetry flush --global --batch-size 10 --timeout-ms 10000
./bin/gemini-agent telemetry doctor --global --json | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const r=JSON.parse(s);const q=r.queue||{};console.log(JSON.stringify({pending:q.pending?.count??q.pending_count??null,failed:q.failed?.count??q.failed_count??null,quarantine:q.quarantine?.count??q.quarantine_count??null},null,2));})'
```

Expected final doctor status: `pending=0`, `failed=0`, `quarantine=0`.

## Self-Review Checklist

- Spec coverage: Tasks cover attribution resolver, capture integration, media metadata, schema support, backfill, summary dimensions, docs, verification, diff review, and telemetry flush.
- Privacy coverage: Summary and economics stay aggregate-only; tests assert no raw paths, email labels, or media filenames in ordinary analytics.
- Performance coverage: Resolver cache is bounded and coalesces concurrent requests; filesystem operations are async and non-fatal.
- Stability coverage: Workspace id requires persisted salt or returns `ws_unknown`.
- Scope control: No server migration, dashboard redesign, visual diff, scorecard, or `telemetry priorities` command in this plan.
