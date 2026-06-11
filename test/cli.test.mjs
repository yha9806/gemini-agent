import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { saveTelemetryConfig } from "../src/telemetry-config.mjs";
import {
  appendTelemetryEvent,
  claimTelemetryBatch,
  completeTelemetryBatch,
  failTelemetryBatch,
  loadTelemetryState,
  loadTelemetryQueueSnapshot,
  telemetryQueueDirs,
} from "../src/telemetry-queue.mjs";

const execFileAsync = promisify(execFile);
const bin = new URL("../bin/gemini-agent", import.meta.url).pathname;
const receiverBin = new URL("../bin/gemini-agent-telemetry-receiver", import.meta.url).pathname;
const TELEMETRY_TOKEN_ENV = "GEMINI_AGENT_TELEMETRY_TOKEN";
const TELEMETRY_TOKEN = "telemetry-token";
const fakeReview = JSON.stringify({
  verdict: "pass",
  top_risks: [],
  missing_tests: [],
  unsafe_claims: [],
  suggested_changes: [],
  notes: ["fake ok"],
});
const CLI_TEST_HOME = await mkdtemp(join(tmpdir(), "gemini-agent-cli-home-"));
const CLI_TEST_ENV = {
  ...process.env,
  HOME: CLI_TEST_HOME,
  USERPROFILE: CLI_TEST_HOME,
};
after(async () => {
  await rm(CLI_TEST_HOME, { recursive: true, force: true });
});

function telemetryEvent(index, overrides = {}) {
  return {
    schema_version: 1,
    event_id: `evt_cli_${index}`,
    trace_id: `trace_cli_${index}`,
    deployment_id: "dep_cli",
    project_id: "gemini-agent",
    source: "cli",
    command: "ask",
    model: "gemini-3.5-flash",
    prompt: `prompt ${index}`,
    response: `response ${index}`,
    status: "success",
    error_type: null,
    latency_ms: 1,
    created_at: "2026-05-29T09:00:00.000Z",
    payload: {
      prompt_truncated: false,
      response_truncated: false,
      multimodal: [],
    },
    ...overrides,
  };
}

async function queueFailedCliEvents(cwd, { start = 1, count = 1, reason = "http_403" } = {}) {
  for (let offset = 0; offset < count; offset += 1) {
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(`retry_${start + offset}`, {
        prompt: `raw cli prompt ${start + offset}`,
        response: `raw cli response ${start + offset}`,
        payload: {
          prompt_truncated: false,
          response_truncated: false,
          multimodal: [{ mime_type: "image/png", basename: `cli-secret-${start + offset}.png` }],
        },
      }),
      maxQueueBytes: 10 * 1024 * 1024,
    });
  }
  const batch = await claimTelemetryBatch({
    cwd,
    batchSize: count,
    now: new Date("2026-06-10T10:00:00.000Z"),
  });
  await failTelemetryBatch({
    cwd,
    batchId: batch.batchId,
    retryable: false,
    reason,
  });
  return batch;
}

async function completeSentCliEvent(cwd, index, now) {
  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(`sent_${index}`, {
      prompt: `raw sent prompt ${index}`,
      response: `raw sent response ${index}`,
    }),
    maxQueueBytes: 10 * 1024 * 1024,
  });
  const batch = await claimTelemetryBatch({ cwd, batchSize: 1, now });
  await completeTelemetryBatch({ cwd, batchId: batch.batchId, now });
  return batch;
}

async function withTelemetryReceiver(handler) {
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    try {
      await handler({ request, response, body });
    } catch (error) {
      response.writeHead(500, { "Content-Type": "text/plain" });
      response.end(error.stack || error.message);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    endpoint: `http://127.0.0.1:${port}/ingest`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

function execBin(args, { input = "", env = CLI_TEST_ENV, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env, cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const error = new Error(`Command failed: ${bin} ${args.join(" ")}`);
      Object.assign(error, { code, signal, stdout, stderr });
      reject(error);
    });
    child.stdin.end(input);
  });
}

async function fetchJson(url, { token } = {}) {
  const response = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) {
    assert.fail(`${url} returned ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function waitForHealth(url, { timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`${url} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Telemetry receiver health check did not become ready: ${lastError?.message ?? "timeout"}`);
}

function closeChildProcess(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
    }, 1000);
    child.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

async function startTelemetryReceiverCli({ storage, env = process.env } = {}) {
  const child = spawn(receiverBin, [
    "--host",
    "127.0.0.1",
    "--port",
    "0",
    "--storage",
    storage,
    "--token-env",
    TELEMETRY_TOKEN_ENV,
  ], { env });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  const endpoint = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Telemetry receiver did not start.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 5000);

    function cleanup() {
      clearTimeout(timeout);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("error", onError);
      child.off("close", onClose);
    }
    function onStdout(chunk) {
      stdout += chunk;
    }
    function onStderr(chunk) {
      stderr += chunk;
      const match = stderr.match(/Telemetry receiver listening on (http:\/\/[^\s]+)/);
      if (match) {
        cleanup();
        resolve(`${match[1]}/ingest`);
      }
    }
    function onError(error) {
      cleanup();
      reject(error);
    }
    function onClose(code, signal) {
      cleanup();
      reject(new Error(
        `Telemetry receiver exited before startup (code=${code}, signal=${signal}).\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      ));
    }

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("error", onError);
    child.once("close", onClose);
  }).catch(async (error) => {
    await closeChildProcess(child);
    throw error;
  });

  try {
    await waitForHealth(endpoint.replace(/\/ingest$/, "/health"));
  } catch (error) {
    await closeChildProcess(child);
    error.message = `${error.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`;
    throw error;
  }

  return {
    endpoint,
    child,
    get output() {
      return { stdout, stderr };
    },
    close: () => closeChildProcess(child),
  };
}
const fakeContextPack = JSON.stringify({
  kind: "context_pack",
  source_summary: ["project notes summary"],
  project_facts: ["CLI accepts context input"],
  relevant_files: [{ path: "stdin", why_relevant: "provided input" }],
  open_questions: [],
  risks: [],
  recommended_codex_actions: ["continue with implementation"],
  limitations: ["selected input only"],
  metadata: {
    model: "gemini-3.5-flash",
    generated_at: "2026-05-28T00:00:00.000Z",
    sources: [],
    omitted_sources: [],
  },
});
const fakeArtifactReview = JSON.stringify({
  kind: "artifact_review",
  artifact_type: "image",
  summary: ["Dashboard screenshot"],
  important_details: ["Primary action is visible"],
  design_or_research_findings: ["Layout is readable"],
  implementation_hints_for_codex: ["Use existing button styles"],
  risks_or_ambiguities: [],
  questions_for_user: [],
  limitations: ["Single image only"],
  metadata: {
    model: "gemini-3.5-flash",
    generated_at: "2026-05-28T00:00:00.000Z",
    sources: [],
    omitted_sources: [],
  },
});

test("auth status reports env source without exposing key", async () => {
  const { stdout } = await execFileAsync(bin, ["auth", "status"], {
    env: { ...process.env, GEMINI_API_KEY: "secret-value" },
  });
  assert.match(stdout, /"ok": true/);
  assert.match(stdout, /"source": "env"/);
  assert.doesNotMatch(stdout, /secret-value/);
});

test("diff-review accepts file input and prints JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));
  const diffPath = join(dir, "change.diff");
  await writeFile(diffPath, "diff --git a/a b/a\n+hello\n");
  const { stdout } = await execFileAsync(bin, ["diff-review", "--file", diffPath], {
    cwd: dir,
    env: {
      ...process.env,
      HOME: CLI_TEST_HOME,
      GEMINI_API_KEY: "fake-key",
      GEMINI_AGENT_ALLOW_FAKE_RESPONSE: "1",
      GEMINI_AGENT_FAKE_RESPONSE: fakeReview,
    },
  });
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.verdict, "pass");
  assert.deepEqual(parsed.notes, ["fake ok"]);
});

test("diff-review --diff reads current git diff and prints JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));
  await execFileAsync("git", ["init"], { cwd: dir });
  await writeFile(join(dir, "app.txt"), "old\n");
  await execFileAsync("git", ["add", "app.txt"], { cwd: dir });
  await writeFile(join(dir, "app.txt"), "new\n");

  const { stdout } = await execFileAsync(bin, ["diff-review", "--diff"], {
    cwd: dir,
    env: {
      ...process.env,
      HOME: CLI_TEST_HOME,
      GEMINI_API_KEY: "fake-key",
      GEMINI_AGENT_ALLOW_FAKE_RESPONSE: "1",
      GEMINI_AGENT_FAKE_RESPONSE: fakeReview,
    },
  });
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.verdict, "pass");
  assert.deepEqual(parsed.notes, ["fake ok"]);
});

test("diff-review --diff rejects empty git diff before auth lookup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));
  await execFileAsync("git", ["init"], { cwd: dir });

  await assert.rejects(
    execFileAsync(bin, ["diff-review", "--diff"], {
      cwd: dir,
      env: { PATH: process.env.PATH, HOME: CLI_TEST_HOME },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Gate input is empty\./);
      assert.doesNotMatch(error.stderr, /Gemini API key/);
      return true;
    },
  );
});

test("diff-review rejects missing file path", async () => {
  await assert.rejects(
    execFileAsync(bin, ["diff-review", "--file"], {
      env: { ...process.env, GEMINI_API_KEY: "fake-key" },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /--file requires a path\./);
      return true;
    },
  );
});

test("diff-review rejects empty file input before review generation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));
  const diffPath = join(dir, "empty.diff");
  await writeFile(diffPath, "");
  await assert.rejects(
    execFileAsync(bin, ["diff-review", "--file", diffPath], {
      cwd: dir,
      env: { ...process.env, GEMINI_API_KEY: "fake-key" },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Gate input is empty\./);
      return true;
    },
  );
});

test("diff-review does not use fake response without explicit allow flag", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));
  const diffPath = join(dir, "change.diff");
  await writeFile(diffPath, "diff --git a/a b/a\n+hello\n");
  await assert.rejects(
    execFileAsync(bin, ["diff-review", "--file", diffPath], {
      cwd: dir,
      env: {
        ...process.env,
        GEMINI_API_KEY: "fake-key",
        GEMINI_AGENT_FAKE_RESPONSE: fakeReview,
      },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.doesNotMatch(error.stdout, /fake ok/);
      assert.match(error.stderr, /GEMINI_AGENT_ALLOW_FAKE_RESPONSE=1/);
      return true;
    },
  );
});

test("plan-critique rejects oversized stdin before auth lookup", async () => {
  await assert.rejects(
    execBin(["plan-critique", "--stdin", "--max-input-bytes", "5"], {
      input: "123456",
      env: { PATH: process.env.PATH, HOME: CLI_TEST_HOME },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /plan-critique input exceeds 5 bytes/);
      assert.match(error.stderr, /context-pack/);
      assert.doesNotMatch(error.stderr, /Gemini API key/);
      return true;
    },
  );
});

test("diff-review wraps collected context input exceeds errors with context-pack advisor", async () => {
  const oversizedInput = "x".repeat(4 * 1024 * 1024);

  await assert.rejects(
    execBin(["diff-review", "--stdin", "--diff"], {
      input: oversizedInput,
      env: { PATH: process.env.PATH, HOME: CLI_TEST_HOME },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /diff-review context input exceeds 4194304 bytes\./);
      assert.match(error.stderr, /gemini-agent context-pack --bootstrap --write-artifact/);
      assert.match(error.stderr, /gemini-agent diff-review --auto-context-pack/);
      assert.match(error.stderr, /narrow fresh input/);
      assert.doesNotMatch(error.stderr, /Gemini API key/);
      return true;
    },
  );
});

test("plan-critique checks file size before auth lookup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));
  const planPath = join(dir, "plan.md");
  await writeFile(planPath, "123456");

  await assert.rejects(
    execFileAsync(bin, ["plan-critique", "--file", planPath, "--max-input-bytes", "5"], {
      cwd: dir,
      env: { PATH: process.env.PATH, HOME: CLI_TEST_HOME },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /plan-critique input exceeds 5 bytes/);
      assert.doesNotMatch(error.stderr, /Gemini API key/);
      return true;
    },
  );
});

test("plan-critique accepts explicit byte limit override", async () => {
  const { stdout } = await execBin(["plan-critique", "--stdin", "--max-input-bytes", "6"], {
    input: "123456",
    env: {
      ...process.env,
      HOME: CLI_TEST_HOME,
      GEMINI_API_KEY: "fake-key",
      GEMINI_AGENT_ALLOW_FAKE_RESPONSE: "1",
      GEMINI_AGENT_FAKE_RESPONSE: fakeReview,
    },
  });

  const parsed = JSON.parse(stdout);
  assert.equal(parsed.verdict, "pass");
  assert.deepEqual(parsed.notes, ["fake ok"]);
});

test("diff-review emits context-pack preflight warning for large raw stdin without breaking JSON stdout", async () => {
  const { stdout, stderr } = await execBin(["diff-review", "--stdin"], {
    input: "x".repeat(20 * 1024),
    env: {
      ...process.env,
      HOME: CLI_TEST_HOME,
      GEMINI_API_KEY: "fake-key",
      GEMINI_AGENT_ALLOW_FAKE_RESPONSE: "1",
      GEMINI_AGENT_FAKE_RESPONSE: fakeReview,
    },
  });

  const parsed = JSON.parse(stdout);
  assert.equal(parsed.verdict, "pass");
  assert.match(stderr, /diff-review raw input is 20480 bytes; current run will continue\./);
  assert.match(stderr, /gemini-agent context-pack --bootstrap --write-artifact/);
  assert.match(stderr, /gemini-agent diff-review --auto-context-pack/);
});

test("diff-review queues safe context-pack preflight metadata for large raw stdin", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-preflight-telemetry-"));
  await saveTelemetryConfig({
    cwd: dir,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TELEMETRY_TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });

  const { stdout, stderr } = await execBin(["diff-review", "--stdin"], {
    cwd: dir,
    input: "x".repeat(20 * 1024),
    env: {
      ...process.env,
      HOME: CLI_TEST_HOME,
      GEMINI_API_KEY: "fake-key",
      GEMINI_AGENT_ALLOW_FAKE_RESPONSE: "1",
      GEMINI_AGENT_FAKE_RESPONSE: fakeReview,
    },
  });

  const parsed = JSON.parse(stdout);
  assert.equal(parsed.verdict, "pass");
  assert.match(stderr, /diff-review raw input is 20480 bytes/);

  const pending = await readdir(telemetryQueueDirs(dir).pending);
  assert.equal(pending.length, 1);
  const event = JSON.parse(await readFile(join(telemetryQueueDirs(dir).pending, pending[0]), "utf8"));
  assert.equal(event.metadata.context_pack_preflight_warning, true);
  assert.equal(event.metadata.context_pack_preflight_threshold_bytes, 16 * 1024);
});

test("diff-review suppresses context-pack preflight warning when auto context pack is used", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-preflight-auto-"));
  await mkdir(join(dir, ".gemini-agent", "context"), { recursive: true });
  await writeFile(join(dir, ".gemini-agent", "context", "latest.json"), fakeContextPack);

  const { stdout, stderr } = await execBin(["diff-review", "--auto-context-pack", "--stdin"], {
    cwd: dir,
    input: "x".repeat(20 * 1024),
    env: {
      ...process.env,
      HOME: CLI_TEST_HOME,
      GEMINI_API_KEY: "fake-key",
      GEMINI_AGENT_ALLOW_FAKE_RESPONSE: "1",
      GEMINI_AGENT_FAKE_RESPONSE: fakeReview,
    },
  });

  const parsed = JSON.parse(stdout);
  assert.equal(parsed.verdict, "pass");
  assert.equal(stderr, "");
});

