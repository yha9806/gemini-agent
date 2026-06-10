const CONTEXT_PACK_COMMAND_MODES = new Set(["bootstrap", "manual"]);
const GATE_CONTEXT_PACK_MODES = new Set(["auto", "explicit", "none"]);
const FRESH_INPUT_MODES = new Set(["stdin", "file", "diff", "text"]);

function safeMode(value, allowed, fallback) {
  return allowed.has(value) ? value : fallback;
}

function uniqueAllowedModes(values, allowed) {
  if (!Array.isArray(values)) return [];
  const result = [];
  for (const value of values) {
    if (allowed.has(value) && !result.includes(value)) result.push(value);
  }
  return result;
}

export function gateFreshInputModes({
  stdinText = "",
  text = "",
  filePath = null,
  sources = [],
} = {}) {
  const sourceList = Array.isArray(sources) ? sources : [];
  const modes = [];
  if (String(stdinText).trim() && sourceList.includes("stdin")) modes.push("stdin");
  if (String(text).trim() && sourceList.includes("stdin")) modes.push("text");
  if (filePath && sourceList.includes(filePath)) modes.push("file");
  if (sourceList.includes("git diff")) modes.push("diff");
  return modes;
}

export function contextPackTelemetryMetadata({
  bootstrap = false,
  writeArtifact = false,
  collected = null,
} = {}) {
  const sources = Array.isArray(collected?.sources) ? collected.sources : [];
  const mode = safeMode(bootstrap ? "bootstrap" : "manual", CONTEXT_PACK_COMMAND_MODES, "manual");
  return {
    context_pack_mode: mode,
    write_artifact: Boolean(writeArtifact),
    source_count: sources.length,
    includes_git_diff: sources.includes("git diff"),
  };
}

export function gateTelemetryMetadata({
  autoContextPack = false,
  contextPackPath = null,
  freshInputModes = [],
} = {}) {
  const contextPackMode = safeMode(
    autoContextPack ? "auto" : contextPackPath ? "explicit" : "none",
    GATE_CONTEXT_PACK_MODES,
    "none",
  );
  const modes = uniqueAllowedModes(freshInputModes, FRESH_INPUT_MODES);
  const freshInputMode = modes.length > 1 ? "mixed" : modes[0] ?? "none";
  return {
    context_pack_mode: contextPackMode,
    fresh_input_mode: freshInputMode,
    has_fresh_input: freshInputMode !== "none",
  };
}
