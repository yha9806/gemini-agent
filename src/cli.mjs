import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { stdin as input, stderr as errorOutput, stdout as output } from "node:process";
import { runArtifactReview } from "./artifact-review.mjs";
import { runVisualGate } from "./visual-gate.mjs";
import { visualGateToPrettyJson } from "./visual-gate-schemas.mjs";
import { applyCodexGlobalInstall } from "./codex-global-install.mjs";
import {
  formatContextPackDoctorText,
  runContextPackDoctor,
} from "./context-pack-doctor.mjs";
import { runContextPack } from "./context-pack.mjs";
import { runDesignBrief } from "./design-brief.mjs";
import { runDesignDraft, validateDesignDraftModelPreflight } from "./design-draft.mjs";
import { runDesignGenerate } from "./design-generate.mjs";
import { runDesignHandoff } from "./design-handoff.mjs";
import { runDesignLoop } from "./design-loop.mjs";
import { designDoctor } from "./design-model-router.mjs";
import { runDesignPerceive, selectPerceptionProvider } from "./design-perceive.mjs";
import { runDesignPrototype, validatePrototypeTargetStack } from "./design-prototype.mjs";
import { resolveDesignRun } from "./design-run-store.mjs";
import { resolveWorkspaceFilePath } from "./workspace-paths.mjs";
import { deleteApiKeyFromKeychain, resolveApiKey, saveApiKeyToKeychain } from "./keychain.mjs";
import { generateReview, generateText } from "./gemini-client.mjs";
import {
  collectBootstrapContext,
  collectTextInput,
  detectArtifactMime,
  imagePartFromFile,
  resolveCwdFilePath,
} from "./input-collector.mjs";
import { loadProjectPolicy } from "./policies.mjs";
import { parsePaletteSplitArgs, runPaletteSplit } from "./palette-mask.mjs";
import { buildGatePrompt } from "./prompts.mjs";
import {
  autoContextPackExists,
  defaultGateInputLimitBytes,
  gateContextPackPreflightMessage,
  gateContextPackPreflightMetadata,
  gateContextInputTooLargeMessage,
  gateInputMetadata,
  limitedGateText,
  parseMaxInputBytes,
  readAutoContextPackFile,
  readLimitedContextPackFile,
  readLimitedGateFile,
  resolveProjectRootForContextPack,
} from "./gate-input.mjs";
import { artifactReviewToPrettyJson, contextPackToPrettyJson, reviewToPrettyJson } from "./schemas.mjs";
import { drainTelemetryCapture } from "./telemetry-capture.mjs";
import {
  contextPackTelemetryMetadata,
  gateFreshInputModes,
  gateTelemetryMetadata,
} from "./telemetry-command-metadata.mjs";
import { artifactReviewsToRawTelemetryBatch } from "./telemetry-backfill.mjs";
import { normalizeTelemetryBatch } from "./telemetry-schemas.mjs";
import { runTelemetryDoctor } from "./telemetry-doctor.mjs";
import {
  formatTelemetryEconomicsText,
  runTelemetryEconomics,
} from "./telemetry-economics.mjs";
import {
  formatTelemetryPrioritiesText,
  runTelemetryPriorities,
} from "./telemetry-priorities.mjs";
import {
  formatTelemetryReportText,
  runTelemetryReport,
} from "./telemetry-report.mjs";
import {
  artifactReviewQualityGateToText,
  runArtifactReviewQualityGate,
} from "./telemetry-artifact-review-quality-gate.mjs";
import {
  artifactReviewCoveragePlanToText,
  runArtifactReviewCoveragePlan,
} from "./telemetry-artifact-review-coverage-plan.mjs";
import {
  artifactReviewReadinessPlanToText,
  runArtifactReviewReadinessPlan,
} from "./telemetry-artifact-review-readiness-plan.mjs";
import {
  formatTelemetryMultimodalRepairMetadataText,
  formatTelemetryMultimodalRepairText,
  runTelemetryMultimodalRepairKind,
  runTelemetryMultimodalRepairMetadata,
} from "./telemetry-multimodal-repair.mjs";
import {
  formatTelemetrySummaryText,
  runTelemetrySummary,
} from "./telemetry-summary.mjs";
import { assertTelemetryPurpose } from "./telemetry-purpose.mjs";
import {
  formatTelemetryRawInventoryText,
  runTelemetryRawInventory,
} from "./telemetry-raw-inventory.mjs";
import {
  formatTelemetryRawPreflightText,
  runTelemetryRawPreflight,
} from "./telemetry-raw-preflight.mjs";
import {
  formatTelemetryRawExportText,
  runTelemetryRawExport,
} from "./telemetry-raw-export.mjs";
import {
  formatTelemetryRawRevealText,
  runTelemetryRawReveal,
} from "./telemetry-raw-reveal.mjs";
import {
  formatTelemetryRawDeleteText,
  runTelemetryRawDelete,
} from "./telemetry-raw-delete.mjs";
import {
  formatTelemetryRawPruneText,
  runTelemetryRawPrune,
} from "./telemetry-raw-prune.mjs";
import {
  assertRawConfirmation,
  disableTelemetryConfig,
  loadTelemetryConfigContext,
  rawTelemetryWarning,
  resolveTelemetryToken,
  saveTelemetryConfig,
} from "./telemetry-config.mjs";
import { flushTelemetryQueue, runTelemetryValidation } from "./telemetry-sender.mjs";
import {
  appendTelemetryEvent,
  appendTelemetryEventsIfNew,
  archiveFailedTelemetryEvents,
  archiveQuarantinedTelemetryEvents,
  inspectFailedTelemetryEvents,
  inspectQuarantinedTelemetryEvents,
  loadTelemetryState,
  purgeTelemetryData,
  quarantineTelemetryEvent,
  retryFailedTelemetryEvents,
  retryQuarantinedTelemetryEvents,
} from "./telemetry-queue.mjs";
import { installScheduler, schedulerStatus, uninstallScheduler } from "./telemetry-scheduler.mjs";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json");

const GATE_COMMANDS = new Map([
  ["plan-critique", "plan_critique"],
  ["patch-precheck", "patch_precheck"],
  ["diff-review", "diff_review"],
  ["research-brief", "research_brief"],
]);

const ARTIFACT_KINDS = new Set(["image", "ui", "design", "architecture", "research"]);
const ARTIFACT_REVIEW_MODES = new Set(["single", "comparison"]);
const ARTIFACT_REVIEW_DEPTHS = new Set(["quick", "standard"]);
const VISUAL_GATE_KINDS = new Set(["ui", "design", "image"]);
const MAX_ARTIFACT_REVIEW_FILES = 4;
const DEFAULT_TELEMETRY_ENDPOINT = "http://127.0.0.1:8787/ingest";
const DEFAULT_TELEMETRY_TOKEN_ENV = "GEMINI_AGENT_TELEMETRY_TOKEN";
const TELEMETRY_CONFIG_PATH = join(".gemini-agent", "telemetry", "config.json");
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function allowFakeResponse(env = process.env) {
  return env.GEMINI_AGENT_ALLOW_FAKE_RESPONSE === "1";
}

function printUsage() {
  output.write([
    "gemini-agent: local Gemini coprocessor for Codex and agentic coding workflows.",
    "",
    "Common workflows:",
    "  gemini-agent ask <prompt>",
    "  gemini-agent context-pack --bootstrap --write-artifact",
    "  gemini-agent diff-review --smart-diff",
    "  gemini-agent artifact-review --file <path> --kind ui",
    "  gemini-agent visual gate --actual-screenshot <path> --kind ui --json",
    "  gemini-agent design draft [--stdin|--file <path>|text]",
    "",
    "Setup:",
    "  gemini-agent auth status",
    "  gemini-agent auth set",
    "  gemini-agent install-codex-global --mode active [--dry-run|--write]",
    "",
    "Operator summaries:",
    "  gemini-agent telemetry status [--global]",
    "  gemini-agent telemetry summary [--global] [--json]",
    "  gemini-agent telemetry report [--global] [--json]",
    "",
    "Run `gemini-agent --help-all` for every command and operator workflow.",
    "",
  ].join("\n"));
}

function printFullUsage() {
  output.write([
    "Usage:",
    "  gemini-agent auth status",
    "  gemini-agent auth set",
    "  gemini-agent auth delete",
    "  gemini-agent ask <prompt>",
    "  gemini-agent context-pack [--bootstrap | --stdin | --file <path> ... | --diff | text] [--write-artifact]",
    "  gemini-agent context-pack --doctor [--json] [--max-age-hours <n>]",
    "  gemini-agent artifact-review --file <path> [--file <path> ...] [--kind image|ui|design|architecture|research] [--review-mode single|comparison] [--review-depth quick|standard] [--telemetry-purpose production|validation] [--write-artifact]",
    "  gemini-agent visual gate --actual-screenshot <path> [--target-screenshot <path>] [--kind ui|design|image] [--risk <hint>] [--smoke-only] [--json]",
    "  gemini-agent palette-split <image.png> --target <name: description> [--target <name: description> ...] --output <dir> [--tolerance <n>]",
    "  gemini-agent design brief [--stdin|--file <path>] [--write-artifact]",
    "  gemini-agent design draft [--stdin|--file <path>|text] [--reference <path> ...] [--target <name: description> ...] [--variants <n>] [--quality fast|pro] [--target-stack html|react|tailwind|auto] [--skip-generate] [--skip-perceive] [--skip-prototype] [--skip-handoff] [--json]",
    "  gemini-agent design generate --run <path> [--variants <n>] [--quality fast|pro]",
    "  gemini-agent design perceive --run <path> --file <path> [--target <name: description> ...] [--provider auto|palette-mask|gemini-vision|vision-banana]",
    "  gemini-agent design prototype --run <path> [--candidate <id>] [--target-stack html|react|tailwind|auto]",
    "  gemini-agent design handoff --run <path> [--candidate <id>]",
    "  gemini-agent design loop --run <path> [--target-screenshot <path>] [--actual-screenshot <path>] [--max-iterations <n>]",
    "  gemini-agent design doctor [--json]",
    "  gemini-agent plan-critique (--file <path> | --stdin | --diff | --context-pack <path> | --auto-context-pack | <text>) [--max-input-bytes <n>]",
    "  gemini-agent patch-precheck (--file <path> | --stdin | --diff | --context-pack <path> | --auto-context-pack | <text>) [--max-input-bytes <n>]",
    "  gemini-agent diff-review (--file <path> | --stdin | --diff | --smart-diff | --context-pack <path> | --auto-context-pack | <text>) [--max-input-bytes <n>]",
    "  gemini-agent research-brief (--file <path> | --stdin | --diff | --context-pack <path> | --auto-context-pack | <text>) [--max-input-bytes <n>]",
    "  gemini-agent install-codex-global --mode active [--dry-run|--write]",
    "  gemini-agent telemetry enable [--global] --level raw --endpoint <url> --token-env <env> --confirm-raw-content [--deployment-id <id>] [--user-label <label>|--clear-user-label] [--schedule <schedule>]",
    "  gemini-agent telemetry status [--global]",
    "  gemini-agent telemetry preview [--global]",
    "  gemini-agent telemetry summary [--global] [--json]",
    "  gemini-agent telemetry raw inventory [--global] [--json]",
    "  gemini-agent telemetry raw preflight [--global] [--batch-size <n>] [--max-bytes <n>] [--json]",
    "  gemini-agent telemetry raw export --state pending|sent --output <path> --limit <n> --confirm-raw-content [--global] [--format jsonl] [--json]",
    "  gemini-agent telemetry raw reveal --state pending|sent --limit <n> --confirm-raw-content [--global] [--json]",
    "  gemini-agent telemetry raw delete --state pending|sent --event-id <id> --confirm-raw-content [--global] [--dry-run|--write] [--json]",
    "  gemini-agent telemetry raw prune --state sent --keep-days <n> [--max-sent-bytes <n>] [--global] [--dry-run|--write] [--json]",
    "  gemini-agent telemetry economics [--global] [--json] [--top <n>] [--input-price-per-million <usd>] [--output-price-per-million <usd>]",
    "  gemini-agent telemetry priorities [--global] [--json] [--top <n>] [--input-price-per-million <usd>] [--output-price-per-million <usd>]",
    "  gemini-agent telemetry report [--global] [--json] [--top <n>] [--input-price-per-million <usd>] [--output-price-per-million <usd>]",
    "  gemini-agent telemetry artifact-review quality-gate [--global] [--json] [--top <n>]",
    "  gemini-agent telemetry artifact-review coverage-plan [--global] [--json] [--top <n>]",
    "  gemini-agent telemetry artifact-review readiness-plan [--global] [--json] [--top <n>]",
    "  gemini-agent telemetry multimodal repair-kind --correction-version <id> [--global] [--dry-run|--write] [--limit <n>] [--json]",
    "  gemini-agent telemetry multimodal repair-metadata --correction-version <id> [--global] [--dry-run|--write] [--limit <n>] [--json]",
    "  gemini-agent telemetry doctor [--global] [--json]",
    "  gemini-agent telemetry flush [--global] [--dry-run] [--batch-size <n>] [--max-bytes <n>] [--timeout-ms <n>]",
    "  gemini-agent telemetry retry-failed [--global] --reason <reason> [--dry-run|--write] [--batch-size <n>]",
    "  gemini-agent telemetry failed inspect [--global] [--reason <reason>] [--limit <n>] [--json]",
    "  gemini-agent telemetry failed archive [--global] --reason <reason> [--dry-run|--write] [--batch-size <n>] [--note <text>]",
    "  gemini-agent telemetry quarantine [--global] --event-id <id> --reason <reason>",
    "  gemini-agent telemetry quarantine inspect [--global] [--reason <reason>] [--limit <n>] [--json]",
    "  gemini-agent telemetry quarantine retry [--global] --reason <reason> [--dry-run|--write] [--batch-size <n>]",
    "  gemini-agent telemetry quarantine archive [--global] --reason <reason> [--dry-run|--write] [--batch-size <n>] [--note <text>]",
    "  gemini-agent telemetry tick [--global] [--batch-size <n>] [--timeout-ms <n>]",
    "  gemini-agent telemetry validate [--global] [--endpoint <url>] [--token-env <env>] [--deployment-id <id>] --confirm-raw-content",
    "  gemini-agent telemetry backfill-artifacts [--artifacts-dir <path>] --deployment-id <id> [--batch-id <id>] [--generated-at <iso>] [--max-files <n>] [--max-artifact-bytes <n>] [--correction-version <id>]",
    "  gemini-agent telemetry install-scheduler [--global] --target launchd|cron|systemd --name <label> [--schedule hourly|daily@HH:MM] [--batch-size <n>] [--timeout-ms <n>] [--env-file <path>] [--launchd-domain gui|user] [--dry-run|--write]",
    "  gemini-agent telemetry scheduler-status --target launchd|cron|systemd --name <label>",
    "  gemini-agent telemetry uninstall-scheduler --target launchd|cron|systemd --name <label>",
    "  gemini-agent telemetry disable",
    "  gemini-agent telemetry purge",
    "",
  ].join("\n"));
}

