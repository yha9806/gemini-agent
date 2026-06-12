import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
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
  assert.equal(sanitizeTelemetryDimension("../secret path", "fallback"), "fallback");
  assert.equal(sanitizeTelemetryDimension("", "fallback"), "fallback");
});

test("sanitizeTelemetryDimension rejects path, credential, and phone-shaped labels", () => {
  assert.equal(sanitizeTelemetryDimension("/Users/alice/vulca-platform", "fallback"), "fallback");
  assert.equal(sanitizeTelemetryDimension("~/.ssh/config", "fallback"), "fallback");
  assert.equal(sanitizeTelemetryDimension("vision Authorization: Bearer secret-token", "fallback"), "fallback");
  assert.equal(sanitizeTelemetryDimension("+1 (415) 555-1212", "fallback"), "fallback");
  assert.equal(sanitizeTelemetryDimension("123-45-6789", "fallback"), "fallback");
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

test("resolveTelemetryAttribution ignores unsafe explicit attribution before safe fallbacks", async () => {
  resetTelemetryAttributionCacheForTests();
  const root = await tempDir();
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "package-app" }));

  const result = await resolveTelemetryAttribution({
    cwd: root,
    projectId: "vision Authorization: Bearer secret-token",
    context: { workspace_id: "123-45-6789" },
    installId: "install_alpha",
    env: {
      GEMINI_AGENT_PROJECT_ID: "Env Project",
      GEMINI_AGENT_WORKSPACE_ID: "ws_env",
    },
  });

  assert.equal(result.project_id, "env-project");
  assert.equal(result.workspace_id, "ws_env");
  assert.equal(result.metadata.project_source, "env");
  assert.equal(result.metadata.workspace_source, "env");
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

test("resolveTelemetryAttribution rejects the real home directory when homeDir is omitted", async () => {
  resetTelemetryAttributionCacheForTests();
  const result = await resolveTelemetryAttribution({
    cwd: homedir(),
    installId: "install_alpha",
    env: {},
    fs: {
      lstat: async (path) => ({
        isFile: () => path.endsWith("package.json") ? false : true,
        isDirectory: () => path.endsWith(".git"),
        isSymbolicLink: () => false,
      }),
    },
  });

  assert.equal(result.project_id, "gemini-agent");
  assert.doesNotMatch(JSON.stringify(result), new RegExp(basename(homedir())));
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
    const { readFile } = await import("node:fs/promises");
    return JSON.parse(await readFile(path, "utf8"));
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
    const { readFile } = await import("node:fs/promises");
    return JSON.parse(await readFile(path, "utf8"));
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
