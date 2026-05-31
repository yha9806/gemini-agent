import { readFile } from "node:fs/promises";
import { stdin as input, stdout as output } from "node:process";
import { runArtifactReview } from "./artifact-review.mjs";
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
import { buildGatePrompt } from "./prompts.mjs";
import { artifactReviewToPrettyJson, contextPackToPrettyJson, reviewToPrettyJson } from "./schemas.mjs";
import { drainTelemetryCapture } from "./telemetry-capture.mjs";
import {
  assertRawConfirmation,
  disableTelemetryConfig,
  loadTelemetryConfig,
  rawTelemetryWarning,
  resolveTelemetryToken,
  saveTelemetryConfig,
} from "./telemetry-config.mjs";
import { flushTelemetryQueue, runTelemetryValidation } from "./telemetry-sender.mjs";
import { loadTelemetryState, purgeTelemetryData } from "./telemetry-queue.mjs";

const GATE_COMMANDS = new Map([
  ["plan-critique", "plan_critique"],
  ["patch-precheck", "patch_precheck"],
  ["diff-review", "diff_review"],
  ["research-brief", "research_brief"],
]);

const ARTIFACT_KINDS = new Set(["image", "ui", "design", "architecture", "research"]);
const DEFAULT_TELEMETRY_ENDPOINT = "http://127.0.0.1:8787/ingest";
const DEFAULT_TELEMETRY_TOKEN_ENV = "GEMINI_AGENT_TELEMETRY_TOKEN";

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
    "  gemini-agent artifact-review --file <path> [--kind image|ui|design|architecture|research] [--write-artifact]",
    "  gemini-agent plan-critique (--file <path> | --stdin | <text>)",
    "  gemini-agent patch-precheck (--file <path> | --stdin | <text>)",
    "  gemini-agent diff-review (--file <path> | --stdin | <text>)",
    "  gemini-agent research-brief (--file <path> | --stdin | <text>)",
    "  gemini-agent telemetry enable --level raw --endpoint <url> --token-env <env> --confirm-raw-content [--schedule <schedule>]",
    "  gemini-agent telemetry status",
    "  gemini-agent telemetry preview",
    "  gemini-agent telemetry flush",
    "  gemini-agent telemetry tick",
    "  gemini-agent telemetry validate [--endpoint <url>] [--token-env <env>] --confirm-raw-content",
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
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--confirm-raw-content") {
      options.confirmRawContent = true;
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
    } else if (arg === "--schedule") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--schedule requires a value.");
      options.schedule = value;
      index += 1;
    } else {
      throw new Error(`Unknown telemetry argument: ${arg}`);
    }
  }

  return options;
}

function assertNoTelemetryOptions(subcommand, args) {
  if (args.length === 0) return;
  parseTelemetryOptions(args);
  throw new Error(`telemetry ${subcommand} does not accept arguments.`);
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
  let file = "";
  let artifactKind = "image";
  let writeArtifact = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--file") {
      const path = args[index + 1];
      if (!path || path.startsWith("--")) throw new Error("--file requires a path.");
      file = path;
      index += 1;
    } else if (arg === "--kind") {
      const kind = args[index + 1];
      if (!kind || kind.startsWith("--")) throw new Error("--kind requires one of: image, ui, design, architecture, research.");
      if (!ARTIFACT_KINDS.has(kind)) {
        throw new Error("--kind requires one of: image, ui, design, architecture, research.");
      }
      artifactKind = kind;
      index += 1;
    } else if (arg === "--write-artifact") {
      writeArtifact = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!file) throw new Error("--file requires a path.");
  return { file, artifactKind, writeArtifact };
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
    telemetry: { cwd: process.cwd(), source: "cli", command, awaitCapture: true },
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
    telemetry: { cwd, source: "cli", command: "context-pack", awaitCapture: true },
  });
  output.write(contextPackToPrettyJson(pack));
}

