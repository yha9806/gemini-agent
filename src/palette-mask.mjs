import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { createUserContent } from "@google/genai";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { z } from "zod";
import { makeGoogleGenAI } from "./gemini-client.mjs";
import { imagePartFromFile } from "./input-collector.mjs";
import { captureGeminiTelemetry } from "./telemetry-capture.mjs";

export const DEFAULT_PALETTE_MASK_MODEL = "gemini-3.1-flash-image";
export const DEFAULT_MASK_TOLERANCE = 64;

const BACKGROUND_NAME = "background";
const BACKGROUND_COLOR = "#000000";
const DEFAULT_BACKGROUND_DESCRIPTION = "everything not assigned to a foreground target";
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const FOREGROUND_COLORS = [
  "#ff0000",
  "#00ff00",
  "#0000ff",
  "#ffff00",
  "#ff00ff",
  "#00ffff",
  "#ff8800",
  "#8800ff",
  "#00aa88",
  "#aa0088",
];

export const PaletteLayerSpec = z.object({
  name: z.string().trim().min(1).regex(/^[A-Za-z0-9_-]+$/),
  description: z.string().trim().min(1),
  color: z.string().trim().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
});

export const PaletteMaskSpec = z.object({
  layers: z.array(PaletteLayerSpec).min(1).optional(),
  targets: z.array(z.union([z.string().min(1), PaletteLayerSpec])).min(1).optional(),
}).refine((value) => value.layers || value.targets, {
  message: "Palette mask spec requires layers or targets.",
});

function normalizeHexColor(color) {
  return color.toLowerCase();
}

function parseHexColor(color) {
  const normalized = normalizeHexColor(color);
  return [
    Number.parseInt(normalized.slice(1, 3), 16),
    Number.parseInt(normalized.slice(3, 5), 16),
    Number.parseInt(normalized.slice(5, 7), 16),
  ];
}

function hasPngMagic(buffer) {
  return buffer.length >= PNG_MAGIC.length && buffer.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC);
}

function hasJpegMagic(buffer) {
  return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}

function stripPngTrailingBytes(buffer) {
  if (!hasPngMagic(buffer)) return buffer;
  let offset = PNG_MAGIC.length;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > buffer.length) break;
    if (type === "IEND") return buffer.subarray(0, chunkEnd);
    offset = chunkEnd;
  }
  return buffer;
}

function jpegToPngBuffer(buffer) {
  const decoded = jpeg.decode(buffer, { useTArray: true });
  const png = new PNG({ width: decoded.width, height: decoded.height });
  png.data.set(decoded.data);
  return PNG.sync.write(png);
}

function normalizeImageBytesToPng(buffer) {
  const bytes = Buffer.from(buffer);
  if (hasPngMagic(bytes)) return Buffer.from(stripPngTrailingBytes(bytes));
  if (hasJpegMagic(bytes)) return jpegToPngBuffer(bytes);
  throw new Error("Palette mask provider returned an unsupported image format.");
}

function safeLayerFileName(name) {
  return `${name.replace(/[^A-Za-z0-9_-]+/g, "_")}.png`;
}

function parseTarget(target) {
  if (typeof target !== "string") return target;
  const separator = target.indexOf(":");
  if (separator < 1) {
    throw new Error(`Target must use "name: description" format: ${target}`);
  }
  const name = target.slice(0, separator).trim();
  const description = target.slice(separator + 1).trim();
  if (!name || !description) {
    throw new Error(`Target must use "name: description" format: ${target}`);
  }
  return { name, description };
}

