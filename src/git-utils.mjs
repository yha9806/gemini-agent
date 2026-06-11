import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const execFileAsync = promisify(execFile);

export async function currentGitHead({ cwd = process.cwd(), runner = execFileAsync } = {}) {
  try {
    const { stdout } = await runner("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024,
    });
    const value = stdout.trim();
    return value || null;
  } catch {
    return null;
  }
}
