import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

function contained(root, candidate) {
  const rel = relative(root, candidate);
  return rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export async function resolveWorkspaceFilePath(path, { cwd = process.cwd() } = {}) {
  const value = String(path ?? "").trim();
  if (!value) throw new Error("Reference path is required.");
  if (isAbsolute(value)) throw new Error("Reference paths must be relative.");

  const physicalCwd = await realpath(cwd);
  const lexicalCandidate = resolve(physicalCwd, value);
  if (!contained(physicalCwd, lexicalCandidate)) {
    throw new Error("Reference path must stay inside cwd.");
  }

  let physicalCandidate;
  try {
    physicalCandidate = await realpath(lexicalCandidate);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error("Reference file not found.");
    }
    throw error;
  }
  if (!contained(physicalCwd, physicalCandidate)) {
    throw new Error("Reference path must stay inside cwd.");
  }
  return physicalCandidate;
}
