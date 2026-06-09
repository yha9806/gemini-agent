import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { resolveApiKey } from "../src/keychain.mjs";
import {
  buildPaletteMaskPrompt,
  decodePaletteMask,
  extractLayers,
  normalizePaletteMaskSpec,
  parsePaletteSplitArgs,
  runPaletteSplit,
  writeManifest,
} from "../src/palette-mask.mjs";

const liveKey = await resolveApiKey();

function pngFromPixels(width, height, pixels) {
  const png = new PNG({ width, height });
  for (let index = 0; index < width * height; index += 1) {
    const [red, green, blue, alpha = 255] = pixels[index];
    const offset = index * 4;
    png.data[offset] = red;
    png.data[offset + 1] = green;
    png.data[offset + 2] = blue;
    png.data[offset + 3] = alpha;
  }
  return png;
}

function pngBuffer(png) {
  return PNG.sync.write(png);
}

async function writePng(path, png) {
  await writeFile(path, pngBuffer(png));
}

async function withTempDir(callback) {
  const dir = await mkdtemp(join(tmpdir(), "palette-mask-test-"));
  try {
    return await callback(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function sampleSpec() {
  return normalizePaletteMaskSpec({
    targets: [
      { name: "product", description: "the red product card on the left" },
      { name: "chart", description: "the blue chart panel on the right" },
    ],
  });
}

function layerByName(decoded, name) {
  return decoded.layers.find((layer) => layer.name === name);
}

test("buildPaletteMaskPrompt includes palette colors and target descriptions", () => {
  const prompt = buildPaletteMaskPrompt(sampleSpec());

  assert.match(prompt, /Create a pure flat RGB palette mask/);
  assert.match(prompt, /background: #000000 = everything not assigned to a foreground target/);
  assert.match(prompt, /product: #ff0000 = the red product card on the left/);
  assert.match(prompt, /chart: #00ff00 = the blue chart panel on the right/);
  assert.match(prompt, /Return only the palette mask image/);
});

test("normalizePaletteMaskSpec rejects too many auto-colored targets clearly", () => {
  assert.throws(
    () => normalizePaletteMaskSpec({
      targets: Array.from({ length: 11 }, (_, index) => ({
        name: `target_${index}`,
        description: `target ${index}`,
      })),
    }),
    /Too many palette targets without explicit colors/,
  );
});

test("decodePaletteMask decodes exact RGB ownership masks", () => {
  const mask = pngFromPixels(2, 2, [
    [0, 0, 0],
    [255, 0, 0],
    [0, 255, 0],
    [255, 0, 0],
  ]);

  const decoded = decodePaletteMask(mask, sampleSpec(), { width: 2, height: 2, tolerance: 0 });
  const product = layerByName(decoded, "product");
  const chart = layerByName(decoded, "chart");

  assert.deepEqual([...product.alpha], [0, 255, 0, 255]);
  assert.deepEqual(product.bbox, [1, 0, 1, 1]);
  assert.equal(product.area_pct, 50);
  assert.equal(product.quality_status, "detected");
  assert.deepEqual([...chart.alpha], [0, 0, 255, 0]);
  assert.deepEqual(chart.bbox, [0, 1, 0, 1]);
  assert.equal(decoded.warnings.length, 0);
});

test("decodePaletteMask assigns near colors using tolerance", () => {
  const mask = pngFromPixels(2, 1, [
    [242, 20, 16],
    [0, 240, 20],
  ]);

  const decoded = decodePaletteMask(mask, sampleSpec(), { width: 2, height: 1, tolerance: 64 });

  assert.deepEqual([...layerByName(decoded, "product").alpha], [255, 0]);
  assert.deepEqual([...layerByName(decoded, "chart").alpha], [0, 255]);
});

test("extractLayers writes RGBA PNG layers with correct alpha", async () => {
  await withTempDir(async (dir) => {
    const source = pngFromPixels(2, 1, [
      [10, 20, 30],
      [40, 50, 60],
    ]);
    const mask = pngFromPixels(2, 1, [
      [255, 0, 0],
      [0, 0, 0],
    ]);
    const decoded = decodePaletteMask(mask, sampleSpec(), { width: 2, height: 1, tolerance: 0 });

    const layers = await extractLayers(source, decoded, join(dir, "layers"));
    const product = layers.find((layer) => layer.name === "product");
    const productPng = PNG.sync.read(await readFile(join(dir, product.file)));

    assert.equal(productPng.colorType, 6);
    assert.deepEqual([...productPng.data.subarray(0, 8)], [10, 20, 30, 255, 40, 50, 60, 0]);
  });
});

test("writeManifest includes required fields for each layer", async () => {
  await withTempDir(async (dir) => {
    const source = pngFromPixels(2, 1, [
      [10, 20, 30],
      [40, 50, 60],
    ]);
    const mask = pngFromPixels(2, 1, [
      [255, 0, 0],
      [0, 0, 0],
    ]);
    const decoded = decodePaletteMask(mask, sampleSpec(), { width: 2, height: 1, tolerance: 0 });
    const layers = await extractLayers(source, decoded, join(dir, "layers"));

    const manifest = await writeManifest({
      outputDir: dir,
      sourceImage: "source.png",
      paletteMask: "palette_mask.png",
      paletteMaskQuantized: "palette_mask_quantized.png",
      contactSheet: "contact_sheet.png",
      layers,
      warnings: decoded.warnings,
    });

    assert.equal(manifest.version, 1);
    assert.equal(manifest.source_image, "source.png");
    assert.equal(manifest.palette_mask, "palette_mask.png");
    assert.equal(manifest.palette_mask_quantized, "palette_mask_quantized.png");
    assert.equal(manifest.contact_sheet, "contact_sheet.png");
    assert.equal(manifest.layers.length, 3);
    assert.deepEqual(Object.keys(manifest.layers.find((layer) => layer.name === "product")).sort(), [
      "area_pct",
      "bbox",
      "color",
      "description",
      "file",
      "name",
      "quality_status",
    ]);
    assert.deepEqual(JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")), manifest);
  });
});

test("runPaletteSplit writes artifacts with a mock provider", async () => {
  await withTempDir(async (dir) => {
    const sourcePath = join(dir, "slide.png");
    await writePng(sourcePath, pngFromPixels(4, 2, [
      [0, 0, 0],
      [200, 0, 0],
      [0, 0, 200],
      [0, 0, 0],
      [0, 0, 0],
      [200, 0, 0],
      [0, 0, 200],
      [0, 0, 0],
    ]));
    const maskBuffer = pngBuffer(pngFromPixels(4, 2, [
      [0, 0, 0],
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 0],
      [0, 0, 0],
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 0],
    ]));
    const calls = [];

    const result = await runPaletteSplit({
      sourceImagePath: sourcePath,
      targets: [
        "product: the red product card on the left",
        "chart: the blue chart panel on the right",
      ],
      outputDir: join(dir, "out"),
      provider: async (request) => {
        calls.push(request);
        return maskBuffer;
      },
    });

    assert.equal(calls.length, 1);
    assert.match(calls[0].prompt, /product: #ff0000/);
    for (const relativePath of [
      "source.png",
      "palette_mask.png",
      "palette_mask_quantized.png",
      "contact_sheet.png",
      "manifest.json",
      "layers/background.png",
      "layers/product.png",
      "layers/chart.png",
    ]) {
      assert.equal(existsSync(join(dir, "out", relativePath)), true, relativePath);
    }
    assert.equal(result.manifest.layers.find((layer) => layer.name === "product").quality_status, "detected");
  });
});

test("runPaletteSplit captures palette workflow telemetry", async () => {
  await withTempDir(async (dir) => {
    const sourcePath = join(dir, "slide.png");
    await writePng(sourcePath, pngFromPixels(4, 2, [
      [0, 0, 0],
      [200, 0, 0],
      [0, 0, 200],
      [0, 0, 0],
      [0, 0, 0],
      [200, 0, 0],
      [0, 0, 200],
      [0, 0, 0],
    ]));
    const maskBuffer = pngBuffer(pngFromPixels(4, 2, [
      [0, 0, 0],
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 0],
      [0, 0, 0],
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 0],
    ]));
    const captured = [];

    await runPaletteSplit({
      sourceImagePath: sourcePath,
      targets: [
        "product: the red product card on the left",
        "chart: the blue chart panel on the right",
      ],
      outputDir: join(dir, "out"),
      provider: async () => maskBuffer,
      model: "test-image-model",
      telemetry: {
        cwd: dir,
        source: "cli",
        command: "palette-split",
        capture: async (event) => captured.push(event),
      },
    });

    assert.equal(captured.length, 1);
    assert.equal(captured[0].cwd, dir);
    assert.equal(captured[0].source, "cli");
    assert.equal(captured[0].command, "palette-split");
    assert.equal(captured[0].status, "success");
    assert.match(captured[0].prompt, /product: #ff0000/);
    assert.match(captured[0].response, /"manifest":"manifest.json"/);
    assert.deepEqual(captured[0].metadata, {
      actual_model: "test-image-model",
      workflow: "palette-split",
      target_count: 2,
      layer_count: 3,
    });
    assert.deepEqual(captured[0].contents.map((item) => item.basename), [
      "source.png",
      "palette_mask.png",
      "palette_mask_quantized.png",
      "contact_sheet.png",
      "background.png",
      "product.png",
      "chart.png",
    ]);
    assert.equal(captured[0].contents.every((item) => item.mime_type === "image/png"), true);
    assert.equal(captured[0].contents.every((item) => Number.isInteger(item.byte_size) && item.byte_size > 0), true);
  });
});

test("runPaletteSplit captures palette workflow telemetry when provider fails", async () => {
  await withTempDir(async (dir) => {
    const sourcePath = join(dir, "slide.png");
    await writePng(sourcePath, pngFromPixels(2, 1, [
      [200, 0, 0],
      [0, 0, 0],
    ]));
    const captured = [];

    await assert.rejects(
      () => runPaletteSplit({
        sourceImagePath: sourcePath,
        targets: ["product: the red product card on the left"],
        outputDir: join(dir, "out"),
        provider: async () => {
          throw new Error("image provider unavailable");
        },
        model: "test-image-model",
        telemetry: {
          cwd: dir,
          source: "cli",
          command: "palette-split",
          capture: async (event) => captured.push(event),
        },
      }),
      /image provider unavailable/,
    );

    assert.equal(captured.length, 1);
    assert.equal(captured[0].status, "error");
    assert.equal(captured[0].errorType, "Error");
    assert.equal(captured[0].response, "");
    assert.match(captured[0].prompt, /product: #ff0000/);
    assert.deepEqual(captured[0].metadata, {
      actual_model: "test-image-model",
      workflow: "palette-split",
      target_count: 1,
      layer_count: 2,
    });
    assert.deepEqual(captured[0].contents, [{
      basename: "slide.png",
      mime_type: "image/png",
    }]);
  });
});

test("runPaletteSplit normalizes a mock JPEG palette mask to PNG", async () => {
  await withTempDir(async (dir) => {
    const sourcePath = join(dir, "slide.png");
    await writePng(sourcePath, pngFromPixels(2, 1, [
      [200, 0, 0],
      [0, 0, 0],
    ]));
    const jpegMask = jpeg.encode({
      width: 2,
      height: 1,
      data: Buffer.from([
        255, 0, 0, 255,
        0, 0, 0, 255,
      ]),
    }, 100).data;

    await runPaletteSplit({
      sourceImagePath: sourcePath,
      targets: ["product: the red product card on the left"],
      outputDir: join(dir, "out"),
      tolerance: 96,
      provider: async () => jpegMask,
    });

    const normalizedMask = await readFile(join(dir, "out", "palette_mask.png"));
    assert.equal(normalizedMask.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(existsSync(join(dir, "out", "layers/product.png")), true);
  });
});

test("parsePaletteSplitArgs accepts multiple targets", () => {
  const parsed = parsePaletteSplitArgs([
    "slide.png",
    "--target",
    "product: red card",
    "--target",
    "chart: blue panel",
    "--output",
    "/tmp/out",
    "--tolerance",
    "48",
  ]);

  assert.deepEqual(parsed, {
    sourceImagePath: "slide.png",
    targets: ["product: red card", "chart: blue panel"],
    outputDir: "/tmp/out",
    tolerance: 48,
  });
});

test("live Gemini palette split smoke writes artifacts when API key is configured", {
  skip: liveKey.ok ? false : "Gemini API key is not configured.",
  timeout: 120_000,
}, async () => {
  await withTempDir(async (dir) => {
    const sourcePath = join(dir, "slide.png");
    await writePng(sourcePath, pngFromPixels(16, 16, Array.from({ length: 256 }, (_, index) => {
      const x = index % 16;
      return x < 8 ? [210, 20, 20] : [20, 70, 190];
    })));

    await runPaletteSplit({
      apiKey: liveKey.key,
      sourceImagePath: sourcePath,
      targets: [
        "product: the red block on the left",
        "chart: the blue block on the right",
      ],
      outputDir: join(dir, "out"),
      tolerance: 96,
    });

    for (const relativePath of [
      "palette_mask.png",
      "palette_mask_quantized.png",
      "contact_sheet.png",
      "manifest.json",
      "layers/product.png",
      "layers/chart.png",
    ]) {
      assert.equal(existsSync(join(dir, "out", relativePath)), true, relativePath);
    }
  });
});
