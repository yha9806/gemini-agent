# Context Pack Preflight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Warn before high-byte gate calls when Codex is about to send raw context without a context pack.

**Architecture:** Keep gate execution explicit and non-blocking. Add a pure preflight formatter in `src/gate-input.mjs`, have `src/cli.mjs` emit that warning to stderr after input collection and before Gemini credential lookup, and document the behavior.

**Tech Stack:** Node.js ESM, `node:test`, existing CLI spawn tests.

---

### Task 1: Preflight Advisor Formatter

**Files:**
- Modify: `src/gate-input.mjs`
- Modify: `test/gate-input.test.mjs`

- [ ] **Step 1: Write failing tests**

Add tests for a function named `gateContextPackPreflightMessage` that returns `null` when input is small or a context pack is already in use, and returns a safe stderr warning when raw gate input is above a threshold.

- [ ] **Step 2: Verify red**

Run:

```bash
node --test test/gate-input.test.mjs --test-name-pattern "preflight"
```

Expected: FAIL because the helper is not exported.

- [ ] **Step 3: Implement helper**

Use a default threshold of 16 KiB. The message must mention the gate command, byte count, context-pack bootstrap command, `--auto-context-pack` retry command, and that the current run continues.

- [ ] **Step 4: Verify green**

Run:

```bash
node --test test/gate-input.test.mjs --test-name-pattern "preflight|advisor"
```

Expected: PASS.

### Task 2: CLI Warning

**Files:**
- Modify: `src/cli.mjs`
- Modify: `test/cli.test.mjs`

- [ ] **Step 1: Write failing CLI tests**

Add one test proving large raw `diff-review --stdin` emits the preflight warning to stderr while still printing valid JSON to stdout. Add one test proving `--auto-context-pack` suppresses the warning.

- [ ] **Step 2: Verify red**

Run:

```bash
node --test test/cli.test.mjs --test-name-pattern "preflight"
```

Expected: FAIL because no warning is emitted.

- [ ] **Step 3: Implement CLI emission**

After `readGateInput`, call the helper with existing telemetry metadata. Write warning text to `stderr` only when the helper returns a string. Do not write to stdout and do not warn on empty input.

- [ ] **Step 4: Verify green**

Run:

```bash
node --test test/cli.test.mjs --test-name-pattern "preflight|auto-context-pack"
```

Expected: PASS.

### Task 3: Docs And Verification

**Files:**
- Modify: `README.md`
- Modify: `test/package.test.mjs`

- [ ] **Step 1: Add README test expectation**

Assert README documents that large raw gate calls print a non-blocking stderr preflight warning.

- [ ] **Step 2: Update README**

Add one concise Safety bullet beside the context-pack gate bullets.

- [ ] **Step 3: Full verification**

Run:

```bash
git diff --check
npm test
./bin/gemini-agent diff-review --diff
```

Expected: all tests pass and Gemini review verdict is `pass`.