function printHelpLines(lines) {
  output.write([...lines, ""].join("\n"));
}

function argsRequestHelp(args) {
  return args.includes("--help") || args.includes("-h");
}

function printFocusedHelp(argv) {
  if (!argsRequestHelp(argv)) return false;
  const [command, subcommand] = argv;

  if (command === "diff-review") {
    printHelpLines([
      "Usage: gemini-agent diff-review (--smart-diff | --diff | --stdin | --file <path> ... | --context-pack <path> | --auto-context-pack | <text>) [--max-input-bytes <n>]",
      "",
      "Reviews the current patch or supplied input for risks, missing tests, unsafe claims, and suggested changes.",
      "",
      "Common:",
      "  gemini-agent diff-review --smart-diff",
      "  gemini-agent diff-review --auto-context-pack --diff",
      "  gemini-agent diff-review --file patch.diff",
    ]);
    return true;
  }

  if (command === "context-pack") {
    printHelpLines([
      "Usage: gemini-agent context-pack [--bootstrap | --stdin | --file <path> ... | --diff | <text>] [--write-artifact]",
      "       gemini-agent context-pack --doctor [--json] [--max-age-hours <n>]",
      "",
      "Creates or checks compact reusable project context under .gemini-agent/context/.",
      "",
      "Common:",
      "  gemini-agent context-pack --bootstrap --write-artifact",
      "  gemini-agent context-pack --doctor --json",
    ]);
    return true;
  }

  if (command === "artifact-review") {
    printHelpLines([
      "Usage: gemini-agent artifact-review --file <path> [--file <path> ...] [--kind image|ui|design|architecture|research] [--review-mode single|comparison] [--review-depth quick|standard] [--telemetry-purpose production|validation] [--write-artifact]",
      "",
      "Reviews screenshots, diagrams, images, and other artifacts without editing source files.",
      "",
      "Common:",
      "  gemini-agent artifact-review --file design.png --kind ui",
      "  gemini-agent artifact-review --file before.png --file after.png --kind ui --review-mode comparison",
    ]);
    return true;
  }

  if (command === "visual" && subcommand === "gate") {
    printHelpLines([
      "Usage: gemini-agent visual gate --actual-screenshot <path> [--target-screenshot <path>] [--kind ui|design|image] [--risk <hint>] [--smoke-only] [--json]",
      "",
      "Runs local screenshot smoke checks plus optional Gemini visual review and returns pass, caution, or block.",
      "",
      "Common:",
      "  gemini-agent visual gate --actual-screenshot after.png --kind ui --json",
      "  gemini-agent visual gate --target-screenshot target.png --actual-screenshot after.png --kind ui --risk design-implementation --json",
    ]);
    return true;
  }

  if (command === "design" && subcommand === "draft") {
    printHelpLines([
      "Usage: gemini-agent design draft [--stdin|--file <path>|text] [--reference <path> ...] [--target <name: description> ...] [--variants <n>] [--quality fast|pro] [--target-stack html|react|tailwind|auto] [--skip-generate] [--skip-perceive] [--skip-prototype] [--skip-handoff] [--json]",
      "",
      "Turns a design brief into local design artifacts, candidate guidance, a prototype, and Codex handoff notes.",
      "",
      "Common:",
      "  gemini-agent design draft --stdin --variants 2 --quality fast --target-stack html",
      "  gemini-agent design draft --file brief.md --skip-generate --skip-prototype",
    ]);
    return true;
  }

  if (command === "telemetry" && subcommand === "summary") {
    printHelpLines([
      "Usage: gemini-agent telemetry summary [--global] [--json]",
      "",
      "Summarizes local or global opt-in telemetry without printing raw prompts, responses, paths, event ids, or media names.",
      "",
      "Common:",
      "  gemini-agent telemetry summary --global",
      "  gemini-agent telemetry summary --global --json",
    ]);
    return true;
  }

  return false;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of input) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function readSecret(prompt) {
  output.write(prompt);
  const wasRaw = input.isRaw;
  if (input.isTTY) input.setRawMode(true);
  let value = "";
  try {
    for await (const chunk of input) {
      const char = chunk.toString("utf8");
      if (char === "\r" || char === "\n") break;
      if (char === "\u0003") {
        output.write("\n");
        const error = new Error("Interrupted.");
        error.exitCode = 130;
        throw error;
      }
      if (char === "\u007f") {
        value = value.slice(0, -1);
      } else {
        value += char;
      }
    }
  } finally {
    if (input.isTTY) input.setRawMode(Boolean(wasRaw));
    output.write("\n");
  }
  return value.trim();
}

function parseTelemetryOptions(args) {
  const options = {
    confirmRawContent: false,
    clearUserLabel: false,
    global: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--confirm-raw-content") {
      options.confirmRawContent = true;
    } else if (arg === "--global") {
      options.global = true;
    } else if (arg === "--level") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--level requires a value.");
      options.level = value;
      index += 1;
    } else if (arg === "--endpoint") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--endpoint requires a URL.");
      options.endpoint = value;
      index += 1;
    } else if (arg === "--token-env") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--token-env requires an environment variable name.");
      options.tokenEnv = value;
      index += 1;
    } else if (arg === "--deployment-id") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--deployment-id requires an id.");
      options.deploymentId = value;
      index += 1;
    } else if (arg === "--user-label") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--user-label requires a label.");
      options.userLabel = value;
      index += 1;
    } else if (arg === "--clear-user-label") {
      options.clearUserLabel = true;
    } else if (arg === "--schedule") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--schedule requires a value.");
      options.schedule = value;
      index += 1;
    } else {
      throw new Error(`Unknown telemetry argument: ${arg}`);
    }
  }
  if (options.userLabel !== undefined && options.clearUserLabel) {
    throw new Error("--user-label and --clear-user-label cannot be used together.");
  }

  return options;
}

function telemetryScope(options, defaultScope = "auto") {
  return options.global ? "global" : defaultScope;
}

function hasNonScopeTelemetryOptions(options) {
  return Boolean(
    options.confirmRawContent
      || options.level
      || options.endpoint
      || options.tokenEnv
      || options.deploymentId
      || options.userLabel
      || options.clearUserLabel
      || options.schedule
  );
}

function parseTelemetryScopeOnlyOptions(subcommand, args) {
  const options = parseTelemetryOptions(args);
  if (hasNonScopeTelemetryOptions(options)) {
    throw new Error(`telemetry ${subcommand} does not accept arguments other than --global.`);
  }
  return options;
}

function parseTelemetryFlushOptions(args) {
  const options = {
    dryRun: false,
    global: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--global") {
      options.global = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--batch-size") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--batch-size requires a positive integer.");
      options.batchSize = positiveIntegerOption(value, "--batch-size");
      index += 1;
    } else if (arg === "--max-bytes") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--max-bytes requires a positive integer.");
      options.maxBytes = positiveIntegerOption(value, "--max-bytes");
      index += 1;
    } else if (arg === "--timeout-ms") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--timeout-ms requires a positive integer.");
      options.timeoutMs = positiveIntegerOption(value, "--timeout-ms");
      index += 1;
    } else {
      throw new Error(`Unknown telemetry flush argument: ${arg}`);
    }
  }

  return options;
}

function parseTelemetryRetryFailedOptions(args) {
  const options = {
    dryRun: true,
    global: false,
    batchSize: 1,
  };
  let sawDryRun = false;
  let sawWrite = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--global") {
      options.global = true;
    } else if (arg === "--dry-run") {
      sawDryRun = true;
      options.dryRun = true;
    } else if (arg === "--write") {
      sawWrite = true;
      options.dryRun = false;
    } else if (arg === "--reason") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--reason requires a reason.");
      options.reason = value;
      index += 1;
    } else if (arg === "--batch-size") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--batch-size requires a positive integer.");
      options.batchSize = positiveIntegerOption(value, "--batch-size");
      index += 1;
    } else {
      throw new Error(`Unknown telemetry retry-failed argument: ${arg}`);
    }
  }

  if (sawDryRun && sawWrite) throw new Error("--dry-run and --write cannot be used together.");
  if (!options.reason) throw new Error("--reason is required.");
  return options;
}

function parseTelemetryFailedInspectOptions(args) {
  const options = {
    global: false,
    json: false,
    limit: 20,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--global") {
      options.global = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--reason") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--reason requires a reason.");
      options.reason = value;
      index += 1;
    } else if (arg === "--limit") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--limit requires a positive integer.");
      options.limit = positiveIntegerOption(value, "--limit");
      index += 1;
    } else {
      throw new Error(`Unknown telemetry failed inspect argument: ${arg}`);
    }
  }

  return options;
}

function parseTelemetryFailedArchiveOptions(args) {
  const options = {
    dryRun: true,
    global: false,
    batchSize: 1,
    note: null,
  };
  let sawDryRun = false;
  let sawWrite = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--global") {
      options.global = true;
    } else if (arg === "--dry-run") {
      sawDryRun = true;
      options.dryRun = true;
    } else if (arg === "--write") {
      sawWrite = true;
      options.dryRun = false;
    } else if (arg === "--reason") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--reason requires a reason.");
      options.reason = value;
      index += 1;
    } else if (arg === "--batch-size") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--batch-size requires a positive integer.");
      options.batchSize = positiveIntegerOption(value, "--batch-size");
      index += 1;
    } else if (arg === "--note") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--note requires text.");
      options.note = value;
      index += 1;
    } else {
      throw new Error(`Unknown telemetry failed archive argument: ${arg}`);
    }
  }

  if (sawDryRun && sawWrite) throw new Error("--dry-run and --write cannot be used together.");
  if (!options.reason) throw new Error("--reason is required.");
  return options;
}

function parseTelemetryTickOptions(args) {
  const options = {
    global: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--global") {
      options.global = true;
    } else if (arg === "--batch-size") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--batch-size requires a positive integer.");
      options.batchSize = positiveIntegerOption(value, "--batch-size");
      index += 1;
    } else if (arg === "--timeout-ms") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--timeout-ms requires a positive integer.");
      options.timeoutMs = positiveIntegerOption(value, "--timeout-ms");
      index += 1;
    } else {
      throw new Error(`Unknown telemetry tick argument: ${arg}`);
    }
  }

  return options;
}

function parseTelemetryDoctorOptions(args) {
  const options = {
    global: false,
    json: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--global") {
      options.global = true;
    } else if (arg === "--json") {
      options.json = true;
    } else {
      throw new Error(`Unknown telemetry doctor argument: ${arg}`);
    }
  }

  return options;
}

function parseTelemetrySummaryOptions(args) {
  const options = {
    global: false,
    json: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--global") {
      options.global = true;
    } else if (arg === "--json") {
      options.json = true;
    } else {
      throw new Error(`Unknown telemetry summary argument: ${arg}`);
    }
  }

  return options;
}

function parseTelemetryRawInventoryOptions(args) {
  const options = {
    global: false,
    json: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--global") {
      options.global = true;
    } else if (arg === "--json") {
      options.json = true;
    } else {
      throw new Error(`Unknown telemetry raw inventory argument: ${arg}`);
    }
  }

  return options;
}

function parseTelemetryRawPreflightOptions(args) {
  const options = {
    global: false,
    json: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--global") {
      options.global = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--batch-size") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--batch-size requires a positive integer.");
      options.batchSize = positiveIntegerOption(value, "--batch-size");
      index += 1;
    } else if (arg === "--max-bytes") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--max-bytes requires a positive integer.");
      options.maxBytes = positiveIntegerOption(value, "--max-bytes");
      index += 1;
    } else if (arg === "--now") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--now requires an ISO timestamp.");
      options.now = new Date(value);
      if (Number.isNaN(options.now.getTime())) throw new Error("--now requires a valid ISO timestamp.");
      index += 1;
    } else {
      throw new Error(`Unknown telemetry raw preflight argument: ${arg}`);
    }
  }

  return options;
}