export function normalizePaletteMaskSpec(input) {
  const parsed = PaletteMaskSpec.parse(input);
  const rawLayers = (parsed.layers ?? parsed.targets).map(parseTarget);
  const foreground = [];
  let background = null;
  const names = new Set();

  for (const rawLayer of rawLayers) {
    const layer = PaletteLayerSpec.parse(rawLayer);
    const normalized = {
      ...layer,
      color: layer.color ? normalizeHexColor(layer.color) : undefined,
    };
    if (names.has(normalized.name)) throw new Error(`Duplicate palette layer name: ${normalized.name}`);
    names.add(normalized.name);
    if (normalized.name === BACKGROUND_NAME) {
      background = {
        ...normalized,
        description: normalized.description || DEFAULT_BACKGROUND_DESCRIPTION,
        color: BACKGROUND_COLOR,
      };
    } else {
      foreground.push(normalized);
    }
  }

  if (!background) {
    background = {
      name: BACKGROUND_NAME,
      description: DEFAULT_BACKGROUND_DESCRIPTION,
      color: BACKGROUND_COLOR,
    };
  }

  const usedColors = new Set([BACKGROUND_COLOR]);
  const layers = [background];
  let colorIndex = 0;
  for (const layer of foreground) {
    let color = layer.color;
    if (!color) {
      while (usedColors.has(FOREGROUND_COLORS[colorIndex])) colorIndex += 1;
      if (colorIndex >= FOREGROUND_COLORS.length) {
        throw new Error("Too many palette targets without explicit colors.");
      }
      color = FOREGROUND_COLORS[colorIndex];
      colorIndex += 1;
    }
    if (usedColors.has(color)) throw new Error(`Duplicate palette color: ${color}`);
    usedColors.add(color);
    layers.push({ ...layer, color });
  }

  return { layers };
}

export function buildPaletteMaskPrompt(spec) {
  const normalized = normalizePaletteMaskSpec(spec);
  const lines = [
    "Create a pure flat RGB palette mask for the provided image.",
    "Do not generate a normal image, realistic image, shaded image, or textured image.",
    "Every output pixel should use one of the listed colors as closely as possible.",
    "Use hard boundaries. Do not draw labels, text, shadows, gradients, or outlines.",
    "The output must preserve the input composition and dimensions.",
    "",
    "Palette ownership map:",
    ...normalized.layers.map((layer) => `- ${layer.name}: ${layer.color} = ${layer.description}`),
    "",
    "Return only the palette mask image.",
  ];
  return lines.join("\n");
}

function ensurePngImage(image) {
  if (image && Number.isInteger(image.width) && Number.isInteger(image.height) && image.data) {
    return image;
  }
  if (Buffer.isBuffer(image) || image instanceof Uint8Array) {
    return PNG.sync.read(normalizeImageBytesToPng(image));
  }
  throw new Error("Expected a PNG image object or PNG buffer.");
}

function blankPng(width, height, fill = [0, 0, 0, 0]) {
  const png = new PNG({ width, height });
  for (let offset = 0; offset < png.data.length; offset += 4) {
    png.data[offset] = fill[0];
    png.data[offset + 1] = fill[1];
    png.data[offset + 2] = fill[2];
    png.data[offset + 3] = fill[3];
  }
  return png;
}

function resizeNearest(image, width, height) {
  const source = ensurePngImage(image);
  if (source.width === width && source.height === height) {
    const copy = new PNG({ width, height });
    copy.data.set(source.data);
    return copy;
  }

  const resized = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(source.height - 1, Math.floor(((y + 0.5) * source.height) / height));
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(source.width - 1, Math.floor(((x + 0.5) * source.width) / width));
      const sourceOffset = (sourceY * source.width + sourceX) * 4;
      const targetOffset = (y * width + x) * 4;
      resized.data[targetOffset] = source.data[sourceOffset];
      resized.data[targetOffset + 1] = source.data[sourceOffset + 1];
      resized.data[targetOffset + 2] = source.data[sourceOffset + 2];
      resized.data[targetOffset + 3] = source.data[sourceOffset + 3];
    }
  }
  return resized;
}

function colorDistanceSquared(red, green, blue, color) {
  const redDelta = red - color.rgb[0];
  const greenDelta = green - color.rgb[1];
  const blueDelta = blue - color.rgb[2];
  return redDelta * redDelta + greenDelta * greenDelta + blueDelta * blueDelta;
}

