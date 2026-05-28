import assert from "node:assert/strict";
import test from "node:test";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";

const root = new URL("../", import.meta.url);

test("package exposes both executables", async () => {
  const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  assert.equal(pkg.bin["gemini-agent"], "./bin/gemini-agent");
  assert.equal(pkg.bin["gemini-agent-mcp"], "./bin/gemini-agent-mcp");
  await access(new URL("bin/gemini-agent", root), constants.X_OK);
  await access(new URL("bin/gemini-agent-mcp", root), constants.X_OK);
});
