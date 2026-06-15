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
  assert.match(readme, /^\.\/bin\/gemini-agent telemetry raw reveal --global --state sent --limit 1 --confirm-raw-content --json$/m);
  assert.match(readme, /^\.\/bin\/gemini-agent telemetry raw delete --global --state sent --event-id evt_example --confirm-raw-content --dry-run --json$/m);
  assert.match(readme, /^\.\/bin\/gemini-agent telemetry raw prune --global --state sent --keep-days 30 --dry-run$/m);
  assert.match(readme, /^\.\/bin\/gemini-agent telemetry raw prune --global --state sent --keep-days 30 --write --json$/m);
  assert.match(readme, /^\.\/bin\/gemini-agent telemetry economics --global$/m);
  assert.match(readme, /^\.\/bin\/gemini-agent telemetry economics --global --json$/m);
  assert.match(readme, /^\.\/bin\/gemini-agent telemetry report --global$/m);
  assert.match(readme, /^\.\/bin\/gemini-agent telemetry report --global --json$/m);
  assert.match(readme, /^\.\/bin\/gemini-agent telemetry artifact-review quality-gate --global --json$/m);
  assert.match(readme, /^\.\/bin\/gemini-agent telemetry artifact-review coverage-plan --global --json$/m);
  assert.match(readme, /^\.\/bin\/gemini-agent telemetry artifact-review readiness-plan --global --json$/m);
  assert.match(readme, /^\.\/bin\/gemini-agent telemetry multimodal repair-kind --global --correction-version media-kind-v1 --dry-run$/m);
  assert.match(readme, /^\.\/bin\/gemini-agent telemetry multimodal repair-metadata --global --correction-version media-v2 --dry-run$/m);
  assert.match(readme, /^\.\/bin\/gemini-agent diff-review --diff$/m);
  assert.match(readme, /^\.\/bin\/gemini-agent diff-review --smart-diff$/m);
  assert.match(readme, /^\.\/bin\/gemini-agent diff-review --auto-context-pack --diff$/m);
  assert.match(readme, /^\.\/bin\/gemini-agent plan-critique --context-pack \.gemini-agent\/context\/latest\.json$/m);
  assert.match(readme, /^\.\/bin\/gemini-agent plan-critique --auto-context-pack --stdin$/m);
  assert.match(readme, /^\.\/bin\/gemini-agent context-pack --bootstrap --write-artifact$/m);
  assert.match(readme, /^\.\/bin\/gemini-agent context-pack --doctor --json$/m);
  assert.match(readme, /^\.\/bin\/gemini-agent artifact-review --file design\.png --kind ui --review-depth quick$/m);
  assert.match(readme, /^\.\/bin\/gemini-agent artifact-review --file design\.png --kind ui --telemetry-purpose validation$/m);
  assert.match(readme, /^\.\/bin\/gemini-agent artifact-review --file before\.png --file after\.png --kind ui --review-mode comparison$/m);
  assert.match(readme, /^\.\/bin\/gemini-agent visual gate --actual-screenshot after\.png --kind ui --smoke-only --json$/m);
  assert.match(readme, /^\.\/bin\/gemini-agent visual gate --target-screenshot target\.png --actual-screenshot after\.png --kind ui --risk design-implementation --json$/m);
  assert.match(readme, /^\.\/bin\/gemini-agent design brief --stdin --write-artifact$/m);
  assert.match(readme, /^\.\/bin\/gemini-agent design draft --stdin --variants 2 --quality fast --target-stack html$/m);
  assert.match(readme, /^\.\/bin\/gemini-agent design generate --run \.gemini-agent\/design\/<run-id> --variants 2 --quality fast$/m);
  assert.match(readme, /^\.\/bin\/gemini-agent design perceive --run \.gemini-agent\/design\/<run-id> --file screenshot\.png --target "hero: main area"$/m);
  assert.match(readme, /^\.\/bin\/gemini-agent design prototype --run \.gemini-agent\/design\/<run-id> --target-stack html$/m);
  assert.match(readme, /^\.\/bin\/gemini-agent design handoff --run \.gemini-agent\/design\/<run-id>$/m);
  assert.match(readme, /^\.\/bin\/gemini-agent design loop --run \.gemini-agent\/design\/<run-id> --target-screenshot target\.png --actual-screenshot after\.png$/m);
  assert.match(readme, /^\.\/bin\/gemini-agent design doctor --json$/m);
  assert.match(readme, /^\.\/bin\/gemini-agent telemetry tick --global --batch-size 1 --timeout-ms 20000$/m);
  assert.match(readme, /project\/workspace attribution/);
  assert.match(readme, /multimodal MIME\/kind\/byte coverage/);
  assert.match(readme, /`artifact-review` returns a structured design scorecard/);
  assert.match(readme, /`artifact-review --review-depth quick` keeps the same JSON shape/);
  assert.match(readme, /quick single reviews use the 2048 output-token cohort while quick comparison reviews use the 4096 output-token cohort/);
  assert.match(readme, /`artifact-review` retries one malformed structured JSON response/);
  assert.match(readme, /`artifact-review --telemetry-purpose validation` marks canary or manual validation runs/);
  assert.match(readme, /`visual gate` composes local screenshot smoke checks/);
  assert.match(readme, /Visual gate outputs and telemetry do not expose raw prompts, raw responses, local paths, media file names, or image bytes/);
  assert.match(readme, /`design brief` starts a design run under `\.gemini-agent\/design\/<run-id>\/` and writes `brief\.json` plus `DESIGN\.md`/);
  assert.match(readme, /`design draft` orchestrates brief, candidate generation, prototype, and handoff artifacts under `\.gemini-agent\/design\/<run-id>\/`/);
  assert.match(readme, /`design generate` reads a run `brief\.json`, calls the configured image model, and writes PNG candidates plus `candidates\/manifest\.json`/);
  assert.match(readme, /`design perceive` reads a target screenshot, chooses palette masks when `--target` values are supplied, and writes `perceive\/perception\.json`/);
  assert.match(readme, /`design prototype` writes reviewable prototype code under `prototype\/` only/);
  assert.match(readme, /`design handoff` reads the normalized design brief and writes `handoff\.json` plus `codex-tasks\.md` for implementation/);
  assert.match(readme, /`design loop` keeps Codex as the source-editing authority and uses `visual gate` for target-vs-actual screenshot feedback/);
  assert.match(readme, /`design doctor --json` reports design model routing and provider configuration without looking up auth or calling Gemini/);
  assert.match(readme, /Telemetry summary and report aggregate artifact-review design scorecard metrics and per-field score coverage/);
  assert.match(readme, /Telemetry summary, economics, priorities, and report expose product-adjusted analytics/);
  assert.match(readme, /The telemetry receiver `\/metrics` and `\/dashboard` endpoints expose product-adjusted analytics/);
  assert.match(readme, /`telemetry backfill-artifacts` carries only allowlisted numeric\/null artifact-review design scorecard fields/);
  assert.match(readme, /Telemetry priorities use artifact-review design scorecard coverage, per-field score coverage, and average score/);
  assert.match(readme, /Telemetry priorities and report surface aggregate structured response diagnostics/);
  assert.match(readme, /retry recovery counts\/rates/);
  assert.match(readme, /pending raw preflight governance/);
  assert.match(readme, /`telemetry artifact-review quality-gate` reports aggregate quick-depth readiness/);
  assert.match(readme, /`telemetry artifact-review coverage-plan` separates production scorecard coverage from validation scorecard coverage/);
  assert.match(readme, /It combines coverage-plan, quality-gate, structured-response, latency, and raw-governance signals into one aggregate blocked \/ collect-more-samples \/ ready-for-limited-routing decision\./);
  assert.match(readme, /It does not run artifact-review samples, upload raw telemetry, or change routing by itself\./);
  assert.match(readme, /Output does not include raw prompts, raw responses, local paths, event ids, media file names, or credential-shaped strings\./);
  assert.match(readme, /Validation artifact-review coverage is calibration evidence only and cannot prove production routing readiness/);
  assert.match(readme, /Artifact-review quality gate separates Gemini generation latency readiness from scorecard coverage/);
  assert.match(readme, /current active quick budget cohort from historical non-active cohorts/);
  assert.match(readme, /multi-file artifact-review records media metadata without printing raw image bytes/);
  assert.match(readme, /`diff-review --diff` reads the current git diff directly/);
  assert.match(readme, /`diff-review --smart-diff` reviews the current git diff with the project-root context pack/);
  assert.match(readme, /if `\.gemini-agent\/context\/latest\.json` is missing, it first bootstraps one/);
  assert.match(readme, /`diff-review --smart-diff` is the preferred short context-reuse path/);
  assert.match(readme, /`diff-review --auto-context-pack --diff` remains the explicit equivalent when the pack already exists/);
  assert.match(readme, /Gate commands accept `--context-pack <path>`/);
  assert.match(readme, /Gate commands accept `--auto-context-pack`/);
  assert.match(readme, /`context-pack --bootstrap --write-artifact` creates the project-root context artifact used by `--auto-context-pack`/);
  assert.match(readme, /`context-pack --doctor` checks whether the project-root context pack is missing, invalid, stale, or tied to a different git HEAD without calling Gemini/);
  assert.match(readme, /Oversized gate failures print concrete `context-pack --bootstrap --write-artifact` and `--auto-context-pack` retry commands/);
  assert.match(readme, /Large raw gate calls print a non-blocking stderr preflight warning before Gemini credentials are resolved/);
  assert.match(readme, /Large raw `diff-review --diff` calls with an existing context pack suggest `diff-review --smart-diff`/);
  assert.match(readme, /Telemetry summary and economics aggregate context-pack preflight warning counts, smart-diff auto-bootstrap counts\/rates, and context reuse rates without exposing raw gate input/);
  assert.match(readme, /Telemetry summary reports aggregate latency p50\/p95\/p99 by command/);
  assert.match(readme, /Telemetry summary aggregates safe latency stage attribution, including captured `gemini_generation` time and artifact-review `pre_gemini_total`/);
  assert.match(readme, /Telemetry summary aggregates safe structured-response diagnostics/);
  assert.match(readme, /visual_gate/);
  assert.match(readme, /Telemetry priorities use latency stage attribution to distinguish captured Gemini generation latency from pre-Gemini artifact-review work/);
  assert.match(readme, /Telemetry summary, economics, and priorities normalize legacy `gemini-\*` command aliases into current command names/);
  assert.match(readme, /Latency priorities only use stage attribution when `gemini_generation` or `pre_gemini_total` has at least 5 command-level samples/);
  assert.match(readme, /Latency priorities initially require at least 5 samples and command p95 >= 10,000 ms/);
  assert.match(readme, /Global active Codex policy tells sessions to use `diff-review --smart-diff` for current branch review/);
  assert.match(readme, /manually regenerate stale or unrelated packs/);
  assert.match(readme, /palette-split quality/);
  assert.match(readme, /local raw telemetry counts, bytes, truncation counts, multimodal counts, and credential-like aggregate signals/);
  assert.match(readme, /pending raw upload batch risk before flushing/);
  assert.match(readme, /writes confirmed raw telemetry to a local JSONL file/);
  assert.match(readme, /prints confirmed, bounded raw telemetry to stdout/);
  assert.match(readme, /deletes confirmed local raw telemetry by event id with dry-run by default/);
  assert.match(readme, /local sent-telemetry retention with dry-run by default/);
  assert.match(readme, /estimates Gemini cost, Codex token savings, and aggregate gate input byte metrics/);
  assert.match(readme, /combines aggregate health, economics, context reuse, attribution, multimodal adoption, and top development priority into a product decision snapshot/);
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
