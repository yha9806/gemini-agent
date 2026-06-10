import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const rootPath = fileURLToPath(root);

test("package exposes executables", async () => {
  const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  const lock = JSON.parse(await readFile(new URL("package-lock.json", root), "utf8"));
  assert.equal(pkg.bin["gemini-agent"], "./bin/gemini-agent");
  assert.equal(pkg.bin["gemini-agent-mcp"], "./bin/gemini-agent-mcp");
  assert.equal(pkg.bin["gemini-agent-telemetry-receiver"], "./bin/gemini-agent-telemetry-receiver");
  assert.equal(lock.packages[""].bin["gemini-agent-telemetry-receiver"], "bin/gemini-agent-telemetry-receiver");
  await access(new URL("bin/gemini-agent", root), constants.X_OK);
  await access(new URL("bin/gemini-agent-mcp", root), constants.X_OK);
  await access(new URL("bin/gemini-agent-telemetry-receiver", root), constants.X_OK);
  await access(new URL("src/cli.mjs", root), constants.R_OK);
  await access(new URL("src/mcp-server.mjs", root), constants.R_OK);
  await access(new URL("src/telemetry-receiver-cli.mjs", root), constants.R_OK);
});

test("git ignores installed dependencies", async () => {
  const gitignore = await readFile(new URL(".gitignore", root), "utf8");
  assert.match(gitignore, /^node_modules\/$/m);
});

test("public markdown does not expose local home paths", async () => {
  const files = [
    fileURLToPath(new URL("README.md", root)),
    ...await markdownFiles(fileURLToPath(new URL("docs", root))),
  ];

  for (const file of files) {
    const content = await readFile(file, "utf8");
    const label = relative(rootPath, file);
    assert.doesNotMatch(content, /\/Users\/[^/\s]+/u, `${label} exposes a local home path`);
  }
});

