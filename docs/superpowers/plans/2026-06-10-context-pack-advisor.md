# Context Pack Advisor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make oversized gate failures give Codex a concrete context-pack reuse path instead of a generic size error.

**Architecture:** Keep gate execution explicit. Add a small advisor formatter in `src/gate-input.mjs`, route gate-side `collectTextInput` size failures through that formatter in `src/cli.mjs`, and document the intended bootstrap/retry loop.

**Tech Stack:** Node.js ESM, `node:test`, existing CLI tests.

---

### Task 1: Gate Advisor Message

**Files:**
- Modify: `src/gate-input.mjs`
- Modify: `test/gate-input.test.mjs`

- [ ] **Step 1: Write failing advisor tests**

Add tests that assert oversized gate messages include:
- the command-specific failure prefix,
- `gemini-agent context-pack --bootstrap --write-artifact`,
- `gemini-agent <gate-command> --auto-context-pack`,
- a reminder to add only narrow fresh input.

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
node --test test/gate-input.test.mjs --test-name-pattern "advisor|exceeds"
```

Expected: FAIL because the retry command is not present yet.

- [ ] **Step 3: Implement the advisor formatter**

Add exported helpers in `src/gate-input.mjs`:

```js
export function contextPackAdvisorMessage({ command = null, gate = null } = {}) {
  const label = gateCommandLabel(gate, command);
  return [
    "Run: gemini-agent context-pack --bootstrap --write-artifact",
    `Then retry: gemini-agent ${label} --auto-context-pack`,
    "Add --stdin, --diff, or --file <path> only for narrow fresh input beyond the pack.",
  ].join(" ");
}
```

Use this helper from `gateInputTooLargeMessage`.

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```bash
node --test test/gate-input.test.mjs --test-name-pattern "advisor|exceeds"
```

Expected: PASS.

### Task 2: CLI Collection Error Wrapping

**Files:**
- Modify: `src/cli.mjs`
- Modify: `test/cli.test.mjs`

- [ ] **Step 1: Write failing CLI tests**

Add a test for a gate `--diff` or `--stdin --diff` path that makes `collectTextInput` throw `Context input exceeds <n> bytes.` and assert stderr includes:
- `diff-review context input exceeds`,
- the bootstrap command,
- the `diff-review --auto-context-pack` retry command,
- no Gemini API key error.

- [ ] **Step 2: Run the focused CLI test and verify it fails**

Run:

```bash
node --test test/cli.test.mjs --test-name-pattern "context input exceeds|auto-context-pack"
```

Expected: FAIL because `collectTextInput` size errors are not gate-advised yet.

- [ ] **Step 3: Wrap gate collection size errors**

In `readGateInput`, catch errors whose message is exactly `Context input exceeds <number> bytes.` and rethrow a gate-specific message that uses the same advisor helper. Do not wrap empty input, invalid paths, invalid JSON, or API-key errors.

- [ ] **Step 4: Run focused CLI tests**

Run:

```bash
node --test test/cli.test.mjs --test-name-pattern "context input exceeds|auto-context-pack|input exceeds"
```

Expected: PASS.

### Task 3: Documentation And Full Verification

**Files:**
- Modify: `README.md`
- Modify: `test/package.test.mjs`

- [ ] **Step 1: Write README expectation**

Add a package test assertion that the README explains oversized gate failures now print bootstrap and retry commands.

- [ ] **Step 2: Update README**

Add one concise bullet near the context-pack gate documentation.

- [ ] **Step 3: Verify full suite and review**

Run:

```bash
git diff --check
npm test
./bin/gemini-agent diff-review --diff
```

Expected: all tests pass and Gemini review verdict is `pass`.
