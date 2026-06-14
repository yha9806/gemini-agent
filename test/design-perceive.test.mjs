import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { runDesignPerceive, selectPerceptionProvider } from "../src/design-perceive.mjs";

const runId = "20260614T120000000Z-abcdef";

async function writeBrief(dir) {
  await writeFile(join(dir, "brief.json"), `${JSON.stringify({ run_id: runId })}\n`);
}

test("selectPerceptionProvider auto chooses palette-mask only when targets exist", () => {
  assert.equal(selectPerceptionProvider({ provider: "auto", targets: ["hero: main area"] }), "palette-mask");
  assert.equal(selectPerceptionProvider({ provider: "auto", targets: [] }), "gemini-vision");
  assert.equal(selectPerceptionProvider({ provider: "vision-banana", targets: [] }), "vision-banana");
  assert.throws(() => selectPerceptionProvider({ provider: "bad-provider", targets: [] }), /--provider must be auto/);
});

test("palette-mask provider writes perception from palette split manifest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "design-perceive-"));
  try {
    const image = join(dir, "screen.png");
    await writeFile(image, PNG.sync.write(new PNG({ width: 2, height: 2 })));
    await writeBrief(dir);

    const result = await runDesignPerceive({
      runDir: dir,
      file: image,
      provider: "palette-mask",
      targets: ["hero: main visual area"],
      apiKey: "key",
      paletteSplit: async ({ outputDir, sourceImagePath, targets }) => {
        assert.equal(sourceImagePath, image);
        assert.deepEqual(targets, ["hero: main visual area"]);
        const manifest = {
          layers: [{ name: "hero", file: "layers/hero.png" }],
          warnings: [],
        };
        await writeFile(join(outputDir, "manifest.json"), `${JSON.stringify(manifest)}\n`);
        return { outputDir, manifest };
      },
    });

    assert.equal(result.provider, "palette-mask");
    assert.equal(result.perception.provider, "palette-mask");
    assert.equal(result.perception.run_id, runId);
    assert.equal(result.perception.regions[0].id, "hero");
    assert.equal(result.perception.regions[0].mask_ref, "layers/hero.png");
    const written = JSON.parse(await readFile(join(dir, "perceive", "perception.json"), "utf8"));
    assert.equal(written.regions[0].id, "hero");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("vision-banana provider fails clearly when unconfigured", async () => {
  await assert.rejects(() => runDesignPerceive({
    runDir: "/tmp/run",
    file: "screen.png",
    provider: "vision-banana",
    env: {},
  }), /Vision Banana provider is not configured/);
});

test("vision-banana provider reports HTTP failures", async () => {
  const dir = await mkdtemp(join(tmpdir(), "design-perceive-"));
  try {
    await writeBrief(dir);
    await assert.rejects(() => runDesignPerceive({
      runDir: dir,
      file: "screen.png",
      provider: "vision-banana",
      env: { VISION_BANANA_ENDPOINT: "https://example.test/vision" },
      fetchImpl: async () => ({ ok: false, status: 503, text: async () => "down" }),
    }), /Vision Banana provider failed with HTTP 503/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("vision-banana provider reports timeout", async () => {
  const dir = await mkdtemp(join(tmpdir(), "design-perceive-"));
  try {
    await writeBrief(dir);
    await assert.rejects(() => runDesignPerceive({
      runDir: dir,
      file: "screen.png",
      provider: "vision-banana",
      env: { VISION_BANANA_ENDPOINT: "https://example.test/vision" },
      fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      }),
      timeoutMs: 1,
    }), /Vision Banana provider timed out/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("gemini-vision provider fails clearly without injected generator", async () => {
  const dir = await mkdtemp(join(tmpdir(), "design-perceive-"));
  try {
    await writeBrief(dir);
    await assert.rejects(() => runDesignPerceive({
      runDir: dir,
      file: "screen.png",
      provider: "gemini-vision",
    }), /gemini-vision provider requires an injected generate function/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
