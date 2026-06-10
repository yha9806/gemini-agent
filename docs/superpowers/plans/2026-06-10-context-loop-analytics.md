# Context Loop Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make telemetry analytics report whether gate commands are reusing context packs, especially automatic project-root context packs, so product priorities can measure the low-token Codex/Gemini loop.

**Architecture:** Add a small aggregate model inside existing local telemetry analytics rather than adding a new command. `telemetry-summary` owns adoption counts, `telemetry-economics` owns reuse rates and input-byte efficiency, and `telemetry-priorities` turns low reuse on high-volume gates into a product recommendation.

**Tech Stack:** Node.js ES modules, `node:test`, existing telemetry queue files, existing raw-safe summary/economics/priorities modules.

---

### Task 1: Summary Context Loop Aggregate

**Files:**
- Modify: `src/telemetry-summary.mjs`
- Test: `test/telemetry-summary.test.mjs`

- [ ] **Step 1: Write the failing summary test**

Add a test named `runTelemetrySummary aggregates context loop modes without leaking paths`. Create local telemetry events with:
- `plan-critique` metadata `{ gate: "plan_critique", context_pack_mode: "auto", fresh_input_mode: "stdin", has_fresh_input: true }`
- `diff-review` metadata `{ gate: "diff_review", context_pack_mode: "explicit", fresh_input_mode: "diff", has_fresh_input: true, context_pack_path: "[PATH]/private/latest.json" }`
- `patch-precheck` metadata `{ gate: "patch_precheck", context_pack_mode: "none", fresh_input_mode: "file", has_fresh_input: true }`
- `research-brief` metadata `{ gate: "research_brief", context_pack_mode: "not-a-real-mode", fresh_input_mode: "[PATH]/private/file.md" }`
- one legacy gate event with `{ gate: "plan_critique" }`

Assert `summary.context_loop` contains `gate_event_count`, `context_pack_reused_event_count`, `auto_context_pack_event_count`, `explicit_context_pack_event_count`, `no_context_pack_event_count`, `unknown_context_pack_mode_event_count`, `has_fresh_input_count`, `top_context_pack_modes`, `top_fresh_input_modes`, and `top_gate_commands`. Assert serialized output does not contain local paths, `latest.json`, or `file.md`.

- [ ] **Step 2: Run the summary test and confirm failure**

Run: `node --test test/telemetry-summary.test.mjs --test-name-pattern "context loop"`

Expected: FAIL because `summary.context_loop` is undefined.

- [ ] **Step 3: Implement summary aggregation**

Add safe enum helpers for `context_pack_mode` and `fresh_input_mode`, an accumulator section for context loop counts, and public `context_loop` output. Treat missing or invalid metadata as `unknown`. Count context pack reuse only for `auto` and `explicit`.

- [ ] **Step 4: Run the summary test and confirm pass**

Run: `node --test test/telemetry-summary.test.mjs --test-name-pattern "context loop"`

Expected: PASS.

### Task 2: Economics Context Loop Rates

**Files:**
- Modify: `src/telemetry-economics.mjs`
- Test: `test/telemetry-economics.test.mjs`

- [ ] **Step 1: Write the failing economics test**

Add a test named `runTelemetryEconomics reports context loop reuse rates safely`. Create gate events with `input_bytes`, `input_limit_bytes`, `context_pack_mode`, and `fresh_input_mode`. Include auto, explicit, none, legacy unknown, invalid enum, and a path-like unsafe enum. Assert totals and per-command rows include reuse counts/rates and do not leak path text.

- [ ] **Step 2: Run the economics test and confirm failure**

Run: `node --test test/telemetry-economics.test.mjs --test-name-pattern "context loop"`

Expected: FAIL because `report.context_loop` is undefined.

- [ ] **Step 3: Implement economics aggregation**

Extend economics accumulators with context loop counters. Compute `context_pack_reuse_rate`, `auto_context_pack_rate`, and per-command context loop rows. Return `null` rates for zero denominators. Keep input-byte averages at the existing command level; do not add tiny-sample per-mode averages in this slice.

- [ ] **Step 4: Run the economics test and confirm pass**

Run: `node --test test/telemetry-economics.test.mjs --test-name-pattern "context loop"`

Expected: PASS.

### Task 3: Priorities Recommendation

**Files:**
- Modify: `src/telemetry-priorities.mjs`
- Test: `test/telemetry-priorities.test.mjs`

- [ ] **Step 1: Write the failing priorities test**

Add a test named `runTelemetryPriorities recommends context pack reuse for heavy low-reuse gates`. Build enough `plan-critique` events with gate input bytes and `context_pack_mode: "none"` to make low reuse visible, plus at least one high-ROI command so ordering remains deterministic. Assert a workflow priority mentions increasing context-pack reuse and includes safe aggregate evidence.

- [ ] **Step 2: Run the priorities test and confirm failure**

Run: `node --test test/telemetry-priorities.test.mjs --test-name-pattern "context pack reuse"`

Expected: FAIL because no context-loop priority exists.

- [ ] **Step 3: Implement priorities rule**

Read `economics.context_loop.top_gate_commands`. If a command has at least five gate input events, average input bytes above 1,024, and context pack reuse rate below 0.5, add a medium workflow priority. Evidence must contain only aggregate counts and rates.

- [ ] **Step 4: Run the priorities test and confirm pass**

Run: `node --test test/telemetry-priorities.test.mjs --test-name-pattern "context pack reuse"`

Expected: PASS.

### Task 4: Full Verification And Review

**Files:**
- All modified files above.

- [ ] **Step 1: Run focused tests**

Run:
`node --test test/telemetry-summary.test.mjs test/telemetry-economics.test.mjs test/telemetry-priorities.test.mjs --test-name-pattern "context loop|context pack reuse"`

Expected: PASS.

- [ ] **Step 2: Run full test suite**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 3: Run independent Gemini review**

Run: `./bin/gemini-agent diff-review --diff`

Expected: `verdict: pass`.

- [ ] **Step 4: Commit**

Run:
`git add docs/superpowers/plans/2026-06-10-context-loop-analytics.md src/telemetry-summary.mjs src/telemetry-economics.mjs src/telemetry-priorities.mjs test/telemetry-summary.test.mjs test/telemetry-economics.test.mjs test/telemetry-priorities.test.mjs`

Then:
`git commit -m "feat: report context loop telemetry analytics"`