function statsForAlpha(alpha, width, height, layer) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let area = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!alpha[y * width + x]) continue;
      area += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  const areaPct = Number(((area * 100) / (width * height)).toFixed(1));
  const warnings = [];
  let qualityStatus = "detected";
  let bbox = [minX, minY, maxX, maxY];

  if (area === 0) {
    qualityStatus = "empty";
    bbox = null;
    warnings.push(`Layer "${layer.name}" is empty.`);
  } else if (width * height >= 1024 && area < 4) {
    qualityStatus = "degenerate";
    warnings.push(`Layer "${layer.name}" is degenerate.`);
  }

  return {
    bbox,
    area_pct: areaPct,
    quality_status: qualityStatus,
    warnings,
  };
}

export function decodePaletteMask(maskImage, spec, {
  width,
  height,
  tolerance = DEFAULT_MASK_TOLERANCE,
} = {}) {
  if (!Number.isInteger(width) || width <= 0) throw new Error("decodePaletteMask requires a positive width.");
  if (!Number.isInteger(height) || height <= 0) throw new Error("decodePaletteMask requires a positive height.");
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error("decodePaletteMask tolerance must be non-negative.");

  const normalized = normalizePaletteMaskSpec(spec);
  const palette = normalized.layers.map((layer) => ({
    ...layer,
    rgb: parseHexColor(layer.color),
    alpha: new Uint8Array(width * height),
  }));
  const backgroundIndex = palette.findIndex((layer) => layer.name === BACKGROUND_NAME);
  const fallbackIndex = backgroundIndex >= 0 ? backgroundIndex : 0;
  const resized = resizeNearest(maskImage, width, height);
  const quantized = new PNG({ width, height });
  const toleranceSquared = tolerance * tolerance;

  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4;
    const red = resized.data[offset];
    const green = resized.data[offset + 1];
    const blue = resized.data[offset + 2];
    let bestIndex = fallbackIndex;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let paletteIndex = 0; paletteIndex < palette.length; paletteIndex += 1) {
      const distance = colorDistanceSquared(red, green, blue, palette[paletteIndex]);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = paletteIndex;
      }
    }
    const assignedIndex = bestDistance <= toleranceSquared ? bestIndex : fallbackIndex;
    palette[assignedIndex].alpha[index] = 255;
    const assignedColor = palette[assignedIndex].rgb;
    quantized.data[offset] = assignedColor[0];
    quantized.data[offset + 1] = assignedColor[1];
    quantized.data[offset + 2] = assignedColor[2];
    quantized.data[offset + 3] = 255;
  }

  const warnings = [];
  const layers = palette.map((layer) => {
    const stats = statsForAlpha(layer.alpha, width, height, layer);
    warnings.push(...stats.warnings);
    return {
      name: layer.name,
      description: layer.description,
      color: layer.color,
      alpha: layer.alpha,
      bbox: stats.bbox,
      area_pct: stats.area_pct,
      quality_status: stats.quality_status,
    };
  });

  return {
    width,
    height,
    layers,
    quantized,
    warnings,
  };
}

function selectedManifestFields(layer) {
  return {
    name: layer.name,
    description: layer.description,
    color: layer.color,
    file: layer.file,
    bbox: layer.bbox,
    area_pct: layer.area_pct,
    quality_status: layer.quality_status,
  };
}