test("diff-review --diff with existing context pack suggests smart context reuse and queues safe metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-smart-preflight-"));
  await execFileAsync("git", ["init"], { cwd: dir });
  await mkdir(join(dir, ".gemini-agent", "context"), { recursive: true });
  await writeFile(join(dir, ".gemini-agent", "context", "latest.json"), fakeContextPack);
  await writeFile(join(dir, "app.txt"), "old\n");
  await execFileAsync("git", ["add", "app.txt"], { cwd: dir });
  await writeFile(join(dir, "app.txt"), `${"new line\n".repeat(3000)}\n`);
  await saveTelemetryConfig({
    cwd: dir,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TELEMETRY_TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });

  const { stdout, stderr } = await execBin(["diff-review", "--diff"], {
    cwd: dir,
    env: {
      ...process.env,
      HOME: CLI_TEST_HOME,
      GEMINI_API_KEY: "fake-key",
      GEMINI_AGENT_ALLOW_FAKE_RESPONSE: "1",
      GEMINI_AGENT_FAKE_RESPONSE: fakeReview,
    },
  });

  assert.equal(JSON.parse(stdout).verdict, "pass");
  assert.match(stderr, /diff-review can reuse the existing context pack/);
  assert.match(stderr, /gemini-agent diff-review --smart-diff/);
  assert.doesNotMatch(stderr, /Run: gemini-agent context-pack --bootstrap --write-artifact/);

  const pending = await readdir(telemetryQueueDirs(dir).pending);
  assert.equal(pending.length, 1);
  const event = JSON.parse(await readFile(join(telemetryQueueDirs(dir).pending, pending[0]), "utf8"));
  assert.equal(event.metadata.context_pack_existing_hint, true);
  assert.doesNotMatch(JSON.stringify(event.metadata), /latest\.json|\.gemini-agent/);
});

test("diff-review --auto-context-pack --diff suppresses existing context pack hint", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-smart-preflight-auto-"));
  await execFileAsync("git", ["init"], { cwd: dir });
  await mkdir(join(dir, ".gemini-agent", "context"), { recursive: true });
  await writeFile(join(dir, ".gemini-agent", "context", "latest.json"), fakeContextPack);
  await writeFile(join(dir, "app.txt"), "old\n");
  await execFileAsync("git", ["add", "app.txt"], { cwd: dir });
  await writeFile(join(dir, "app.txt"), `${"new line\n".repeat(3000)}\n`);

  const { stdout, stderr } = await execBin(["diff-review", "--auto-context-pack", "--diff"], {
    cwd: dir,
    env: {
      ...process.env,
      HOME: CLI_TEST_HOME,
      GEMINI_API_KEY: "fake-key",
      GEMINI_AGENT_ALLOW_FAKE_RESPONSE: "1",
      GEMINI_AGENT_FAKE_RESPONSE: fakeReview,
    },
  });

  assert.equal(JSON.parse(stdout).verdict, "pass");
  assert.equal(stderr, "");
});

test("diff-review --smart-diff uses auto context pack with current git diff and safe telemetry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-smart-diff-"));
  await execFileAsync("git", ["init"], { cwd: dir });
  await mkdir(join(dir, ".gemini-agent", "context"), { recursive: true });
  await writeFile(join(dir, ".gemini-agent", "context", "latest.json"), fakeContextPack);
  await writeFile(join(dir, "app.txt"), "old\n");
  await execFileAsync("git", ["add", "app.txt"], { cwd: dir });
  await writeFile(join(dir, "app.txt"), "new\n");
  await saveTelemetryConfig({
    cwd: dir,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TELEMETRY_TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });

  const { stdout, stderr } = await execBin(["diff-review", "--smart-diff"], {
    cwd: dir,
    env: {
      ...process.env,
      HOME: CLI_TEST_HOME,
      GEMINI_API_KEY: "fake-key",
      GEMINI_AGENT_ALLOW_FAKE_RESPONSE: "1",
      GEMINI_AGENT_FAKE_RESPONSE: fakeReview,
    },
  });

  assert.equal(JSON.parse(stdout).verdict, "pass");
  assert.equal(stderr, "");

  const pending = await readdir(telemetryQueueDirs(dir).pending);
  assert.equal(pending.length, 1);
  const event = JSON.parse(await readFile(join(telemetryQueueDirs(dir).pending, pending[0]), "utf8"));
  assert.equal(event.metadata.context_pack_mode, "auto");
  assert.equal(event.metadata.fresh_input_mode, "smart-diff");
  assert.equal(event.metadata.smart_diff_shortcut, true);
  assert.equal(event.metadata.context_pack_preflight_warning, false);
  assert.doesNotMatch(JSON.stringify(event.metadata), /latest\.json|\.gemini-agent|app\.txt/);
});

test("diff-review --smart-diff fails clearly when context pack is missing before credentials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-smart-diff-missing-"));
  await execFileAsync("git", ["init"], { cwd: dir });
  await writeFile(join(dir, "app.txt"), "old\n");
  await execFileAsync("git", ["add", "app.txt"], { cwd: dir });
  await writeFile(join(dir, "app.txt"), "new\n");

  await assert.rejects(
    execBin(["diff-review", "--smart-diff"], {
      cwd: dir,
      env: { ...process.env, HOME: CLI_TEST_HOME },
    }),
    (error) => {
      assert.match(error.stderr, /No context pack found/);
      assert.match(error.stderr, /context-pack --bootstrap --write-artifact/);
      assert.match(error.stderr, /--smart-diff/);
      assert.doesNotMatch(error.stderr, /Gemini API key is not configured/);
      return true;
    },
  );
});

test("diff-review --smart-diff rejects conflicting input flags", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-smart-diff-conflict-"));
  await assert.rejects(
    execBin(["diff-review", "--smart-diff", "--diff"], {
      cwd: dir,
      env: { ...process.env, HOME: CLI_TEST_HOME },
    }),
    (error) => {
      assert.match(error.stderr, /--smart-diff cannot be combined with --diff, --stdin, --file, --context-pack, --auto-context-pack, or text input/);
      return true;
    },
  );
});

test("non diff-review gates reject --smart-diff", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-smart-diff-scope-"));
  await assert.rejects(
    execBin(["plan-critique", "--smart-diff"], {
      cwd: dir,
      env: { ...process.env, HOME: CLI_TEST_HOME },
    }),
    (error) => {
      assert.match(error.stderr, /--smart-diff is only supported for diff-review/);
      return true;
    },
  );
});

test("gate commands accept context-pack input and print JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));
  const contextPath = join(dir, "context.json");
  await writeFile(contextPath, fakeContextPack);

  for (const command of ["plan-critique", "patch-precheck", "diff-review", "research-brief"]) {
    const { stdout } = await execFileAsync(bin, [command, "--context-pack", contextPath], {
      cwd: dir,
      env: {
        ...process.env,
        HOME: CLI_TEST_HOME,
        GEMINI_API_KEY: "fake-key",
        GEMINI_AGENT_ALLOW_FAKE_RESPONSE: "1",
        GEMINI_AGENT_FAKE_RESPONSE: fakeReview,
      },
    });

    const parsed = JSON.parse(stdout);
    assert.equal(parsed.verdict, "pass");
    assert.deepEqual(parsed.notes, ["fake ok"]);
  }
});

test("gate commands auto-discover project-root context pack from nested git cwd", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-auto-context-"));
  await execFileAsync("git", ["init"], { cwd: dir });
  await mkdir(join(dir, ".gemini-agent", "context"), { recursive: true });
  await writeFile(join(dir, ".gemini-agent", "context", "latest.json"), fakeContextPack);
  const nested = join(dir, "packages", "app");
  await mkdir(nested, { recursive: true });

  const { stdout } = await execFileAsync(bin, ["plan-critique", "--auto-context-pack"], {
    cwd: nested,
    env: {
      ...process.env,
      HOME: CLI_TEST_HOME,
      GEMINI_API_KEY: "fake-key",
      GEMINI_AGENT_ALLOW_FAKE_RESPONSE: "1",
      GEMINI_AGENT_FAKE_RESPONSE: fakeReview,
    },
  });

  const parsed = JSON.parse(stdout);
  assert.equal(parsed.verdict, "pass");
  assert.deepEqual(parsed.notes, ["fake ok"]);
});

test("gate commands auto-discover context pack from non-git cwd fallback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-auto-context-nongit-"));
  await mkdir(join(dir, ".gemini-agent", "context"), { recursive: true });
  await writeFile(join(dir, ".gemini-agent", "context", "latest.json"), fakeContextPack);

  const { stdout } = await execFileAsync(bin, ["research-brief", "--auto-context-pack"], {
    cwd: dir,
    env: {
      ...process.env,
      HOME: CLI_TEST_HOME,
      GEMINI_API_KEY: "fake-key",
      GEMINI_AGENT_ALLOW_FAKE_RESPONSE: "1",
      GEMINI_AGENT_FAKE_RESPONSE: fakeReview,
    },
  });

  const parsed = JSON.parse(stdout);
  assert.equal(parsed.verdict, "pass");
});

test("plan-critique rejects missing auto context-pack before auth lookup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-auto-context-missing-"));

  await assert.rejects(
    execFileAsync(bin, ["plan-critique", "--auto-context-pack"], {
      cwd: dir,
      env: { PATH: process.env.PATH, HOME: CLI_TEST_HOME },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /No context pack found/);
      assert.match(error.stderr, /context-pack --bootstrap --write-artifact/);
      assert.doesNotMatch(error.stderr, /Gemini API key/);
      return true;
    },
  );
});

test("plan-critique rejects invalid auto context-pack before auth lookup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-auto-context-invalid-"));
  await mkdir(join(dir, ".gemini-agent", "context"), { recursive: true });
  await writeFile(join(dir, ".gemini-agent", "context", "latest.json"), "{bad json");

  await assert.rejects(
    execFileAsync(bin, ["plan-critique", "--auto-context-pack"], {
      cwd: dir,
      env: { PATH: process.env.PATH, HOME: CLI_TEST_HOME },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Invalid context pack JSON/);
      assert.doesNotMatch(error.stderr, /Gemini API key/);
      return true;
    },
  );
});

test("plan-critique rejects explicit and auto context-pack together", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-auto-context-exclusive-"));
  const contextPath = join(dir, "context.json");
  await writeFile(contextPath, fakeContextPack);

  await assert.rejects(
    execFileAsync(bin, ["plan-critique", "--context-pack", contextPath, "--auto-context-pack"], {
      cwd: dir,
      env: { PATH: process.env.PATH, HOME: CLI_TEST_HOME },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /--context-pack and --auto-context-pack are mutually exclusive/);
      assert.doesNotMatch(error.stderr, /Gemini API key/);
      return true;
    },
  );
});

test("plan-critique enforces auto context-pack and stdin combined limit before auth lookup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-auto-context-limit-"));
  await mkdir(join(dir, ".gemini-agent", "context"), { recursive: true });
  await writeFile(join(dir, ".gemini-agent", "context", "latest.json"), fakeContextPack);

  await assert.rejects(
    execBin(["plan-critique", "--auto-context-pack", "--stdin", "--max-input-bytes", "80"], {
      cwd: dir,
      input: "additional plan text",
      env: { PATH: process.env.PATH, HOME: CLI_TEST_HOME },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /plan-critique input exceeds 80 bytes/);
      assert.doesNotMatch(error.stderr, /Gemini API key/);
      return true;
    },
  );
});

test("plan-critique rejects missing context-pack path", async () => {
  await assert.rejects(
    execFileAsync(bin, ["plan-critique", "--context-pack"], {
      env: { PATH: process.env.PATH, HOME: CLI_TEST_HOME },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /--context-pack requires a path\./);
      assert.doesNotMatch(error.stderr, /Gemini API key/);
      return true;
    },
  );
});

test("plan-critique rejects invalid context-pack before auth lookup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));
  const contextPath = join(dir, "context.json");
  await writeFile(contextPath, "{bad json");

  await assert.rejects(
    execFileAsync(bin, ["plan-critique", "--context-pack", contextPath], {
      cwd: dir,
      env: { PATH: process.env.PATH, HOME: CLI_TEST_HOME },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Invalid context pack JSON/);
      assert.doesNotMatch(error.stderr, /Gemini API key/);
      return true;
    },
  );
});

test("plan-critique enforces combined context-pack and stdin byte limit before auth lookup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));
  const contextPath = join(dir, "context.json");
  await writeFile(contextPath, fakeContextPack);

  await assert.rejects(
    execBin(["plan-critique", "--context-pack", contextPath, "--stdin", "--max-input-bytes", "80"], {
      cwd: dir,
      input: "additional plan text",
      env: { PATH: process.env.PATH, HOME: CLI_TEST_HOME },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /plan-critique input exceeds 80 bytes/);
      assert.doesNotMatch(error.stderr, /Gemini API key/);
      return true;
    },
  );
});

test("auth set requires an interactive TTY", async () => {
  await assert.rejects(
    execFileAsync(bin, ["auth", "set"], {
      input: "secret-value\n",
      env: process.env,
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /auth set requires an interactive TTY\./);
      assert.doesNotMatch(error.stdout, /secret-value/);
      assert.doesNotMatch(error.stderr, /secret-value/);
      return true;
    },
  );
});

test("ask rejects empty prompts before auth lookup", async () => {
  for (const args of [["ask"], ["ask", "   "]]) {
    await assert.rejects(
      execFileAsync(bin, args, {
        env: { PATH: process.env.PATH },
      }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /Prompt is empty\./);
        assert.doesNotMatch(error.stderr, /Gemini API key/);
        return true;
      },
    );
  }
});

test("context-pack accepts stdin and prints JSON", async () => {
  const { stdout } = await execBin(["context-pack", "--stdin"], {
    input: "project notes",
    env: {
      ...process.env,
      HOME: CLI_TEST_HOME,
      GEMINI_API_KEY: "fake-key",
      GEMINI_AGENT_ALLOW_FAKE_RESPONSE: "1",
      GEMINI_AGENT_FAKE_RESPONSE: fakeContextPack,
    },
  });

  const parsed = JSON.parse(stdout);
  assert.equal(parsed.kind, "context_pack");
  assert.deepEqual(parsed.source_summary, ["project notes summary"]);
  assert.deepEqual(parsed.metadata.sources, ["stdin"]);
});

test("context-pack bootstrap writes project-root artifact from nested git cwd", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-bootstrap-"));
  await execFileAsync("git", ["init"], { cwd: dir });
  await writeFile(join(dir, "README.md"), "# Bootstrap Project\n");
  await writeFile(join(dir, "package-lock.json"), "{\"lockfileVersion\":3}\n");
  await writeFile(join(dir, ".env"), "SECRET=value\n");
  const nested = join(dir, "packages", "app");
  await mkdir(nested, { recursive: true });

  const { stdout } = await execFileAsync(bin, ["context-pack", "--bootstrap", "--write-artifact"], {
    cwd: nested,
    env: {
      ...process.env,
      HOME: CLI_TEST_HOME,
      GEMINI_API_KEY: "fake-key",
      GEMINI_AGENT_ALLOW_FAKE_RESPONSE: "1",
      GEMINI_AGENT_FAKE_RESPONSE: fakeContextPack,
    },
  });

  const parsed = JSON.parse(stdout);
  assert.equal(parsed.kind, "context_pack");
  assert.deepEqual(parsed.metadata.sources, ["README.md"]);

  const latest = JSON.parse(await readFile(join(dir, ".gemini-agent", "context", "latest.json"), "utf8"));
  assert.equal(latest.kind, "context_pack");
  assert.deepEqual(latest.metadata.sources, ["README.md"]);
  assert.doesNotMatch(JSON.stringify(latest), /lockfileVersion|SECRET=value/);
});

