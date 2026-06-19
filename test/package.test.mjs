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

test("package has open-source discovery metadata and a bounded publish surface", async () => {
  const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));

  assert.equal(pkg.private, true);
  assert.equal(pkg.description, "Local-first Gemini coprocessor for Codex and agentic coding workflows");
  assert.deepEqual(pkg.repository, {
    type: "git",
    url: "git+https://github.com/yha9806/gemini-agent.git",
  });
  assert.deepEqual(pkg.bugs, {
    url: "https://github.com/yha9806/gemini-agent/issues",
  });
  assert.equal(pkg.homepage, "https://github.com/yha9806/gemini-agent#readme");
  for (const keyword of ["gemini", "codex", "cli", "mcp", "code-review", "context-pack"]) {
    assert.ok(pkg.keywords.includes(keyword), `missing keyword: ${keyword}`);
  }
  assert.deepEqual(pkg.files, [
    "bin/",
    "src/",
    "docs/telemetry.md",
    "docs/assets/",
    "docs/release/",
    "examples/",
    "README.md",
    "LICENSE",
  ]);
});

test("repository includes open-source contribution and security entrypoints", async () => {
  const contributing = await readFile(new URL("CONTRIBUTING.md", root), "utf8");
  const security = await readFile(new URL("SECURITY.md", root), "utf8");
  const telemetryDocs = await readFile(new URL("docs/telemetry.md", root), "utf8");
  const releaseNotes = await readFile(new URL("docs/release/v0.1.0.md", root), "utf8");
  const postReleaseChecklist = await readFile(new URL("docs/release/post-release-checklist.md", root), "utf8");
  const workflowOverview = await readFile(new URL("docs/assets/workflow-overview.svg", root), "utf8");
  const bugTemplate = await readFile(new URL(".github/ISSUE_TEMPLATE/bug_report.yml", root), "utf8");
  const featureTemplate = await readFile(new URL(".github/ISSUE_TEMPLATE/feature_request.yml", root), "utf8");
  const issueConfig = await readFile(new URL(".github/ISSUE_TEMPLATE/config.yml", root), "utf8");
  const ci = await readFile(new URL(".github/workflows/ci.yml", root), "utf8");

  assert.match(contributing, /^# Contributing$/m);
  assert.match(contributing, /GEMINI_AGENT_RUN_LIVE_TESTS=1 npm run test:live/);
  assert.match(security, /^# Security Policy$/m);
  assert.match(security, /Do not disclose vulnerabilities in a public issue/);
  assert.match(security, /published source release/);
  assert.match(telemetryDocs, /^# Telemetry$/m);
  assert.match(telemetryDocs, /Raw telemetry governance commands are explicit and bounded/);
  assert.match(releaseNotes, /^# gemini-agent v0\.1\.0 Release Notes$/m);
  assert.match(releaseNotes, /first open-source source release/);
  assert.match(releaseNotes, /npm pack --dry-run/);
  assert.match(postReleaseChecklist, /^# Post-Release Checklist$/m);
  assert.match(postReleaseChecklist, /Confirm the release tag points at the intended `main` commit/);
  assert.match(workflowOverview, /<title id="title">gemini-agent workflow overview<\/title>/);
  assert.match(workflowOverview, /Execution stays local/);
  assert.match(bugTemplate, /^name: Bug report$/m);
  assert.match(bugTemplate, /I removed secrets, raw telemetry, private screenshots, customer data, and unredacted prompts\/responses/);
  assert.match(featureTemplate, /^name: Feature request$/m);
  assert.match(featureTemplate, /keeping the command surface small/);
  assert.match(issueConfig, /Security vulnerability/);
  assert.match(ci, /npm ci/);
  assert.match(ci, /npm test/);
  assert.match(ci, /npm audit --omit=dev/);
  assert.match(ci, /npm pack --dry-run/);
});

test("git ignores installed dependencies", async () => {
  const gitignore = await readFile(new URL(".gitignore", root), "utf8");
  assert.match(gitignore, /^node_modules\/$/m);
});

test("public markdown does not expose local home paths", async () => {
  const files = [
    fileURLToPath(new URL("README.md", root)),
    ...await markdownFiles(fileURLToPath(new URL("docs", root))),
    ...await markdownFiles(fileURLToPath(new URL("examples", root))),
  ];

  for (const file of files) {
    const content = await readFile(file, "utf8");
    const label = relative(rootPath, file);
    assert.doesNotMatch(content, /\/Users\/[^/\s]+/u, `${label} exposes a local home path`);
  }
});

test("README documents open-source setup and core workflows", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");

  assert.match(readme, /https:\/\/img\.shields\.io\/badge\/license-MIT-green\.svg/);
  assert.match(readme, /!\[CLI focused help\]\(docs\/assets\/cli-focused-help\.svg\)/);
  assert.match(readme, /^## 30-Second Fit Check$/m);
  assert.match(readme, /\| Use it when\.\.\. \| Reach for something else when\.\.\. \|/);
  assert.match(readme, /You want a second model to review plans, patches, diffs, screenshots, or design artifacts before Codex acts/);
  assert.match(readme, /Fastest useful command after setup/);
  assert.match(readme, /^## First Run$/m);
  assert.match(readme, /Requires Node\.js 22 or newer and a Gemini API key/);
  assert.match(readme, /verifies credentials, proves Gemini access, and runs the first review gate/);
  assert.match(readme, /^export GEMINI_API_KEY="\.\.\."$/m);
  assert.match(readme, /On macOS, you can store the key in Keychain instead/);
  assert.match(readme, /If `diff-review --smart-diff` has no context pack yet/);
  assert.doesNotMatch(readme, /^## Install$/m);
  assert.doesNotMatch(readme, /^## Configure Credentials$/m);
  assert.doesNotMatch(readme, /^## 90-Second Quick Start$/m);
  assert.doesNotMatch(readme, /^## Examples$/m);
  assert.match(readme, /^## Why Use It\?$/m);
  assert.match(readme, /\| Keep Codex from rereading a large repo slice \| `context-pack --bootstrap --write-artifact` \|/);
  assert.match(readme, /!\[Workflow overview\]\(docs\/assets\/workflow-overview\.svg\)/);
  assert.match(readme, /^## What It Is Not$/m);
  assert.match(readme, /\[OpenAI Codex CLI\]\(https:\/\/github\.com\/openai\/codex\)/);
  assert.match(readme, /\[Gemini CLI\]\(https:\/\/github\.com\/google-gemini\/gemini-cli\)/);
  assert.match(readme, /\[Aider\]\(https:\/\/github\.com\/Aider-AI\/aider\)/);
  assert.match(readme, /\[Repomix\]\(https:\/\/github\.com\/yamadashy\/repomix\)/);
  assert.match(readme, /\[CodeRabbit\]\(https:\/\/docs\.coderabbit\.ai\/cli\) and \[Greptile\]\(https:\/\/www\.greptile\.com\/docs\/introduction\)/);
  assert.match(readme, /^## Requirements$/m);
  assert.match(readme, /Node\.js 22 or newer/);
  assert.match(readme, /marked `"private": true`/);
  assert.match(readme, /^git clone https:\/\/github\.com\/yha9806\/gemini-agent\.git$/m);
  assert.match(readme, /^npm install$/m);
  assert.match(readme, /^\.\/bin\/gemini-agent --help$/m);
  assert.match(readme, /^\.\/bin\/gemini-agent --help-all$/m);
  assert.match(readme, /Default help is intentionally short/);
  assert.match(readme, /^\.\/bin\/gemini-agent auth status$/m);
  assert.match(readme, /^\.\/bin\/gemini-agent ask "Reply with exactly: gemini-agent-ok"$/m);
  assert.match(readme, /\[Quick diff review\]\(examples\/quick-diff-review\/README\.md\)/);
  assert.match(readme, /\[Visual gate\]\(examples\/visual-gate\/README\.md\)/);
  assert.match(readme, /\[MCP config\]\(examples\/mcp-config\/README\.md\)/);

  assert.match(readme, /```mermaid\nflowchart TD/);
  assert.match(readme, /^\.\/bin\/gemini-agent diff-review --smart-diff$/m);
  assert.match(readme, /^\.\/bin\/gemini-agent diff-review --auto-context-pack --diff$/m);
  assert.match(readme, /^\.\/bin\/gemini-agent context-pack --bootstrap --write-artifact$/m);
  assert.match(readme, /^\.\/bin\/gemini-agent context-pack --doctor --json$/m);
  assert.match(readme, /^\.\/bin\/gemini-agent artifact-review --file design\.png --kind ui --review-depth quick$/m);
  assert.match(readme, /^\.\/bin\/gemini-agent visual gate --target-screenshot target\.png --actual-screenshot after\.png --kind ui --risk design-implementation --json$/m);
  assert.match(readme, /^\.\/bin\/gemini-agent design draft --stdin --variants 2 --quality fast --target-stack html$/m);
  assert.match(readme, /^\.\/bin\/gemini-agent install-codex-global --mode active --dry-run$/m);
  assert.match(readme, /gemini-agent-mcp` is a stdio MCP server entrypoint/);
  assert.match(readme, /gemini_design_draft/);

  assert.match(readme, /^\.\/bin\/gemini-agent telemetry summary --global --json$/m);
  assert.match(readme, /\[docs\/telemetry\.md\]\(docs\/telemetry\.md\)/);
  assert.match(readme, /^## Release Notes$/m);
  assert.match(readme, /\[docs\/release\/v0\.1\.0\.md\]\(docs\/release\/v0\.1\.0\.md\)/);
  assert.match(readme, /\[docs\/release\/post-release-checklist\.md\]\(docs\/release\/post-release-checklist\.md\)/);

  assert.match(readme, /Raw telemetry mode can capture prompts and responses/);
  assert.match(readme, /`--confirm-raw-content` is an explicit acknowledgement/);
  assert.match(readme, /Codex or the operator remains responsible for edits, tests, commits, and final\s+decisions/);
  assert.match(readme, /without printing raw prompts, raw responses,\s+local paths, event ids, batch ids,\s+media file names, or image bytes/);
  assert.match(readme, /^npm test$/m);
  assert.match(readme, /^GEMINI_AGENT_RUN_LIVE_TESTS=1 npm run test:live$/m);
  assert.match(readme, /\[CONTRIBUTING\.md\]\(CONTRIBUTING\.md\)/);
  assert.match(readme, /\[SECURITY\.md\]\(SECURITY\.md\)/);
  assert.match(readme, /MIT\. See \[LICENSE\]\(LICENSE\)/);
});

test("live Gemini tests require explicit opt-in", async () => {
  const paletteMaskTest = await readFile(new URL("palette-mask.test.mjs", import.meta.url), "utf8");

  assert.match(paletteMaskTest, /GEMINI_AGENT_RUN_LIVE_TESTS/);
  assert.doesNotMatch(paletteMaskTest, /^const liveKey = await resolveApiKey\(\);$/m);
  assert.match(paletteMaskTest, /skip: runLiveTests && liveKey\.ok\s+\? false\s+: /);
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
