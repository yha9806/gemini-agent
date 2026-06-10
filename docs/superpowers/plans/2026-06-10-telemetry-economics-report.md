# Telemetry Economics Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `gemini-agent telemetry economics` so local/global telemetry can report estimated Gemini cost, estimated Codex token savings, usage coverage, and command-level ROI.

**Architecture:** Create a focused `src/telemetry-economics.mjs` module that scans telemetry queue files safely, aggregates totals and command-level economics, and formats JSON/text output. Keep `src/cli.mjs` responsible for argument parsing and routing only. Reuse telemetry config context, queue directories, schema normalization, and credential masking already used by `telemetry summary`.

**Tech Stack:** Node.js ESM, built-in `node:test`, existing telemetry queue/config/schema modules, no new dependencies.

---

## Files

- Create: `src/telemetry-economics.mjs`
- Create: `test/telemetry-economics.test.mjs`
- Modify: `src/cli.mjs`
- Modify: `test/cli.test.mjs`
- Modify: `README.md`
- Modify: `test/package.test.mjs`

## Task 1: Economics Module

**Files:**
- Create: `test/telemetry-economics.test.mjs`
- Create: `src/telemetry-economics.mjs`

- [ ] **Step 1: Write failing module tests**

Create tests for:

```js
test("runTelemetryEconomics aggregates totals and command ROI safely", async () => {
  // Setup enabled telemetry config.
  // Append diff-review, plan_critique, and ask events with usage metadata.
  // Include raw prompt/response strings that must not appear in serialized report.
  // Assert total cost, total savings, usage coverage, canonical command rows,
  // recommendations, and no raw text leakage.
});

test("runTelemetryEconomics supports price overrides and global scope", async () => {
  // Save global config under a temporary home.
  // Append one event with input/output usage.
  // Run with custom input/output prices.
  // Assert scope, storage cwd, and cost calculation.
});

test("runTelemetryEconomics rejects invalid options", async () => {
  await assert.rejects(() => runTelemetryEconomics({ topLimit: 0 }), /topLimit/);
  await assert.rejects(() => runTelemetryEconomics({ inputPricePerMillion: -1 }), /inputPricePerMillion/);
  await assert.rejects(() => runTelemetryEconomics({ outputPricePerMillion: Number.NaN }), /outputPricePerMillion/);
});
```

Run:

```bash
node --test test/telemetry-economics.test.mjs
```

Expected: FAIL because `src/telemetry-economics.mjs` does not exist.

- [ ] **Step 2: Implement minimal module**

Create `src/telemetry-economics.mjs` with:

- `runTelemetryEconomics({ cwd, home, scope, now, topLimit, inputPricePerMillion, outputPricePerMillion })`
- `formatTelemetryEconomicsText(report)`
- safe queue walking copied from `telemetry-summary.mjs` patterns.
- command canonicalization: lowercase, trim, underscore-to-hyphen.
- aggregate-only output.
- cost rounded to six decimals.

Run:

```bash
node --test test/telemetry-economics.test.mjs
```

Expected: PASS.

- [ ] **Step 3: Commit module**

```bash
git add src/telemetry-economics.mjs test/telemetry-economics.test.mjs
git commit -m "feat: add telemetry economics module"
```

## Task 2: CLI Route

**Files:**
- Modify: `src/cli.mjs`
- Modify: `test/cli.test.mjs`

- [ ] **Step 1: Write failing CLI tests**

Add tests:

```js
test("telemetry economics prints safe human output", async () => {
  // Enable telemetry, append one event, run `telemetry economics`.
  // Assert pricing, cost, savings appear.
  // Assert raw prompt/response do not appear.
});

test("telemetry economics --json supports global scope and price overrides", async () => {
  // Save global config, append one event, run with --global --json
  // and custom prices.
  // Assert parsed pricing and totals.
});

test("telemetry economics rejects invalid arguments", async () => {
  // Unknown arg, --top 0, and invalid price should exit 1.
});
```

Run:

```bash
node --test test/cli.test.mjs --test-name-pattern "telemetry economics"
```

Expected: FAIL with unknown telemetry command.

- [ ] **Step 2: Implement CLI parsing and routing**

In `src/cli.mjs`:

- Import `formatTelemetryEconomicsText` and `runTelemetryEconomics`.
- Add usage line after `telemetry summary`.
- Add `parseTelemetryEconomicsOptions(args)`.
- Add `runTelemetryEconomicsCommand(args)`.
- Route `subcommand === "economics"`.

Supported arguments:

- `--global`
- `--json`
- `--top <positive integer>`
- `--input-price-per-million <nonnegative number>`
- `--output-price-per-million <nonnegative number>`

Run:

```bash
node --test test/cli.test.mjs --test-name-pattern "telemetry economics"
```

Expected: PASS.

- [ ] **Step 3: Commit CLI**

```bash
git add src/cli.mjs test/cli.test.mjs
git commit -m "feat: add telemetry economics cli"
```

## Task 3: Docs And Verification

**Files:**
- Modify: `README.md`
- Modify: `test/package.test.mjs`

- [ ] **Step 1: Add README examples and docs test**

Document:

```bash
./bin/gemini-agent telemetry economics --global
./bin/gemini-agent telemetry economics --global --json
```

Update package/readme test to assert those examples exist.

Run:

```bash
node --test test/package.test.mjs
```

Expected: PASS.

- [ ] **Step 2: Run full verification**

```bash
git diff --check
npm test
./bin/gemini-agent telemetry economics --global --json
```

Expected:

- `git diff --check` exits 0.
- `npm test` passes.
- Economics JSON prints aggregate totals and no raw prompt/response.

- [ ] **Step 3: Independent review**

```bash
git diff main...HEAD | ./bin/gemini-agent diff-review --stdin
```

Expected: `verdict` is `pass` or only non-blocking suggestions.

- [ ] **Step 4: Commit docs if needed**

```bash
git add README.md test/package.test.mjs
git commit -m "docs: document telemetry economics"
```

## Self-Review

- Spec coverage: module, CLI, docs, JSON/text output, pricing overrides, safety, and verification are covered.
- Placeholder scan: no placeholder implementation steps remain.
- Type consistency: uses `runTelemetryEconomics`, `formatTelemetryEconomicsText`, `inputPricePerMillion`, `outputPricePerMillion`, and `topLimit` consistently.
