import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { DEFAULT_TEXT_LIMIT_BYTES } from "./input-collector.mjs";
import { normalizeContextPack } from "./schemas.mjs";

const execFileAsync = promisify(execFile);

export const PLAN_CRITIQUE_DEFAULT_INPUT_LIMIT_BYTES = 128 * 1024;

export function defaultGateInputLimitBytes(gate) {
  return gate === "plan_critique"
    ? PLAN_CRITIQUE_DEFAULT_INPUT_LIMIT_BYTES
    : DEFAULT_TEXT_LIMIT_BYTES;
}

export function parseMaxInputBytes(value, flag = "--max-input-bytes") {
  if (typeof value !== "string" || value.trim() === "" || value.startsWith("--")) {
    throw new Error(`${flag} requires a positive integer.`);
  }
  if (!/^\d+$/.test(value)) throw new Error(`${flag} requires a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} requires a positive integer.`);
  }
  return parsed;
}

export function gateCommandLabel(gate, command = null) {
  return command || String(gate ?? "").replaceAll("_", "-") || "gate";
}

export function gateInputTooLargeMessage({ gate, command, inputBytes, limitBytes }) {
  return [
    `${gateCommandLabel(gate, command)} input exceeds ${limitBytes} bytes (${inputBytes} bytes).`,
    "Use context-pack first, narrow the input, or pass --max-input-bytes <n> if this is intentional.",
  ].join(" ");
}

export function assertGateInputWithinLimit({ gate, command = null, inputBytes, limitBytes }) {
  if (inputBytes > limitBytes) {
    throw new Error(gateInputTooLargeMessage({ gate, command, inputBytes, limitBytes }));
  }
}

export function gateInputMetadata({ gate, inputBytes, limitBytes }) {
  return {
    gate,
    input_bytes: inputBytes,
    input_limit_bytes: limitBytes,
  };
}

export async function readLimitedGateFile(path, { gate, command = null, limitBytes }) {
  const { size } = await stat(path);
  assertGateInputWithinLimit({
    gate,
    command,
    inputBytes: size,
    limitBytes,
  });
  const inputText = await readFile(path, "utf8");
  const inputBytes = Buffer.byteLength(inputText, "utf8");
  assertGateInputWithinLimit({
    gate,
    command,
    inputBytes,
    limitBytes,
  });
  return { inputText, inputBytes };
}

function bulletList(title, values) {
  if (!values.length) return [];
  return [
    `${title}:`,
    ...values.map((value) => `- ${value}`),
  ];
}

export function formatContextPackForGate(value) {
  const pack = normalizeContextPack(value);
  const relevantFiles = pack.relevant_files.map((file) => `${file.path}: ${file.why_relevant}`);
  return [
    "--- Context pack ---",
    ...bulletList("Source summary", pack.source_summary),
    ...bulletList("Project facts", pack.project_facts),
    ...bulletList("Relevant files", relevantFiles),
    ...bulletList("Open questions", pack.open_questions),
    ...bulletList("Risks", pack.risks),
    ...bulletList("Recommended Codex actions", pack.recommended_codex_actions),
    ...bulletList("Limitations", pack.limitations),
  ].join("\n");
}

export async function readLimitedContextPackFile(path, { gate, command = null, limitBytes }) {
  const { size } = await stat(path);
  assertGateInputWithinLimit({
    gate,
    command,
    inputBytes: size,
    limitBytes,
  });
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid context pack JSON: ${error.message}`);
    }
    throw error;
  }
  const inputText = formatContextPackForGate(parsed);
  const inputBytes = Buffer.byteLength(inputText, "utf8");
  assertGateInputWithinLimit({
    gate,
    command,
    inputBytes,
    limitBytes,
  });
  return { inputText, inputBytes };
}

export async function resolveProjectRootForContextPack({
  cwd = process.cwd(),
  runner = execFileAsync,
} = {}) {
  try {
    const { stdout } = await runner("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024,
    });
    const root = stdout.trim();
    return root || cwd;
  } catch {
    return cwd;
  }
}

export async function autoContextPackPath({ cwd = process.cwd(), runner } = {}) {
  const root = await resolveProjectRootForContextPack({ cwd, runner });
  return join(root, ".gemini-agent", "context", "latest.json");
}

export async function readAutoContextPackFile({
  gate,
  command = null,
  limitBytes,
  cwd = process.cwd(),
  runner,
} = {}) {
  const path = await autoContextPackPath({ cwd, runner });
  try {
    return await readLimitedContextPackFile(path, { gate, command, limitBytes });
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error([
        `No context pack found at ${path}.`,
        "Run gemini-agent context-pack --bootstrap --write-artifact from the project root before using --auto-context-pack.",
      ].join(" "));
    }
    throw error;
  }
}

export function limitedGateText(inputText, { gate, command = null, limitBytes }) {
  const text = String(inputText ?? "");
  const inputBytes = Buffer.byteLength(text, "utf8");
  assertGateInputWithinLimit({
    gate,
    command,
    inputBytes,
    limitBytes,
  });
  return { inputText: text, inputBytes };
}