function roundPct(value) {
  return Number(value.toFixed(1));
}

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function computePaletteQuality({
  sourceImage,
  paletteMask,
  decodedMasks,
  warnings = [],
} = {}) {
  const source = ensurePngImage(sourceImage);
  const mask = ensurePngImage(paletteMask);
  const layers = Array.isArray(decodedMasks?.layers) ? decodedMasks.layers : [];
  const targets = layers.filter((layer) => layer.name !== BACKGROUND_NAME);
  const targetCount = targets.length;
  const detectedTargetCount = targets.filter((layer) => layer.quality_status === "detected").length;
  const emptyTargetCount = targets.filter((layer) => layer.quality_status === "empty").length;
  const degenerateTargetCount = targets.filter((layer) => layer.quality_status === "degenerate").length;
  const foregroundAreaPct = roundPct(targets.reduce((total, layer) => total + Number(layer.area_pct ?? 0), 0));
  const largestTargetAreaPct = roundPct(targets.reduce((largest, layer) => (
    Math.max(largest, Number(layer.area_pct ?? 0))
  ), 0));
  const maskResized = source.width !== mask.width || source.height !== mask.height;
  const warningsCount = Array.isArray(warnings) ? warnings.length : 0;
  const qualityScore = clampScore(
    100
    - (maskResized ? 10 : 0)
    - emptyTargetCount * 30
    - degenerateTargetCount * 20
    - warningsCount * 5,
  );

  return {
    source_width: source.width,
    source_height: source.height,
    mask_width: mask.width,
    mask_height: mask.height,
    mask_resized: maskResized,
    layer_count: layers.length,
    target_count: targetCount,
    detected_target_count: detectedTargetCount,
    empty_target_count: emptyTargetCount,
    degenerate_target_count: degenerateTargetCount,
    foreground_area_pct: foregroundAreaPct,
    largest_target_area_pct: largestTargetAreaPct,
    warnings_count: warningsCount,
    quality_score: qualityScore,
  };
}

export async function extractLayers(sourceImage, decodedMasks, outputDir) {
  const source = ensurePngImage(sourceImage);
  if (source.width !== decodedMasks.width || source.height !== decodedMasks.height) {
    throw new Error("Source image and decoded masks dimensions do not match.");
  }
  await mkdir(outputDir, { recursive: true });
  const outputRoot = resolve(outputDir, "..");

  const layerRecords = [];
  for (const layer of decodedMasks.layers) {
    const image = new PNG({ width: source.width, height: source.height });
    for (let index = 0; index < source.width * source.height; index += 1) {
      const offset = index * 4;
      image.data[offset] = source.data[offset];
      image.data[offset + 1] = source.data[offset + 1];
      image.data[offset + 2] = source.data[offset + 2];
      image.data[offset + 3] = layer.alpha[index];
    }
    const filePath = join(outputDir, safeLayerFileName(layer.name));
    await writeFile(filePath, PNG.sync.write(image));
    layerRecords.push({
      ...selectedManifestFields({
        ...layer,
        file: relative(outputRoot, filePath),
      }),
    });
  }
  return layerRecords;
}