test("README documents telemetry summary and bounded scheduler examples", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  assert.match(readme, /^\.\/bin\/gemini-agent telemetry summary --global$/m);
  assert.match(readme, /^\.\/bin\/gemini-agent telemetry summary --global --json$/m);
  assert.match(readme, /^\.\/bin\/gemini-agent telemetry raw inventory --global$/m);
  assert.match(readme, /^\.\/bin\/gemini-agent telemetry raw inventory --global --json$/m);
  assert.match(readme, /^\.\/bin\/gemini-agent telemetry raw preflight --global --batch-size 1 --json$/m);
  assert.match(readme, /^\.\/bin\/gemini-agent telemetry raw export --global --state pending --output \.\/raw-export\.jsonl --limit 100 --confirm-raw-content --json$/m);
  assert.match(readme, /^\.\/bin\/gemini-agent telemetry raw prune --global --state sent --keep-days 30 --dry-run$/m);
  assert.match(readme, /^\.\/bin\/gemini-agent telemetry raw prune --global --state sent --keep-days 30 --write --json$/m);
  assert.match(readme, /^\.\/bin\/gemini-agent telemetry economics --global$/m);
  assert.match(readme, /^\.\/bin\/gemini-agent telemetry economics --global --json$/m);
  assert.match(readme, /^\.\/bin\/gemini-agent telemetry multimodal repair-kind --global --correction-version media-kind-v1 --dry-run$/m);
  assert.match(readme, /^\.\/bin\/gemini-agent telemetry multimodal repair-metadata --global --correction-version media-v2 --dry-run$/m);
  assert.match(readme, /^\.\/bin\/gemini-agent diff-review --diff$/m);
  assert.match(readme, /^\.\/bin\/gemini-agent diff-review --auto-context-pack --diff$/m);
  assert.match(readme, /^\.\/bin\/gemini-agent plan-critique --context-pack \.gemini-agent\/context\/latest\.json$/m);
  assert.match(readme, /^\.\/bin\/gemini-agent plan-critique --auto-context-pack --stdin$/m);
  assert.match(readme, /^\.\/bin\/gemini-agent context-pack --bootstrap --write-artifact$/m);
  assert.match(readme, /^\.\/bin\/gemini-agent artifact-review --file before\.png --file after\.png --kind ui --review-mode comparison$/m);
  assert.match(readme, /^\.\/bin\/gemini-agent telemetry tick --global --batch-size 1 --timeout-ms 20000$/m);
  assert.match(readme, /project\/workspace attribution/);
  assert.match(readme, /multimodal MIME\/kind\/byte coverage/);
  assert.match(readme, /multi-file artifact-review records media metadata without printing raw image bytes/);
  assert.match(readme, /`diff-review --diff` reads the current git diff directly/);
  assert.match(readme, /`diff-review --auto-context-pack --diff` is the preferred context-reuse path/);
  assert.match(readme, /Gate commands accept `--context-pack <path>`/);
  assert.match(readme, /Gate commands accept `--auto-context-pack`/);
  assert.match(readme, /`context-pack --bootstrap --write-artifact` creates the project-root context artifact used by `--auto-context-pack`/);
  assert.match(readme, /Oversized gate failures print concrete `context-pack --bootstrap --write-artifact` and `--auto-context-pack` retry commands/);
  assert.match(readme, /Large raw gate calls print a non-blocking stderr preflight warning before Gemini credentials are resolved/);
  assert.match(readme, /Telemetry summary and economics aggregate context-pack preflight warning counts and rates without exposing raw gate input/);
  assert.match(readme, /Global active Codex policy tells sessions to reuse project-root `\.gemini-agent\/context\/latest\.json` with gate `--auto-context-pack` or explicit `--context-pack`/);
  assert.match(readme, /regenerate the context pack first when it is missing, stale, or unrelated/);
  assert.match(readme, /palette-split quality/);
  assert.match(readme, /local raw telemetry counts, bytes, truncation counts, multimodal counts, and credential-like aggregate signals/);
  assert.match(readme, /pending raw upload batch risk before flushing/);
  assert.match(readme, /writes confirmed raw telemetry to a local JSONL file/);
  assert.match(readme, /local sent-telemetry retention with dry-run by default/);
  assert.match(readme, /estimates Gemini cost, Codex token savings, and aggregate gate input byte metrics/);
  assert.match(readme, /safe MIME and media-kind corrections for historical multimodal telemetry/);
  assert.match(
    readme,
    /^\.\/bin\/gemini-agent telemetry install-scheduler --global --target launchd --name gemini-agent-main --schedule daily@09:00 --batch-size 1 --timeout-ms 20000 --env-file ~\/\.gemini-agent\/telemetry\.env --dry-run$/m,
  );
});

test("wrappers fail clearly before Gemini integration is implemented", async () => {
  const cli = await runNodeScript(new URL("bin/gemini-agent", root));
  assert.equal(cli.code, 0);
  assert.match(cli.stdout, /gemini-agent/i);
  assert.doesNotMatch(cli.stderr, /ERR_MODULE_NOT_FOUND|Cannot find module/);

  const mcp = await runNodeScript(new URL("bin/gemini-agent-mcp", root));
  assert.notEqual(mcp.code, 0);
  assert.match(mcp.stderr, /not implemented|placeholder/i);
  assert.doesNotMatch(mcp.stderr, /ERR_MODULE_NOT_FOUND|Cannot find module/);

  const receiver = await runNodeScript(new URL("bin/gemini-agent-telemetry-receiver", root), {
    env: { GEMINI_AGENT_TELEMETRY_TOKEN: "" },
  });
  assert.notEqual(receiver.code, 0);
  assert.match(receiver.stderr, /GEMINI_AGENT_TELEMETRY_TOKEN/);
  assert.doesNotMatch(receiver.stderr, /ERR_MODULE_NOT_FOUND|Cannot find module/);
});

function runNodeScript(scriptUrl, { env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(scriptUrl)], {
      cwd: fileURLToPath(root),
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
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
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

async function markdownFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await markdownFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(path);
    }
  }
  return files;
}
