import assert from "node:assert/strict";
import test from "node:test";
import {
  contextPackTelemetryMetadata,
  gateFreshInputModes,
  gateTelemetryMetadata,
} from "../src/telemetry-command-metadata.mjs";

test("contextPackTelemetryMetadata records bootstrap mode without source names", () => {
  const metadata = contextPackTelemetryMetadata({
    bootstrap: true,
    writeArtifact: true,
    collected: {
      sources: ["README.md", "git diff", "/Users/example/private/app.js"],
    },
  });

  assert.deepEqual(metadata, {
    context_pack_mode: "bootstrap",
    write_artifact: true,
    source_count: 3,
    includes_git_diff: true,
  });
  assert.doesNotMatch(JSON.stringify(metadata), /README|Users|private|app\.js/);
});

test("contextPackTelemetryMetadata records manual mode without raw input labels", () => {
  const metadata = contextPackTelemetryMetadata({
    bootstrap: false,
    writeArtifact: false,
    collected: {
      sources: ["stdin", "notes.md"],
    },
  });

  assert.deepEqual(metadata, {
    context_pack_mode: "manual",
    write_artifact: false,
    source_count: 2,
    includes_git_diff: false,
  });
  assert.doesNotMatch(JSON.stringify(metadata), /stdin|notes\.md/);
});

test("gateTelemetryMetadata records context reuse and fresh input mode without paths", () => {
  assert.deepEqual(gateTelemetryMetadata({
    autoContextPack: true,
    freshInputModes: ["stdin"],
  }), {
    context_pack_mode: "auto",
    fresh_input_mode: "stdin",
    has_fresh_input: true,
  });

  const explicit = gateTelemetryMetadata({
    contextPackPath: "/Users/example/private/context/latest.json",
    freshInputModes: [],
  });
  assert.deepEqual(explicit, {
    context_pack_mode: "explicit",
    fresh_input_mode: "none",
    has_fresh_input: false,
  });
  assert.doesNotMatch(JSON.stringify(explicit), /Users|private|latest\.json/);
});

test("gateTelemetryMetadata collapses multiple fresh inputs to mixed and ignores unsafe labels", () => {
  const metadata = gateTelemetryMetadata({
    contextPackPath: "context.json",
    freshInputModes: ["file", "/Users/example/plan.md", "diff", "text", "file"],
  });

  assert.deepEqual(metadata, {
    context_pack_mode: "explicit",
    fresh_input_mode: "mixed",
    has_fresh_input: true,
  });
  assert.doesNotMatch(JSON.stringify(metadata), /Users|plan\.md|context\.json/);
});

test("gateFreshInputModes records only actual non-empty fresh inputs without paths", () => {
  assert.deepEqual(gateFreshInputModes({
    stdinText: "",
    text: "inline plan",
    sources: ["stdin"],
  }), ["text"]);

  assert.deepEqual(gateFreshInputModes({
    stdinText: "stdin plan",
    text: "",
    sources: ["stdin"],
  }), ["stdin"]);

  const modes = gateFreshInputModes({
    stdinText: "stdin plan",
    text: "inline plan",
    filePath: "/Users/example/private/plan.md",
    sources: ["stdin", "/Users/example/private/plan.md", "git diff"],
  });
  assert.deepEqual(modes, ["stdin", "text", "file", "diff"]);
  assert.doesNotMatch(JSON.stringify(modes), /Users|private|plan\.md/);
});