test("context-pack bootstrap rejects empty project before auth lookup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-bootstrap-empty-"));

  await assert.rejects(
    execFileAsync(bin, ["context-pack", "--bootstrap", "--write-artifact"], {
      cwd: dir,
      env: { PATH: process.env.PATH, HOME: CLI_TEST_HOME },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Bootstrap context is empty/);
      assert.doesNotMatch(error.stderr, /Gemini API key/);
      return true;
    },
  );
});

test("context-pack bootstrap rejects manual input flags before auth lookup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-bootstrap-exclusive-"));
  await writeFile(join(dir, "README.md"), "# Project\n");

  for (const args of [
    ["context-pack", "--bootstrap", "--stdin"],
    ["context-pack", "--bootstrap", "--file", "README.md"],
    ["context-pack", "--bootstrap", "--diff"],
    ["context-pack", "--bootstrap", "manual notes"],
  ]) {
    const run = args.includes("--stdin")
      ? execBin(args, {
        cwd: dir,
        input: "manual\n",
        env: { PATH: process.env.PATH, HOME: CLI_TEST_HOME },
      })
      : execFileAsync(bin, args, {
        cwd: dir,
        env: { PATH: process.env.PATH, HOME: CLI_TEST_HOME },
      });

    await assert.rejects(
      run,
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /--bootstrap cannot be combined with manual context input/);
        assert.doesNotMatch(error.stderr, /Gemini API key/);
        return true;
      },
    );
  }
});

test("context-pack rejects empty input before auth lookup", async () => {
  await assert.rejects(
    execBin(["context-pack", "--stdin"], {
      input: "   \n",
      env: { PATH: process.env.PATH },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Context input is empty/);
      assert.doesNotMatch(error.stderr, /Gemini API key/);
      return true;
    },
  );
});

test("context-pack rejects missing file before auth lookup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));
  await assert.rejects(
    execFileAsync(bin, ["context-pack", "--file", "missing.md"], {
      cwd: dir,
      env: { PATH: process.env.PATH },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /ENOENT/);
      assert.doesNotMatch(error.stderr, /Gemini API key/);
      return true;
    },
  );
});

test("context-pack rejects unsafe file paths before auth lookup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));
  await writeFile(join(dir, "notes.md"), "notes\n");

  await assert.rejects(
    execFileAsync(bin, ["context-pack", "--file", join(dir, "notes.md")], {
      cwd: dir,
      env: { PATH: process.env.PATH },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /File path must be relative to cwd/);
      assert.doesNotMatch(error.stderr, /Gemini API key/);
      return true;
    },
  );

  await assert.rejects(
    execFileAsync(bin, ["context-pack", "--file", "../notes.md"], {
      cwd: dir,
      env: { PATH: process.env.PATH },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /File path must stay within cwd/);
      assert.doesNotMatch(error.stderr, /Gemini API key/);
      return true;
    },
  );
});

test("context-pack accepts direct text args and prints JSON", async () => {
  const { stdout } = await execFileAsync(bin, ["context-pack", "project", "notes"], {
    env: {
      ...process.env,
      HOME: CLI_TEST_HOME,
      GEMINI_API_KEY: "fake-key",
      GEMINI_AGENT_ALLOW_FAKE_RESPONSE: "1",
      GEMINI_AGENT_FAKE_RESPONSE: fakeContextPack,
    },
  });

  const parsed = JSON.parse(stdout);
  assert.equal(parsed.kind, "context_pack");
  assert.deepEqual(parsed.metadata.sources, ["stdin"]);
});

test("artifact-review accepts image file and prints JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));
  const imagePath = join(dir, "design.png");
  await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

  const { stdout } = await execFileAsync(bin, ["artifact-review", "--file", "design.png", "--kind", "ui"], {
    cwd: dir,
    env: {
      ...process.env,
      HOME: CLI_TEST_HOME,
      GEMINI_API_KEY: "fake-key",
      GEMINI_AGENT_ALLOW_FAKE_RESPONSE: "1",
      GEMINI_AGENT_FAKE_RESPONSE: fakeArtifactReview,
    },
  });

  const parsed = JSON.parse(stdout);
  assert.equal(parsed.kind, "artifact_review");
  assert.equal(parsed.artifact_type, "design");
  assert.deepEqual(parsed.summary, ["Dashboard screenshot"]);
});

test("artifact-review accepts multiple image files for comparison", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  await writeFile(join(dir, "before.png"), png);
  await writeFile(join(dir, "after.png"), png);

  const { stdout } = await execFileAsync(bin, [
    "artifact-review",
    "--file",
    "before.png",
    "--file",
    "after.png",
    "--kind",
    "ui",
    "--review-mode",
    "comparison",
  ], {
    cwd: dir,
    env: {
      ...process.env,
      HOME: CLI_TEST_HOME,
      GEMINI_API_KEY: "fake-key",
      GEMINI_AGENT_ALLOW_FAKE_RESPONSE: "1",
      GEMINI_AGENT_FAKE_RESPONSE: fakeArtifactReview,
    },
  });

  const parsed = JSON.parse(stdout);
  assert.equal(parsed.kind, "artifact_review");
  assert.equal(parsed.artifact_type, "design");
  assert.deepEqual(parsed.metadata.sources, ["before.png", "after.png"]);
  assert.equal(parsed.metadata.review_mode, "comparison");
});

test("artifact-review rejects unsupported artifact before auth lookup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));
  await writeFile(join(dir, "archive.zip"), "zip");

  await assert.rejects(
    execFileAsync(bin, ["artifact-review", "--file", "archive.zip"], {
      cwd: dir,
      env: { PATH: process.env.PATH },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Unsupported artifact file type/);
      assert.doesNotMatch(error.stderr, /Gemini API key/);
      return true;
    },
  );
});

test("artifact-review rejects unsupported first file before auth lookup when multiple files are provided", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));
  await writeFile(join(dir, "archive.zip"), "zip");
  await writeFile(join(dir, "after.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

  await assert.rejects(
    execFileAsync(bin, ["artifact-review", "--file", "archive.zip", "--file", "after.png"], {
      cwd: dir,
      env: { PATH: process.env.PATH },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Unsupported artifact file type/);
      assert.doesNotMatch(error.stderr, /Gemini API key/);
      return true;
    },
  );
});

test("artifact-review rejects invalid review mode before auth lookup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));
  await writeFile(join(dir, "design.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

  await assert.rejects(
    execFileAsync(bin, ["artifact-review", "--file", "design.png", "--review-mode", "audit"], {
      cwd: dir,
      env: { PATH: process.env.PATH },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /--review-mode must be single or comparison/);
      assert.doesNotMatch(error.stderr, /Gemini API key/);
      return true;
    },
  );
});

test("artifact-review rejects too many files before auth lookup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (const name of ["a.png", "b.png", "c.png", "d.png", "e.png"]) {
    await writeFile(join(dir, name), png);
  }

  await assert.rejects(
    execFileAsync(bin, [
      "artifact-review",
      "--file",
      "a.png",
      "--file",
      "b.png",
      "--file",
      "c.png",
      "--file",
      "d.png",
      "--file",
      "e.png",
    ], {
      cwd: dir,
      env: { PATH: process.env.PATH },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /at most 4 files/);
      assert.doesNotMatch(error.stderr, /Gemini API key/);
      return true;
    },
  );
});

test("artifact-review rejects missing image file before auth lookup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));
  await assert.rejects(
    execFileAsync(bin, ["artifact-review", "--file", "missing.png"], {
      cwd: dir,
      env: { PATH: process.env.PATH },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /ENOENT/);
      assert.doesNotMatch(error.stderr, /Gemini API key/);
      return true;
    },
  );
});

test("artifact-review rejects PDF before auth lookup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));
  await writeFile(join(dir, "paper.pdf"), "%PDF-1.7\n");

  await assert.rejects(
    execFileAsync(bin, ["artifact-review", "--file", "paper.pdf"], {
      cwd: dir,
      env: { PATH: process.env.PATH },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /PDF artifact review requires Files API support/);
      assert.doesNotMatch(error.stderr, /Gemini API key/);
      return true;
    },
  );
});

test("artifact-review rejects unsafe file paths before auth lookup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));
  const imagePath = join(dir, "design.png");
  await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

  await assert.rejects(
    execFileAsync(bin, ["artifact-review", "--file", imagePath], {
      cwd: dir,
      env: { PATH: process.env.PATH },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /File path must be relative to cwd/);
      assert.doesNotMatch(error.stderr, /Gemini API key/);
      return true;
    },
  );

  await assert.rejects(
    execFileAsync(bin, ["artifact-review", "--file", "../design.png"], {
      cwd: dir,
      env: { PATH: process.env.PATH },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /File path must stay within cwd/);
      assert.doesNotMatch(error.stderr, /Gemini API key/);
      return true;
    },
  );
});

test("telemetry enable requires raw content confirmation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));

  await assert.rejects(
    execFileAsync(bin, [
      "telemetry",
      "enable",
      "--level",
      "raw",
      "--endpoint",
      "http://127.0.0.1:8787/ingest",
      "--token-env",
      TELEMETRY_TOKEN_ENV,
    ], {
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

test("telemetry enable writes config and prints raw warning", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));

  const { stdout } = await execFileAsync(bin, [
    "telemetry",
    "enable",
    "--level",
    "raw",
    "--endpoint",
    "http://127.0.0.1:8787/ingest",
    "--token-env",
    TELEMETRY_TOKEN_ENV,
    "--confirm-raw-content",
    "--deployment-id",
    "gemini-agent-main",
    "--user-label",
    "local-admin",
    "--schedule",
    "hourly",
  ], {
    cwd: dir,
    env: { PATH: process.env.PATH },
  });

  assert.match(stdout, /Raw prompt\/response telemetry may capture/);
  assert.match(stdout, /Telemetry enabled/);
  const config = JSON.parse(await readFile(join(dir, ".gemini-agent/telemetry/config.json"), "utf8"));
  assert.equal(config.enabled, true);
  assert.equal(config.level, "raw");
  assert.equal(config.endpoint, "http://127.0.0.1:8787/ingest");
  assert.equal(config.token_env, TELEMETRY_TOKEN_ENV);
  assert.equal(config.deployment_id, "gemini-agent-main");
  assert.match(config.install_id, /^install_[0-9a-f-]{36}$/);
  assert.equal(config.user_label, "local-admin");
  assert.equal(config.schedule, "hourly");
});

test("telemetry enable rejects conflicting user label options", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));

  await assert.rejects(
    execFileAsync(bin, [
      "telemetry",
      "enable",
      "--level",
      "raw",
      "--endpoint",
      "http://127.0.0.1:8787/ingest",
      "--token-env",
      TELEMETRY_TOKEN_ENV,
      "--confirm-raw-content",
      "--user-label",
      "local-admin",
      "--clear-user-label",
    ], {
      cwd: dir,
      env: { PATH: process.env.PATH },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /--user-label and --clear-user-label cannot be used together/);
      return true;
    },
  );
});

test("telemetry status prints config and queue state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));
  await saveTelemetryConfig({
    cwd: dir,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TELEMETRY_TOKEN_ENV,
  });
  await appendTelemetryEvent({ cwd: dir, event: telemetryEvent(1) });

  const { stdout } = await execFileAsync(bin, ["telemetry", "status"], {
    cwd: dir,
    env: { PATH: process.env.PATH },
  });

  const parsed = JSON.parse(stdout);
  assert.equal(parsed.config.enabled, true);
  assert.equal(parsed.config.level, "raw");
  assert.equal(parsed.queue.sent_success_count, 0);
  assert.ok(parsed.queue.queue_bytes > 0);
});

test("telemetry summary prints human summary without raw prompt or response", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));
  await saveTelemetryConfig({
    cwd: dir,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TELEMETRY_TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });
  await appendTelemetryEvent({
    cwd: dir,
    event: telemetryEvent(91, {
      project_id: "vulca-platform",
      command: "artifact-review",
      prompt: "raw prompt should not print",
      response: "raw response should not print",
    }),
  });

  const { stdout, stderr } = await execFileAsync(bin, ["telemetry", "summary"], {
    cwd: dir,
    env: { PATH: process.env.PATH },
  });

  assert.equal(stderr, "");
  assert.match(stdout, /Telemetry Summary/);
  assert.match(stdout, /vulca-platform/);
  assert.match(stdout, /artifact-review/);
  assert.doesNotMatch(stdout, /raw prompt should not print/);
  assert.doesNotMatch(stdout, /raw response should not print/);
});

test("telemetry summary --json prints stable JSON and supports global scope", async () => {
  const home = await mkdtemp(join(tmpdir(), "gemini-agent-cli-home-"));
  const project = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));
  await saveTelemetryConfig({
    cwd: project,
    home,
    scope: "global",
    endpoint: "https://vulca-api.onrender.com/api/v1/gemini-agent/telemetry/ingest",
    tokenEnv: TELEMETRY_TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });
  await appendTelemetryEvent({
    cwd: home,
    event: telemetryEvent(92, {
      project_id: "global-project",
      command: "context-pack",
      prompt: "global raw prompt should not print",
      response: "global raw response should not print",
    }),
  });

  const { stdout, stderr } = await execFileAsync(bin, ["telemetry", "summary", "--global", "--json"], {
    cwd: project,
    env: { ...process.env, HOME: home },
  });
  const parsed = JSON.parse(stdout);

  assert.equal(stderr, "");
  assert.equal(parsed.scope, "global");
  assert.equal(parsed.storage_cwd, home);
  assert.equal(parsed.event_counts.total, 1);
  assert.equal(parsed.top_projects[0].project_id, "global-project");
  assert.doesNotMatch(stdout, /global raw prompt should not print/);
  assert.doesNotMatch(stdout, /global raw response should not print/);
});

test("telemetry raw inventory reports raw data risk without exposing raw content", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-cli-raw-inventory-"));
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TELEMETRY_TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });
  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(95, {
      command: "artifact-review",
      prompt: "Authorization: Bearer secret-token",
      response: "raw inventory response should not print",
      payload: {
        prompt_truncated: false,
        response_truncated: false,
        multimodal: [{ basename: "private-design.png", mime_type: "image/png", byte_size: 10 }],
      },
    }),
  });

  const { stdout, stderr } = await execBin(["telemetry", "raw", "inventory", "--json"], { cwd });
  const parsed = JSON.parse(stdout);

  assert.equal(stderr, "");
  assert.equal(parsed.totals.event_count, 1);
  assert.equal(parsed.totals.credential_like_prompt_events, 1);
  assert.equal(parsed.totals.media_item_count, 1);
  assert.doesNotMatch(stdout, /secret-token/);
  assert.doesNotMatch(stdout, /raw inventory response should not print/);
  assert.doesNotMatch(stdout, /evt_cli_95|private-design/);
});

test("telemetry raw inventory rejects unknown arguments", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-cli-raw-inventory-args-"));
  await assert.rejects(
    () => execBin(["telemetry", "raw", "inventory", "--unknown"], { cwd }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Unknown telemetry raw inventory argument/);
      return true;
    },
  );
});

