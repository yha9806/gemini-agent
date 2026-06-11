# Smart Diff Shortcut Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `gemini-agent diff-review --smart-diff` as a shorter explicit path for reviewing the current git diff with an existing project-root context pack.

**Architecture:** Keep the implementation inside the existing gate input pipeline. `src/cli.mjs` parses `--smart-diff`, maps it to auto context-pack plus current git diff, and emits safe telemetry metadata. The Gemini client, review schema, and telemetry reports do not need new modules because existing context-loop analytics already aggregate `context_pack_mode` and `fresh_input_mode`.

**Tech Stack:** Node.js ES modules, `node:test`, existing CLI integration tests, existing local telemetry queue helpers.

---

## File Map

- Modify `src/cli.mjs`: add `--smart-diff` to usage, parse it in `readGateInput`, reject invalid combinations, and set safe metadata.
- Modify `test/cli.test.mjs`: add red/green CLI tests for success, missing context pack, conflicting flags, and non-diff-review rejection.
- Modify `README.md`: document the new shortcut in the quick command list and context-pack guidance.
- Modify `test/package.test.mjs`: assert README documents the new command and behavioral sentence.

## Task 1: CLI Behavior

**Files:**
- Modify: `test/cli.test.mjs`
- Modify: `src/cli.mjs`

- [ ] **Step 1: Write the failing success test**

Add this test near the existing `diff-review --auto-context-pack --diff` tests in `test/cli.test.mjs`:

```js
test("diff-review --smart-diff uses auto context pack with current git diff and safe telemetry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-smart-diff-"));
  await execFileAsync("git", ["init"], { cwd: dir });
  await mkdir(join(dir, ".gemini-agent", "context"), { recursive: true });
  await writeFile(join(dir, ".gemini-agent", "context", "latest.json"), fakeContextPack);
  await writeFile(join(dir, "app.txt"), "old\n");
  await execFileAsync("git", ["add", "app.txt"], { cwd: dir });
  await writeFile(join(dir, "app.txt"), "new\n");
  await saveTelemetryConfig({
    cwd: dir,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TELEMETRY_TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });

  const { stdout, stderr } = await execBin(["diff-review", "--smart-diff"], {
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

  const pending = await readdir(telemetryQueueDirs(dir).pending);
  assert.equal(pending.length, 1);
  const event = JSON.parse(await readFile(join(telemetryQueueDirs(dir).pending, pending[0]), "utf8"));
  assert.equal(event.metadata.context_pack_mode, "auto");
  assert.equal(event.metadata.fresh_input_mode, "smart-diff");
  assert.equal(event.metadata.smart_diff_shortcut, true);
  assert.equal(event.metadata.context_pack_preflight_warning, false);
  assert.doesNotMatch(JSON.stringify(event.metadata), /latest\.json|\.gemini-agent|app\.txt/);
});
```

- [ ] **Step 2: Run the success test and verify RED**

Run:

```bash
node --test --test-name-pattern "smart-diff uses auto context pack" test/cli.test.mjs
```

Expected: FAIL because `--smart-diff` is treated as text input or unknown behavior, so telemetry metadata does not include `smart_diff_shortcut`.

- [ ] **Step 3: Write conflicting flag and scope tests**

Add these tests near the success test:

```js
test("diff-review --smart-diff fails clearly when context pack is missing before credentials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-smart-diff-missing-"));
  await execFileAsync("git", ["init"], { cwd: dir });
  await writeFile(join(dir, "app.txt"), "old\n");
  await execFileAsync("git", ["add", "app.txt"], { cwd: dir });
  await writeFile(join(dir, "app.txt"), "new\n");

  await assert.rejects(
    execBin(["diff-review", "--smart-diff"], {
      cwd: dir,
      env: { ...process.env, HOME: CLI_TEST_HOME },
    }),
    (error) => {
      assert.match(error.stderr, /No context pack found/);
      assert.match(error.stderr, /context-pack --bootstrap --write-artifact/);
      assert.match(error.stderr, /--smart-diff/);
      assert.doesNotMatch(error.stderr, /Gemini API key is not configured/);
      return true;
    },
  );
});

test("diff-review --smart-diff rejects conflicting input flags", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-smart-diff-conflict-"));
  await assert.rejects(
    execBin(["diff-review", "--smart-diff", "--diff"], {
      cwd: dir,
      env: { ...process.env, HOME: CLI_TEST_HOME },
    }),
    /--smart-diff cannot be combined with --diff, --stdin, --file, --context-pack, --auto-context-pack, or text input/,
  );
});

test("non diff-review gates reject --smart-diff", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-smart-diff-scope-"));
  await assert.rejects(
    execBin(["plan-critique", "--smart-diff"], {
      cwd: dir,
      env: { ...process.env, HOME: CLI_TEST_HOME },
    }),
    /--smart-diff is only supported for diff-review/,
  );
});
```

- [ ] **Step 4: Run the new tests and verify RED**

Run:

```bash
node --test --test-name-pattern "smart-diff" test/cli.test.mjs
```

Expected: FAIL because `--smart-diff` is not parsed.

- [ ] **Step 5: Implement minimal parser support**