function parseTelemetryRawExportOptions(args) {
  const options = {
    confirmRawContent: false,
    format: "jsonl",
    global: false,
    json: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--global") {
      options.global = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--confirm-raw-content") {
      options.confirmRawContent = true;
    } else if (arg === "--state") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--state must be pending or sent.");
      options.state = value;
      index += 1;
    } else if (arg === "--output") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--output is required.");
      options.output = value;
      index += 1;
    } else if (arg === "--limit") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--limit requires a positive integer.");
      options.limit = positiveIntegerOption(value, "--limit");
      index += 1;
    } else if (arg === "--format") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--format requires jsonl.");
      options.format = value;
      index += 1;
    } else {
      throw new Error(`Unknown telemetry raw export argument: ${arg}`);
    }
  }

  if (options.state !== "pending" && options.state !== "sent") {
    throw new Error("--state must be pending or sent.");
  }
  if (!options.output) throw new Error("--output is required.");
  if (options.limit === undefined) throw new Error("--limit is required.");
  return options;
}

function parseTelemetryRawRevealOptions(args) {
  const options = {
    confirmRawContent: false,
    global: false,
    json: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--global") {
      options.global = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--confirm-raw-content") {
      options.confirmRawContent = true;
    } else if (arg === "--state") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--state must be pending or sent.");
      options.state = value;
      index += 1;
    } else if (arg === "--limit") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--limit requires a positive integer.");
      options.limit = positiveIntegerOption(value, "--limit");
      index += 1;
    } else {
      throw new Error(`Unknown telemetry raw reveal argument: ${arg}`);
    }
  }

  if (options.state !== "pending" && options.state !== "sent") {
    throw new Error("--state must be pending or sent.");
  }
  if (options.limit === undefined) throw new Error("--limit is required.");
  return options;
}

function parseTelemetryRawDeleteOptions(args) {
  const options = {
    confirmRawContent: false,
    dryRun: true,
    global: false,
    json: false,
  };
  let sawDryRun = false;
  let sawWrite = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--global") {
      options.global = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--confirm-raw-content") {
      options.confirmRawContent = true;
    } else if (arg === "--dry-run") {
      sawDryRun = true;
      options.dryRun = true;
    } else if (arg === "--write") {
      sawWrite = true;
      options.dryRun = false;
    } else if (arg === "--state") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--state must be pending or sent.");
      options.state = value;
      index += 1;
    } else if (arg === "--event-id") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--event-id is required.");
      options.eventId = value;
      index += 1;
    } else {
      throw new Error(`Unknown telemetry raw delete argument: ${arg}`);
    }
  }

  if (sawDryRun && sawWrite) throw new Error("--dry-run and --write cannot be used together.");
  if (options.state !== "pending" && options.state !== "sent") {
    throw new Error("--state must be pending or sent.");
  }
  if (!options.eventId) throw new Error("--event-id is required.");
  return options;
}

function nonnegativeIntegerOption(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} requires a nonnegative integer.`);
  }
  return parsed;
}

function parseTelemetryRawPruneOptions(args) {
  const options = {
    dryRun: true,
    global: false,
    json: false,
  };
  let sawDryRun = false;
  let sawWrite = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--global") {
      options.global = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--dry-run") {
      sawDryRun = true;
      options.dryRun = true;
    } else if (arg === "--write") {
      sawWrite = true;
      options.dryRun = false;
    } else if (arg === "--state") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--state sent is required.");
      options.state = value;
      index += 1;
    } else if (arg === "--keep-days") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--keep-days is required.");
      options.keepDays = nonnegativeIntegerOption(value, "--keep-days");
      index += 1;
    } else if (arg === "--max-sent-bytes") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--max-sent-bytes requires a nonnegative integer.");
      options.maxSentBytes = nonnegativeIntegerOption(value, "--max-sent-bytes");
      index += 1;
    } else if (arg === "--now") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--now requires an ISO timestamp.");
      options.now = new Date(value);
      if (Number.isNaN(options.now.getTime())) throw new Error("--now requires a valid ISO timestamp.");
      index += 1;
    } else {
      throw new Error(`Unknown telemetry raw prune argument: ${arg}`);
    }
  }

  if (sawDryRun && sawWrite) throw new Error("--dry-run and --write cannot be used together.");
  if (options.state !== "sent") throw new Error("--state sent is required.");
  if (options.keepDays === undefined) throw new Error("--keep-days is required.");
  return options;
}

function nonnegativeNumberOption(value, flag) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${flag} requires a nonnegative number.`);
  }
  return parsed;
}

function parseTelemetryEconomicsOptions(args) {
  const options = {
    global: false,
    json: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--global") {
      options.global = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--top") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--top requires a positive integer.");
      options.topLimit = positiveIntegerOption(value, "--top");
      index += 1;
    } else if (arg === "--input-price-per-million") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--input-price-per-million requires a nonnegative number.");
      options.inputPricePerMillion = nonnegativeNumberOption(value, "--input-price-per-million");
      index += 1;
    } else if (arg === "--output-price-per-million") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--output-price-per-million requires a nonnegative number.");
      options.outputPricePerMillion = nonnegativeNumberOption(value, "--output-price-per-million");
      index += 1;
    } else {
      throw new Error(`Unknown telemetry economics argument: ${arg}`);
    }
  }

  return options;
}

function parseTelemetryPrioritiesOptions(args) {
  const options = {
    global: false,
    json: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--global") {
      options.global = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--top") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--top requires a positive integer.");
      options.topLimit = positiveIntegerOption(value, "--top");
      index += 1;
    } else if (arg === "--input-price-per-million") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--input-price-per-million requires a nonnegative number.");
      options.inputPricePerMillion = nonnegativeNumberOption(value, "--input-price-per-million");
      index += 1;
    } else if (arg === "--output-price-per-million") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--output-price-per-million requires a nonnegative number.");
      options.outputPricePerMillion = nonnegativeNumberOption(value, "--output-price-per-million");
      index += 1;
    } else {
      throw new Error(`Unknown telemetry priorities argument: ${arg}`);
    }
  }

  return options;
}

function parseTelemetryReportOptions(args) {
  const options = {
    global: false,
    json: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--global") {
      options.global = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--top") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--top requires a positive integer.");
      options.topLimit = positiveIntegerOption(value, "--top");
      index += 1;
    } else if (arg === "--input-price-per-million") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--input-price-per-million requires a nonnegative number.");
      options.inputPricePerMillion = nonnegativeNumberOption(value, "--input-price-per-million");
      index += 1;
    } else if (arg === "--output-price-per-million") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--output-price-per-million requires a nonnegative number.");
      options.outputPricePerMillion = nonnegativeNumberOption(value, "--output-price-per-million");
      index += 1;
    } else {
      throw new Error(`Unknown telemetry report argument: ${arg}`);
    }
  }

  return options;
}

function parseTelemetryArtifactReviewQualityGateOptions(args) {
  const options = {
    global: false,
    json: false,
    topLimit: 10,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--global") {
      options.global = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--top") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--top requires a positive integer.");
      options.topLimit = positiveIntegerOption(value, "--top");
      index += 1;
    } else {
      throw new Error(`Unknown telemetry artifact-review quality-gate argument: ${arg}`);
    }
  }

  return options;
}

function parseTelemetryArtifactReviewCoveragePlanOptions(args) {
  const options = {
    global: false,
    json: false,
    topLimit: 10,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--global") {
      options.global = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--top") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--top requires a positive integer.");
      options.topLimit = positiveIntegerOption(value, "--top");
      index += 1;
    } else {
      throw new Error(`Unknown telemetry artifact-review coverage-plan argument: ${arg}`);
    }
  }

  return options;
}

function parseTelemetryArtifactReviewReadinessPlanOptions(args) {
  const options = {
    global: false,
    json: false,
    topLimit: 10,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--global") {
      options.global = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--top") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--top requires a positive integer.");
      options.topLimit = positiveIntegerOption(value, "--top");
      index += 1;
    } else {
      throw new Error(`Unknown telemetry artifact-review readiness-plan argument: ${arg}`);
    }
  }

  return options;
}

function parseTelemetryMultimodalRepairOptions(args, { subcommand = "repair-kind" } = {}) {
  const options = {
    dryRun: true,
    global: false,
    json: false,
  };
  let sawDryRun = false;
  let sawWrite = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--global") {
      options.global = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--dry-run") {
      sawDryRun = true;
      options.dryRun = true;
    } else if (arg === "--write") {
      sawWrite = true;
      options.dryRun = false;
    } else if (arg === "--correction-version") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--correction-version requires an id.");
      if (!/^[A-Za-z0-9._-]{1,48}$/.test(value)) {
        throw new Error("--correction-version contains invalid characters.");
      }
      options.correctionVersion = value;
      index += 1;
    } else if (arg === "--limit") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--limit requires a positive integer.");
      options.limit = positiveIntegerOption(value, "--limit");
      index += 1;
    } else {
      throw new Error(`Unknown telemetry multimodal ${subcommand} argument: ${arg}`);
    }
  }

  if (sawDryRun && sawWrite) throw new Error("--dry-run and --write cannot be used together.");
  if (!options.correctionVersion) throw new Error("--correction-version is required.");
  return options;
}

function parseTelemetryMultimodalRepairKindOptions(args) {
  return parseTelemetryMultimodalRepairOptions(args, { subcommand: "repair-kind" });
}

function parseTelemetryMultimodalRepairMetadataOptions(args) {
  return parseTelemetryMultimodalRepairOptions(args, { subcommand: "repair-metadata" });
}

function parseTelemetryQuarantineOptions(args) {
  const options = {
    global: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--global") {
      options.global = true;
    } else if (arg === "--event-id") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--event-id requires an id.");
      options.eventId = value;
      index += 1;
    } else if (arg === "--reason") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--reason requires a reason.");
      options.reason = value;
      index += 1;
    } else {
      throw new Error(`Unknown telemetry quarantine argument: ${arg}`);
    }
  }

  if (!options.eventId) throw new Error("--event-id is required.");
  if (!options.reason) throw new Error("--reason is required.");
  return options;
}

function parseTelemetryQuarantineInspectOptions(args) {
  const options = {
    global: false,
    json: false,
    limit: 20,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--global") {
      options.global = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--reason") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--reason requires a reason.");
      options.reason = value;
      index += 1;
    } else if (arg === "--limit") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--limit requires a positive integer.");
      options.limit = positiveIntegerOption(value, "--limit");
      index += 1;
    } else {
      throw new Error(`Unknown telemetry quarantine inspect argument: ${arg}`);
    }
  }

  return options;
}

function parseTelemetryQuarantineArchiveOptions(args) {
  const options = {
    dryRun: true,
    global: false,
    batchSize: 1,
    note: null,
  };
  let sawDryRun = false;
  let sawWrite = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--global") {
      options.global = true;
    } else if (arg === "--dry-run") {
      sawDryRun = true;
      options.dryRun = true;
    } else if (arg === "--write") {
      sawWrite = true;
      options.dryRun = false;
    } else if (arg === "--reason") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--reason requires a reason.");
      options.reason = value;
      index += 1;
    } else if (arg === "--batch-size") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--batch-size requires a positive integer.");
      options.batchSize = positiveIntegerOption(value, "--batch-size");
      index += 1;
    } else if (arg === "--note") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--note requires text.");
      options.note = value;
      index += 1;
    } else {
      throw new Error(`Unknown telemetry quarantine archive argument: ${arg}`);
    }
  }

  if (sawDryRun && sawWrite) throw new Error("--dry-run and --write cannot be used together.");
  if (!options.reason) throw new Error("--reason is required.");
  return options;
}

function parseTelemetryQuarantineRetryOptions(args) {
  const options = {
    dryRun: true,
    global: false,
    batchSize: 1,
  };
  let sawDryRun = false;
  let sawWrite = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--global") {
      options.global = true;
    } else if (arg === "--dry-run") {
      sawDryRun = true;
      options.dryRun = true;
    } else if (arg === "--write") {
      sawWrite = true;
      options.dryRun = false;
    } else if (arg === "--reason") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--reason requires a reason.");
      options.reason = value;
      index += 1;
    } else if (arg === "--batch-size") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--batch-size requires a positive integer.");
      options.batchSize = positiveIntegerOption(value, "--batch-size");
      index += 1;
    } else {
      throw new Error(`Unknown telemetry quarantine retry argument: ${arg}`);
    }
  }

  if (sawDryRun && sawWrite) throw new Error("--dry-run and --write cannot be used together.");
  if (!options.reason) throw new Error("--reason is required.");
  return options;
}

function positiveIntegerOption(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} requires a positive integer.`);
  }
  return parsed;
}

function parseBackfillArtifactOptions(args) {
  const options = {
    artifactsDir: join(process.cwd(), ".gemini-agent", "artifacts"),
    global: false,
    queue: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--artifacts-dir") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--artifacts-dir requires a path.");
      options.artifactsDir = value;
      index += 1;
    } else if (arg === "--global") {
      options.global = true;
    } else if (arg === "--queue") {
      options.queue = true;
    } else if (arg === "--deployment-id") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--deployment-id requires an id.");
      options.deploymentId = value;
      index += 1;
    } else if (arg === "--batch-id") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--batch-id requires an id.");
      options.batchId = value;
      index += 1;
    } else if (arg === "--generated-at") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--generated-at requires an ISO timestamp.");
      options.generatedAt = new Date(value);
      if (Number.isNaN(options.generatedAt.getTime())) throw new Error("--generated-at requires a valid ISO timestamp.");
      index += 1;
    } else if (arg === "--max-files") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--max-files requires a positive integer.");
      options.maxFiles = positiveIntegerOption(value, "--max-files");
      index += 1;
    } else if (arg === "--max-artifact-bytes") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--max-artifact-bytes requires a positive integer.");
      options.maxArtifactBytes = positiveIntegerOption(value, "--max-artifact-bytes");
      index += 1;
    } else if (arg === "--correction-version") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--correction-version requires an id.");
      options.correctionVersion = value;
      index += 1;
    } else {
      throw new Error(`Unknown backfill-artifacts argument: ${arg}`);
    }
  }

  if (!options.deploymentId) throw new Error("--deployment-id is required.");
  return options;
}

function schedulerValue(args, index, flag, description = "a value") {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires ${description}.`);
  return value;
}

