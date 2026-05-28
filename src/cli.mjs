import { readFile } from "node:fs/promises";
import { stdin as input, stdout as output } from "node:process";
import { runContextPack } from "./context-pack.mjs";
import { deleteApiKeyFromKeychain, resolveApiKey, saveApiKeyToKeychain } from "./keychain.mjs";
import { generateReview, generateText } from "./gemini-client.mjs";
import { collectTextInput } from "./input-collector.mjs";
import { loadProjectPolicy } from "./policies.mjs";
import { buildGatePrompt } from "./prompts.mjs";
import { contextPackToPrettyJson, reviewToPrettyJson } from "./schemas.mjs";

const GATE_COMMANDS = new Map([
  ["plan-critique", "plan_critique"],
  ["patch-precheck", "patch_precheck"],
  ["diff-review", "diff_review"],
  ["research-brief", "research_brief"],
]);

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
    "  gemini-agent plan-critique (--file <path> | --stdin | <text>)",
    "  gemini-agent patch-precheck (--file <path> | --stdin | <text>)",
    "  gemini-agent diff-review (--file <path> | --stdin | <text>)",
    "  gemini-agent research-brief (--file <path> | --stdin | <text>)",
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
        process.exit(130);
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
  const review = await generateReview({ apiKey: key.key, prompt, allowFakeResponse: fakeAllowed, env: process.env });
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
  });
  output.write(contextPackToPrettyJson(pack));
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
  if (command === "ask") {
    const prompt = args.join(" ").trim();
    if (!prompt) throw new Error("Prompt is empty.");
    const key = await resolveApiKey();
    if (!key.ok) throw new Error("Gemini API key is not configured. Run: gemini-agent auth set");
    const text = await generateText({ apiKey: key.key, prompt });
    output.write(`${text}\n`);
    return;
  }
  if (command === "context-pack") {
    await runContextPackCommand(args);
    return;
  }
  if (GATE_COMMANDS.has(command)) {
    await runGate(command, args);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
