import { readFile, stat } from "node:fs/promises";
import { DEFAULT_TEXT_LIMIT_BYTES } from "./input-collector.mjs";
import { normalizeContextPack } from "./schemas.mjs";

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
