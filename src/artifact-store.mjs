import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ARTIFACT_ROOT = ".gemini-agent";

function stamp(now = new Date()) {
  return now.toISOString().replace(/:/g, "").replace(".", "");
}

export function artifactDirectory({ cwd = process.cwd(), category }) {
  return join(cwd, ARTIFACT_ROOT, category);
}

export async function ensureArtifactGitignore(cwd = process.cwd()) {
  const gitignorePath = join(cwd, ".gitignore");
  let content = "";

  try {
    content = await readFile(gitignorePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  if (content.split(/\r?\n/).includes(`${ARTIFACT_ROOT}/`)) {
    return false;
  }

  const prefix = content && !content.endsWith("\n") ? "\n" : "";
  await writeFile(gitignorePath, `${content}${prefix}${ARTIFACT_ROOT}/\n`);
  return true;
}

export async function writeJsonArtifact({
  cwd = process.cwd(),
  category,
  artifact,
  now = new Date(),
}) {
  if (!category || !category.trim()) {
    throw new Error("Artifact category is empty.");
  }

  const dir = artifactDirectory({ cwd, category });
  await mkdir(dir, { recursive: true });

  const body = `${JSON.stringify(artifact, null, 2)}\n`;
  const timestampedPath = join(dir, `${stamp(now)}-${category}.json`);
  const latestPath = join(dir, "latest.json");
  const tmpPath = join(
    dir,
    `latest.json.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );

  await writeFile(timestampedPath, body);
  await writeFile(tmpPath, body);
  await rename(tmpPath, latestPath);

  return { latestPath, timestampedPath };
}

export async function readLatestArtifact({ cwd = process.cwd(), category }) {
  const latestPath = join(artifactDirectory({ cwd, category }), "latest.json");

  try {
    return JSON.parse(await readFile(latestPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