test("telemetry raw preflight reports pending upload risk without exposing content", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-cli-raw-preflight-"));
  try {
    await saveTelemetryConfig({
      cwd,
      endpoint: "http://127.0.0.1:8787/ingest",
      tokenEnv: TELEMETRY_TOKEN_ENV,
      deploymentId: "dep_cli",
    });
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(96, {
        command: "artifact-review",
        prompt: "Authorization: Bearer cli-secret-token",
        response: "raw preflight response should not print",
        payload: {
          prompt_truncated: false,
          response_truncated: false,
          multimodal: [{ basename: "private-cli-design.png", mime_type: "image/png", byte_size: 10 }],
        },
      }),
    });
    await appendTelemetryEvent({ cwd, event: telemetryEvent(97) });

    const { stdout, stderr } = await execBin([
      "telemetry",
      "raw",
      "preflight",
      "--batch-size",
      "1",
      "--json",
    ], { cwd });
    const parsed = JSON.parse(stdout);

    assert.equal(stderr, "");
    assert.equal(parsed.ok, true);
    assert.equal(parsed.pending.total_count, 2);
    assert.equal(parsed.batch.would_send_count, 1);
    assert.equal(parsed.risk.credential_like_prompt_events, 1);
    assert.equal(parsed.risk.media_item_count, 1);
    assert.doesNotMatch(stdout, /cli-secret-token/);
    assert.doesNotMatch(stdout, /raw preflight response should not print/);
    assert.doesNotMatch(stdout, /evt_cli_96|private-cli-design|queue\/pending/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("telemetry raw preflight rejects invalid arguments", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-cli-raw-preflight-args-"));
  try {
    await assert.rejects(
      () => execBin(["telemetry", "raw", "preflight", "--batch-size", "0"], { cwd }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /--batch-size requires a positive integer/);
        return true;
      },
    );
    await assert.rejects(
      () => execBin(["telemetry", "raw", "preflight", "--unknown"], { cwd }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /Unknown telemetry raw preflight argument/);
        return true;
      },
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("telemetry raw export writes local JSONL with confirmation without exposing stdout", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-cli-raw-export-"));
  try {
    await saveTelemetryConfig({
      cwd,
      endpoint: "http://127.0.0.1:8787/ingest",
      tokenEnv: TELEMETRY_TOKEN_ENV,
      deploymentId: "dep_cli",
    });
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(98, {
        command: "artifact-review",
        prompt: "Authorization: Bearer cli-export-secret",
        response: "raw export response should only be in file",
        payload: {
          prompt_truncated: false,
          response_truncated: false,
          multimodal: [{ basename: "private-cli-export.png", mime_type: "image/png", byte_size: 10 }],
        },
      }),
    });
    const output = join(cwd, "export.jsonl");

    const { stdout, stderr } = await execBin([
      "telemetry",
      "raw",
      "export",
      "--state",
      "pending",
      "--output",
      output,
      "--limit",
      "1",
      "--confirm-raw-content",
      "--json",
    ], { cwd });
    const parsed = JSON.parse(stdout);
    const exported = JSON.parse((await readFile(output, "utf8")).trim());

    assert.equal(stderr, "");
    assert.equal(parsed.ok, true);
    assert.equal(parsed.exported_count, 1);
    assert.match(exported.prompt, /Authorization: \[MASKED\]/);
    assert.match(exported.response, /raw export response should only be in file/);
    assert.doesNotMatch(stdout, /Authorization: \[MASKED\]|cli-export-secret/);
    assert.doesNotMatch(stdout, /raw export response should only be in file/);
    assert.doesNotMatch(stdout, /evt_cli_98|private-cli-export|export\.jsonl|queue\/pending/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("telemetry raw reveal prints bounded raw events only after confirmation", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-cli-raw-reveal-"));
  try {
    await saveTelemetryConfig({
      cwd,
      endpoint: "http://127.0.0.1:8787/ingest",
      tokenEnv: TELEMETRY_TOKEN_ENV,
      deploymentId: "dep_cli",
    });
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(99, {
        command: "artifact-review",
        prompt: "Authorization: Bearer cli-reveal-secret",
        response: "raw reveal response should print only after confirmation",
        payload: {
          prompt_truncated: false,
          response_truncated: false,
          multimodal: [{ basename: "private-cli-reveal.png", mime_type: "image/png", byte_size: 10 }],
        },
      }),
    });

    const { stdout, stderr } = await execBin([
      "telemetry",
      "raw",
      "reveal",
      "--state",
      "pending",
      "--limit",
      "1",
      "--confirm-raw-content",
      "--json",
    ], { cwd });
    const parsed = JSON.parse(stdout);

    assert.equal(stderr, "");
    assert.equal(parsed.ok, true);
    assert.match(parsed.warning, /raw prompt\/response telemetry/i);
    assert.equal(parsed.revealed_count, 1);
    assert.equal(parsed.events.length, 1);
    assert.match(parsed.events[0].prompt, /Authorization: \[MASKED\]/);
    assert.match(parsed.events[0].response, /raw reveal response should print only after confirmation/);
    assert.equal(parsed.events[0].payload.multimodal[0].basename, "private-cli-reveal.png");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("telemetry raw reveal rejects missing confirmation and unsafe arguments", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-cli-raw-reveal-args-"));
  try {
    await assert.rejects(
      () => execBin(["telemetry", "raw", "reveal", "--state", "pending", "--limit", "1"], { cwd }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /--confirm-raw-content is required/);
        return true;
      },
    );
    await assert.rejects(
      () => execBin(["telemetry", "raw", "reveal", "--state", "pending", "--limit", "0", "--confirm-raw-content"], { cwd }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /--limit requires a positive integer/);
        return true;
      },
    );
    await assert.rejects(
      () => execBin(["telemetry", "raw", "reveal", "--state", "failed", "--limit", "1", "--confirm-raw-content"], { cwd }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /--state must be pending or sent/);
        return true;
      },
    );
    await assert.rejects(
      () => execBin(["telemetry", "raw", "reveal", "--unknown"], { cwd }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /Unknown telemetry raw reveal argument/);
        return true;
      },
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("telemetry raw delete dry-runs and writes pending deletion without exposing raw content", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-cli-raw-delete-pending-"));
  try {
    await saveTelemetryConfig({
      cwd,
      endpoint: "http://127.0.0.1:8787/ingest",
      tokenEnv: TELEMETRY_TOKEN_ENV,
      deploymentId: "dep_cli",
    });
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent("delete_pending", {
        prompt: "Authorization: Bearer cli-delete-secret",
        response: "raw delete response should not print",
        payload: {
          prompt_truncated: false,
          response_truncated: false,
          multimodal: [{ basename: "private-cli-delete.png", mime_type: "image/png", byte_size: 10 }],
        },
      }),
    });
    await writeFile(telemetryQueueDirs(cwd).state, `${JSON.stringify({ queue_bytes: 999 })}\n`);
    assert.equal((await loadTelemetryState({ cwd })).queue_bytes > 0, true);

    const dryRun = await execBin([
      "telemetry",
      "raw",
      "delete",
      "--state",
      "pending",
      "--event-id",
      "evt_cli_delete_pending",
      "--confirm-raw-content",
      "--dry-run",
      "--json",
    ], { cwd });
    const dryRunParsed = JSON.parse(dryRun.stdout);
    assert.equal(dryRun.stderr, "");
    assert.equal(dryRunParsed.ok, true);
    assert.equal(dryRunParsed.dry_run, true);
    assert.equal(dryRunParsed.matched_count, 1);
    assert.equal(dryRunParsed.deleted_count, 0);
    assert.equal(dryRunParsed.would_delete_count, 1);
    assert.equal((await readdir(telemetryQueueDirs(cwd).pending)).length, 1);

    const write = await execBin([
      "telemetry",
      "raw",
      "delete",
      "--state",
      "pending",
      "--event-id",
      "evt_cli_delete_pending",
      "--confirm-raw-content",
      "--write",
      "--json",
    ], { cwd });
    const writeParsed = JSON.parse(write.stdout);

    assert.equal(write.stderr, "");
    assert.equal(writeParsed.ok, true);
    assert.equal(writeParsed.dry_run, false);
    assert.equal(writeParsed.matched_count, 1);
    assert.equal(writeParsed.deleted_count, 1);
    assert.equal((await readdir(telemetryQueueDirs(cwd).pending)).length, 0);
    assert.equal((await loadTelemetryState({ cwd })).queue_bytes, 0);
    assert.doesNotMatch(write.stdout, /evt_cli_delete_pending|cli-delete-secret|raw delete response should not print|private-cli-delete|queue\/pending/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("telemetry raw delete writes sent deletion by event id", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-cli-raw-delete-sent-"));
  try {
    await saveTelemetryConfig({
      cwd,
      endpoint: "http://127.0.0.1:8787/ingest",
      tokenEnv: TELEMETRY_TOKEN_ENV,
      deploymentId: "dep_cli",
    });
    await completeSentCliEvent(cwd, "delete_sent", new Date("2026-06-11T10:00:00.000Z"));
    assert.equal((await loadTelemetryQueueSnapshot({ cwd })).sent.count, 1);

    const { stdout, stderr } = await execBin([
      "telemetry",
      "raw",
      "delete",
      "--state",
      "sent",
      "--event-id",
      "evt_cli_sent_delete_sent",
      "--confirm-raw-content",
      "--write",
      "--json",
    ], { cwd });
    const parsed = JSON.parse(stdout);

    assert.equal(stderr, "");
    assert.equal(parsed.ok, true);
    assert.equal(parsed.deleted_count, 1);
    assert.equal((await loadTelemetryQueueSnapshot({ cwd })).sent.count, 0);
    assert.doesNotMatch(stdout, /evt_cli_sent_delete_sent|raw sent prompt|raw sent response|queue\/sent/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("telemetry raw delete rejects missing confirmation and unsafe arguments", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-cli-raw-delete-args-"));
  try {
    await assert.rejects(
      () => execBin(["telemetry", "raw", "delete", "--state", "pending", "--event-id", "evt_cli_1"], { cwd }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /--confirm-raw-content is required/);
        return true;
      },
    );
    await assert.rejects(
      () => execBin(["telemetry", "raw", "delete", "--state", "pending", "--event-id", "evt_cli_1", "--confirm-raw-content", "--dry-run", "--write"], { cwd }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /--dry-run and --write cannot be used together/);
        return true;
      },
    );
    await assert.rejects(
      () => execBin(["telemetry", "raw", "delete", "--state", "failed", "--event-id", "evt_cli_1", "--confirm-raw-content"], { cwd }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /--state must be pending or sent/);
        return true;
      },
    );
    await assert.rejects(
      () => execBin(["telemetry", "raw", "delete", "--state", "pending", "--event-id", "../evt_cli_1", "--confirm-raw-content"], { cwd }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /--event-id must be a safe telemetry event id/);
        return true;
      },
    );
    await assert.rejects(
      () => execBin(["telemetry", "raw", "delete", "--unknown"], { cwd }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /Unknown telemetry raw delete argument/);
        return true;
      },
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("telemetry raw export rejects missing confirmation and unsafe arguments", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-cli-raw-export-args-"));
  try {
    const output = join(cwd, "export.jsonl");
    await assert.rejects(
      () => execBin(["telemetry", "raw", "export", "--state", "pending", "--output", output, "--limit", "1"], { cwd }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /--confirm-raw-content is required/);
        return true;
      },
    );
    await assert.rejects(
      () => execBin(["telemetry", "raw", "export", "--state", "pending", "--output", output, "--limit", "0", "--confirm-raw-content"], { cwd }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /--limit requires a positive integer/);
        return true;
      },
    );
    await assert.rejects(
      () => execBin(["telemetry", "raw", "export", "--state", "failed", "--output", output, "--limit", "1", "--confirm-raw-content"], { cwd }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /--state must be pending or sent/);
        return true;
      },
    );
    await assert.rejects(
      () => execBin(["telemetry", "raw", "export", "--unknown"], { cwd }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /Unknown telemetry raw export argument/);
        return true;
      },
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("telemetry raw prune dry-run previews sent raw deletion without exposing content", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-cli-raw-prune-"));
  try {
    await saveTelemetryConfig({
      cwd,
      endpoint: "http://127.0.0.1:8787/ingest",
      tokenEnv: TELEMETRY_TOKEN_ENV,
      deploymentId: "dep_cli",
    });
    await completeSentCliEvent(cwd, 1, new Date("2026-05-20T12:00:00.000Z"));
    await completeSentCliEvent(cwd, 2, new Date("2026-06-09T12:00:00.000Z"));
    const dirs = telemetryQueueDirs(cwd);
    await mkdir(join(dirs.sent, "2026-05-19"), { recursive: true });
    await writeFile(join(dirs.sent, "2026-05-19", "PRIVATE_TOKEN=secret.json"), "{}\n");

    const { stdout, stderr } = await execBin([
      "telemetry",
      "raw",
      "prune",
      "--state",
      "sent",
      "--keep-days",
      "7",
      "--now",
      "2026-06-10T12:00:00.000Z",
      "--json",
    ], { cwd });
    const parsed = JSON.parse(stdout);

    assert.equal(stderr, "");
    assert.equal(parsed.ok, true);
    assert.equal(parsed.dry_run, true);
    assert.equal(parsed.would_delete_count, 2);
    assert.equal(parsed.deleted_count, 0);
    assert.equal((await readdir(join(dirs.sent, "2026-05-20"))).length, 1);
    assert.doesNotMatch(stdout, /raw sent prompt|raw sent response|evt_cli_sent|PRIVATE_TOKEN|queue\/sent/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("telemetry raw prune write deletes only old sent raw data", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-cli-raw-prune-write-"));
  try {
    await saveTelemetryConfig({
      cwd,
      endpoint: "http://127.0.0.1:8787/ingest",
      tokenEnv: TELEMETRY_TOKEN_ENV,
      deploymentId: "dep_cli",
    });
    await completeSentCliEvent(cwd, 1, new Date("2026-06-02T23:59:59.000Z"));
    await completeSentCliEvent(cwd, 2, new Date("2026-06-03T00:00:00.000Z"));
    const dirs = telemetryQueueDirs(cwd);

    const { stdout } = await execBin([
      "telemetry",
      "raw",
      "prune",
      "--state",
      "sent",
      "--keep-days",
      "7",
      "--now",
      "2026-06-10T12:00:00.000Z",
      "--write",
      "--json",
    ], { cwd });
    const parsed = JSON.parse(stdout);

    assert.equal(parsed.dry_run, false);
    assert.equal(parsed.deleted_count, 1);
    await assert.rejects(() => readdir(join(dirs.sent, "2026-06-02")), /ENOENT/);
    assert.equal((await readdir(join(dirs.sent, "2026-06-03"))).length, 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("telemetry raw prune rejects unsafe arguments", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-cli-raw-prune-args-"));
  try {
    await assert.rejects(
      () => execBin(["telemetry", "raw", "prune", "--keep-days", "7"], { cwd }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /--state sent is required/);
        return true;
      },
    );
    await assert.rejects(
      () => execBin(["telemetry", "raw", "prune", "--state", "sent"], { cwd }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /--keep-days is required/);
        return true;
      },
    );
    await assert.rejects(
      () => execBin(["telemetry", "raw", "prune", "--state", "sent", "--keep-days", "-1"], { cwd }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /--keep-days requires a nonnegative integer/);
        return true;
      },
    );
    await assert.rejects(
      () => execBin(["telemetry", "raw", "prune", "--state", "sent", "--keep-days", "7", "--dry-run", "--write"], { cwd }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /--dry-run and --write cannot be used together/);
        return true;
      },
    );
    await assert.rejects(
      () => execBin(["telemetry", "raw", "prune", "--state", "pending", "--keep-days", "7"], { cwd }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /--state sent is required/);
        return true;
      },
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("telemetry economics prints safe human output", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-cli-economics-"));
  try {
    await saveTelemetryConfig({
      cwd,
      endpoint: "http://127.0.0.1:8787/ingest",
      tokenEnv: TELEMETRY_TOKEN_ENV,
      deploymentId: "gemini-agent-main",
    });
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(93, {
        command: "diff_review",
        prompt: "raw economics prompt should not print",
        response: "raw economics response should not print",
        economics: {
          input_tokens: 1_000_000,
          output_tokens: 100_000,
          total_tokens: 1_100_000,
          codex_tokens_saved_estimate: 2_000_000,
        },
      }),
    });

    const { stdout, stderr } = await execBin(["telemetry", "economics"], { cwd });

    assert.equal(stderr, "");
    assert.match(stdout, /Telemetry Economics/);
    assert.match(stdout, /diff-review/);
    assert.match(stdout, /Estimated Gemini cost/);
    assert.match(stdout, /Estimated Codex tokens saved/);
    assert.doesNotMatch(stdout, /raw economics prompt should not print/);
    assert.doesNotMatch(stdout, /raw economics response should not print/);
    assert.doesNotMatch(stdout, /evt_cli_93/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("telemetry economics --json supports global scope and price overrides", async () => {
  const home = await mkdtemp(join(tmpdir(), "gemini-agent-cli-economics-home-"));
  const project = await mkdtemp(join(tmpdir(), "gemini-agent-cli-economics-project-"));
  try {
    await saveTelemetryConfig({
      cwd: home,
      scope: "local",
      endpoint: "https://vulca-api.onrender.com/api/v1/gemini-agent/telemetry/ingest",
      tokenEnv: TELEMETRY_TOKEN_ENV,
      deploymentId: "gemini-agent-main",
    });
    await appendTelemetryEvent({
      cwd: home,
      event: telemetryEvent(94, {
        command: "plan_critique",
        economics: {
          input_tokens: 1_000_000,
          output_tokens: 1_000_000,
          total_tokens: 2_000_000,
          codex_tokens_saved_estimate: 1_500_000,
        },
      }),
    });

    const { stdout, stderr } = await execBin([
      "telemetry",
      "economics",
      "--global",
      "--json",
      "--input-price-per-million",
      "2",
      "--output-price-per-million",
      "3",
      "--top",
      "3",
    ], {
      cwd: project,
      env: { ...process.env, HOME: home },
    });
    const parsed = JSON.parse(stdout);

    assert.equal(stderr, "");
    assert.equal(parsed.scope, "global");
    assert.equal(parsed.storage_cwd, home);
    assert.equal(parsed.pricing.input_price_per_million, 2);
    assert.equal(parsed.pricing.output_price_per_million, 3);
    assert.equal(parsed.totals.gemini_estimated_cost_usd, 5);
    assert.equal(parsed.top_commands[0].command, "plan-critique");
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});

test("telemetry economics rejects invalid arguments", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-cli-economics-args-"));
  try {
    await assert.rejects(
      () => execBin(["telemetry", "economics", "--unknown"], { cwd }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /Unknown telemetry economics argument/);
        return true;
      },
    );
    await assert.rejects(
      () => execBin(["telemetry", "economics", "--top", "0"], { cwd }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /--top requires a positive integer/);
        return true;
      },
    );
    await assert.rejects(
      () => execBin(["telemetry", "economics", "--input-price-per-million", "-1"], { cwd }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /--input-price-per-million requires a nonnegative number/);
        return true;
      },
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("telemetry priorities prints safe human output", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-cli-priorities-"));
  try {
    await saveTelemetryConfig({
      cwd,
      endpoint: "http://127.0.0.1:8787/ingest",
      tokenEnv: TELEMETRY_TOKEN_ENV,
      deploymentId: "gemini-agent-main",
    });
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(99, {
        command: "diff_review",
        prompt: "raw priorities prompt should not print",
        response: "raw priorities response should not print",
        context: { cwd: "/Users/example/private/project" },
        payload: {
          prompt_truncated: false,
          response_truncated: false,
          multimodal: [{ basename: "secret-priority.png", byte_size: 10 }],
        },
        economics: {
          input_tokens: 1_000_000,
          output_tokens: 100_000,
          total_tokens: 1_100_000,
          codex_tokens_saved_estimate: 2_000_000,
        },
      }),
    });

    const { stdout, stderr } = await execBin(["telemetry", "priorities"], { cwd });

    assert.equal(stderr, "");
    assert.match(stdout, /Telemetry Development Priorities/);
    assert.match(stdout, /diff-review/);
    assert.match(stdout, /Estimated Codex tokens saved/);
    assert.doesNotMatch(stdout, /raw priorities prompt should not print/);
    assert.doesNotMatch(stdout, /raw priorities response should not print/);
    assert.doesNotMatch(stdout, /evt_cli_99/);
    assert.doesNotMatch(stdout, /secret-priority\.png/);
    assert.doesNotMatch(stdout, /\/Users\/example/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("telemetry priorities --json supports global scope and price overrides", async () => {
  const home = await mkdtemp(join(tmpdir(), "gemini-agent-cli-priorities-home-"));
  const project = await mkdtemp(join(tmpdir(), "gemini-agent-cli-priorities-project-"));
  try {
    await saveTelemetryConfig({
      cwd: home,
      scope: "local",
      endpoint: "https://vulca-api.onrender.com/api/v1/gemini-agent/telemetry/ingest",
      tokenEnv: TELEMETRY_TOKEN_ENV,
      deploymentId: "gemini-agent-main",
    });
    await appendTelemetryEvent({
      cwd: home,
      event: telemetryEvent(100, {
        command: "context_pack",
        economics: {
          input_tokens: 1_000_000,
          output_tokens: 1_000_000,
          total_tokens: 2_000_000,
          codex_tokens_saved_estimate: 1_500_000,
        },
      }),
    });

    const { stdout, stderr } = await execBin([
      "telemetry",
      "priorities",
      "--global",
      "--json",
      "--input-price-per-million",
      "2",
      "--output-price-per-million",
      "3",
      "--top",
      "1",
    ], {
      cwd: project,
      env: { ...process.env, HOME: home },
    });
    const parsed = JSON.parse(stdout);

    assert.equal(stderr, "");
    assert.equal(parsed.scope, "global");
    assert.equal(parsed.storage_cwd, home);
    assert.equal(parsed.pricing.input_price_per_million, 2);
    assert.equal(parsed.pricing.output_price_per_million, 3);
    assert.equal(parsed.priorities.length, 1);
    assert.equal(parsed.priorities[0].kind, "economics");
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});

test("telemetry priorities rejects invalid arguments", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-cli-priorities-args-"));
  try {
    await assert.rejects(
      () => execBin(["telemetry", "priorities", "--unknown"], { cwd }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /Unknown telemetry priorities argument/);
        return true;
      },
    );
    await assert.rejects(
      () => execBin(["telemetry", "priorities", "--top", "0"], { cwd }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /--top requires a positive integer/);
        return true;
      },
    );
    await assert.rejects(
      () => execBin(["telemetry", "priorities", "--output-price-per-million", "-1"], { cwd }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /--output-price-per-million requires a nonnegative number/);
        return true;
      },
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("telemetry report prints safe product output", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-cli-report-"));
  try {
    await saveTelemetryConfig({
      cwd,
      endpoint: "http://127.0.0.1:8787/ingest",
      tokenEnv: TELEMETRY_TOKEN_ENV,
      deploymentId: "gemini-agent-main",
    });
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(104, {
        project_id: "vulca-platform",
        command: "diff_review",
        prompt: "raw report prompt should not print",
        response: "raw report response should not print",
        context: {
          cwd: "/Users/example/private/report-project",
          workspace_id: "ws_vulca",
          user_label: "vulca-operator",
        },
        payload: {
          prompt_truncated: false,
          response_truncated: false,
          multimodal: [{ basename: "secret-report-cli.png", byte_size: 10 }],
        },
        metadata: {
          gate: "diff_review",
          input_bytes: 12_000,
          input_limit_bytes: 4 * 1024 * 1024,
          context_pack_mode: "none",
          fresh_input_mode: "diff",
        },
        economics: {
          input_tokens: 1_000_000,
          output_tokens: 100_000,
          total_tokens: 1_100_000,
          codex_tokens_saved_estimate: 2_000_000,
        },
      }),
    });

    const { stdout, stderr } = await execBin(["telemetry", "report"], { cwd });

    assert.equal(stderr, "");
    assert.match(stdout, /Telemetry Product Report/);
    assert.match(stdout, /Estimated Codex tokens saved/);
    assert.match(stdout, /Multimodal adoption/);
    assert.match(stdout, /Attribution/);
    assert.match(stdout, /vulca-platform/);
    assert.match(stdout, /ws_vulca/);
    assert.match(stdout, /vulca-operator/);
    assert.match(stdout, /diff-review/);
    assert.doesNotMatch(stdout, /raw report prompt should not print/);
    assert.doesNotMatch(stdout, /raw report response should not print/);
    assert.doesNotMatch(stdout, /evt_cli_104/);
    assert.doesNotMatch(stdout, /secret-report-cli\.png/);
    assert.doesNotMatch(stdout, /\/Users\/example/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("telemetry report --json supports global scope and price overrides", async () => {
  const home = await mkdtemp(join(tmpdir(), "gemini-agent-cli-report-home-"));
  const project = await mkdtemp(join(tmpdir(), "gemini-agent-cli-report-project-"));
  try {
    await saveTelemetryConfig({
      cwd: home,
      scope: "local",
      endpoint: "https://vulca-api.onrender.com/api/v1/gemini-agent/telemetry/ingest",
      tokenEnv: TELEMETRY_TOKEN_ENV,
      deploymentId: "gemini-agent-main",
    });
    await appendTelemetryEvent({
      cwd: home,
      event: telemetryEvent(105, {
        command: "context_pack",
        economics: {
          input_tokens: 1_000_000,
          output_tokens: 1_000_000,
          total_tokens: 2_000_000,
          codex_tokens_saved_estimate: 1_500_000,
        },
      }),
    });

    const { stdout, stderr } = await execBin([
      "telemetry",
      "report",
      "--global",
      "--json",
      "--input-price-per-million",
      "2",
      "--output-price-per-million",
      "3",
      "--top",
      "1",
    ], {
      cwd: project,
      env: { ...process.env, HOME: home },
    });
    const parsed = JSON.parse(stdout);

    assert.equal(stderr, "");
    assert.equal(parsed.scope, "global");
    assert.equal(parsed.pricing.input_price_per_million, 2);
    assert.equal(parsed.pricing.output_price_per_million, 3);
    assert.equal(parsed.priorities.length, 1);
    assert.equal(parsed.priorities[0].kind, "economics");
    assert.equal(Object.hasOwn(parsed, "storage_cwd"), false);
    assert.doesNotMatch(stdout, new RegExp(home.replaceAll("/", "\\/")));
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});

test("telemetry report rejects invalid arguments", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-cli-report-args-"));
  try {
    await assert.rejects(
      () => execBin(["telemetry", "report", "--unknown"], { cwd }),
      (error) => {
        assert.match(error.stderr, /Unknown telemetry report argument/);
        return true;
      },
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("telemetry multimodal repair-kind dry-runs aggregate-only historical repairs", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-cli-multimodal-repair-"));
  try {
    await saveTelemetryConfig({
      cwd,
      endpoint: "http://127.0.0.1:8787/ingest",
      tokenEnv: TELEMETRY_TOKEN_ENV,
      deploymentId: "gemini-agent-main",
    });
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(101, {
        command: "gemini_artifact_review",
        prompt: "raw multimodal repair prompt should not print",
        response: "raw multimodal repair response should not print",
        payload: {
          prompt_truncated: false,
          response_truncated: false,
          multimodal: [{ mime_type: "image/png", byte_size: 10, basename: "private-repair.png" }],
        },
      }),
    });

    const { stdout, stderr } = await execBin([
      "telemetry",
      "multimodal",
      "repair-kind",
      "--correction-version",
      "media-kind-v1",
      "--dry-run",
    ], { cwd });

    assert.equal(stderr, "");
    assert.match(stdout, /Telemetry Multimodal Repair/);
    assert.match(stdout, /Repairable events: 1/);
    assert.doesNotMatch(stdout, /raw multimodal repair prompt should not print/);
    assert.doesNotMatch(stdout, /raw multimodal repair response should not print/);
    assert.doesNotMatch(stdout, /evt_cli_101|private-repair\.png/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("telemetry multimodal repair-kind --write queues corrections without exposing ids", async () => {
  const home = await mkdtemp(join(tmpdir(), "gemini-agent-cli-multimodal-repair-home-"));
  const project = await mkdtemp(join(tmpdir(), "gemini-agent-cli-multimodal-repair-project-"));
  try {
    await saveTelemetryConfig({
      cwd: home,
      scope: "local",
      endpoint: "https://vulca-api.onrender.com/api/v1/gemini-agent/telemetry/ingest",
      tokenEnv: TELEMETRY_TOKEN_ENV,
      deploymentId: "gemini-agent-main",
    });
    await appendTelemetryEvent({
      cwd: home,
      event: telemetryEvent(102, {
        command: "palette-split",
        payload: {
          prompt_truncated: false,
          response_truncated: false,
          multimodal: [{ mime_type: "image/png", byte_size: 10, basename: "palette_mask.png", media_kind: "unknown" }],
        },
      }),
    });

    const { stdout, stderr } = await execBin([
      "telemetry",
      "multimodal",
      "repair-kind",
      "--global",
      "--correction-version",
      "media-kind-v1",
      "--write",
      "--json",
    ], {
      cwd: project,
      env: { ...process.env, HOME: home },
    });
    const parsed = JSON.parse(stdout);

    assert.equal(stderr, "");
    assert.equal(parsed.scope, "global");
    assert.equal(parsed.storage_cwd, home);
    assert.equal(parsed.dry_run, false);
    assert.equal(parsed.queued_count, 1);
    assert.equal(parsed.repairable_events, 1);
    assert.equal(Object.hasOwn(parsed, "event_ids"), false);
    assert.doesNotMatch(stdout, /evt_cli_102|palette_mask\.png/);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});

test("telemetry multimodal repair-metadata dry-runs aggregate-only MIME repairs", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-cli-multimodal-metadata-repair-"));
  try {
    await saveTelemetryConfig({
      cwd,
      endpoint: "http://127.0.0.1:8787/ingest",
      tokenEnv: TELEMETRY_TOKEN_ENV,
      deploymentId: "gemini-agent-main",
    });
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(103, {
        command: "artifact-review-backfill",
        prompt: "raw metadata repair prompt should not print",
        response: "raw metadata repair response should not print",
        payload: {
          prompt_truncated: false,
          response_truncated: false,
          multimodal: [{ basename: "media-private-screenshot.PNG" }],
        },
      }),
    });

    const { stdout, stderr } = await execBin([
      "telemetry",
      "multimodal",
      "repair-metadata",
      "--correction-version",
      "media-v2",
      "--dry-run",
    ], { cwd });

    assert.equal(stderr, "");
    assert.match(stdout, /Telemetry Multimodal Metadata Repair/);
    assert.match(stdout, /Repairable events: 1/);
    assert.match(stdout, /image\/png: 1 media items/);
    assert.doesNotMatch(stdout, /raw metadata repair prompt should not print/);
    assert.doesNotMatch(stdout, /raw metadata repair response should not print/);
    assert.doesNotMatch(stdout, /evt_cli_103|media-private-screenshot/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("telemetry multimodal repair-kind rejects unsafe arguments", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-cli-multimodal-repair-args-"));
  try {
    await assert.rejects(
      () => execBin(["telemetry", "multimodal", "repair-kind", "--correction-version", "bad/version"], { cwd }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /--correction-version contains invalid characters/);
        return true;
      },
    );
    await assert.rejects(
      () => execBin(["telemetry", "multimodal", "repair-kind", "--correction-version", "media-kind-v1", "--limit", "0"], { cwd }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /--limit requires a positive integer/);
        return true;
      },
    );
    await assert.rejects(
      () => execBin(["telemetry", "multimodal", "repair-kind", "--correction-version", "media-kind-v1", "--dry-run", "--write"], { cwd }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /--dry-run and --write cannot be used together/);
        return true;
      },
    );
    await assert.rejects(
      () => execBin(["telemetry", "multimodal", "repair-metadata", "--correction-version", "bad/version"], { cwd }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /--correction-version contains invalid characters/);
        return true;
      },
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("telemetry summary rejects unknown arguments", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));

  await assert.rejects(
    execFileAsync(bin, ["telemetry", "summary", "--bad"], {
      cwd: dir,
      env: { PATH: process.env.PATH },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Unknown telemetry summary argument: --bad/);
      return true;
    },
  );
});

test("telemetry backfill-artifacts prints raw-v1 batch JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));
  const artifactsDir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-artifacts-"));
  await writeFile(join(artifactsDir, "2026-06-03T145551114Z-artifacts.json"), `${JSON.stringify({
    kind: "artifact_review",
    artifact_type: "image",
    summary: ["Review of Run 2.16 /Users/example/private/secret.png"],
    important_details: ["Bearer secret-token"],
    metadata: {
      model: "gemini-3.5-flash",
      generated_at: "2026-06-03T14:55:51.114Z",
      sources: ["/Users/example/private/secret.png"],
      omitted_sources: [],
    },
  })}\n`);
  await writeFile(join(artifactsDir, "latest.json"), `${JSON.stringify({
    kind: "artifact_review",
    artifact_type: "image",
    summary: ["latest duplicate"],
    metadata: {
      model: "gemini-3.5-flash",
      generated_at: "2026-06-04T00:00:00.000Z",
      sources: [],
      omitted_sources: [],
    },
  })}\n`);

  const { stdout } = await execFileAsync(bin, [
    "telemetry",
    "backfill-artifacts",
    "--artifacts-dir",
    artifactsDir,
    "--deployment-id",
    "gemini-agent-main",
    "--batch-id",
    "batch_cli_backfill",
    "--generated-at",
    "2026-06-03T15:00:00.000Z",
  ], {
    cwd: dir,
    env: { PATH: process.env.PATH },
  });

  const parsed = JSON.parse(stdout);
  assert.equal(parsed.schema_version, "raw-v1");
  assert.equal(parsed.batch_id, "batch_cli_backfill");
  assert.equal(parsed.deployment_id, "gemini-agent-main");
  assert.equal(parsed.generated_at, "2026-06-03T15:00:00.000Z");
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.events[0].command, "artifact-review-backfill");
  assert.equal(parsed.events[0].metadata.context.run_id, "run-2.16");
  assert.doesNotMatch(parsed.events[0].response_raw, /\/Users\/example/);
  assert.doesNotMatch(parsed.events[0].response_raw, /secret-token/);
});

test("telemetry backfill-artifacts queues events through configured global telemetry", async () => {
  const home = await mkdtemp(join(tmpdir(), "gemini-agent-cli-home-"));
  const project = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));
  const artifactsDir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-artifacts-"));
  await saveTelemetryConfig({
    cwd: project,
    home,
    scope: "global",
    endpoint: "https://vulca-api.onrender.com/api/v1/gemini-agent/telemetry/ingest",
    tokenEnv: TELEMETRY_TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });
  await writeFile(join(artifactsDir, "2026-06-03T145551114Z-artifacts.json"), `${JSON.stringify({
    kind: "artifact_review",
    artifact_type: "image",
    summary: ["Review of Run 2.17 /Users/example/private/secret.png"],
    metadata: {
      model: "gemini-3.5-flash",
      generated_at: "2026-06-03T14:55:51.114Z",
      sources: ["/Users/example/private/secret.png"],
      omitted_sources: [],
    },
  })}\n`);

  const { stdout } = await execFileAsync(bin, [
    "telemetry",
    "backfill-artifacts",
    "--global",
    "--queue",
    "--artifacts-dir",
    artifactsDir,
    "--deployment-id",
    "gemini-agent-main",
    "--batch-id",
    "batch_cli_backfill_queue",
    "--generated-at",
    "2026-06-03T15:00:00.000Z",
  ], {
    cwd: project,
    env: { ...process.env, HOME: home },
  });

  const parsed = JSON.parse(stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.queued, true);
  assert.equal(parsed.queued_count, 1);
  assert.equal(parsed.storage_cwd, home);
  assert.equal(parsed.batch_id, "batch_cli_backfill_queue");

  const pending = await readdir(telemetryQueueDirs(home).pending);
  assert.equal(pending.length, 1);
  const event = JSON.parse(await readFile(join(telemetryQueueDirs(home).pending, pending[0]), "utf8"));
  assert.equal(event.command, "artifact-review-backfill");
  assert.equal(event.deployment_id, "gemini-agent-main");
  assert.equal(event.context.run_id, "run-2.17");
  assert.doesNotMatch(event.response, /\/Users\/example/);
});

test("telemetry backfill-artifacts skips duplicate queued event ids", async () => {
  const home = await mkdtemp(join(tmpdir(), "gemini-agent-cli-home-"));
  const project = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));
  const artifactsDir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-artifacts-"));
  await saveTelemetryConfig({
    cwd: project,
    home,
    scope: "global",
    endpoint: "https://vulca-api.onrender.com/api/v1/gemini-agent/telemetry/ingest",
    tokenEnv: TELEMETRY_TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });
  await writeFile(join(artifactsDir, "2026-06-03T145551114Z-artifacts.json"), `${JSON.stringify({
    kind: "artifact_review",
    artifact_type: "image",
    summary: ["Review of Run 2.18 /Users/example/private/secret.png"],
    metadata: {
      model: "gemini-3.5-flash",
      generated_at: "2026-06-03T14:55:51.114Z",
      sources: ["/Users/example/private/secret.png"],
      omitted_sources: [],
    },
  })}\n`);
  const args = [
    "telemetry",
    "backfill-artifacts",
    "--global",
    "--queue",
    "--artifacts-dir",
    artifactsDir,
    "--deployment-id",
    "gemini-agent-main",
    "--batch-id",
    "batch_cli_backfill_duplicate",
    "--generated-at",
    "2026-06-03T15:00:00.000Z",
  ];

  const first = JSON.parse((await execFileAsync(bin, args, {
    cwd: project,
    env: { ...process.env, HOME: home },
  })).stdout);
  const second = JSON.parse((await execFileAsync(bin, args, {
    cwd: project,
    env: { ...process.env, HOME: home },
  })).stdout);

  assert.equal(first.queued_count, 1);
  assert.equal(first.skipped_count, 0);
  assert.equal(second.queued_count, 0);
  assert.equal(second.skipped_count, 1);
  assert.deepEqual(second.skipped_event_ids, first.event_ids);
  const pending = await readdir(telemetryQueueDirs(home).pending);
  assert.equal(pending.length, 1);
});

test("telemetry backfill-artifacts queues correction events by version", async () => {
  const home = await mkdtemp(join(tmpdir(), "gemini-agent-cli-home-"));
  const project = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));
  const artifactsDir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-artifacts-"));
  await saveTelemetryConfig({
    cwd: project,
    home,
    scope: "global",
    endpoint: "https://vulca-api.onrender.com/api/v1/gemini-agent/telemetry/ingest",
    tokenEnv: TELEMETRY_TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });
  await writeFile(join(artifactsDir, "2026-06-03T145551114Z-artifacts.json"), `${JSON.stringify({
    kind: "artifact_review",
    artifact_type: "image",
    summary: ["Review of Run 2.19 /Users/example/private/secret.png"],
    metadata: {
      model: "gemini-3.5-flash",
      generated_at: "2026-06-03T14:55:51.114Z",
      sources: ["/Users/example/private/secret.png"],
      omitted_sources: [],
    },
  })}\n`);
  const args = [
    "telemetry",
    "backfill-artifacts",
    "--global",
    "--queue",
    "--artifacts-dir",
    artifactsDir,
    "--deployment-id",
    "gemini-agent-main",
    "--batch-id",
    "batch_cli_backfill_correction",
    "--generated-at",
    "2026-06-03T15:00:00.000Z",
    "--correction-version",
    "media-v1",
  ];

  const first = JSON.parse((await execFileAsync(bin, args, {
    cwd: project,
    env: { ...process.env, HOME: home },
  })).stdout);
  const second = JSON.parse((await execFileAsync(bin, args, {
    cwd: project,
    env: { ...process.env, HOME: home },
  })).stdout);

  assert.equal(first.queued_count, 1);
  assert.equal(first.skipped_count, 0);
  assert.equal(second.queued_count, 0);
  assert.equal(second.skipped_count, 1);

  const pending = await readdir(telemetryQueueDirs(home).pending);
  assert.equal(pending.length, 1);
  const event = JSON.parse(await readFile(join(telemetryQueueDirs(home).pending, pending[0]), "utf8"));
  assert.equal(event.command, "artifact-review-backfill-correction");
  assert.match(event.event_id, /^artifact_correction_[a-f0-9]{24}$/);
  assert.equal(event.metadata.correction_version, "media-v1");
  assert.match(event.metadata.correction_for_event_id, /^artifact_/);
  assert.equal(event.event_id.includes(event.metadata.correction_for_event_id), false);
});

test("telemetry global scope writes config and flushes the home queue from any cwd", async () => {
  const home = await mkdtemp(join(tmpdir(), "gemini-agent-cli-home-"));
  const projectA = await mkdtemp(join(tmpdir(), "gemini-agent-cli-a-"));
  const projectB = await mkdtemp(join(tmpdir(), "gemini-agent-cli-b-"));
  let receivedBatch;
  const receiver = await withTelemetryReceiver(async ({ request, response, body }) => {
    assert.equal(request.method, "POST");
    assert.equal(request.headers.authorization, `Bearer ${TELEMETRY_TOKEN}`);
    receivedBatch = JSON.parse(body);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      ok: true,
      batch_id: receivedBatch.batch_id,
      accepted_event_ids: receivedBatch.events.map((event) => event.event_id),
      rejected: [],
      received_at: "2026-06-03T09:00:01.000Z",
    }));
  });

  try {
    await execFileAsync(bin, [
      "telemetry",
      "enable",
      "--global",
      "--level",
      "raw",
      "--endpoint",
      receiver.endpoint,
      "--token-env",
      TELEMETRY_TOKEN_ENV,
      "--confirm-raw-content",
      "--deployment-id",
      "gemini-agent-main",
    ], {
      cwd: projectA,
      env: { ...process.env, HOME: home },
    });
    await appendTelemetryEvent({ cwd: home, event: telemetryEvent(42, { deployment_id: "gemini-agent-main" }) });

    const status = JSON.parse((await execFileAsync(bin, ["telemetry", "status"], {
      cwd: projectB,
      env: { ...process.env, HOME: home },
    })).stdout);
    assert.equal(status.scope, "global");
    assert.equal(status.storage_cwd, home);
    assert.equal(status.config.deployment_id, "gemini-agent-main");
    assert.ok(status.queue.queue_bytes > 0);

    const flushed = JSON.parse((await execFileAsync(bin, ["telemetry", "flush"], {
      cwd: projectB,
      env: { ...process.env, HOME: home, [TELEMETRY_TOKEN_ENV]: TELEMETRY_TOKEN },
    })).stdout);
    assert.equal(flushed.ok, true);
    assert.equal(flushed.sent_count, 1);
    assert.equal(receivedBatch.deployment_id, "gemini-agent-main");
    assert.equal(receivedBatch.events[0].event_id, "evt_cli_42");
    await assert.rejects(() => readdir(telemetryQueueDirs(projectB).sent), /ENOENT/);
  } finally {
    await receiver.close();
  }
});

test("telemetry doctor --global --json performs health GET without raw upload", async () => {
  const home = await mkdtemp(join(tmpdir(), "gemini-agent-cli-home-"));
  const project = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));
  const otherCwd = await mkdtemp(join(tmpdir(), "gemini-agent-cli-other-"));
  let healthRequests = 0;
  let ingestRequests = 0;
  const receiver = await withTelemetryReceiver(async ({ request, response }) => {
    if (request.method === "GET" && request.url === "/health") {
      healthRequests += 1;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.method === "POST" && request.url === "/ingest") {
      ingestRequests += 1;
      response.writeHead(500, { "Content-Type": "text/plain" });
      response.end("unexpected raw upload");
      return;
    }
    response.writeHead(404);
    response.end();
  });

  try {
    await saveTelemetryConfig({
      cwd: project,
      home,
      scope: "global",
      endpoint: receiver.endpoint,
      tokenEnv: TELEMETRY_TOKEN_ENV,
      deploymentId: "gemini-agent-main",
    });
    await appendTelemetryEvent({
      cwd: home,
      event: telemetryEvent(51, { deployment_id: "gemini-agent-main" }),
    });

    const { stdout } = await execFileAsync(bin, ["telemetry", "doctor", "--global", "--json"], {
      cwd: otherCwd,
      env: { ...process.env, HOME: home, [TELEMETRY_TOKEN_ENV]: TELEMETRY_TOKEN },
    });

    const parsed = JSON.parse(stdout);
    assert.equal(parsed.scope, "global");
    assert.equal(parsed.storage_cwd, home);
    assert.equal(parsed.endpoint_check.ok, true);
    assert.equal(parsed.queue.pending.count, 1);
    assert.equal(parsed.small_flush_safe, true);
    assert.equal(healthRequests, 1);
    assert.equal(ingestRequests, 0);
  } finally {
    await receiver.close();
  }
});

test("telemetry flush --dry-run --batch-size 1 does not move or send", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));
  const first = await appendTelemetryEvent({ cwd: dir, event: telemetryEvent(61) });
  await appendTelemetryEvent({ cwd: dir, event: telemetryEvent(62) });
  const env = { ...process.env };
  delete env[TELEMETRY_TOKEN_ENV];
  await saveTelemetryConfig({
    cwd: dir,
    endpoint: "http://127.0.0.1:9/ingest",
    tokenEnv: TELEMETRY_TOKEN_ENV,
  });

  const { stdout } = await execFileAsync(bin, [
    "telemetry",
    "flush",
    "--dry-run",
    "--batch-size",
    "1",
  ], {
    cwd: dir,
    env,
  });

  const parsed = JSON.parse(stdout);
  assert.equal(parsed.dry_run, true);
  assert.equal(parsed.event_ids.length, 1);
  assert.equal(parsed.event_ids[0], first.event_id);
  const pendingFiles = await readdir(telemetryQueueDirs(dir).pending);
  assert.equal(pendingFiles.length, 2);
});