function parseSchedulerInstallOptions(args) {
  const options = {
    schedule: "daily@09:00",
    write: false,
    global: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--target") {
      options.target = schedulerValue(args, index, arg, "one of: launchd, cron, systemd");
      index += 1;
    } else if (arg === "--name") {
      options.name = schedulerValue(args, index, arg, "a label");
      index += 1;
    } else if (arg === "--schedule") {
      options.schedule = schedulerValue(args, index, arg, "hourly or daily@HH:MM");
      index += 1;
    } else if (arg === "--batch-size") {
      options.batchSize = positiveIntegerOption(
        schedulerValue(args, index, arg, "a positive integer"),
        "--batch-size",
      );
      index += 1;
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = positiveIntegerOption(
        schedulerValue(args, index, arg, "a positive integer"),
        "--timeout-ms",
      );
      index += 1;
    } else if (arg === "--env-file") {
      options.envFile = schedulerValue(args, index, arg, "a path");
      index += 1;
    } else if (arg === "--launchd-domain") {
      options.launchdDomain = schedulerValue(args, index, arg, "gui or user");
      index += 1;
    } else if (arg === "--dry-run") {
      options.write = false;
    } else if (arg === "--write") {
      options.write = true;
    } else if (arg === "--global") {
      options.global = true;
    } else {
      throw new Error(`Unknown scheduler argument: ${arg}`);
    }
  }

  if (!options.target) throw new Error("--target is required.");
  if (!options.name) throw new Error("--name is required.");
  return options;
}

function parseSchedulerIdentityOptions(args) {
  const options = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--target") {
      options.target = schedulerValue(args, index, arg, "one of: launchd, cron, systemd");
      index += 1;
    } else if (arg === "--name") {
      options.name = schedulerValue(args, index, arg, "a label");
      index += 1;
    } else {
      throw new Error(`Unknown scheduler argument: ${arg}`);
    }
  }

  if (!options.target) throw new Error("--target is required.");
  if (!options.name) throw new Error("--name is required.");
  return options;
}

function parseGlobalInstallOptions(args) {
  const options = {
    mode: "active",
    write: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--mode") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--mode requires a value.");
      options.mode = value;
      index += 1;
    } else if (arg === "--dry-run") {
      options.write = false;
    } else if (arg === "--write") {
      options.write = true;
    } else {
      throw new Error(`Unknown install-codex-global argument: ${arg}`);
    }
  }

  return options;
}

function parseTimestamp(value) {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dailyScheduleWindow(schedule, now) {
  const match = /^daily@([01]\d|2[0-3]):([0-5]\d)$/.exec(schedule);
  if (!match) return null;
  const scheduled = new Date(now);
  scheduled.setHours(Number(match[1]), Number(match[2]), 0, 0);
  const reached = scheduled <= now;
  const nextDue = scheduled > now ? scheduled : new Date(scheduled.getTime() + DAY_MS);
  return { reached, scheduled, nextDue };
}

function telemetryTickDecision({ schedule, lastSentAt, now = new Date() }) {
  const lastSent = parseTimestamp(lastSentAt);
  if (schedule === "hourly") {
    if (!lastSent) return { due: true, next_due_at: now.toISOString() };
    const nextDue = new Date(lastSent.getTime() + HOUR_MS);
    return {
      due: now >= nextDue,
      next_due_at: nextDue.toISOString(),
    };
  }

  const daily = dailyScheduleWindow(schedule, now);
  if (daily) {
    const due = daily.reached && (!lastSent || lastSent < daily.scheduled);
    return {
      due,
      next_due_at: daily.nextDue.toISOString(),
    };
  }

  throw new Error(`Unsupported telemetry schedule: ${schedule}`);
}

function gateCollectionError(error, { gate, command }) {
  const match = /^Context input exceeds (\d+) bytes\.$/.exec(error?.message ?? "");
  if (!match) return error;
  return new Error(gateContextInputTooLargeMessage({
    gate,
    command,
    limitBytes: Number(match[1]),
  }));
}

async function readGateInput(args, { gate, command, ensureAutoContextPack = null } = {}) {
  let filePath = null;
  let contextPackPath = null;
  let autoContextPack = false;
  let smartDiff = false;
  let smartDiffContextPackBootstrapped = false;
  let readFromStdin = false;
  let diff = false;
  let limitBytes = defaultGateInputLimitBytes(gate);
  const textArgs = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--file") {
      const path = args[index + 1];
      if (!path) throw new Error("--file requires a path.");
      filePath = path;
      index += 1;
    } else if (arg === "--context-pack") {
      const path = args[index + 1];
      if (!path || path.startsWith("--")) throw new Error("--context-pack requires a path.");
      contextPackPath = path;
      index += 1;
    } else if (arg === "--auto-context-pack") {
      autoContextPack = true;
    } else if (arg === "--smart-diff") {
      smartDiff = true;
    } else if (arg === "--stdin") {
      readFromStdin = true;
    } else if (arg === "--diff") {
      diff = true;
    } else if (arg === "--max-input-bytes") {
      limitBytes = parseMaxInputBytes(args[index + 1]);
      index += 1;
    } else {
      textArgs.push(arg);
    }
  }

  if (contextPackPath && autoContextPack) {
    throw new Error("--context-pack and --auto-context-pack are mutually exclusive.");
  }

  if (smartDiff && command !== "diff-review") {
    throw new Error("--smart-diff is only supported for diff-review.");
  }

  if (
    smartDiff
    && (contextPackPath || autoContextPack || readFromStdin || diff || filePath || textArgs.join(" ").trim())
  ) {
    throw new Error("--smart-diff cannot be combined with --diff, --stdin, --file, --context-pack, --auto-context-pack, or text input.");
  }

  const shouldReadAutoContextPack = autoContextPack || smartDiff;
  const shouldReadDiff = diff || smartDiff;
  const sections = [];
  const freshInputModes = [];
  if (shouldReadAutoContextPack) {
    try {
      const contextPackInput = await readAutoContextPackFile({
        gate,
        command,
        limitBytes,
        cwd: process.cwd(),
      });
      sections.push(contextPackInput.inputText);
    } catch (error) {
      if (!(smartDiff && /^No context pack found at /.test(error?.message ?? ""))) {
        throw error;
      }
      if (typeof ensureAutoContextPack !== "function") {
        throw new Error(error.message.replace("--auto-context-pack", "--smart-diff"));
      }
      await ensureAutoContextPack();
      const contextPackInput = await readAutoContextPackFile({
        gate,
        command,
        limitBytes,
        cwd: process.cwd(),
      });
      sections.push(contextPackInput.inputText);
      smartDiffContextPackBootstrapped = true;
    }
  }

  if (contextPackPath) {
    const contextPackInput = await readLimitedContextPackFile(contextPackPath, { gate, command, limitBytes });
    sections.push(contextPackInput.inputText);
  }

  if (shouldReadDiff) {
    let collected;
    const stdinText = readFromStdin ? await readStdin() : "";
    const text = textArgs.join(" ");
    try {
      collected = await collectTextInput({
        stdinText: [
          stdinText,
          text,
        ].filter(Boolean).join("\n"),
        files: filePath ? [filePath] : [],
        diff: shouldReadDiff,
        cwd: process.cwd(),
      });
    } catch (error) {
      if (error?.message === "Context input is empty.") {
        collected = null;
      } else {
        throw gateCollectionError(error, { gate, command });
      }
    }
    if (collected?.input?.trim()) {
      sections.push(collected.input.trim());
      const modes = gateFreshInputModes({
        stdinText,
        text,
        filePath,
        sources: collected.sources,
      }).map((mode) => (smartDiff && mode === "diff" ? "smart-diff" : mode));
      freshInputModes.push(...modes);
    }
  } else {
    if (filePath) {
      const input = await readLimitedGateFile(filePath, { gate, command, limitBytes });
      if (input.inputText.trim()) {
        sections.push(input.inputText);
        freshInputModes.push("file");
      }
    } else {
      const stdinText = readFromStdin ? await readStdin() : "";
      const textInput = readFromStdin ? stdinText : textArgs.join(" ").trim();
      const input = limitedGateText(textInput, { gate, command, limitBytes });
      if (input.inputText.trim()) {
        sections.push(input.inputText);
        freshInputModes.push(readFromStdin ? "stdin" : "text");
      }
    }
  }

  const metadata = {
    ...gateTelemetryMetadata({
      autoContextPack: shouldReadAutoContextPack,
      contextPackPath,
      freshInputModes,
    }),
    smart_diff_shortcut: smartDiff,
    smart_diff_context_pack_bootstrapped: smartDiffContextPackBootstrapped,
  };

  if (!sections.length) {
    return { inputText: "", inputBytes: 0, limitBytes, metadata };
  }

  return {
    ...limitedGateText(sections.join("\n\n"), { gate, command, limitBytes }),
    limitBytes,
    metadata,
  };
}

async function parseCommonInputArgs(args) {
  const files = [];
  const textArgs = [];
  let readFromStdin = false;
  let diff = false;
  let bootstrap = false;
  let writeArtifact = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--stdin") {
      readFromStdin = true;
    } else if (arg === "--bootstrap") {
      bootstrap = true;
    } else if (arg === "--file") {
      const path = args[index + 1];
      if (!path) throw new Error("--file requires a path.");
      files.push(path);
      index += 1;
    } else if (arg === "--diff") {
      diff = true;
    } else if (arg === "--write-artifact") {
      writeArtifact = true;
    } else {
      textArgs.push(arg);
    }
  }

  if (bootstrap && (readFromStdin || diff || files.length > 0 || textArgs.join(" ").trim())) {
    throw new Error("--bootstrap cannot be combined with manual context input.");
  }

  const stdinText = [
    readFromStdin ? await readStdin() : "",
    textArgs.join(" "),
  ].filter(Boolean).join("\n");

  return { stdinText, files, diff, bootstrap, writeArtifact };
}

function parseDesignBriefArgs(args) {
  const options = {
    stdin: false,
    files: [],
    writeArtifact: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--stdin") {
      options.stdin = true;
    } else if (arg === "--file") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--file requires a path.");
      options.files.push(value);
      index += 1;
    } else if (arg === "--write-artifact") {
      options.writeArtifact = true;
    } else {
      throw new Error(`Unknown design brief argument: ${arg}`);
    }
  }

  return options;
}

function parseDesignDraftArgs(args) {
  const options = {
    stdin: false,
    files: [],
    text: [],
    references: [],
    targets: [],
    variants: 1,
    quality: "fast",
    targetStack: "html",
    skipGenerate: false,
    skipPerceive: false,
    skipPrototype: false,
    skipHandoff: false,
    json: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--stdin") {
      options.stdin = true;
    } else if (arg === "--file") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--file requires a path.");
      options.files.push(value);
      index += 1;
    } else if (arg === "--reference") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--reference requires a path.");
      options.references.push(value);
      index += 1;
    } else if (arg === "--target") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--target requires a value.");
      validateDesignPerceiveTarget(value);
      options.targets.push(value);
      index += 1;
    } else if (arg === "--variants") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--variants must be between 1 and 4.");
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 4) {
        throw new Error("--variants must be between 1 and 4.");
      }
      options.variants = parsed;
      index += 1;
    } else if (arg === "--quality") {
      const value = args[index + 1];
      if (!value || value.startsWith("--") || !["fast", "pro"].includes(value)) {
        throw new Error("--quality must be fast or pro.");
      }
      options.quality = value;
      index += 1;
    } else if (arg === "--target-stack") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--target-stack must be html, react, tailwind, or auto.");
      }
      options.targetStack = validatePrototypeTargetStack(value);
      index += 1;
    } else if (arg === "--skip-generate") {
      options.skipGenerate = true;
    } else if (arg === "--skip-perceive") {
      options.skipPerceive = true;
    } else if (arg === "--skip-prototype") {
      options.skipPrototype = true;
    } else if (arg === "--skip-handoff") {
      options.skipHandoff = true;
    } else if (arg === "--json") {
      options.json = true;
    } else {
      options.text.push(arg);
    }
  }

  return options;
}

function withDesignDraftContext(inputText, { references = [], targets = [] } = {}) {
  const additions = [];
  if (references.length > 0) {
    additions.push([
      "Reference files:",
      ...references.map((reference) => `- ${reference}`),
    ].join("\n"));
  }
  if (targets.length > 0) {
    additions.push([
      "Targets:",
      ...targets.map((target) => `- ${target}`),
    ].join("\n"));
  }
  if (additions.length === 0) return inputText;
  return `${inputText.trim()}\n\n${additions.join("\n\n")}\n`;
}

function parseDesignGenerateArgs(args) {
  const options = { variants: 1, quality: "fast" };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--run") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--run requires a path.");
      options.run = value;
      index += 1;
    } else if (arg === "--variants") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--variants must be between 1 and 4.");
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 4) {
        throw new Error("--variants must be between 1 and 4.");
      }
      options.variants = parsed;
      index += 1;
    } else if (arg === "--quality") {
      const value = args[index + 1];
      if (!value || value.startsWith("--") || !["fast", "pro"].includes(value)) {
        throw new Error("--quality must be fast or pro.");
      }
      options.quality = value;
      index += 1;
    } else {
      throw new Error(`Unknown design generate argument: ${arg}`);
    }
  }

  if (!options.run) throw new Error("--run requires a path.");
  return options;
}

