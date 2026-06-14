import { mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

const DESIGN_ROOT = join(".gemini-agent", "design");
const RUN_ID_PATTERN = /^[0-9TzZ._-]+-[A-Za-z0-9]{6,}$/;

function stamp(now) {
  return now.toISOString().replace(/[-:]/g, "").replace(".", "");
}

function randomSuffix(random) {
  return random().toString(36).replace(/[^A-Za-z0-9]/g, "").slice(0, 8).padEnd(6, "0");
}

export function designRunRoot(cwd = process.cwd()) {
  return resolve(cwd, DESIGN_ROOT);
}

function assertContained(root, candidate, message) {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const rel = relative(resolvedRoot, resolvedCandidate);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(message);
  }
  return resolvedCandidate;
}

export function safeRunId(value) {
  const runId = String(value ?? "").trim();
  if (
    !RUN_ID_PATTERN.test(runId)
    || runId.includes("..")
    || /[\u0000-\u001f]/u.test(runId)
  ) {
    throw new Error("Unsafe design run id.");
  }
  return runId;
}

export function resolveDesignRun({ cwd = process.cwd(), run }) {
  const root = designRunRoot(cwd);
  const candidate = run && String(run).includes(sep)
    ? resolve(cwd, run)
    : resolve(root, safeRunId(run));
  return assertContained(root, candidate, "Design run path must stay under .gemini-agent/design.");
}

export async function readDesignRunId(runDir) {
  const brief = await readFile(resolve(runDir, "brief.json"), "utf8")
    .then((text) => JSON.parse(text))
    .catch(() => null);
  if (brief?.run_id) return safeRunId(brief.run_id);
  return safeRunId(basename(resolve(runDir)));
}

export async function createDesignRun({ cwd = process.cwd(), now = new Date(), random = Math.random } = {}) {
  const root = designRunRoot(cwd);
  await mkdir(root, { recursive: true });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const suffix = attempt === 0 ? randomSuffix(random) : `${randomSuffix(random)}${attempt}`;
    const runId = safeRunId(`${stamp(now)}-${suffix}`);
    const dir = resolve(root, runId);
    assertContained(root, dir, "Design run path must stay under .gemini-agent/design.");
    try {
      await mkdir(dir, { recursive: false });
      return { runId, dir };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  throw new Error("Unable to create a unique design run directory.");
}

export async function writeDesignJson({ runDir, relativePath, value }) {
  const target = assertContained(runDir, resolve(runDir, relativePath), "Design artifact path must stay inside the run directory.");
  await mkdir(resolve(target, ".."), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`);
  return target;
}

export function assertPrototypeRelativePath(path) {
  const value = String(path ?? "").trim();
  if (!value || /[\u0000-\u001f]/u.test(value)) {
    throw new Error("Prototype file path must stay under prototype/.");
  }
  const prototypeRoot = resolve("/", "__prototype__");
  const resolved = resolve(prototypeRoot, value);
  const rel = relative(prototypeRoot, resolved);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("Prototype file path must stay under prototype/.");
  }
  return rel;
}

export async function writePrototypeFiles({ runDir, files }) {
  const prototypeDir = resolve(runDir, "prototype");
  const versionsDir = resolve(runDir, ".prototype-versions");
  const versionName = `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const versionDir = resolve(versionsDir, versionName);
  const tmpLink = resolve(runDir, `prototype.link-${versionName}`);
  await rm(tmpLink, { force: true });
  await mkdir(versionsDir, { recursive: true });
  await mkdir(versionDir, { recursive: false });
  try {
    for (const [name, body] of Object.entries(files)) {
      const safeName = assertPrototypeRelativePath(name);
      const target = resolve(versionDir, safeName);
      await mkdir(resolve(target, ".."), { recursive: true });
      await writeFile(target, String(body));
    }
    await symlink(versionDir, tmpLink);
    await rename(tmpLink, prototypeDir);
  } catch (error) {
    await rm(tmpLink, { force: true });
    await rm(versionDir, { recursive: true, force: true });
    throw error;
  }
  return prototypeDir;
}