test("telemetry flush --dry-run previews with invalid endpoint and missing token", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));
  const first = await appendTelemetryEvent({ cwd: dir, event: telemetryEvent(63) });
  const env = { ...process.env };
  delete env[TELEMETRY_TOKEN_ENV];
  await mkdir(join(dir, ".gemini-agent", "telemetry"), { recursive: true });
  await writeFile(join(dir, ".gemini-agent", "telemetry", "config.json"), `${JSON.stringify({
    enabled: true,
    level: "raw",
    endpoint: "not-a-url",
    token_env: TELEMETRY_TOKEN_ENV,
    deployment_id: "gemini-agent-main",
    schedule: "daily@09:00",
    created_at: "2026-06-03T09:00:00.000Z",
    updated_at: "2026-06-03T09:00:00.000Z",
  }, null, 2)}\n`);

  const { stdout } = await execFileAsync(bin, [
    "telemetry",
    "flush",
    "--dry-run",
    "--batch-size",
    "1",
  ], {
    cwd: dir,
    env,
  });

  const parsed = JSON.parse(stdout);
  assert.equal(parsed.dry_run, true);
  assert.deepEqual(parsed.event_ids, [first.event_id]);
  const pendingFiles = await readdir(telemetryQueueDirs(dir).pending);
  assert.equal(pendingFiles.length, 1);
});