export async function writeManifest({
  outputDir,
  sourceImage = "source.png",
  paletteMask = "palette_mask.png",
  paletteMaskQuantized = "palette_mask_quantized.png",
  contactSheet = "contact_sheet.png",
  layers,
  warnings = [],
  quality,
}) {
  await mkdir(outputDir, { recursive: true });
  const manifest = {
    version: 1,
    source_image: sourceImage,
    palette_mask: paletteMask,
    palette_mask_quantized: paletteMaskQuantized,
    contact_sheet: contactSheet,
    ...(quality ? { quality } : {}),
    layers: layers.map(selectedManifestFields),
    warnings,
  };
  await writeFile(join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function drawPixel(dest, offset, red, green, blue, alpha = 255) {
  dest.data[offset] = red;
  dest.data[offset + 1] = green;
  dest.data[offset + 2] = blue;
  dest.data[offset + 3] = alpha;
}

function drawRect(dest, x, y, width, height, color) {
  const [red, green, blue, alpha = 255] = color;
  for (let yy = y; yy < y + height; yy += 1) {
    for (let xx = x; xx < x + width; xx += 1) {
      if (xx < 0 || yy < 0 || xx >= dest.width || yy >= dest.height) continue;
      drawPixel(dest, (yy * dest.width + xx) * 4, red, green, blue, alpha);
    }
  }
}

function drawChecker(dest, x, y, width, height) {
  for (let yy = y; yy < y + height; yy += 1) {
    for (let xx = x; xx < x + width; xx += 1) {
      const dark = (Math.floor((xx - x) / 8) + Math.floor((yy - y) / 8)) % 2 === 0;
      const value = dark ? 218 : 244;
      drawPixel(dest, (yy * dest.width + xx) * 4, value, value, value, 255);
    }
  }
}

function drawImageOver(dest, source, x, y) {
  for (let yy = 0; yy < source.height; yy += 1) {
    for (let xx = 0; xx < source.width; xx += 1) {
      const destX = x + xx;
      const destY = y + yy;
      if (destX < 0 || destY < 0 || destX >= dest.width || destY >= dest.height) continue;
      const sourceOffset = (yy * source.width + xx) * 4;
      const destOffset = (destY * dest.width + destX) * 4;
      const alpha = source.data[sourceOffset + 3] / 255;
      const invAlpha = 1 - alpha;
      dest.data[destOffset] = Math.round(source.data[sourceOffset] * alpha + dest.data[destOffset] * invAlpha);
      dest.data[destOffset + 1] = Math.round(source.data[sourceOffset + 1] * alpha + dest.data[destOffset + 1] * invAlpha);
      dest.data[destOffset + 2] = Math.round(source.data[sourceOffset + 2] * alpha + dest.data[destOffset + 2] * invAlpha);
      dest.data[destOffset + 3] = 255;
    }
  }
}

async function readLayerImages(outputDir, layers) {
  const images = [];
  for (const layer of layers) {
    images.push({
      color: layer.color,
      image: PNG.sync.read(await readFile(join(outputDir, layer.file))),
    });
  }
  return images;
}

export async function writeContactSheet({
  outputDir,
  sourceImage,
  paletteMaskQuantized,
  layers,
  file = "contact_sheet.png",
  maxThumb = 240,
}) {
  const source = ensurePngImage(sourceImage);
  const quantized = ensurePngImage(paletteMaskQuantized);
  const layerImages = await readLayerImages(outputDir, layers);
  const items = [
    { color: "#666666", image: source },
    { color: "#999999", image: quantized },
    ...layerImages,
  ];

  const scale = Math.min(1, maxThumb / Math.max(source.width, source.height));
  const thumbWidth = Math.max(1, Math.round(source.width * scale));
  const thumbHeight = Math.max(1, Math.round(source.height * scale));
  const gap = 12;
  const padding = 8;
  const header = 10;
  const columns = Math.min(3, items.length);
  const rows = Math.ceil(items.length / columns);
  const cellWidth = thumbWidth + padding * 2;
  const cellHeight = thumbHeight + padding * 2 + header;
  const sheet = blankPng(
    columns * cellWidth + (columns + 1) * gap,
    rows * cellHeight + (rows + 1) * gap,
    [255, 255, 255, 255],
  );

  for (let index = 0; index < items.length; index += 1) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = gap + column * (cellWidth + gap);
    const y = gap + row * (cellHeight + gap);
    drawRect(sheet, x, y, cellWidth, cellHeight, [248, 248, 248, 255]);
    drawRect(sheet, x, y, cellWidth, header, [...parseHexColor(items[index].color), 255]);
    drawChecker(sheet, x + padding, y + padding + header, thumbWidth, thumbHeight);
    drawImageOver(sheet, resizeNearest(items[index].image, thumbWidth, thumbHeight), x + padding, y + padding + header);
  }

  await writeFile(join(outputDir, file), PNG.sync.write(sheet));
  return file;
}

function imageBufferFromProviderResult(result) {
  if (Buffer.isBuffer(result)) return result;
  if (result instanceof Uint8Array) return Buffer.from(result);
  if (typeof result === "string") return Buffer.from(result, "base64");
  if (result?.buffer) return imageBufferFromProviderResult(result.buffer);
  throw new Error("Palette mask provider did not return image bytes.");
}

function telemetryErrorType(error) {
  return error instanceof Error && error.name ? error.name : "Error";
}

async function capturePaletteTelemetry(telemetry, event, { awaitCapture = false } = {}) {
  if (!telemetry) return;
  const capture = telemetry.capture ?? captureGeminiTelemetry;
  const capturePromise = Promise.resolve()
    .then(() => capture({
      ...event,
      cwd: telemetry.cwd,
      source: telemetry.source || "cli",
      command: telemetry.command || event.command || "palette-split",
    }))
    .catch(() => null);
  if (telemetry.capture || telemetry.awaitCapture || awaitCapture) await capturePromise;
}

function paletteTelemetryMetadata({ model, spec, manifest }) {
  const metadata = {
    actual_model: model,
    workflow: "palette-split",
    target_count: Math.max(0, spec.layers.length - 1),
    layer_count: manifest?.layers?.length ?? spec.layers.length,
  };
  if (manifest?.quality) metadata.quality = manifest.quality;
  return metadata;
}

function paletteTelemetryResponse(manifest) {
  return JSON.stringify({
    manifest: "manifest.json",
    layers: manifest.layers.map((layer) => ({
      name: layer.name,
      area_pct: layer.area_pct,
      quality_status: layer.quality_status,
    })),
    warnings: manifest.warnings ?? [],
  });
}

async function pngTelemetryContent(filePath, name = basename(filePath)) {
  const info = await stat(filePath);
  return {
    basename: name,
    mime_type: "image/png",
    byte_size: info.size,
  };
}

async function paletteTelemetryContents({ outputDir, manifest }) {
  const files = [
    manifest.source_image,
    manifest.palette_mask,
    manifest.palette_mask_quantized,
    manifest.contact_sheet,
    ...manifest.layers.map((layer) => layer.file),
  ];
  const contents = [];
  for (const file of files) {
    contents.push(await pngTelemetryContent(join(outputDir, file), basename(file)));
  }
  return contents;
}

function imageBufferFromGeminiResponse(response) {
  const candidateParts = response?.candidates?.flatMap((candidate) => candidate?.content?.parts ?? []) ?? [];
  const parts = [
    ...(Array.isArray(response?.parts) ? response.parts : []),
    ...candidateParts,
  ];
  for (const part of parts) {
    const inlineData = part?.inlineData ?? part?.inline_data;
    if (inlineData?.data && /^image\//.test(inlineData.mimeType ?? inlineData.mime_type ?? "image/png")) {
      return Buffer.from(inlineData.data, "base64");
    }
  }
  throw new Error("Gemini response did not include an image.");
}

export async function generatePaletteMask(
  imagePath,
  spec,
  {
    apiKey,
    provider = "gemini",
    env = process.env,
    makeAi = makeGoogleGenAI,
    model = env.GEMINI_IMAGE_MODEL || DEFAULT_PALETTE_MASK_MODEL,
  } = {},
) {
  const normalized = normalizePaletteMaskSpec(spec);
  const prompt = buildPaletteMaskPrompt(normalized);

  if (typeof provider === "function") {
    const result = await provider({ imagePath, spec: normalized, prompt, model });
    return imageBufferFromProviderResult(result);
  }
  if (provider !== "gemini") throw new Error(`Unsupported palette mask provider: ${provider}`);
  if (!apiKey) throw new Error("Gemini API key is missing.");

  const ai = makeAi(apiKey);
  const imagePart = await imagePartFromFile(imagePath);
  const response = await ai.models.generateContent({
    model,
    contents: createUserContent([prompt, imagePart]),
    config: {
      responseModalities: ["Image"],
    },
  });
  return imageBufferFromGeminiResponse(response);
}

export function parsePaletteSplitArgs(args) {
  const options = {
    targets: [],
    tolerance: DEFAULT_MASK_TOLERANCE,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--target") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--target requires a value.");
      options.targets.push(value);
      index += 1;
    } else if (arg === "--output") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--output requires a directory.");
      options.outputDir = value;
      index += 1;
    } else if (arg === "--tolerance") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--tolerance requires a number.");
      const tolerance = Number(value);
      if (!Number.isInteger(tolerance) || tolerance < 0) throw new Error("--tolerance must be a non-negative integer.");
      options.tolerance = tolerance;
      index += 1;
    } else if (!options.sourceImagePath && !arg.startsWith("--")) {
      options.sourceImagePath = arg;
    } else {
      throw new Error(`Unknown palette-split argument: ${arg}`);
    }
  }

  if (!options.sourceImagePath) throw new Error("palette-split requires a source PNG path.");
  if (options.targets.length === 0) throw new Error("palette-split requires at least one --target.");
  if (!options.outputDir) {
    options.outputDir = `${basename(options.sourceImagePath).replace(/\.[^.]+$/, "")}_palette_split`;
  }
  for (const target of options.targets) parseTarget(target);

  return {
    sourceImagePath: options.sourceImagePath,
    targets: options.targets,
    outputDir: options.outputDir,
    tolerance: options.tolerance,
  };
}