function parseDesignPrototypeArgs(args) {
  const options = {
    targetStack: "html",
    selectedCandidate: null,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--run") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--run requires a path.");
      options.run = value;
      index += 1;
    } else if (arg === "--candidate") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--candidate requires an id.");
      options.selectedCandidate = value;
      index += 1;
    } else if (arg === "--target-stack") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--target-stack must be html, react, tailwind, or auto.");
      }
      options.targetStack = validatePrototypeTargetStack(value);
      index += 1;
    } else {
      throw new Error(`Unknown design prototype argument: ${arg}`);
    }
  }

  if (!options.run) throw new Error("--run requires a path.");
  validatePrototypeTargetStack(options.targetStack);
  return options;
}

function parseDesignHandoffArgs(args) {
  const options = {
    selectedCandidate: null,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--run") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--run requires a path.");
      options.run = value;
      index += 1;
    } else if (arg === "--candidate") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--candidate requires an id.");
      options.selectedCandidate = value;
      index += 1;
    } else {
      throw new Error(`Unknown design handoff argument: ${arg}`);
    }
  }

  if (!options.run) throw new Error("--run requires a path.");
  return options;
}

function parseDesignLoopArgs(args) {
  const options = {
    targetScreenshot: null,
    actualScreenshot: null,
    maxIterations: 2,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--run") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--run requires a path.");
      options.run = value;
      index += 1;
    } else if (arg === "--target-screenshot") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--target-screenshot requires a path.");
      options.targetScreenshot = value;
      index += 1;
    } else if (arg === "--actual-screenshot") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--actual-screenshot requires a path.");
      options.actualScreenshot = value;
      index += 1;
    } else if (arg === "--max-iterations") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--max-iterations must be an integer between 1 and 3.");
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 3) {
        throw new Error("--max-iterations must be an integer between 1 and 3.");
      }
      options.maxIterations = parsed;
      index += 1;
    } else {
      throw new Error(`Unknown design loop argument: ${arg}`);
    }
  }

  if (!options.run) throw new Error("--run requires a path.");
  return options;
}

function parseDesignDoctorArgs(args) {
  const options = { json: false };
  for (const arg of args) {
    if (arg === "--json") {
      options.json = true;
    } else {
      throw new Error(`Unknown design doctor argument: ${arg}`);
    }
  }
  return options;
}

function validateDesignPerceiveTarget(target) {
  const value = String(target ?? "");
  const separator = value.indexOf(":");
  if (separator < 1) {
    throw new Error(`Target must use "name: description" format: ${value}`);
  }
  const name = value.slice(0, separator).trim();
  const description = value.slice(separator + 1).trim();
  if (!name || !description || !/^[A-Za-z0-9_-]+$/u.test(name)) {
    throw new Error(`Target must use "name: description" format: ${value}`);
  }
}

function parseDesignPerceiveArgs(args) {
  const options = {
    provider: "auto",
    targets: [],
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--run") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--run requires a path.");
      options.run = value;
      index += 1;
    } else if (arg === "--file") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--file requires a path.");
      options.file = value;
      index += 1;
    } else if (arg === "--target") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--target requires a value.");
      validateDesignPerceiveTarget(value);
      options.targets.push(value);
      index += 1;
    } else if (arg === "--provider") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--provider must be auto, palette-mask, gemini-vision, or vision-banana.");
      }
      options.provider = value;
      selectPerceptionProvider({ provider: options.provider, targets: options.targets });
      index += 1;
    } else {
      throw new Error(`Unknown design perceive argument: ${arg}`);
    }
  }

  if (!options.run) throw new Error("--run requires a path.");
  if (!options.file) throw new Error("--file requires a path.");
  selectPerceptionProvider({ provider: options.provider, targets: options.targets });
  return options;
}

function parseContextPackDoctorOptions(args) {
  const options = {
    json: false,
  };
  let sawDoctor = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--doctor") {
      sawDoctor = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--max-age-hours") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--max-age-hours requires a positive integer.");
      options.maxAgeHours = positiveIntegerOption(value, "--max-age-hours");
      index += 1;
    } else {
      throw new Error(`Unknown context-pack doctor argument: ${arg}`);
    }
  }

  if (!sawDoctor) throw new Error("--doctor is required.");
  return options;
}

function parseArtifactArgs(args) {
  const files = [];
  let artifactKind = "image";
  let reviewMode = null;
  let reviewDepth = "standard";
  let telemetryPurpose = "production";
  let writeArtifact = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--file") {
      const path = args[index + 1];
      if (!path || path.startsWith("--")) throw new Error("--file requires a path.");
      files.push(path);
      index += 1;
    } else if (arg === "--kind") {
      const kind = args[index + 1];
      if (!kind || kind.startsWith("--")) throw new Error("--kind requires one of: image, ui, design, architecture, research.");
      if (!ARTIFACT_KINDS.has(kind)) {
        throw new Error("--kind requires one of: image, ui, design, architecture, research.");
      }
      artifactKind = kind;
      index += 1;
    } else if (arg === "--review-mode") {
      const mode = args[index + 1];
      if (!mode || mode.startsWith("--")) throw new Error("--review-mode must be single or comparison.");
      if (!ARTIFACT_REVIEW_MODES.has(mode)) throw new Error("--review-mode must be single or comparison.");
      reviewMode = mode;
      index += 1;
    } else if (arg === "--review-depth") {
      const depth = args[index + 1];
      if (!depth || depth.startsWith("--")) throw new Error("--review-depth must be quick or standard.");
      if (!ARTIFACT_REVIEW_DEPTHS.has(depth)) throw new Error("--review-depth must be quick or standard.");
      reviewDepth = depth;
      index += 1;
    } else if (arg === "--telemetry-purpose") {
      const purpose = args[index + 1];
      if (!purpose || purpose.startsWith("--")) throw new Error("--telemetry-purpose must be production or validation.");
      telemetryPurpose = assertTelemetryPurpose(purpose);
      index += 1;
    } else if (arg === "--write-artifact") {
      writeArtifact = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (files.length === 0) throw new Error("--file requires a path.");
  if (files.length > MAX_ARTIFACT_REVIEW_FILES) {
    throw new Error(`artifact-review supports at most ${MAX_ARTIFACT_REVIEW_FILES} files.`);
  }
  return { file: files[0], files, artifactKind, reviewMode, reviewDepth, telemetryPurpose, writeArtifact };
}

function parseVisualGateArgs(args) {
  const options = {
    targetScreenshot: null,
    actualScreenshot: null,
    kind: "ui",
    riskHints: [],
    smokeOnly: false,
    json: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--target-screenshot") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--target-screenshot requires a path.");
      options.targetScreenshot = value;
      index += 1;
    } else if (arg === "--actual-screenshot") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--actual-screenshot requires a path.");
      options.actualScreenshot = value;
      index += 1;
    } else if (arg === "--kind") {
      const value = args[index + 1];
      if (!value || value.startsWith("--") || !VISUAL_GATE_KINDS.has(value)) {
        throw new Error("--kind requires one of: ui, design, image.");
      }
      options.kind = value;
      index += 1;
    } else if (arg === "--risk") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--risk requires a hint.");
      options.riskHints.push(value);
      index += 1;
    } else if (arg === "--smoke-only") {
      options.smokeOnly = true;
    } else if (arg === "--json") {
      options.json = true;
    } else {
      throw new Error(`Unknown visual gate argument: ${arg}`);
    }
  }
  if (!options.actualScreenshot) throw new Error("--actual-screenshot is required.");
  return options;
}

async function prevalidateArtifactFile(file, cwd = process.cwd()) {
  const resolvedFile = resolveCwdFilePath(file, { cwd });
  let mimeType;
  try {
    mimeType = detectArtifactMime(file);
  } catch (error) {
    if (error.message === "Unsupported artifact type.") {
      throw new Error("Unsupported artifact file type.");
    }
    throw error;
  }

  if (mimeType === "application/pdf") {
    throw new Error("PDF artifact review requires Files API support.");
  }

  await imagePartFromFile(resolvedFile);
}

async function runAuth(args) {
  const sub = args[0];
  if (sub === "status") {
    const result = await resolveApiKey();
    output.write(`${JSON.stringify({ ok: result.ok, source: result.source }, null, 2)}\n`);
    return;
  }
  if (sub === "set") {
    if (!input.isTTY) throw new Error("auth set requires an interactive TTY.");
    const key = await readSecret("Gemini API key: ");
    await saveApiKeyToKeychain(key);
    output.write("Saved GEMINI_API_KEY to macOS Keychain.\n");
    return;
  }
  if (sub === "delete") {
    await deleteApiKeyFromKeychain();
    output.write("Deleted GEMINI_API_KEY from macOS Keychain.\n");
    return;
  }
  throw new Error("Unknown auth command.");
}

async function runGate(command, args) {
  const gate = GATE_COMMANDS.get(command);
  const fakeAllowed = allowFakeResponse(process.env);
  if (process.env.GEMINI_AGENT_FAKE_RESPONSE && !fakeAllowed) {
    throw new Error("GEMINI_AGENT_FAKE_RESPONSE requires GEMINI_AGENT_ALLOW_FAKE_RESPONSE=1.");
  }
  let keyResult = null;
  const resolveGateKey = async () => {
    if (!keyResult) keyResult = await resolveApiKey();
    if (!keyResult.ok) throw new Error("Gemini API key is not configured. Run: gemini-agent auth set");
    return keyResult;
  };
  const ensureAutoContextPack = command === "diff-review" && args.includes("--smart-diff")
    ? async () => {
      const cwd = process.cwd();
      const effectiveCwd = await resolveProjectRootForContextPack({ cwd });
      const collected = await collectBootstrapContext({ cwd: effectiveCwd });
      const key = await resolveGateKey();
      await runContextPack({
        apiKey: key.key,
        cwd: effectiveCwd,
        collected,
        env: process.env,
        allowFakeResponse: fakeAllowed,
        writeArtifact: true,
        telemetry: {
          cwd: effectiveCwd,
          source: "cli",
          command: "context-pack",
          metadata: contextPackTelemetryMetadata({
            bootstrap: true,
            writeArtifact: true,
            collected,
          }),
        },
      });
    }
    : null;
  const { inputText, inputBytes, limitBytes, metadata } = await readGateInput(args, {
    gate,
    command,
    ensureAutoContextPack,
  });
  if (!inputText || !inputText.trim()) throw new Error("Gate input is empty.");
  const preflightMetadata = gateContextPackPreflightMetadata({
    inputBytes,
    contextPackMode: metadata.context_pack_mode,
  });
  const preflightMessage = gateContextPackPreflightMessage({
    gate,
    command,
    inputBytes,
    contextPackMode: metadata.context_pack_mode,
  });
  const shouldCheckExistingContextPack = command === "diff-review"
    && metadata.context_pack_mode === "none"
    && metadata.fresh_input_mode === "diff"
    && preflightMetadata.context_pack_preflight_warning === true;
  const existingContextPackHint = shouldCheckExistingContextPack
    ? await autoContextPackExists({ cwd: process.cwd() })
    : false;
  const smartPreflightMetadata = {
    context_pack_existing_hint: existingContextPackHint,
  };
  const smartPreflightMessage = existingContextPackHint
    ? "diff-review can reuse the existing context pack; current run will continue. Prefer: gemini-agent diff-review --smart-diff"
    : null;
  const emittedPreflightMessage = smartPreflightMessage ?? preflightMessage;
  if (emittedPreflightMessage) errorOutput.write(`${emittedPreflightMessage}\n`);
  const key = await resolveGateKey();
  const policy = await loadProjectPolicy(process.cwd());
  const prompt = buildGatePrompt({ gate, input: inputText, policy });
  const review = await generateReview({
    apiKey: key.key,
    prompt,
    allowFakeResponse: fakeAllowed,
    env: process.env,
    telemetry: {
      cwd: process.cwd(),
      source: "cli",
      command,
      metadata: {
        ...gateInputMetadata({ gate, inputBytes, limitBytes }),
        ...metadata,
        ...preflightMetadata,
        ...smartPreflightMetadata,
      },
    },
  });
  output.write(reviewToPrettyJson(review));
}

async function runContextPackCommand(args) {
  if (args.includes("--doctor")) {
    const options = parseContextPackDoctorOptions(args);
    const result = await runContextPackDoctor({
      cwd: process.cwd(),
      maxAgeHours: options.maxAgeHours,
    });
    output.write(options.json
      ? `${JSON.stringify(result, null, 2)}\n`
      : formatContextPackDoctorText(result));
    return;
  }

  const { stdinText, files, diff, bootstrap, writeArtifact } = await parseCommonInputArgs(args);
  const cwd = process.cwd();
  let effectiveCwd = cwd;
  let collected;
  if (bootstrap) {
    effectiveCwd = await resolveProjectRootForContextPack({ cwd });
    collected = await collectBootstrapContext({ cwd: effectiveCwd });
  } else {
    collected = await collectTextInput({ stdinText, files, diff, cwd });
  }
  const fakeAllowed = allowFakeResponse(process.env);
  if (process.env.GEMINI_AGENT_FAKE_RESPONSE && !fakeAllowed) {
    throw new Error("GEMINI_AGENT_FAKE_RESPONSE requires GEMINI_AGENT_ALLOW_FAKE_RESPONSE=1.");
  }
  const key = await resolveApiKey();
  if (!key.ok) throw new Error("Gemini API key is not configured. Run: gemini-agent auth set");
  const pack = await runContextPack({
    apiKey: key.key,
    cwd: effectiveCwd,
    collected,
    env: process.env,
    allowFakeResponse: fakeAllowed,
    writeArtifact,
    telemetry: {
      cwd: effectiveCwd,
      source: "cli",
      command: "context-pack",
      metadata: contextPackTelemetryMetadata({ bootstrap, writeArtifact, collected }),
    },
  });
  output.write(contextPackToPrettyJson(pack));
}

