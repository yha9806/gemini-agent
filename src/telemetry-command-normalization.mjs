const LEGACY_COMMAND_ALIASES = new Map([
  ["gemini-ask", "ask"],
  ["gemini-artifact-review", "artifact-review"],
  ["gemini-context-pack", "context-pack"],
  ["gemini-diff-review", "diff-review"],
  ["gemini-patch-precheck", "patch-precheck"],
  ["gemini-plan-critique", "plan-critique"],
  ["gemini-research-brief", "research-brief"],
]);

export function normalizeTelemetryCommandAlias(command) {
  return LEGACY_COMMAND_ALIASES.get(command) ?? command;
}
