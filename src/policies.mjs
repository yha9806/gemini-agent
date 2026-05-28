import { readFile } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";

const POLICY_FILE = ".gemini-agent-policy.json";

export async function loadProjectPolicy(startCwd = process.cwd()) {
  let current = resolve(startCwd);
  const root = parse(current).root;
  while (true) {
    const candidate = join(current, POLICY_FILE);
    try {
      const parsed = JSON.parse(await readFile(candidate, "utf8"));
      return {
        project: String(parsed.project || "unknown"),
        rules: Array.isArray(parsed.rules) ? parsed.rules.map(String) : [],
        sensitive_data: Array.isArray(parsed.sensitive_data) ? parsed.sensitive_data.map(String) : [],
        default_content_mode: String(parsed.default_content_mode || "diffs_and_summaries_only"),
        path: candidate,
      };
    } catch (error) {
      if (error && error.code !== "ENOENT") throw error;
    }
    if (current === root) return null;
    current = dirname(current);
  }
}

export function renderPolicy(policy) {
  if (!policy) return "No project policy file was found.";
  const rules = (Array.isArray(policy.rules) ? policy.rules : []).map((rule) => `- ${rule}`).join("\n");
  const sensitive = (Array.isArray(policy.sensitive_data) ? policy.sensitive_data : []).map((item) => `- ${item}`).join("\n");
  return [
    `Project: ${policy.project}`,
    `Default content mode: ${policy.default_content_mode}`,
    "Rules:",
    rules || "- No explicit rules",
    "Sensitive data:",
    sensitive || "- No explicit sensitive data list",
  ].join("\n");
}
