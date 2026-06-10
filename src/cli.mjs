import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { runArtifactReview } from "./artifact-review.mjs";
import { applyCodexGlobalInstall } from "./codex-global-install.mjs";
import { runContextPack } from "./context-pack.mjs";
import { deleteApiKeyFromKeychain, resolveApiKey, saveApiKeyToKeychain } from "./keychain.mjs";
import { generateReview, generateText } from "./gemini-client.mjs";
import {
  collectTextInput,
  detectArtifactMime,
  imagePartFromFile,
  resolveCwdFilePath,
} from "./input-collector.mjs";
import { loadProjectPolicy } from "./policies.mjs";
import { parsePaletteSplitArgs, runPaletteSplit } from "./palette-mask.mjs";
import { buildGatePrompt } from "./prompts.mjs";
import { artifactReviewToPrettyJson, contextPackToPrettyJson, reviewToPrettyJson } from "./schemas.mjs";
import { drainTelemetryCapture } from "./telemetry-capture.mjs";
import { artifactReviewsToRawTelemetryBatch } from "./telemetry-backfill.mjs";
import { normalizeTelemetryBatch } from "./telemetry-schemas.mjs";
import { runTelemetryDoctor } from "./telemetry-doctor.mjs";
import {
  formatTelemetryEconomicsText,
  runTelemetryEconomics,
} from "./telemetry-economics.mjs";
import {
  formatTelemetrySummaryText,
  runTelemetrySummary,
} from "./telemetry-summary.mjs";
import {
  formatTelemetryRawInventoryText,
  runTelemetryRawInventory,
} from "./telemetry-raw-inventory.mjs";
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
  inspectFailedTelemetryEvents,
  loadTelemetryState,
  purgeTelemetryData,
  quarantineTelemetryEvent,
  retryFailedTelemetryEvents,
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
    "Usage:",
    "  gemini-agent auth status",
    "  gemini-agent auth set",
    "  gemini-agent auth delete",
    "  gemini-agent ask <prompt>",
    "  gemini-agent context-pack [--stdin] [--file <path> ...] [--diff] [--write-artifact] [text]",
    "  gemini-agent artifact-review --file <path> [--file <path> ...] [--kind image|ui|design|architecture|research] [--review-mode single|comparison] [--write-artifact]",
    "  gemini-agent palette-split <image.png> --target <name: description> [--target <name: description> ...] --output <dir> [--tolerance <n>]",
    "  gemini-agent plan-critique (--file <path> | --stdin | <text>)",
    "  gemini-agent patch-precheck (--file <path> | --stdin | <text>)",
    "  gemini-agent diff-review (--file <path> | --stdin | <text>)",
    "  gemini-agent research-brief (--file <path> | --stdin | <text>)",
    "  gemini-agent install-codex-global --mode active [--dry-run|--write]",
    "  gemini-agent telemetry enable [--global] --level raw --endpoint <url> --token-env <env> --confirm-raw-content [--deployment-id <id>] [--user-label <label>|--clear-user-label] [--schedule <schedule>]",
    "  gemini-agent telemetry status [--global]",
    "  gemini-agent telemetry preview [--global]",
    "  gemini-agent telemetry summary [--global] [--json]",
    "  gemini-agent telemetry raw inventory [--global] [--json]",
    "  gemini-agent telemetry economics [--global] [--json] [--top <n>] [--input-price-per-million <usd>] [--output-price-per-million <usd>]",
    "  gemini-agent telemetry doctor [--global] [--json]",
    "  gemini-agent telemetry flush [--global] [--dry-run] [--batch-size <n>] [--max-bytes <n>] [--timeout-ms <n>]",
    "  gemini-agent telemetry retry-failed [--global] --reason <reason> [--dry-run|--write] [--batch-size <n>]",
    "  gemini-agent telemetry failed inspect [--global] [--reason <reason>] [--limit <n>] [--json]",
    "  gemini-agent telemetry failed archive [--global] --reason <reason> [--dry-run|--write] [--batch-size <n>] [--note <text>]",
    "  gemini-agent telemetry quarantine [--global] --event-id <id> --reason <reason>",
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

async function readGateInput(args) {
  const fileIndex = args.indexOf("--file");
  if (fileIndex !== -1) {
    const path = args[fileIndex + 1];
    if (!path) throw new Error("--file requires a path.");
    return readFile(path, "utf8");
  }
  if (args.includes("--stdin")) return readStdin();
  return args.join(" ").trim();
}

async function parseCommonInputArgs(args) {
  const files = [];
  const textArgs = [];
  let readFromStdin = false;
  let diff = false;
  let writeArtifact = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--stdin") {
      readFromStdin = true;
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

  const stdinText = [
    readFromStdin ? await readStdin() : "",
    textArgs.join(" "),
  ].filter(Boolean).join("\n");

  return { stdinText, files, diff, writeArtifact };
}

function parseArtifactArgs(args) {
  const files = [];
  let artifactKind = "image";
  let reviewMode = null;
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
  return { file: files[0], files, artifactKind, reviewMode, writeArtifact };
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
  const inputText = await readGateInput(args);
  if (!inputText || !inputText.trim()) throw new Error("Gate input is empty.");
  const fakeAllowed = allowFakeResponse(process.env);
  if (process.env.GEMINI_AGENT_FAKE_RESPONSE && !fakeAllowed) {
    throw new Error("GEMINI_AGENT_FAKE_RESPONSE requires GEMINI_AGENT_ALLOW_FAKE_RESPONSE=1.");
  }
  const key = await resolveApiKey();
  if (!key.ok) throw new Error("Gemini API key is not configured. Run: gemini-agent auth set");
  const policy = await loadProjectPolicy(process.cwd());
  const prompt = buildGatePrompt({ gate, input: inputText, policy });
  const review = await generateReview({
    apiKey: key.key,
    prompt,
    allowFakeResponse: fakeAllowed,
    env: process.env,
    telemetry: { cwd: process.cwd(), source: "cli", command },
  });
  output.write(reviewToPrettyJson(review));
}

async function runContextPackCommand(args) {
  const { stdinText, files, diff, writeArtifact } = await parseCommonInputArgs(args);
  const cwd = process.cwd();
  const collected = await collectTextInput({ stdinText, files, diff, cwd });
  const fakeAllowed = allowFakeResponse(process.env);
  if (process.env.GEMINI_AGENT_FAKE_RESPONSE && !fakeAllowed) {
    throw new Error("GEMINI_AGENT_FAKE_RESPONSE requires GEMINI_AGENT_ALLOW_FAKE_RESPONSE=1.");
  }
  const key = await resolveApiKey();
  if (!key.ok) throw new Error("Gemini API key is not configured. Run: gemini-agent auth set");
  const pack = await runContextPack({
    apiKey: key.key,
    cwd,
    collected,
    env: process.env,
    allowFakeResponse: fakeAllowed,
    writeArtifact,
    telemetry: { cwd, source: "cli", command: "context-pack" },
  });
  output.write(contextPackToPrettyJson(pack));
}

async function runArtifactReviewCommand(args) {
  const { file, files, artifactKind, reviewMode, writeArtifact } = parseArtifactArgs(args);
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
    env: process.env,
    allowFakeResponse: fakeAllowed,
    writeArtifact,
    telemetry: { cwd, source: "cli", command: "artifact-review" },
  });
  output.write(artifactReviewToPrettyJson(review));
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
  if (subcommand !== "inventory") throw new Error("telemetry raw requires inventory.");
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

async function runTelemetryQuarantine(args = []) {
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
  if (command === "palette-split") {
    await runPaletteSplitCommand(args);
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