test("telemetry retry-failed dry-run prints aggregate-only preview", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-cli-retry-"));
  try {
    await saveTelemetryConfig({
      cwd,
      scope: "local",
      endpoint: "http://127.0.0.1:8787/ingest",
      tokenEnv: TELEMETRY_TOKEN_ENV,
      deploymentId: "dep_cli",
    });
    await queueFailedCliEvents(cwd, { start: 10, count: 2, reason: "http_403" });

    const { stdout } = await execBin(["telemetry", "retry-failed", "--reason", "http_403"], {
      cwd,
      env: { ...process.env, [TELEMETRY_TOKEN_ENV]: TELEMETRY_TOKEN },
    });
    const parsed = JSON.parse(stdout);
    const serialized = JSON.stringify(parsed);

    assert.equal(parsed.ok, true);
    assert.equal(parsed.dry_run, true);
    assert.equal(parsed.scope, "local");
    assert.equal(parsed.reason, "http_403");
    assert.equal(parsed.would_move_count, 1);
    assert.equal(parsed.moved_count, 0);
    assert.doesNotMatch(serialized, /evt_cli_retry_10/);
    assert.doesNotMatch(serialized, /batch_2026/);
    assert.doesNotMatch(serialized, /raw cli prompt/);
    assert.doesNotMatch(serialized, /raw cli response/);
    assert.doesNotMatch(serialized, /cli-secret/);
    assert.doesNotMatch(serialized, /queue\/failed/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("telemetry retry-failed write mode requires token env before moving files", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-cli-retry-token-"));
  try {
    await saveTelemetryConfig({
      cwd,
      scope: "local",
      endpoint: "http://127.0.0.1:8787/ingest",
      tokenEnv: TELEMETRY_TOKEN_ENV,
      deploymentId: "dep_cli",
    });
    await queueFailedCliEvents(cwd, { start: 20, count: 1, reason: "http_403" });

    await assert.rejects(
      () => execBin(["telemetry", "retry-failed", "--reason", "http_403", "--write"], {
        cwd,
        env: { ...process.env, [TELEMETRY_TOKEN_ENV]: "" },
      }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /Telemetry token env GEMINI_AGENT_TELEMETRY_TOKEN is empty/);
        return true;
      },
    );

    const snapshot = await loadTelemetryQueueSnapshot({ cwd });
    assert.equal(snapshot.pending.count, 0);
    assert.equal(snapshot.failed.count, 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("telemetry retry-failed write mode moves bounded failed events to pending", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-cli-retry-write-"));
  try {
    await saveTelemetryConfig({
      cwd,
      scope: "local",
      endpoint: "http://127.0.0.1:8787/ingest",
      tokenEnv: TELEMETRY_TOKEN_ENV,
      deploymentId: "dep_cli",
    });
    await queueFailedCliEvents(cwd, { start: 30, count: 2, reason: "http_403" });

    const { stdout } = await execBin([
      "telemetry",
      "retry-failed",
      "--reason",
      "http_403",
      "--write",
      "--batch-size",
      "1",
    ], {
      cwd,
      env: { ...process.env, [TELEMETRY_TOKEN_ENV]: TELEMETRY_TOKEN },
    });

    const parsed = JSON.parse(stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.dry_run, false);
    assert.equal(parsed.moved_count, 1);
    assert.equal(parsed.remaining_failed_count_for_reason, 1);

    const snapshot = await loadTelemetryQueueSnapshot({ cwd });
    assert.equal(snapshot.pending.count, 1);
    assert.equal(snapshot.failed.count, 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("telemetry retry-failed rejects invalid arguments", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-cli-retry-args-"));
  try {
    await assert.rejects(
      () => execBin(["telemetry", "retry-failed"], { cwd }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /--reason is required/);
        return true;
      },
    );
    await assert.rejects(
      () => execBin(["telemetry", "retry-failed", "--reason", "http_403", "--dry-run", "--write"], { cwd }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /--dry-run and --write cannot be used together/);
        return true;
      },
    );
    await assert.rejects(
      () => execBin(["telemetry", "retry-failed", "--reason", "http_403", "--batch-size", "0"], { cwd }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /--batch-size requires a positive integer/);
        return true;
      },
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("telemetry retry-failed --global targets home telemetry storage", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-cli-retry-global-cwd-"));
  const home = await mkdtemp(join(tmpdir(), "gemini-agent-cli-retry-global-home-"));
  try {
    await saveTelemetryConfig({
      cwd: home,
      scope: "local",
      endpoint: "http://127.0.0.1:8787/ingest",
      tokenEnv: TELEMETRY_TOKEN_ENV,
      deploymentId: "dep_cli",
    });
    await queueFailedCliEvents(home, { start: 40, count: 1, reason: "http_403" });

    const { stdout } = await execBin(["telemetry", "retry-failed", "--global", "--reason", "http_403"], {
      cwd,
      env: { ...process.env, HOME: home, [TELEMETRY_TOKEN_ENV]: TELEMETRY_TOKEN },
    });
    const parsed = JSON.parse(stdout);

    assert.equal(parsed.scope, "global");
    assert.equal(parsed.storage_cwd, home);
    assert.equal(parsed.would_move_count, 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("telemetry failed inspect prints aggregate-only JSON", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-cli-failed-inspect-"));
  try {
    await queueFailedCliEvents(cwd, { start: 50, count: 2, reason: "http_403" });

    const { stdout } = await execBin(["telemetry", "failed", "inspect", "--json"], { cwd });
    const parsed = JSON.parse(stdout);
    const serialized = JSON.stringify(parsed);

    assert.equal(parsed.ok, true);
    assert.equal(parsed.scope, "local");
    assert.equal(parsed.failed_event_count, 2);
    assert.equal(parsed.reason_counts[0].reason, "http_403");
    assert.equal(parsed.events.length, 2);
    assert.doesNotMatch(serialized, /evt_cli_retry_50/);
    assert.doesNotMatch(serialized, /batch_2026/);
    assert.doesNotMatch(serialized, /raw cli prompt/);
    assert.doesNotMatch(serialized, /raw cli response/);
    assert.doesNotMatch(serialized, /cli-secret/);
    assert.doesNotMatch(serialized, /queue\/failed/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("telemetry failed inspect filters and limits descriptors", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-cli-failed-inspect-filter-"));
  try {
    await queueFailedCliEvents(cwd, { start: 60, count: 2, reason: "http_403" });
    await queueFailedCliEvents(cwd, { start: 70, count: 1, reason: "unauthorized" });

    const { stdout } = await execBin([
      "telemetry",
      "failed",
      "inspect",
      "--reason",
      "http_403",
      "--limit",
      "1",
      "--json",
    ], { cwd });
    const parsed = JSON.parse(stdout);

    assert.equal(parsed.reason_filter, "http_403");
    assert.equal(parsed.failed_event_count, 2);
    assert.equal(parsed.events.length, 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("telemetry failed archive dry-run and write are local-only", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-cli-failed-archive-"));
  try {
    await saveTelemetryConfig({
      cwd,
      scope: "local",
      endpoint: "http://127.0.0.1:8787/ingest",
      tokenEnv: TELEMETRY_TOKEN_ENV,
      deploymentId: "dep_cli",
    });
    await queueFailedCliEvents(cwd, { start: 80, count: 2, reason: "http_403" });

    const dry = await execBin([
      "telemetry",
      "failed",
      "archive",
      "--reason",
      "http_403",
      "--dry-run",
      "--batch-size",
      "1",
    ], {
      cwd,
      env: { ...process.env, [TELEMETRY_TOKEN_ENV]: "" },
    });
    const dryParsed = JSON.parse(dry.stdout);
    assert.equal(dryParsed.dry_run, true);
    assert.equal(dryParsed.would_archive_count, 1);

    const written = await execBin([
      "telemetry",
      "failed",
      "archive",
      "--reason",
      "http_403",
      "--write",
      "--batch-size",
      "1",
      "--note",
      "../local cleanup",
    ], {
      cwd,
      env: { ...process.env, [TELEMETRY_TOKEN_ENV]: "" },
    });
    const parsed = JSON.parse(written.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.archived_count, 1);
    assert.match(parsed.resolution_bucket, /^resolved_/);

    const snapshot = await loadTelemetryQueueSnapshot({ cwd });
    assert.equal(snapshot.failed.count, 1);
    assert.equal(snapshot.pending.count, 0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("telemetry failed archive rejects invalid arguments", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-cli-failed-archive-args-"));
  try {
    await assert.rejects(
      () => execBin(["telemetry", "failed", "archive"], { cwd }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /--reason is required/);
        return true;
      },
    );
    await assert.rejects(
      () => execBin(["telemetry", "failed", "archive", "--reason", "http_403", "--dry-run", "--write"], { cwd }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /--dry-run and --write cannot be used together/);
        return true;
      },
    );
    await assert.rejects(
      () => execBin(["telemetry", "failed", "inspect", "--limit", "0"], { cwd }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /--limit requires a positive integer/);
        return true;
      },
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("telemetry quarantine moves pending event out of normal flush path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));
  let receivedBatch;
  const receiver = await withTelemetryReceiver(async ({ request, response, body }) => {
    assert.equal(request.method, "POST");
    receivedBatch = JSON.parse(body);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      ok: true,
      batch_id: receivedBatch.batch_id,
      accepted_event_ids: receivedBatch.events.map((event) => event.event_id),
      rejected: [],
      received_at: "2026-06-03T09:00:01.000Z",
    }));
  });

  try {
    await saveTelemetryConfig({
      cwd: dir,
      endpoint: receiver.endpoint,
      tokenEnv: TELEMETRY_TOKEN_ENV,
    });
    const first = await appendTelemetryEvent({ cwd: dir, event: telemetryEvent(71) });
    const second = await appendTelemetryEvent({ cwd: dir, event: telemetryEvent(72) });

    const quarantined = JSON.parse((await execFileAsync(bin, [
      "telemetry",
      "quarantine",
      "--event-id",
      first.event_id,
      "--reason",
      "bad payload",
    ], {
      cwd: dir,
      env: { ...process.env, [TELEMETRY_TOKEN_ENV]: TELEMETRY_TOKEN },
    })).stdout);

    assert.equal(quarantined.quarantined, true);
    assert.equal(quarantined.scope, "local");
    assert.equal(quarantined.event_id, first.event_id);

    const flushed = JSON.parse((await execFileAsync(bin, ["telemetry", "flush"], {
      cwd: dir,
      env: { ...process.env, [TELEMETRY_TOKEN_ENV]: TELEMETRY_TOKEN },
    })).stdout);

    assert.equal(flushed.sent_count, 1);
    assert.deepEqual(receivedBatch.events.map((event) => event.event_id), [second.event_id]);
    assert.notEqual(receivedBatch.events[0].event_id, first.event_id);
  } finally {
    await receiver.close();
  }
});

test("telemetry install-scheduler dry-runs cron artifact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));

  const { stdout, stderr } = await execFileAsync(bin, [
    "telemetry",
    "install-scheduler",
    "--target",
    "cron",
    "--name",
    "cli-test",
    "--batch-size",
    "1",
    "--timeout-ms",
    "20000",
  ], {
    cwd: dir,
    env: { PATH: process.env.PATH },
  });

  assert.equal(stderr, "");
  assert.match(stdout, /gemini-agent:cli-test/);
  assert.match(stdout, /0 9 \* \* \*/);
  assert.match(stdout, /telemetry tick --batch-size 1 --timeout-ms 20000/);
  assert.match(stdout, /"dry_run": true/);
});

test("telemetry install-scheduler rejects invalid batch size", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));

  await assert.rejects(
    execFileAsync(bin, [
      "telemetry",
      "install-scheduler",
      "--target",
      "cron",
      "--name",
      "cli-test",
      "--batch-size",
      "0",
    ], {
      cwd: dir,
      env: { PATH: process.env.PATH },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /--batch-size requires a positive integer/);
      return true;
    },
  );
});

test("telemetry scheduler-status accepts only status arguments", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));

  const { stdout, stderr } = await execFileAsync(bin, [
    "telemetry",
    "scheduler-status",
    "--target",
    "cron",
    "--name",
    "cli-test",
  ], {
    cwd: dir,
    env: { PATH: process.env.PATH },
  });
  const parsed = JSON.parse(stdout);

  assert.equal(stderr, "");
  assert.equal(parsed.ok, true);
  assert.equal(parsed.target, "cron");
  assert.equal(parsed.name, "cli-test");

  await assert.rejects(
    execFileAsync(bin, [
      "telemetry",
      "scheduler-status",
      "--target",
      "cron",
      "--name",
      "cli-test",
      "--schedule",
      "hourly",
    ], {
      cwd: dir,
      env: { PATH: process.env.PATH },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Unknown scheduler argument: --schedule/);
      return true;
    },
  );
});

test("telemetry uninstall-scheduler rejects dry-run and install-only arguments", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));

  await assert.rejects(
    execFileAsync(bin, [
      "telemetry",
      "uninstall-scheduler",
      "--target",
      "cron",
      "--name",
      "cli-test",
      "--dry-run",
    ], {
      cwd: dir,
      env: { PATH: process.env.PATH },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Unknown scheduler argument: --dry-run/);
      return true;
    },
  );

  await assert.rejects(
    execFileAsync(bin, [
      "telemetry",
      "uninstall-scheduler",
      "--target",
      "cron",
      "--name",
      "cli-test",
      "--env-file",
      join(dir, "env"),
    ], {
      cwd: dir,
      env: { PATH: process.env.PATH },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Unknown scheduler argument: --env-file/);
      return true;
    },
  );
});

test("telemetry zero-argument commands reject extra arguments", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));

  await assert.rejects(
    execFileAsync(bin, ["telemetry", "status", "--bad"], {
      cwd: dir,
      env: { PATH: process.env.PATH },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Unknown telemetry argument: --bad/);
      return true;
    },
  );

  await assert.rejects(
    execFileAsync(bin, ["telemetry", "preview", "--level", "raw"], {
      cwd: dir,
      env: { PATH: process.env.PATH },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /telemetry preview does not accept arguments/);
      return true;
    },
  );
});

test("install-codex-global dry-run prints JSON without writing target", async () => {
  const home = await mkdtemp(join(tmpdir(), "gemini-agent-cli-home-"));

  const { stdout, stderr } = await execFileAsync(bin, [
    "install-codex-global",
    "--mode",
    "active",
    "--dry-run",
  ], {
    env: { ...process.env, HOME: home },
  });
  const parsed = JSON.parse(stdout);

  assert.equal(stderr, "");
  assert.equal(parsed.changed, true);
  assert.equal(parsed.targetPath, join(home, ".codex", "AGENTS.md"));
  assert.equal(parsed.dry_run, true);
  assert.equal(parsed.backupPath, null);
  await assert.rejects(readFile(join(home, ".codex", "AGENTS.md"), "utf8"), /ENOENT/);
});

test("install-codex-global write uses HOME and creates backup", async () => {
  const home = await mkdtemp(join(tmpdir(), "gemini-agent-cli-home-"));

  const { stdout, stderr } = await execFileAsync(bin, [
    "install-codex-global",
    "--mode",
    "active",
    "--write",
  ], {
    env: { ...process.env, HOME: home },
  });
  const parsed = JSON.parse(stdout);

  assert.equal(stderr, "");
  assert.equal(parsed.changed, true);
  assert.equal(parsed.dry_run, false);
  assert.equal(parsed.targetPath, join(home, ".codex", "AGENTS.md"));
  assert.ok(parsed.backupPath);
  assert.match(await readFile(parsed.targetPath, "utf8"), /BEGIN GEMINI AGENT ACTIVE POLICY/);
  assert.equal((await readdir(join(home, ".codex", "backups"))).length, 1);
});

test("install-codex-global rejects unknown mode and unknown args", async () => {
  const home = await mkdtemp(join(tmpdir(), "gemini-agent-cli-home-"));

  await assert.rejects(
    execFileAsync(bin, ["install-codex-global", "--mode", "passive"], {
      env: { ...process.env, HOME: home },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Unknown install-codex-global mode: passive/);
      return true;
    },
  );

  await assert.rejects(
    execFileAsync(bin, ["install-codex-global", "--bad"], {
      env: { ...process.env, HOME: home },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Unknown install-codex-global argument: --bad/);
      return true;
    },
  );
});

test("telemetry flush rejects when telemetry is not enabled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));

  await assert.rejects(
    execFileAsync(bin, ["telemetry", "flush"], {
      cwd: dir,
      env: { HOME: dir, PATH: process.env.PATH, [TELEMETRY_TOKEN_ENV]: TELEMETRY_TOKEN },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Telemetry is not enabled/);
      return true;
    },
  );
});

test("telemetry flush rejects when configured token env is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));
  await saveTelemetryConfig({
    cwd: dir,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TELEMETRY_TOKEN_ENV,
  });

  await assert.rejects(
    execFileAsync(bin, ["telemetry", "flush"], {
      cwd: dir,
      env: { PATH: process.env.PATH },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Telemetry token env GEMINI_AGENT_TELEMETRY_TOKEN is not set/);
      return true;
    },
  );
});

test("telemetry flush sends queued events with configured token", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));
  let receivedBatch;
  const receiver = await withTelemetryReceiver(async ({ request, response, body }) => {
    assert.equal(request.method, "POST");
    assert.equal(request.headers.authorization, `Bearer ${TELEMETRY_TOKEN}`);
    receivedBatch = JSON.parse(body);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      ok: true,
      batch_id: receivedBatch.batch_id,
      received_count: receivedBatch.events.length,
      received_at: "2026-05-29T09:00:01.000Z",
    }));
  });

  try {
    await saveTelemetryConfig({
      cwd: dir,
      endpoint: receiver.endpoint,
      tokenEnv: TELEMETRY_TOKEN_ENV,
    });
    await appendTelemetryEvent({ cwd: dir, event: telemetryEvent(1) });

    const { stdout } = await execFileAsync(bin, ["telemetry", "flush"], {
      cwd: dir,
      env: { PATH: process.env.PATH, [TELEMETRY_TOKEN_ENV]: TELEMETRY_TOKEN },
    });

    const parsed = JSON.parse(stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.sent_count, 1);
    assert.equal(receivedBatch.events[0].event_id, "evt_cli_1");
  } finally {
    await receiver.close();
  }
});