export async function runPaletteSplit({
  sourceImagePath,
  targets,
  outputDir,
  tolerance = DEFAULT_MASK_TOLERANCE,
  apiKey,
  provider = "gemini",
  env = process.env,
  makeAi,
  model,
  telemetry,
} = {}) {
  if (!sourceImagePath) throw new Error("sourceImagePath is required.");
  if (!outputDir) throw new Error("outputDir is required.");
  const spec = normalizePaletteMaskSpec({ targets });
  const resolvedModel = model ?? env.GEMINI_IMAGE_MODEL ?? DEFAULT_PALETTE_MASK_MODEL;
  const prompt = buildPaletteMaskPrompt(spec);
  const started = Date.now();
  await mkdir(outputDir, { recursive: true });

  try {
    const sourceBuffer = await readFile(sourceImagePath);
    const sourceImage = PNG.sync.read(sourceBuffer);
    const sourceOutput = join(outputDir, "source.png");
    await copyFile(sourceImagePath, sourceOutput);

    const maskBuffer = await generatePaletteMask(sourceImagePath, spec, {
      apiKey,
      provider,
      env,
      makeAi,
      model: resolvedModel,
    });
    const maskPngBuffer = normalizeImageBytesToPng(maskBuffer);
    const rawMaskImage = PNG.sync.read(maskPngBuffer);
    await writeFile(join(outputDir, "palette_mask.png"), maskPngBuffer);

    const decoded = decodePaletteMask(rawMaskImage, spec, {
      width: sourceImage.width,
      height: sourceImage.height,
      tolerance,
    });
    await writeFile(join(outputDir, "palette_mask_quantized.png"), PNG.sync.write(decoded.quantized));
    const layers = await extractLayers(sourceImage, decoded, join(outputDir, "layers"));
    await writeContactSheet({
      outputDir,
      sourceImage,
      paletteMaskQuantized: decoded.quantized,
      layers,
    });
    const manifest = await writeManifest({
      outputDir,
      sourceImage: "source.png",
      paletteMask: "palette_mask.png",
      paletteMaskQuantized: "palette_mask_quantized.png",
      contactSheet: "contact_sheet.png",
      layers,
      warnings: decoded.warnings,
      quality: computePaletteQuality({
        sourceImage,
        paletteMask: rawMaskImage,
        decodedMasks: decoded,
        warnings: decoded.warnings,
      }),
    });

    await capturePaletteTelemetry(telemetry, {
      prompt,
      response: paletteTelemetryResponse(manifest),
      status: "success",
      latencyMs: Date.now() - started,
      contents: await paletteTelemetryContents({ outputDir, manifest }).catch(() => []),
      metadata: paletteTelemetryMetadata({ model: resolvedModel, spec, manifest }),
    });

    return {
      outputDir: resolve(outputDir),
      manifest,
    };
  } catch (error) {
    await capturePaletteTelemetry(telemetry, {
      prompt,
      response: "",
      status: "error",
      errorType: telemetryErrorType(error),
      latencyMs: Date.now() - started,
      contents: [{
        basename: basename(sourceImagePath),
        mime_type: "image/png",
      }],
      metadata: paletteTelemetryMetadata({ model: resolvedModel, spec, manifest: null }),
    }, { awaitCapture: true });
    throw error;
  }
}
