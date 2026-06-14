import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { imageDimensions, normalizeBBox } from "../src/design-image-dimensions.mjs";

test("reads PNG dimensions and normalizes bbox", async () => {
  const dir = await mkdtemp(join(tmpdir(), "design-dim-"));
  try {
    const png = new PNG({ width: 200, height: 100 });
    const file = join(dir, "screen.png");
    await writeFile(file, PNG.sync.write(png));

    assert.deepEqual(await imageDimensions(file), { width: 200, height: 100, mimeType: "image/png" });
    assert.deepEqual(normalizeBBox({ x: 20, y: 10, width: 100, height: 50 }, { width: 200, height: 100 }), {
      x: 0.1,
      y: 0.1,
      width: 0.5,
      height: 0.5,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reads JPEG dimensions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "design-dim-"));
  try {
    const width = 64;
    const height = 32;
    const data = Buffer.alloc(width * height * 4, 255);
    const file = join(dir, "screen.jpg");
    await writeFile(file, jpeg.encode({ data, width, height }, 80).data);

    assert.deepEqual(await imageDimensions(file), { width, height, mimeType: "image/jpeg" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function webpChunk(type, payload) {
  const pad = payload.length % 2;
  const buffer = Buffer.alloc(12 + 8 + payload.length + pad);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(4 + 8 + payload.length + pad, 4);
  buffer.write("WEBP", 8, "ascii");
  buffer.write(type, 12, "ascii");
  buffer.writeUInt32LE(payload.length, 16);
  payload.copy(buffer, 20);
  return buffer;
}

function vp8xWebp({ width, height }) {
  const payload = Buffer.alloc(10);
  payload.writeUIntLE(width - 1, 4, 3);
  payload.writeUIntLE(height - 1, 7, 3);
  return webpChunk("VP8X", payload);
}

function vp8lWebp({ width, height }) {
  const payload = Buffer.alloc(5);
  const w = width - 1;
  const h = height - 1;
  payload[0] = 0x2f;
  payload[1] = w & 0xff;
  payload[2] = ((w >> 8) & 0x3f) | ((h & 0x03) << 6);
  payload[3] = (h >> 2) & 0xff;
  payload[4] = (h >> 10) & 0x0f;
  return webpChunk("VP8L", payload);
}

function vp8Webp({ width, height }) {
  const payload = Buffer.alloc(10);
  payload[3] = 0x9d;
  payload[4] = 0x01;
  payload[5] = 0x2a;
  payload.writeUInt16LE(width, 6);
  payload.writeUInt16LE(height, 8);
  return webpChunk("VP8 ", payload);
}

test("reads VP8X, VP8L, and VP8 WEBP dimensions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "design-dim-"));
  try {
    const vp8x = join(dir, "screen-vp8x.webp");
    const vp8l = join(dir, "screen-vp8l.webp");
    const vp8 = join(dir, "screen-vp8.webp");
    await writeFile(vp8x, vp8xWebp({ width: 320, height: 180 }));
    await writeFile(vp8l, vp8lWebp({ width: 321, height: 181 }));
    await writeFile(vp8, vp8Webp({ width: 322, height: 182 }));

    assert.deepEqual(await imageDimensions(vp8x), { width: 320, height: 180, mimeType: "image/webp" });
    assert.deepEqual(await imageDimensions(vp8l), { width: 321, height: 181, mimeType: "image/webp" });
    assert.deepEqual(await imageDimensions(vp8), { width: 322, height: 182, mimeType: "image/webp" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("unsupported WEBP chunks degrade to unknown dimensions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "design-dim-"));
  try {
    const file = join(dir, "unknown.webp");
    await writeFile(file, webpChunk("ALPH", Buffer.from([1, 2, 3, 4])));

    assert.deepEqual(await imageDimensions(file), { width: null, height: null, mimeType: "image/webp" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("corrupted image payloads degrade to unknown dimensions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "design-dim-"));
  try {
    const png = join(dir, "bad.png");
    const jpg = join(dir, "bad.jpg");
    const webp = join(dir, "bad.webp");
    await writeFile(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(jpg, Buffer.from([0xff, 0xd8, 0xff]));
    await writeFile(webp, Buffer.from("RIFFxxxxWEBP", "ascii"));

    assert.deepEqual(await imageDimensions(png), { width: null, height: null, mimeType: "image/png" });
    assert.deepEqual(await imageDimensions(jpg), { width: null, height: null, mimeType: "image/jpeg" });
    assert.deepEqual(await imageDimensions(webp), { width: null, height: null, mimeType: "image/webp" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("invalid dimensions and out-of-range boxes return null bbox", () => {
  assert.equal(normalizeBBox({ x: 1, y: 1, width: 1, height: 1 }, { width: 0, height: 10 }), null);
  assert.equal(normalizeBBox({ x: 190, y: 1, width: 20, height: 1 }, { width: 200, height: 100 }), null);
});