test("telemetry flush honors timeout-ms for slow receivers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));
  const receiver = await withTelemetryReceiver(async ({ response }) => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      ok: true,
      batch_id: "too-late",
      received_count: 1,
      received_at: "2026-05-29T09:00:01.000Z",
    }));
  });

  try {
    await saveTelemetryConfig({
      cwd: dir,
      endpoint: receiver.endpoint,
      tokenEnv: TELEMETRY_TOKEN_ENV,
    });
    await appendTelemetryEvent({ cwd: dir, event: telemetryEvent(2) });

    await assert.rejects(
      execFileAsync(bin, ["telemetry", "flush", "--timeout-ms", "1"], {
        cwd: dir,
        env: { PATH: process.env.PATH, [TELEMETRY_TOKEN_ENV]: TELEMETRY_TOKEN },
      }),
      (error) => {
        assert.match(error.stderr, /Telemetry request aborted after 1ms timeout/);
        return true;
      },
    );
  } finally {
    await receiver.close();
  }
});

test("telemetry tick honors timeout-ms for slow receivers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));
  const receiver = await withTelemetryReceiver(async ({ response }) => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      ok: true,
      batch_id: "too-late",
      received_count: 1,
      received_at: "2026-06-05T09:00:01.000Z",
    }));
  });

  try {
    await saveTelemetryConfig({
      cwd: dir,
      endpoint: receiver.endpoint,
      tokenEnv: TELEMETRY_TOKEN_ENV,
      schedule: "hourly",
    });
    await appendTelemetryEvent({ cwd: dir, event: telemetryEvent(22) });

    await assert.rejects(
      execFileAsync(bin, ["telemetry", "tick", "--timeout-ms", "1"], {
        cwd: dir,
        env: { PATH: process.env.PATH, [TELEMETRY_TOKEN_ENV]: TELEMETRY_TOKEN },
      }),
      (error) => {
        assert.match(error.stderr, /Telemetry request aborted after 1ms timeout/);
        return true;
      },
    );
  } finally {
    await receiver.close();
  }
});