async function runArtifactReviewCommand(args) {
  const { file, files, artifactKind, reviewMode, reviewDepth, telemetryPurpose, writeArtifact } = parseArtifactArgs(args);
  const cwd = process.cwd();
  for (const source of files) {
    await prevalidateArtifactFile(source, cwd);
  }
  const fakeAllowed = allowFakeResponse(process.env);
  if (process.env.GEMINI_AGENT_FAKE_RESPONSE && !fakeAllowed) {
    throw new Error("GEMINI_AGENT_FAKE_RESPONSE requires GEMINI_AGENT_ALLOW_FAKE_RESPONSE=1.");
  }
  const key = await resolveApiKey();
  if (!key.ok) throw new Error("Gemini API key is not configured. Run: gemini-agent auth set");
  const review = await runArtifactReview({
    apiKey: key.key,
    cwd,
    file,
    files,
    artifactKind,
    reviewMode,
    reviewDepth,
    env: process.env,
    allowFakeResponse: fakeAllowed,
    writeArtifact,
    telemetry: {
      cwd,
      source: "cli",
      command: "artifact-review",
      metadata: { telemetry_purpose: telemetryPurpose },
    },
  });
  output.write(artifactReviewToPrettyJson(review));
}

async function runVisualCommand(args) {
  const [subcommand, ...subArgs] = args;
  if (subcommand !== "gate") throw new Error("Unknown visual command.");
  const options = parseVisualGateArgs(subArgs);
  const cwd = process.cwd();
  const fakeAllowed = allowFakeResponse(process.env);
  if (process.env.GEMINI_AGENT_FAKE_RESPONSE && !fakeAllowed) {
    throw new Error("GEMINI_AGENT_FAKE_RESPONSE requires GEMINI_AGENT_ALLOW_FAKE_RESPONSE=1.");
  }
  if (!options.smokeOnly) {
    const smokeProbe = await runVisualGate({ cwd, ...options, smokeOnly: true, telemetry: null });
    if (smokeProbe.review_posture === "blocked_before_gemini") {
      throw new Error("visual gate blocked before Gemini: capture a readable supported screenshot and retry.");
    }
  }
  let keyResult = null;
  const resolveVisualGateKey = async () => {
    if (!keyResult) keyResult = await resolveApiKey();
    if (!keyResult.ok) throw new Error("Gemini API key is not configured. Run: gemini-agent auth set");
    return keyResult;
  };
  const result = await runVisualGate({
    ...options,
    cwd,
    artifactReview: async (artifactOptions) => {
      const key = await resolveVisualGateKey();
      return runArtifactReview({
        ...artifactOptions,
        apiKey: key.key,
        env: process.env,
        allowFakeResponse: fakeAllowed,
      });
    },
    telemetry: {
      cwd,
      source: "cli",
      command: "visual-gate",
    },
  });
  output.write(visualGateToPrettyJson(result));
}

async function runPaletteSplitCommand(args) {
  const options = parsePaletteSplitArgs(args);
  const key = await resolveApiKey();
  if (!key.ok) throw new Error("Gemini API key is not configured. Run: gemini-agent auth set");
  const result = await runPaletteSplit({
    ...options,
    apiKey: key.key,
    telemetry: { cwd: process.cwd(), source: "cli", command: "palette-split" },
  });
  output.write(`${JSON.stringify({
    output_dir: result.outputDir,
    manifest: "manifest.json",
  }, null, 2)}\n`);
}

