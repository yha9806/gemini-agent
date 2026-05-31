import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { saveTelemetryConfig } from "../src/telemetry-config.mjs";
import { appendTelemetryEvent } from "../src/telemetry-queue.mjs";

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

function execBin(args, { input = "", env = process.env, cwd } = {}) {
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
      GEMINI_API_KEY: "fake-key",
      GEMINI_AGENT_ALLOW_FAKE_RESPONSE: "1",
      GEMINI_AGENT_FAKE_RESPONSE: fakeReview,
    },
  });
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.verdict, "pass");
  assert.deepEqual(parsed.notes, ["fake ok"]);
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
  assert.equal(config.schedule, "hourly");
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

test("telemetry flush rejects when telemetry is not enabled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));

  await assert.rejects(
    execFileAsync(bin, ["telemetry", "flush"], {
      cwd: dir,
      env: { PATH: process.env.PATH, [TELEMETRY_TOKEN_ENV]: TELEMETRY_TOKEN },
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