test("telemetry tick flushes only when the hourly schedule is due", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));
  const receivedBatches = [];
  const receiver = await withTelemetryReceiver(async ({ request, response, body }) => {
    assert.equal(request.method, "POST");
    assert.equal(request.headers.authorization, `Bearer ${TELEMETRY_TOKEN}`);
    const batch = JSON.parse(body);
    receivedBatches.push(batch);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      ok: true,
      batch_id: batch.batch_id,
      received_count: batch.events.length,
      received_at: "2026-05-29T09:00:01.000Z",
    }));
  });

  try {
    await saveTelemetryConfig({
      cwd: dir,
      endpoint: receiver.endpoint,
      tokenEnv: TELEMETRY_TOKEN_ENV,
      schedule: "hourly",
    });
    await appendTelemetryEvent({ cwd: dir, event: telemetryEvent(1) });

    const first = await execFileAsync(bin, ["telemetry", "tick"], {
      cwd: dir,
      env: { PATH: process.env.PATH, [TELEMETRY_TOKEN_ENV]: TELEMETRY_TOKEN },
    });
    assert.equal(JSON.parse(first.stdout).sent_count, 1);

    await appendTelemetryEvent({ cwd: dir, event: telemetryEvent(2) });
    const second = await execFileAsync(bin, ["telemetry", "tick"], {
      cwd: dir,
      env: { PATH: process.env.PATH, [TELEMETRY_TOKEN_ENV]: TELEMETRY_TOKEN },
    });
    const skipped = JSON.parse(second.stdout);

    assert.equal(skipped.ok, true);
    assert.equal(skipped.skipped, true);
    assert.equal(skipped.reason, "schedule_not_due");
    assert.equal(receivedBatches.length, 1);
  } finally {
    await receiver.close();
  }
});

test("telemetry tick accepts batch-size and flushes bounded batches when due", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));
  const receivedBatches = [];
  const receiver = await withTelemetryReceiver(async ({ request, response, body }) => {
    assert.equal(request.method, "POST");
    const batch = JSON.parse(body);
    receivedBatches.push(batch);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      ok: true,
      batch_id: batch.batch_id,
      accepted_event_ids: batch.events.map((event) => event.event_id),
      rejected: [],
      received_at: "2026-06-04T09:00:01.000Z",
    }));
  });

  try {
    await saveTelemetryConfig({
      cwd: dir,
      endpoint: receiver.endpoint,
      tokenEnv: TELEMETRY_TOKEN_ENV,
      schedule: "hourly",
    });
    await appendTelemetryEvent({ cwd: dir, event: telemetryEvent(81) });
    await appendTelemetryEvent({ cwd: dir, event: telemetryEvent(82) });

    const { stdout } = await execFileAsync(bin, ["telemetry", "tick", "--batch-size", "1"], {
      cwd: dir,
      env: { PATH: process.env.PATH, [TELEMETRY_TOKEN_ENV]: TELEMETRY_TOKEN },
    });

    const parsed = JSON.parse(stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.sent_count, 1);
    assert.equal(receivedBatches.length, 1);
    assert.equal(receivedBatches[0].events.length, 1);
    assert.equal(receivedBatches[0].events[0].event_id, "evt_cli_81");
  } finally {
    await receiver.close();
  }
});

test("telemetry tick rejects missing or invalid batch size", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));
  await saveTelemetryConfig({
    cwd: dir,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TELEMETRY_TOKEN_ENV,
    schedule: "hourly",
  });

  await assert.rejects(
    execFileAsync(bin, ["telemetry", "tick", "--batch-size"], {
      cwd: dir,
      env: { PATH: process.env.PATH, [TELEMETRY_TOKEN_ENV]: TELEMETRY_TOKEN },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /--batch-size requires a positive integer/);
      return true;
    },
  );

  await assert.rejects(
    execFileAsync(bin, ["telemetry", "tick", "--batch-size", "1.5"], {
      cwd: dir,
      env: { PATH: process.env.PATH, [TELEMETRY_TOKEN_ENV]: TELEMETRY_TOKEN },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /--batch-size requires a positive integer/);
      return true;
    },
  );
});

test("telemetry validate uses fake response path and prints result JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));
  let latestBatch;
  const receiver = await withTelemetryReceiver(async ({ request, response, body }) => {
    if (request.url === "/ingest") {
      latestBatch = JSON.parse(body);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        ok: true,
        batch_id: latestBatch.batch_id,
        received_count: latestBatch.events.length,
        received_at: "2026-05-29T09:00:01.000Z",
      }));
      return;
    }
    if (request.url === "/metrics") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        ok: true,
        received_batches: latestBatch ? 1 : 0,
        received_events: latestBatch?.events.length ?? 0,
        last_received_at: latestBatch ? "2026-05-29T09:00:01.000Z" : null,
        last_batch_id: latestBatch?.batch_id ?? null,
        latest_event: latestBatch ? {
          batch_id: latestBatch.batch_id,
          command: latestBatch.events.at(-1).command,
          model: latestBatch.events.at(-1).model,
          status: latestBatch.events.at(-1).status,
          received_at: "2026-05-29T09:00:01.000Z",
        } : null,
        status_counts: { success: latestBatch?.events.length ?? 0, error: 0 },
        clock_skew_warnings: 0,
      }));
      return;
    }
    response.writeHead(404);
    response.end();
  });

  try {
    const { stdout } = await execFileAsync(bin, [
      "telemetry",
      "validate",
      "--endpoint",
      receiver.endpoint,
      "--token-env",
      TELEMETRY_TOKEN_ENV,
      "--confirm-raw-content",
    ], {
      cwd: dir,
      env: {
        HOME: CLI_TEST_HOME,
        PATH: process.env.PATH,
        [TELEMETRY_TOKEN_ENV]: TELEMETRY_TOKEN,
        GEMINI_AGENT_ALLOW_FAKE_RESPONSE: "1",
        GEMINI_AGENT_FAKE_RESPONSE: "telemetry-ok",
      },
    });

    const parsed = JSON.parse(stdout);
    assert.equal(parsed.ok, true);
    assert.equal(latestBatch.events[0].command, "telemetry validate");
    assert.equal(latestBatch.events[0].response_raw, "telemetry-ok");
  } finally {
    await receiver.close();
  }
});

test("telemetry validate exits successfully when metrics endpoint is admin protected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));
  let latestBatch;
  const receiver = await withTelemetryReceiver(async ({ request, response, body }) => {
    if (request.url === "/ingest") {
      latestBatch = JSON.parse(body);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        ok: true,
        batch_id: latestBatch.batch_id,
        accepted_event_ids: latestBatch.events.map((event) => event.event_id),
        rejected: [],
        received_at: "2026-05-29T09:00:01.000Z",
      }));
      return;
    }
    if (request.url === "/metrics") {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ detail: "Not authenticated" }));
      return;
    }
    response.writeHead(404);
    response.end();
  });

  try {
    const { stdout } = await execFileAsync(bin, [
      "telemetry",
      "validate",
      "--endpoint",
      receiver.endpoint,
      "--token-env",
      TELEMETRY_TOKEN_ENV,
      "--confirm-raw-content",
    ], {
      cwd: dir,
      env: {
        HOME: CLI_TEST_HOME,
        PATH: process.env.PATH,
        [TELEMETRY_TOKEN_ENV]: TELEMETRY_TOKEN,
        GEMINI_AGENT_ALLOW_FAKE_RESPONSE: "1",
        GEMINI_AGENT_FAKE_RESPONSE: "telemetry-ok",
      },
    });

    const parsed = JSON.parse(stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.flush.sent_count, 1);
    assert.equal(parsed.metrics, null);
    assert.match(parsed.metrics_warning.message, /Telemetry receiver returned 401\./);
    assert.equal(latestBatch.events[0].command, "telemetry validate");
  } finally {
    await receiver.close();
  }
});

test("telemetry validate posts to the real local receiver CLI", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));
  const storage = await mkdtemp(join(tmpdir(), "gemini-agent-receiver-"));
  const receiver = await startTelemetryReceiverCli({
    storage,
    env: {
      PATH: process.env.PATH,
      [TELEMETRY_TOKEN_ENV]: TELEMETRY_TOKEN,
    },
  });

  try {
    const { stdout } = await execFileAsync(bin, [
      "telemetry",
      "validate",
      "--endpoint",
      receiver.endpoint,
      "--token-env",
      TELEMETRY_TOKEN_ENV,
      "--confirm-raw-content",
    ], {
      cwd: dir,
      env: {
        HOME: CLI_TEST_HOME,
        PATH: process.env.PATH,
        [TELEMETRY_TOKEN_ENV]: TELEMETRY_TOKEN,
        GEMINI_AGENT_ALLOW_FAKE_RESPONSE: "1",
        GEMINI_AGENT_FAKE_RESPONSE: "telemetry-ok",
      },
    });

    const parsed = JSON.parse(stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.flush.sent_count, 1);
    assert.ok(parsed.metrics.received_events >= 1);

    const metrics = await fetchJson(receiver.endpoint.replace(/\/ingest$/, "/metrics"), {
      token: TELEMETRY_TOKEN,
    });
    assert.ok(metrics.received_events >= 1);
  } finally {
    await receiver.close();
  }
});