async function runArtifactReviewCommand(args) {
  const { file, artifactKind, writeArtifact } = parseArtifactArgs(args);
  const cwd = process.cwd();
  await prevalidateArtifactFile(file, cwd);
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
    artifactKind,
    env: process.env,
    allowFakeResponse: fakeAllowed,
    writeArtifact,
    telemetry: { cwd, source: "cli", command: "artifact-review", awaitCapture: true },
  });
  output.write(artifactReviewToPrettyJson(review));
}

async function requireEnabledTelemetryConfig() {
  const config = await loadTelemetryConfig({ cwd: process.cwd() });
  if (!config?.enabled) throw new Error("Telemetry is not enabled.");
  if (config.level !== "raw") throw new Error("Only raw telemetry is supported.");
  return config;
}

async function runTelemetryFlush() {
  const config = await requireEnabledTelemetryConfig();
  const token = resolveTelemetryToken({ tokenEnv: config.token_env, env: process.env });
  const result = await flushTelemetryQueue({
    cwd: process.cwd(),
    endpoint: config.endpoint,
    token,
  });
  output.write(`${JSON.stringify(result, null, 2)}\n`);
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

  const config = await loadTelemetryConfig({ cwd: process.cwd() });
  const enabledConfig = config?.enabled ? config : null;
  const endpoint = options.endpoint ?? enabledConfig?.endpoint ?? DEFAULT_TELEMETRY_ENDPOINT;
  const tokenEnv = options.tokenEnv ?? enabledConfig?.token_env ?? DEFAULT_TELEMETRY_TOKEN_ENV;
  const token = resolveTelemetryToken({ tokenEnv, env: process.env });
  const result = await runTelemetryValidation({
    cwd: process.cwd(),
    endpoint,
    token,
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
      endpoint: options.endpoint,
      tokenEnv: options.tokenEnv,
      schedule: options.schedule,
    });
    output.write(`${rawTelemetryWarning()}\n`);
    output.write(`Telemetry enabled: ${config.level} -> ${config.endpoint}\n`);
    return;
  }

  if (subcommand === "status") {
    assertNoTelemetryOptions(subcommand, subArgs);
    const config = await loadTelemetryConfig({ cwd: process.cwd() });
    const queue = await loadTelemetryState({ cwd: process.cwd() });
    output.write(`${JSON.stringify({ config: config ?? { enabled: false }, queue }, null, 2)}\n`);
    return;
  }

  if (subcommand === "preview") {
    assertNoTelemetryOptions(subcommand, subArgs);
    const queue = await loadTelemetryState({ cwd: process.cwd() });
    output.write(`${JSON.stringify({ queue }, null, 2)}\n`);
    return;
  }

  if (subcommand === "flush" || subcommand === "tick") {
    assertNoTelemetryOptions(subcommand, subArgs);
    await runTelemetryFlush();
    return;
  }

  if (subcommand === "validate") {
    await runTelemetryValidate(subArgs);
    return;
  }

  if (subcommand === "disable") {
    assertNoTelemetryOptions(subcommand, subArgs);
    const config = await disableTelemetryConfig({ cwd: process.cwd() });
    output.write(`${JSON.stringify({ config }, null, 2)}\n`);
    return;
  }

  if (subcommand === "purge") {
    assertNoTelemetryOptions(subcommand, subArgs);
    const result = await purgeTelemetryData({ cwd: process.cwd() });
    output.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  throw new Error("Unknown telemetry command.");
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
  if (command === "ask") {
    const prompt = args.join(" ").trim();
    if (!prompt) throw new Error("Prompt is empty.");
    const key = await resolveApiKey();
    if (!key.ok) throw new Error("Gemini API key is not configured. Run: gemini-agent auth set");
    const text = await generateText({
      apiKey: key.key,
      prompt,
      telemetry: { cwd: process.cwd(), source: "cli", command: "ask", awaitCapture: true },
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
