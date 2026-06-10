# Smart Diff Review Context-Pack Warning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a non-blocking `diff-review --diff` warning that prefers `gemini-agent diff-review --auto-context-pack --diff` when a project-root context pack already exists.

**Architecture:** Keep gate execution explicit. Add a small context-pack existence helper in `src/gate-input.mjs`, use it from `src/cli.mjs` after input collection, and record only safe boolean telemetry metadata. Existing stdout JSON behavior and hard input-limit behavior stay unchanged.

**Tech Stack:** Node.js ES modules, `node:test`, existing CLI helpers in `src/cli.mjs` and `src/gate-input.mjs`.

---

### Task 1: Context-Pack Existence Helper

**Files:**
- Modify: `src/gate-input.mjs`
- Test: `test/gate-input.test.mjs`

- [ ] **Step 1: Write the failing helper test**

Add `autoContextPackExists` to the import list in `test/gate-input.test.mjs` and append this test:

```js
test("autoContextPackExists checks project-root latest context pack without parsing it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-context-exists-"));
  await execFile("git", ["init"], { cwd: dir });
  const nested = join(dir, "packages", "app");
  await mkdir(join(dir, ".gemini-agent", "context"), { recursive: true });
  await mkdir(nested, { recursive: true });
  await writeFile(join(dir, ".gemini-agent", "context", "latest.json"), "{not parsed");

  assert.equal(await autoContextPackExists({ cwd: nested }), true);
});
```

- [ ] **Step 2: Run the helper test and verify it fails**

Run:

```bash
node --test --test-name-pattern "autoContextPackExists" test/gate-input.test.mjs
```

Expected: FAIL because `autoContextPackExists` is not exported.

- [ ] **Step 3: Implement the helper**

In `src/gate-input.mjs`, add this export near `autoContextPackPath`:

```js
export async function autoContextPackExists({ cwd = process.cwd(), runner } = {}) {
  const path = await autoContextPackPath({ cwd, runner });
  try {
    const stats = await stat(path);
    return stats.isFile();
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run the helper test and verify it passes**

Run:

```bash
node --test --test-name-pattern "autoContextPackExists" test/gate-input.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit helper changes**

```bash
git add src/gate-input.mjs test/gate-input.test.mjs
git commit -m "feat: detect existing auto context pack"
```

### Task 2: Smart Diff-Review Warning And Telemetry

**Files:**
- Modify: `src/cli.mjs`
- Test: `test/cli.test.mjs`

- [ ] **Step 1: Write failing CLI tests**

Add this test near the existing preflight tests in `test/cli.test.mjs`:

```js
test("diff-review --diff with existing context pack suggests auto context reuse and queues safe metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-smart-preflight-"));
  await execFileAsync("git", ["init"], { cwd: dir });
  await mkdir(join(dir, ".gemini-agent", "context"), { recursive: true });
  await writeFile(join(dir, ".gemini-agent", "context", "latest.json"), fakeContextPack);
  await writeFile(join(dir, "app.txt"), "old\n");
  await execFileAsync("git", ["add", "app.txt"], { cwd: dir });
  await writeFile(join(dir, "app.txt"), `${"new line\n".repeat(3000)}\n`);
  await saveTelemetryConfig({
    cwd: dir,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TELEMETRY_TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });

  const { stdout, stderr } = await execBin(["diff-review", "--diff"], {
    cwd: dir,
    env: {
      ...process.env,
      HOME: CLI_TEST_HOME,
      GEMINI_API_KEY: "fake-key",
      GEMINI_AGENT_ALLOW_FAKE_RESPONSE: "1",
      GEMINI_AGENT_FAKE_RESPONSE: fakeReview,
    },
  });

  assert.equal(JSON.parse(stdout).verdict, "pass");
  assert.match(stderr, /diff-review can reuse the existing context pack/);
  assert.match(stderr, /gemini-agent diff-review --auto-context-pack --diff/);
  assert.doesNotMatch(stderr, /Run: gemini-agent context-pack --bootstrap --write-artifact/);

  const pending = await readdir(telemetryQueueDirs(dir).pending);
  assert.equal(pending.length, 1);
  const event = JSON.parse(await readFile(join(telemetryQueueDirs(dir).pending, pending[0]), "utf8"));
  assert.equal(event.metadata.context_pack_existing_hint, true);
  assert.doesNotMatch(JSON.stringify(event.metadata), /latest\.json|\.gemini-agent/);
});
```

Also add this suppression test:

```js
test("diff-review --auto-context-pack --diff suppresses existing context pack hint", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-smart-preflight-auto-"));
  await execFileAsync("git", ["init"], { cwd: dir });
  await mkdir(join(dir, ".gemini-agent", "context"), { recursive: true });
  await writeFile(join(dir, ".gemini-agent", "context", "latest.json"), fakeContextPack);
  await writeFile(join(dir, "app.txt"), "old\n");
  await execFileAsync("git", ["add", "app.txt"], { cwd: dir });
  await writeFile(join(dir, "app.txt"), `${"new line\n".repeat(3000)}\n`);

  const { stdout, stderr } = await execBin(["diff-review", "--auto-context-pack", "--diff"], {
    cwd: dir,
    env: {
      ...process.env,
      HOME: CLI_TEST_HOME,
      GEMINI_API_KEY: "fake-key",
      GEMINI_AGENT_ALLOW_FAKE_RESPONSE: "1",
      GEMINI_AGENT_FAKE_RESPONSE: fakeReview,
    },
  });

  assert.equal(JSON.parse(stdout).verdict, "pass");
  assert.equal(stderr, "");
});
```

- [ ] **Step 2: Run the CLI tests and verify they fail**

Run:

```bash
node --test --test-name-pattern "existing context pack hint|smart preflight" test/cli.test.mjs
```

Expected: FAIL because the smart warning and metadata are not implemented.

- [ ] **Step 3: Implement smart warning**

In `src/cli.mjs`, import `autoContextPackExists`. In `runGate()`, compute:

```js
const existingContextPackHint = command === "diff-review"
  && metadata.context_pack_mode === "none"
  && metadata.fresh_input_mode === "diff"
  && preflightMetadata.context_pack_preflight_warning === true
  && await autoContextPackExists({ cwd: process.cwd() });
const smartPreflightMetadata = {
  context_pack_existing_hint: existingContextPackHint,
};
const smartPreflightMessage = existingContextPackHint
  ? "diff-review can reuse the existing context pack; current run will continue. Prefer: gemini-agent diff-review --auto-context-pack --diff"
  : null;
```

Then write `smartPreflightMessage ?? preflightMessage` to stderr and include `...smartPreflightMetadata` in telemetry metadata after `...preflightMetadata`.

- [ ] **Step 4: Run the CLI tests and verify they pass**

Run:

```bash
node --test --test-name-pattern "preflight|auto-context-pack|existing context pack hint|smart preflight" test/cli.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit CLI changes**

```bash
git add src/cli.mjs test/cli.test.mjs
git commit -m "feat: hint existing context pack for diff review"
```

### Task 3: Documentation And Verification

**Files:**
- Modify: `README.md`
- Modify: `test/package.test.mjs`

- [ ] **Step 1: Write the failing package test**

In `test/package.test.mjs`, assert README documents that existing context packs make the warning more specific:

```js
assert.match(readme, /Large raw `diff-review --diff` calls with an existing context pack suggest `diff-review --auto-context-pack --diff`/);
```

- [ ] **Step 2: Run the package test and verify it fails**

Run:

```bash
node --test test/package.test.mjs
```

Expected: FAIL because README does not document the smart warning.

- [ ] **Step 3: Update README**

Add this Safety bullet near the existing preflight bullets:

```md
- Large raw `diff-review --diff` calls with an existing context pack suggest `diff-review --auto-context-pack --diff`; the current run continues and stdout remains JSON.
```

- [ ] **Step 4: Run package and focused tests**

Run:

```bash
node --test test/package.test.mjs test/gate-input.test.mjs
node --test --test-name-pattern "preflight|auto-context-pack|existing context pack hint|smart preflight" test/cli.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Run full verification and Gemini review**

Run:

```bash
git diff --check
npm test
./bin/gemini-agent context-pack --bootstrap --write-artifact
./bin/gemini-agent diff-review --auto-context-pack --diff
```

Expected: `git diff --check` exits 0, `npm test` passes, context-pack writes an artifact, and Gemini diff-review returns `verdict: pass`.

- [ ] **Step 6: Commit docs**

```bash
git add README.md test/package.test.mjs
git commit -m "docs: document smart diff review context hint"
```

### Task 4: Integration And Telemetry Flush

**Files:**
- No source file changes beyond committed tasks.

- [ ] **Step 1: Merge branch to main**

```bash
git switch main
git merge --ff-only codex/smart-diff-review-warning-design
```

Expected: Fast-forward merge succeeds.

- [ ] **Step 2: Push main**

```bash
git push origin main
```

Expected: Push succeeds.

- [ ] **Step 3: Flush telemetry safely**

```bash
./bin/gemini-agent telemetry doctor --global --json
./bin/gemini-agent telemetry flush --global --dry-run --batch-size 1
./bin/gemini-agent telemetry flush --global --batch-size 1
./bin/gemini-agent telemetry doctor --global --json
```

Expected: final doctor shows `pending=0`, `failed=0`, and `quarantine=0`.