async function runDesignCommand(args) {
  const [subcommand, ...subArgs] = args;
  if (subcommand === "doctor") {
    const options = parseDesignDoctorArgs(subArgs);
    const report = await designDoctor({
      env: process.env,
      probe: async () => ({ ok: null, status: "not_probed" }),
    });
    output.write(options.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : `Design doctor: ${report.ok ? "ok" : "caution"}\n`);
    return;
  }

  if (subcommand === "draft") {
    const options = parseDesignDraftArgs(subArgs);
    const stdinText = options.stdin ? await readStdin() : "";
    const textInput = [
      stdinText,
      options.text.join(" "),
    ].filter((text) => text.trim()).join("\n");
    const collected = await collectTextInput({
      stdinText: textInput,
      files: options.files,
      cwd: process.cwd(),
    });
    for (const reference of options.references) {
      await resolveWorkspaceFilePath(reference, { cwd: process.cwd() });
    }
    validateDesignDraftModelPreflight({
      env: process.env,
      quality: options.quality,
      skipGenerate: options.skipGenerate,
    });
    const fakeAllowed = allowFakeResponse(process.env);
    if (process.env.GEMINI_AGENT_FAKE_RESPONSE && !fakeAllowed) {
      throw new Error("GEMINI_AGENT_FAKE_RESPONSE requires GEMINI_AGENT_ALLOW_FAKE_RESPONSE=1.");
    }
    const key = await resolveApiKey();
    if (!key.ok) throw new Error("Gemini API key is not configured. Run: gemini-agent auth set");
    const result = await runDesignDraft({
      cwd: process.cwd(),
      inputText: withDesignDraftContext(collected.input, {
        references: options.references,
        targets: options.targets,
      }),
      apiKey: key.key,
      env: process.env,
      variants: options.variants,
      quality: options.quality,
      targetStack: options.targetStack,
      skipGenerate: options.skipGenerate,
      skipPerceive: options.skipPerceive,
      skipPrototype: options.skipPrototype,
      skipHandoff: options.skipHandoff,
      allowFakeResponse: fakeAllowed,
      telemetry: { cwd: process.cwd(), source: "cli", command: "design-draft" },
    });
    output.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (subcommand === "loop") {
    const options = parseDesignLoopArgs(subArgs);
    const runDir = resolveDesignRun({ cwd: process.cwd(), run: options.run });
    const shouldReviewScreenshots = options.actualScreenshot && options.targetScreenshot;
    const fakeAllowed = allowFakeResponse(process.env);
    if (shouldReviewScreenshots && process.env.GEMINI_AGENT_FAKE_RESPONSE && !fakeAllowed) {
      throw new Error("GEMINI_AGENT_FAKE_RESPONSE requires GEMINI_AGENT_ALLOW_FAKE_RESPONSE=1.");
    }
    let keyResult = null;
    const resolveDesignLoopKey = async () => {
      if (!keyResult) keyResult = await resolveApiKey();
      if (!keyResult.ok) throw new Error("Gemini API key is not configured. Run: gemini-agent auth set");
      return keyResult;
    };
    const result = await runDesignLoop({
      runDir,
      targetScreenshot: options.targetScreenshot,
      actualScreenshot: options.actualScreenshot,
      maxIterations: options.maxIterations,
      visualGate: shouldReviewScreenshots
        ? (gateInput) => runVisualGate({
          ...gateInput,
          artifactReview: async (artifactOptions) => {
            const key = await resolveDesignLoopKey();
            return runArtifactReview({
              ...artifactOptions,
              apiKey: key.key,
              env: process.env,
              allowFakeResponse: fakeAllowed,
            });
          },
        })
        : undefined,
      telemetry: { cwd: process.cwd(), source: "cli", command: "design-loop" },
    });
    const gate = result.review.visual_gate
      && typeof result.review.visual_gate === "object"
      && !Array.isArray(result.review.visual_gate)
      ? result.review.visual_gate
      : null;
    output.write(`${JSON.stringify({
      status: result.review.status,
      loop_review: "loop-review.json",
      path: result.path,
      ...(gate ? {
        visual_gate_verdict: gate.verdict ?? null,
        visual_gate_artifact_review_used: gate.artifact_review?.used === true,
        visual_gate_fallback_used: gate.artifact_review?.fallback_used === true,
      } : {}),
      message: result.message,
    }, null, 2)}\n`);
    return;
  }

  if (subcommand === "perceive") {
    const options = parseDesignPerceiveArgs(subArgs);
    const selectedProvider = selectPerceptionProvider({ provider: options.provider, targets: options.targets });
    if (selectedProvider === "palette-mask" && options.targets.length === 0) {
      throw new Error("palette-mask provider requires at least one --target.");
    }
    const runDir = resolveDesignRun({ cwd: process.cwd(), run: options.run });
    let apiKey;
    if (selectedProvider === "palette-mask") {
      const key = await resolveApiKey();
      if (!key.ok) throw new Error("Gemini API key is not configured. Run: gemini-agent auth set");
      apiKey = key.key;
    }
    const result = await runDesignPerceive({
      runDir,
      file: options.file,
      provider: options.provider,
      targets: options.targets,
      apiKey,
      env: process.env,
      telemetry: { cwd: process.cwd(), source: "cli", command: "design-perceive" },
    });
    output.write(`${JSON.stringify({
      provider: result.provider,
      perception: "perceive/perception.json",
    }, null, 2)}\n`);
    return;
  }

  if (subcommand === "generate") {
    const options = parseDesignGenerateArgs(subArgs);
    const runDir = resolveDesignRun({ cwd: process.cwd(), run: options.run });
    const key = await resolveApiKey();
    if (!key.ok) throw new Error("Gemini API key is not configured. Run: gemini-agent auth set");
    const result = await runDesignGenerate({
      runDir,
      variants: options.variants,
      quality: options.quality,
      apiKey: key.key,
      env: process.env,
      telemetry: { cwd: process.cwd(), source: "cli", command: "design-generate" },
    });
    output.write(`${JSON.stringify({
      candidates: result.manifest.candidates.length,
      manifest: "candidates/manifest.json",
    }, null, 2)}\n`);
    return;
  }

  if (subcommand === "prototype") {
    const options = parseDesignPrototypeArgs(subArgs);
    const runDir = resolveDesignRun({ cwd: process.cwd(), run: options.run });
    const fakeAllowed = allowFakeResponse(process.env);
    if (process.env.GEMINI_AGENT_FAKE_RESPONSE && !fakeAllowed) {
      throw new Error("GEMINI_AGENT_FAKE_RESPONSE requires GEMINI_AGENT_ALLOW_FAKE_RESPONSE=1.");
    }
    const key = await resolveApiKey();
    if (!key.ok) throw new Error("Gemini API key is not configured. Run: gemini-agent auth set");
    const result = await runDesignPrototype({
      runDir,
      apiKey: key.key,
      env: process.env,
      targetStack: options.targetStack,
      selectedCandidate: options.selectedCandidate,
      allowFakeResponse: fakeAllowed,
      telemetry: { cwd: process.cwd(), source: "cli", command: "design-prototype" },
    });
    output.write(`${JSON.stringify({
      prototype: "prototype",
      manifest: "prototype/manifest.json",
      preview_entry: join("prototype", result.manifest.preview_entry),
    }, null, 2)}\n`);
    return;
  }

  if (subcommand === "handoff") {
    const options = parseDesignHandoffArgs(subArgs);
    const runDir = resolveDesignRun({ cwd: process.cwd(), run: options.run });
    const fakeAllowed = allowFakeResponse(process.env);
    if (process.env.GEMINI_AGENT_FAKE_RESPONSE && !fakeAllowed) {
      throw new Error("GEMINI_AGENT_FAKE_RESPONSE requires GEMINI_AGENT_ALLOW_FAKE_RESPONSE=1.");
    }
    const key = await resolveApiKey();
    if (!key.ok) throw new Error("Gemini API key is not configured. Run: gemini-agent auth set");
    await runDesignHandoff({
      runDir,
      apiKey: key.key,
      env: process.env,
      selectedCandidate: options.selectedCandidate,
      allowFakeResponse: fakeAllowed,
      telemetry: { cwd: process.cwd(), source: "cli", command: "design-handoff" },
    });
    output.write(`${JSON.stringify({
      handoff: "handoff.json",
      tasks: "codex-tasks.md",
    }, null, 2)}\n`);
    return;
  }

  if (subcommand !== "brief") throw new Error("Unknown design command.");

  const options = parseDesignBriefArgs(subArgs);
  const stdinText = options.stdin ? await readStdin() : "";
  const collected = await collectTextInput({
    stdinText,
    files: options.files,
    cwd: process.cwd(),
  });
  const fakeAllowed = allowFakeResponse(process.env);
  if (process.env.GEMINI_AGENT_FAKE_RESPONSE && !fakeAllowed) {
    throw new Error("GEMINI_AGENT_FAKE_RESPONSE requires GEMINI_AGENT_ALLOW_FAKE_RESPONSE=1.");
  }
  const key = await resolveApiKey();
  if (!key.ok) throw new Error("Gemini API key is not configured. Run: gemini-agent auth set");
  const result = await runDesignBrief({
    cwd: process.cwd(),
    inputText: collected.input,
    apiKey: key.key,
    env: process.env,
    allowFakeResponse: fakeAllowed,
    telemetry: {
      cwd: process.cwd(),
      source: "cli",
      command: "design-brief",
      metadata: { write_artifact: options.writeArtifact },
    },
  });
  output.write(`${JSON.stringify({
    run_id: result.run.runId,
    run_dir: result.run.dir,
    brief: "brief.json",
    design: "DESIGN.md",
  }, null, 2)}\n`);
}

async function requireEnabledTelemetryContextForOptions(options) {
  const context = await loadTelemetryConfigContext({
    cwd: process.cwd(),
    scope: telemetryScope(options),
  });
  const config = context.config;
  if (!config?.enabled) throw new Error("Telemetry is not enabled.");
  if (config.level !== "raw") throw new Error("Only raw telemetry is supported.");
  return context;
}

async function requireEnabledTelemetryContext(subcommand, args = []) {
  const options = parseTelemetryScopeOnlyOptions(subcommand, args);
  return requireEnabledTelemetryContextForOptions(options);
}

function resolveTelemetryDryRunHome(home = process.env.HOME) {
  const resolved = home ?? homedir();
  if (typeof resolved !== "string" || !resolved.trim()) {
    throw new Error("Telemetry global scope requires a home directory.");
  }
  return resolved;
}

async function readTelemetryDryRunConfig(cwd) {
  const path = join(cwd, TELEMETRY_CONFIG_PATH);
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Telemetry config is not valid JSON: ${path}`);
    }
    throw error;
  }
}

async function loadTelemetryDryRunContext(options) {
  const requestedScope = telemetryScope(options);
  if (requestedScope === "local") {
    return {
      scope: "local",
      storageCwd: process.cwd(),
      config: await readTelemetryDryRunConfig(process.cwd()),
    };
  }
  if (requestedScope === "global") {
    const storageCwd = resolveTelemetryDryRunHome();
    return {
      scope: "global",
      storageCwd,
      config: await readTelemetryDryRunConfig(storageCwd),
    };
  }

  const localConfig = await readTelemetryDryRunConfig(process.cwd());
  if (localConfig?.enabled) {
    return { scope: "local", storageCwd: process.cwd(), config: localConfig };
  }

  const globalCwd = resolveTelemetryDryRunHome();
  const globalConfig = await readTelemetryDryRunConfig(globalCwd);
  if (globalConfig?.enabled || (!localConfig && globalConfig)) {
    return { scope: "global", storageCwd: globalCwd, config: globalConfig };
  }

  return { scope: "local", storageCwd: process.cwd(), config: localConfig };
}

async function requireTelemetryDryRunContext(options) {
  const context = await loadTelemetryDryRunContext(options);
  const config = context.config;
  if (!config?.enabled) throw new Error("Telemetry is not enabled.");
  if (config.level !== "raw") throw new Error("Only raw telemetry is supported.");
  return context;
}

async function loadTelemetryFailedContext(options) {
  if (options.global) {
    return loadTelemetryDryRunContext(options);
  }
  return {
    scope: "local",
    storageCwd: process.cwd(),
    config: await readTelemetryDryRunConfig(process.cwd()),
  };
}

async function runTelemetryFlush(args = []) {
  const options = parseTelemetryFlushOptions(args);
  if (options.dryRun) {
    const context = await requireTelemetryDryRunContext(options);
    const result = await flushTelemetryQueue({
      cwd: context.storageCwd,
      batchSize: options.batchSize,
      dryRun: true,
      maxBytes: options.maxBytes,
      timeoutMs: options.timeoutMs,
    });
    output.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  const context = await requireEnabledTelemetryContextForOptions(options);
  const config = context.config;
  const token = resolveTelemetryToken({ tokenEnv: config.token_env, env: process.env });
  const result = await flushTelemetryQueue({
    cwd: context.storageCwd,
    endpoint: config.endpoint,
    token,
    batchSize: options.batchSize,
    dryRun: options.dryRun,
    maxBytes: options.maxBytes,
    timeoutMs: options.timeoutMs,
  });
  output.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function runTelemetryRetryFailed(args = []) {
  const options = parseTelemetryRetryFailedOptions(args);
  const context = options.dryRun
    ? await requireTelemetryDryRunContext(options)
    : await requireEnabledTelemetryContextForOptions(options);

  if (!options.dryRun) {
    resolveTelemetryToken({
      tokenEnv: context.config.token_env,
      env: process.env,
    });
  }

  const result = await retryFailedTelemetryEvents({
    cwd: context.storageCwd,
    reason: options.reason,
    batchSize: options.batchSize,
    dryRun: options.dryRun,
  });
  output.write(`${JSON.stringify({
    scope: context.scope,
    storage_cwd: context.storageCwd,
    ...result,
  }, null, 2)}\n`);
}

async function runTelemetryFailed(args = []) {
  const [subcommand, ...subArgs] = args;
  if (subcommand === "inspect") {
    const options = parseTelemetryFailedInspectOptions(subArgs);
    const context = await loadTelemetryFailedContext(options);
    const result = await inspectFailedTelemetryEvents({
      cwd: context.storageCwd,
      reason: options.reason,
      limit: options.limit,
    });
    output.write(`${JSON.stringify({
      scope: context.scope,
      storage_cwd: context.storageCwd,
      ...result,
    }, null, 2)}\n`);
    return;
  }

  if (subcommand === "archive") {
    const options = parseTelemetryFailedArchiveOptions(subArgs);
    const context = await loadTelemetryFailedContext(options);
    const result = await archiveFailedTelemetryEvents({
      cwd: context.storageCwd,
      reason: options.reason,
      batchSize: options.batchSize,
      dryRun: options.dryRun,
      note: options.note,
    });
    output.write(`${JSON.stringify({
      scope: context.scope,
      storage_cwd: context.storageCwd,
      ...result,
    }, null, 2)}\n`);
    return;
  }

  throw new Error("telemetry failed requires inspect or archive.");
}

async function runTelemetryDoctorCommand(args = []) {
  const options = parseTelemetryDoctorOptions(args);
  const result = await runTelemetryDoctor({
    cwd: process.cwd(),
    home: process.env.HOME,
    scope: telemetryScope(options),
    env: process.env,
  });
  output.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function runTelemetrySummaryCommand(args = []) {
  const options = parseTelemetrySummaryOptions(args);
  const summary = await runTelemetrySummary({
    cwd: process.cwd(),
    home: process.env.HOME,
    scope: telemetryScope(options),
  });
  if (options.json) {
    output.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  output.write(formatTelemetrySummaryText(summary));
}

async function runTelemetryRaw(args = []) {
  const [subcommand, ...subArgs] = args;
  if (subcommand === "inventory") {
    const options = parseTelemetryRawInventoryOptions(subArgs);
    const report = await runTelemetryRawInventory({
      cwd: process.cwd(),
      home: process.env.HOME,
      scope: telemetryScope(options),
    });
    if (options.json) {
      output.write(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }
    output.write(formatTelemetryRawInventoryText(report));
    return;
  }

  if (subcommand === "preflight") {
    const options = parseTelemetryRawPreflightOptions(subArgs);
    const report = await runTelemetryRawPreflight({
      cwd: process.cwd(),
      home: process.env.HOME,
      scope: telemetryScope(options),
      batchSize: options.batchSize,
      maxBytes: options.maxBytes,
      now: options.now,
    });
    if (options.json) {
      output.write(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }
    output.write(formatTelemetryRawPreflightText(report));
    return;
  }

  if (subcommand === "export") {
    const options = parseTelemetryRawExportOptions(subArgs);
    const report = await runTelemetryRawExport({
      cwd: process.cwd(),
      home: process.env.HOME,
      scope: telemetryScope(options),
      state: options.state,
      output: options.output,
      limit: options.limit,
      confirmRawContent: options.confirmRawContent,
      format: options.format,
    });
    if (options.json) {
      output.write(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }
    output.write(formatTelemetryRawExportText(report));
    return;
  }

  if (subcommand === "reveal") {
    const options = parseTelemetryRawRevealOptions(subArgs);
    const report = await runTelemetryRawReveal({
      cwd: process.cwd(),
      home: process.env.HOME,
      scope: telemetryScope(options),
      state: options.state,
      limit: options.limit,
      confirmRawContent: options.confirmRawContent,
    });
    if (options.json) {
      output.write(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }
    output.write(formatTelemetryRawRevealText(report));
    return;
  }

  if (subcommand === "delete") {
    const options = parseTelemetryRawDeleteOptions(subArgs);
    const report = await runTelemetryRawDelete({
      cwd: process.cwd(),
      home: process.env.HOME,
      scope: telemetryScope(options),
      state: options.state,
      eventId: options.eventId,
      confirmRawContent: options.confirmRawContent,
      dryRun: options.dryRun,
    });
    if (options.json) {
      output.write(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }
    output.write(formatTelemetryRawDeleteText(report));
    return;
  }

  if (subcommand === "prune") {
    const options = parseTelemetryRawPruneOptions(subArgs);
    const report = await runTelemetryRawPrune({
      cwd: process.cwd(),
      home: process.env.HOME,
      scope: telemetryScope(options),
      state: options.state,
      keepDays: options.keepDays,
      maxSentBytes: options.maxSentBytes,
      dryRun: options.dryRun,
      now: options.now,
    });
    if (options.json) {
      output.write(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }
    output.write(formatTelemetryRawPruneText(report));
    return;
  }

  throw new Error("telemetry raw requires inventory, preflight, export, reveal, delete, or prune.");
}

async function runTelemetryEconomicsCommand(args = []) {
  const options = parseTelemetryEconomicsOptions(args);
  const report = await runTelemetryEconomics({
    cwd: process.cwd(),
    home: process.env.HOME,
    scope: telemetryScope(options),
    topLimit: options.topLimit,
    inputPricePerMillion: options.inputPricePerMillion,
    outputPricePerMillion: options.outputPricePerMillion,
  });
  if (options.json) {
    output.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  output.write(formatTelemetryEconomicsText(report));
}

async function runTelemetryPrioritiesCommand(args = []) {
  const options = parseTelemetryPrioritiesOptions(args);
  const report = await runTelemetryPriorities({
    cwd: process.cwd(),
    home: process.env.HOME,
    scope: telemetryScope(options),
    topLimit: options.topLimit,
    inputPricePerMillion: options.inputPricePerMillion,
    outputPricePerMillion: options.outputPricePerMillion,
  });
  if (options.json) {
    output.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  output.write(formatTelemetryPrioritiesText(report));
}

async function runTelemetryReportCommand(args = []) {
  const options = parseTelemetryReportOptions(args);
  const report = await runTelemetryReport({
    cwd: process.cwd(),
    home: process.env.HOME,
    scope: telemetryScope(options),
    topLimit: options.topLimit,
    inputPricePerMillion: options.inputPricePerMillion,
    outputPricePerMillion: options.outputPricePerMillion,
  });
  if (options.json) {
    output.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  output.write(formatTelemetryReportText(report));
}

async function runTelemetryArtifactReviewQualityGateCommand(args = []) {
  const options = parseTelemetryArtifactReviewQualityGateOptions(args);
  const gate = await runArtifactReviewQualityGate({
    cwd: process.cwd(),
    home: process.env.HOME,
    scope: telemetryScope(options),
    topLimit: options.topLimit,
  });
  if (options.json) {
    output.write(`${JSON.stringify(gate, null, 2)}\n`);
    return;
  }
  output.write(`${artifactReviewQualityGateToText(gate)}\n`);
}

async function runTelemetryArtifactReviewCoveragePlanCommand(args = []) {
  const options = parseTelemetryArtifactReviewCoveragePlanOptions(args);
  const report = await runArtifactReviewCoveragePlan({
    cwd: process.cwd(),
    home: process.env.HOME,
    scope: telemetryScope(options),
    topLimit: options.topLimit,
  });
  if (options.json) {
    output.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  output.write(`${artifactReviewCoveragePlanToText(report)}\n`);
}

async function runTelemetryArtifactReviewReadinessPlanCommand(args = []) {
  const options = parseTelemetryArtifactReviewReadinessPlanOptions(args);
  const report = await runArtifactReviewReadinessPlan({
    cwd: process.cwd(),
    scope: options.global ? "global" : "auto",
    topLimit: options.topLimit,
  });
  if (options.json) {
    output.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  output.write(`${artifactReviewReadinessPlanToText(report)}\n`);
}

async function runTelemetryMultimodal(args = []) {
  const [subcommand, ...subArgs] = args;
  if (subcommand === "repair-kind") {
    const options = parseTelemetryMultimodalRepairKindOptions(subArgs);
    const report = await runTelemetryMultimodalRepairKind({
      cwd: process.cwd(),
      home: process.env.HOME,
      scope: telemetryScope(options),
      correctionVersion: options.correctionVersion,
      dryRun: options.dryRun,
      limit: options.limit,
    });
    if (options.json) {
      output.write(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }
    output.write(formatTelemetryMultimodalRepairText(report));
    return;
  }
  if (subcommand === "repair-metadata") {
    const options = parseTelemetryMultimodalRepairMetadataOptions(subArgs);
    const report = await runTelemetryMultimodalRepairMetadata({
      cwd: process.cwd(),
      home: process.env.HOME,
      scope: telemetryScope(options),
      correctionVersion: options.correctionVersion,
      dryRun: options.dryRun,
      limit: options.limit,
    });
    if (options.json) {
      output.write(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }
    output.write(formatTelemetryMultimodalRepairMetadataText(report));
    return;
  }

  throw new Error("telemetry multimodal requires repair-kind or repair-metadata.");
}

async function runTelemetryQuarantine(args = []) {
  const [subcommand, ...subArgs] = args;
  if (subcommand === "inspect") {
    const options = parseTelemetryQuarantineInspectOptions(subArgs);
    const context = await loadTelemetryFailedContext(options);
    const result = await inspectQuarantinedTelemetryEvents({
      cwd: context.storageCwd,
      reason: options.reason,
      limit: options.limit,
    });
    output.write(`${JSON.stringify({
      scope: context.scope,
      storage_cwd: context.storageCwd,
      ...result,
    }, null, 2)}\n`);
    return;
  }

  if (subcommand === "archive") {
    const options = parseTelemetryQuarantineArchiveOptions(subArgs);
    const context = await loadTelemetryFailedContext(options);
    const result = await archiveQuarantinedTelemetryEvents({
      cwd: context.storageCwd,
      reason: options.reason,
      batchSize: options.batchSize,
      dryRun: options.dryRun,
      note: options.note,
    });
    output.write(`${JSON.stringify({
      scope: context.scope,
      storage_cwd: context.storageCwd,
      ...result,
    }, null, 2)}\n`);
    return;
  }

  if (subcommand === "retry") {
    const options = parseTelemetryQuarantineRetryOptions(subArgs);
    const context = await loadTelemetryFailedContext(options);
    const result = await retryQuarantinedTelemetryEvents({
      cwd: context.storageCwd,
      reason: options.reason,
      batchSize: options.batchSize,
      dryRun: options.dryRun,
    });
    output.write(`${JSON.stringify({
      scope: context.scope,
      storage_cwd: context.storageCwd,
      ...result,
    }, null, 2)}\n`);
    return;
  }

  const options = parseTelemetryQuarantineOptions(args);
  const context = await requireEnabledTelemetryContextForOptions(options);
  const result = await quarantineTelemetryEvent({
    cwd: context.storageCwd,
    eventId: options.eventId,
    reason: options.reason,
  });
  output.write(`${JSON.stringify({
    scope: context.scope,
    storage_cwd: context.storageCwd,
    ...result,
  }, null, 2)}\n`);
}

async function runTelemetryTick(args = []) {
  const options = parseTelemetryTickOptions(args);
  const context = await requireEnabledTelemetryContextForOptions(options);
  const config = context.config;
  const state = await loadTelemetryState({ cwd: context.storageCwd });
  const decision = telemetryTickDecision({
    schedule: config.schedule,
    lastSentAt: state.last_sent_at,
  });
  if (!decision.due) {
    output.write(`${JSON.stringify({
      ok: true,
      skipped: true,
      reason: "schedule_not_due",
      schedule: config.schedule,
      next_due_at: decision.next_due_at,
    }, null, 2)}\n`);
    return;
  }
  const flushArgs = [
    options.global ? "--global" : "",
    options.batchSize ? "--batch-size" : "",
    options.batchSize ? String(options.batchSize) : "",
    options.timeoutMs ? "--timeout-ms" : "",
    options.timeoutMs ? String(options.timeoutMs) : "",
  ].filter(Boolean);
  await runTelemetryFlush(flushArgs);
}

async function askGeminiForTelemetryValidation(prompt) {
  if (process.env.GEMINI_AGENT_ALLOW_FAKE_RESPONSE === "1" && process.env.GEMINI_AGENT_FAKE_RESPONSE) {
    return process.env.GEMINI_AGENT_FAKE_RESPONSE;
  }
  if (process.env.GEMINI_AGENT_FAKE_RESPONSE && process.env.GEMINI_AGENT_ALLOW_FAKE_RESPONSE !== "1") {
    throw new Error("GEMINI_AGENT_FAKE_RESPONSE requires GEMINI_AGENT_ALLOW_FAKE_RESPONSE=1.");
  }
  const key = await resolveApiKey();
  if (!key.ok) throw new Error("Gemini API key is not configured. Run: gemini-agent auth set");
  return generateText({ apiKey: key.key, prompt });
}

async function runTelemetryValidate(args) {
  const options = parseTelemetryOptions(args);
  assertRawConfirmation(options.confirmRawContent);
  if (options.level && options.level !== "raw") throw new Error("Only raw telemetry is supported.");

  const context = await loadTelemetryConfigContext({
    cwd: process.cwd(),
    scope: telemetryScope(options),
  });
  const config = context.config;
  const enabledConfig = config?.enabled ? config : null;
  const endpoint = options.endpoint ?? enabledConfig?.endpoint ?? DEFAULT_TELEMETRY_ENDPOINT;
  const tokenEnv = options.tokenEnv ?? enabledConfig?.token_env ?? DEFAULT_TELEMETRY_TOKEN_ENV;
  const deploymentId = options.deploymentId ?? enabledConfig?.deployment_id;
  const token = resolveTelemetryToken({ tokenEnv, env: process.env });
  const result = await runTelemetryValidation({
    cwd: context.storageCwd,
    endpoint,
    token,
    deploymentId,
    askGemini: askGeminiForTelemetryValidation,
  });
  output.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function runTelemetry(args) {
  const [subcommand, ...subArgs] = args;

  if (subcommand === "enable") {
    const options = parseTelemetryOptions(subArgs);
    if (options.level !== "raw") throw new Error("Only raw telemetry is supported.");
    if (!options.endpoint) throw new Error("--endpoint requires a URL.");
    if (!options.tokenEnv) throw new Error("--token-env requires an environment variable name.");
    assertRawConfirmation(options.confirmRawContent);
    const config = await saveTelemetryConfig({
      cwd: process.cwd(),
      scope: telemetryScope(options, "local"),
      endpoint: options.endpoint,
      tokenEnv: options.tokenEnv,
      deploymentId: options.deploymentId,
      userLabel: options.clearUserLabel ? null : options.userLabel,
      schedule: options.schedule,
    });
    output.write(`${rawTelemetryWarning()}\n`);
    output.write(`Telemetry enabled: ${config.level} -> ${config.endpoint}\n`);
    return;
  }

  if (subcommand === "status") {
    const options = parseTelemetryScopeOnlyOptions(subcommand, subArgs);
    const context = await loadTelemetryConfigContext({
      cwd: process.cwd(),
      scope: telemetryScope(options),
    });
    const queue = await loadTelemetryState({ cwd: context.storageCwd });
    output.write(`${JSON.stringify({
      scope: context.scope,
      storage_cwd: context.storageCwd,
      config: context.config ?? { enabled: false },
      queue,
    }, null, 2)}\n`);
    return;
  }

  if (subcommand === "preview") {
    const options = parseTelemetryScopeOnlyOptions(subcommand, subArgs);
    const context = await loadTelemetryConfigContext({
      cwd: process.cwd(),
      scope: telemetryScope(options),
    });
    const queue = await loadTelemetryState({ cwd: context.storageCwd });
    output.write(`${JSON.stringify({
      scope: context.scope,
      storage_cwd: context.storageCwd,
      queue,
    }, null, 2)}\n`);
    return;
  }

  if (subcommand === "summary") {
    await runTelemetrySummaryCommand(subArgs);
    return;
  }

  if (subcommand === "raw") {
    await runTelemetryRaw(subArgs);
    return;
  }

  if (subcommand === "economics") {
    await runTelemetryEconomicsCommand(subArgs);
    return;
  }

  if (subcommand === "priorities") {
    await runTelemetryPrioritiesCommand(subArgs);
    return;
  }

  if (subcommand === "report") {
    await runTelemetryReportCommand(subArgs);
    return;
  }

  if (subcommand === "artifact-review" && subArgs[0] === "coverage-plan") {
    await runTelemetryArtifactReviewCoveragePlanCommand(subArgs.slice(1));
    return;
  }

  if (subcommand === "artifact-review" && subArgs[0] === "readiness-plan") {
    await runTelemetryArtifactReviewReadinessPlanCommand(subArgs.slice(1));
    return;
  }

  if (subcommand === "artifact-review" && subArgs[0] === "quality-gate") {
    await runTelemetryArtifactReviewQualityGateCommand(subArgs.slice(1));
    return;
  }

  if (subcommand === "multimodal") {
    await runTelemetryMultimodal(subArgs);
    return;
  }

  if (subcommand === "doctor") {
    await runTelemetryDoctorCommand(subArgs);
    return;
  }

  if (subcommand === "flush") {
    await runTelemetryFlush(subArgs);
    return;
  }

  if (subcommand === "retry-failed") {
    await runTelemetryRetryFailed(subArgs);
    return;
  }

  if (subcommand === "failed") {
    await runTelemetryFailed(subArgs);
    return;
  }

  if (subcommand === "quarantine") {
    await runTelemetryQuarantine(subArgs);
    return;
  }

  if (subcommand === "tick") {
    await runTelemetryTick(subArgs);
    return;
  }

  if (subcommand === "validate") {
    await runTelemetryValidate(subArgs);
    return;
  }

  if (subcommand === "backfill-artifacts") {
    const options = parseBackfillArtifactOptions(subArgs);
    const batch = await artifactReviewsToRawTelemetryBatch({
      artifactsDir: options.artifactsDir,
      deploymentId: options.deploymentId,
      agentVersion: packageJson.version,
      batchId: options.batchId,
      generatedAt: options.generatedAt,
      maxFiles: options.maxFiles,
      maxArtifactBytes: options.maxArtifactBytes,
      correctionVersion: options.correctionVersion,
    });
    if (options.queue) {
      const context = await loadTelemetryConfigContext({
        cwd: process.cwd(),
        scope: telemetryScope(options),
      });
      const config = context.config;
      if (!config?.enabled) throw new Error("Telemetry is not enabled.");
      if (config.level !== "raw") throw new Error("Only raw telemetry is supported.");
      const legacyBatch = normalizeTelemetryBatch(batch);
      const { queued, skipped } = await appendTelemetryEventsIfNew({
        cwd: context.storageCwd,
        events: legacyBatch.events,
        maxQueueBytes: config.max_queue_bytes,
      });
      output.write(`${JSON.stringify({
        ok: true,
        queued: true,
        scope: context.scope,
        storage_cwd: context.storageCwd,
        batch_id: batch.batch_id,
        queued_count: queued.length,
        skipped_count: skipped.length,
        event_ids: queued.map((event) => event.event_id),
        skipped_event_ids: skipped.map((event) => event.event_id),
      }, null, 2)}\n`);
      return;
    }
    output.write(`${JSON.stringify(batch, null, 2)}\n`);
    return;
  }

  if (subcommand === "install-scheduler") {
    const options = parseSchedulerInstallOptions(subArgs);
    const result = await installScheduler({
      ...options,
      cwd: process.cwd(),
      bin: process.argv[1],
      home: process.env.HOME,
    });
    output.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (subcommand === "scheduler-status") {
    const options = parseSchedulerIdentityOptions(subArgs);
    const result = await schedulerStatus({
      ...options,
      cwd: process.cwd(),
      home: process.env.HOME,
    });
    output.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (subcommand === "uninstall-scheduler") {
    const options = parseSchedulerIdentityOptions(subArgs);
    const result = await uninstallScheduler({
      ...options,
      cwd: process.cwd(),
      home: process.env.HOME,
    });
    output.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (subcommand === "disable") {
    const options = parseTelemetryScopeOnlyOptions(subcommand, subArgs);
    const config = await disableTelemetryConfig({
      cwd: process.cwd(),
      scope: telemetryScope(options, "local"),
    });
    output.write(`${JSON.stringify({ config }, null, 2)}\n`);
    return;
  }

  if (subcommand === "purge") {
    const options = parseTelemetryScopeOnlyOptions(subcommand, subArgs);
    const context = await loadTelemetryConfigContext({
      cwd: process.cwd(),
      scope: telemetryScope(options),
    });
    const result = await purgeTelemetryData({ cwd: context.storageCwd });
    output.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  throw new Error("Unknown telemetry command.");
}

async function runCodexGlobalInstall(args) {
  const options = parseGlobalInstallOptions(args);
  const result = await applyCodexGlobalInstall({
    home: process.env.HOME,
    mode: options.mode,
    write: options.write,
  });
  output.write(`${JSON.stringify({
    changed: result.changed,
    targetPath: result.targetPath,
    backupPath: result.backupPath,
    dry_run: !options.write,
  }, null, 2)}\n`);
}

async function main(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  if (!command || command === "--help" || command === "-h") {
    printUsage();
    return;
  }
  if (command === "--help-all") {
    printFullUsage();
    return;
  }
  if (printFocusedHelp(argv)) {
    return;
  }
  if (command === "auth") {
    await runAuth(args);
    return;
  }
  if (command === "telemetry") {
    await runTelemetry(args);
    return;
  }
  if (command === "install-codex-global") {
    await runCodexGlobalInstall(args);
    return;
  }
  if (command === "ask") {
    const prompt = args.join(" ").trim();
    if (!prompt) throw new Error("Prompt is empty.");
    const key = await resolveApiKey();
    if (!key.ok) throw new Error("Gemini API key is not configured. Run: gemini-agent auth set");
    const text = await generateText({
      apiKey: key.key,
      prompt,
      telemetry: { cwd: process.cwd(), source: "cli", command: "ask" },
    });
    output.write(`${text}\n`);
    return;
  }
  if (command === "context-pack") {
    await runContextPackCommand(args);
    return;
  }
  if (command === "artifact-review") {
    await runArtifactReviewCommand(args);
    return;
  }
  if (command === "visual") {
    await runVisualCommand(args);
    return;
  }
  if (command === "palette-split") {
    await runPaletteSplitCommand(args);
    return;
  }
  if (command === "design") {
    await runDesignCommand(args);
    return;
  }
  if (GATE_COMMANDS.has(command)) {
    await runGate(command, args);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

async function runCli() {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = error.exitCode ?? 1;
  } finally {
    try {
      await drainTelemetryCapture({ timeoutMs: 2000 });
    } catch {
      // Telemetry drain failures must not affect command outcomes.
    }
  }
}

runCli();
