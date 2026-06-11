import { writeJsonArtifact } from "./artifact-store.mjs";
import { generateContextPack, getDefaultModel } from "./gemini-client.mjs";
import { currentGitHead, execFileAsync } from "./git-utils.mjs";
import { collectTextInput } from "./input-collector.mjs";
import { loadProjectPolicy } from "./policies.mjs";
import { buildContextPackPrompt } from "./prompts.mjs";
import { normalizeContextPack } from "./schemas.mjs";

export async function runContextPack({
  apiKey,
  cwd = process.cwd(),
  stdinText = "",
  files = [],
  diff = false,
  collected = null,
  env = process.env,
  allowFakeResponse = false,
  now = new Date(),
  runner = execFileAsync,
  writeArtifact = false,
  generate = generateContextPack,
  telemetry = { cwd, source: "cli", command: "context-pack" },
} = {}) {
  const context = collected ?? await collectTextInput({ stdinText, files, diff, cwd });
  const policy = await loadProjectPolicy(cwd);
  const prompt = buildContextPackPrompt({
    input: context.input,
    sources: context.sources,
    policy,
  });

  const generated = await generate({
    apiKey,
    prompt,
    env,
    allowFakeResponse,
    telemetry,
  });

  const gitHead = await currentGitHead({ cwd, runner });
  const pack = normalizeContextPack({
    ...generated,
    metadata: {
      ...generated.metadata,
      model: getDefaultModel(),
      generated_at: now.toISOString(),
      sources: context.sources,
      omitted_sources: context.omittedSources,
      ...(gitHead ? { git_head: gitHead } : {}),
    },
  });

  if (writeArtifact) {
    await writeJsonArtifact({ cwd, category: "context", artifact: pack, now });
  }

  return pack;
}