In `src/cli.mjs`, update the usage line for `diff-review` to include `--smart-diff`:

```js
"  gemini-agent diff-review (--file <path> | --stdin | --diff | --smart-diff | --context-pack <path> | --auto-context-pack | <text>) [--max-input-bytes <n>]",
```

Inside `readGateInput`, add:

```js
let smartDiff = false;
```

Parse it:

```js
} else if (arg === "--smart-diff") {
  smartDiff = true;
```

After argument parsing and before reading files, add:

```js
if (smartDiff && command !== "diff-review") {
  throw new Error("--smart-diff is only supported for diff-review.");
}

if (smartDiff && (contextPackPath || autoContextPack || readFromStdin || diff || filePath || textArgs.join(" ").trim())) {
  throw new Error("--smart-diff cannot be combined with --diff, --stdin, --file, --context-pack, --auto-context-pack, or text input.");
}
```

Then make `smartDiff` behave like auto context pack plus current diff:

```js
const shouldReadAutoContextPack = autoContextPack || smartDiff;
const shouldReadDiff = diff || smartDiff;
```

Use `shouldReadAutoContextPack` where the code currently checks `autoContextPack`, and use `shouldReadDiff` where the code currently checks `diff`.

When the missing context pack error comes from smart diff, rewrite the user-facing hint:

```js
try {
  const contextPackInput = await readAutoContextPackFile({
    gate,
    command,
    limitBytes,
    cwd: process.cwd(),
  });
  sections.push(contextPackInput.inputText);
} catch (error) {
  if (smartDiff && /^No context pack found at /.test(error?.message ?? "")) {
    throw new Error(error.message.replace("--auto-context-pack", "--smart-diff"));
  }
  throw error;
}
```

When recording fresh input modes, push `smart-diff` instead of `diff`:

```js
freshInputModes.push(...gateFreshInputModes({
  stdinText,
  text,
  filePath,
  sources: collected.sources,
}).map((mode) => (smartDiff && mode === "diff" ? "smart-diff" : mode)));
```

Update metadata:

```js
const metadata = {
  ...gateTelemetryMetadata({
    autoContextPack: shouldReadAutoContextPack,
    contextPackPath,
    freshInputModes,
  }),
  smart_diff_shortcut: smartDiff,
};
```

- [ ] **Step 6: Run the smart-diff tests and verify GREEN**

Run:

```bash
node --test --test-name-pattern "smart-diff" test/cli.test.mjs
```

Expected: PASS for the smart-diff tests.

- [ ] **Step 7: Commit CLI behavior**

Run:

```bash
git add src/cli.mjs test/cli.test.mjs
git commit -m "feat: add smart diff review shortcut"
```

## Task 2: Docs And Package Guard

**Files:**
- Modify: `README.md`
- Modify: `test/package.test.mjs`

- [ ] **Step 1: Write failing README assertions**

In `test/package.test.mjs`, add:

```js
assert.match(readme, /^\.\/bin\/gemini-agent diff-review --smart-diff$/m);
assert.match(readme, /`diff-review --smart-diff` reviews the current git diff with the project-root context pack/);
```

- [ ] **Step 2: Run package test and verify RED**

Run:

```bash
node --test test/package.test.mjs
```

Expected: FAIL because README does not mention `--smart-diff`.

- [ ] **Step 3: Update README**

Add this command near the existing diff-review commands:

```text
./bin/gemini-agent diff-review --smart-diff
```

Add this safety bullet near the context-pack reuse guidance:

```markdown
- `diff-review --smart-diff` reviews the current git diff with the project-root context pack; it is the short explicit path after `context-pack --bootstrap --write-artifact` has created `.gemini-agent/context/latest.json`.
```

- [ ] **Step 4: Run package test and verify GREEN**

Run:

```bash
node --test test/package.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit docs**

Run:

```bash
git add README.md test/package.test.mjs
git commit -m "docs: document smart diff shortcut"
```

## Task 3: Full Verification And Review

**Files:**
- No new source files.

- [ ] **Step 1: Run focused tests**

Run:

```bash
node --test --test-name-pattern "smart-diff|auto-context-pack|existing context pack suggests" test/cli.test.mjs
node --test test/package.test.mjs
```

Expected: PASS.

- [ ] **Step 2: Run repository checks**

Run:

```bash
git diff --check
npm test
```

Expected: PASS with zero failures.

- [ ] **Step 3: Ask Gemini Agent for independent diff review**

Run after implementation commits:

```bash
./bin/gemini-agent context-pack --bootstrap --write-artifact
git diff origin/main...HEAD | ./bin/gemini-agent diff-review --auto-context-pack --stdin
```

Expected: `verdict` is `pass`, or actionable feedback is handled before integration.

- [ ] **Step 4: Flush telemetry safely**

Run:

```bash
./bin/gemini-agent telemetry doctor --global --json
./bin/gemini-agent telemetry flush --global --dry-run --batch-size 1
./bin/gemini-agent telemetry flush --global --batch-size 1
./bin/gemini-agent telemetry doctor --global --json
```

Expected: pending returns to 0, endpoint health remains OK.
