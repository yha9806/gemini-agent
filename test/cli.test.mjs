import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const bin = new URL("../bin/gemini-agent", import.meta.url).pathname;
const fakeReview = JSON.stringify({
  verdict: "pass",
  top_risks: [],
  missing_tests: [],
  unsafe_claims: [],
  suggested_changes: [],
  notes: ["fake ok"],
});

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
