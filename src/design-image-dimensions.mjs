import { readFile } from "node:fs/promises";
import { PNG } from "pngjs";
import jpeg from "jpeg-js";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_SIGNATURE_PREFIX = PNG_SIGNATURE.subarray(0, 4);

function isWebp(buffer) {
  return buffer.length >= 12
    && buffer.subarray(0, 4).toString("ascii") === "RIFF"
    && buffer.subarray(8, 12).toString("ascii") === "WEBP";
}

function readUInt24LE(buffer, offset) {
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
}

function parseVp8xDimensions(buffer, dataOffset, chunkSize) {
  if (chunkSize < 10 || dataOffset + 10 > buffer.length) return null;
  return {
    width: readUInt24LE(buffer, dataOffset + 4) + 1,
    height: readUInt24LE(buffer, dataOffset + 7) + 1,
  };
}

function parseVp8lDimensions(buffer, dataOffset, chunkSize) {
  if (chunkSize < 5 || dataOffset + 5 > buffer.length || buffer[dataOffset] !== 0x2f) return null;
  const b0 = buffer[dataOffset + 1];
  const b1 = buffer[dataOffset + 2];
  const b2 = buffer[dataOffset + 3];
  const b3 = buffer[dataOffset + 4];
  return {
    width: 1 + (((b1 & 0x3f) << 8) | b0),
    height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
  };
}

function parseVp8Dimensions(buffer, dataOffset, chunkSize) {
  if (
    chunkSize < 10
    || dataOffset + 10 > buffer.length
    || buffer[dataOffset + 3] !== 0x9d
    || buffer[dataOffset + 4] !== 0x01
    || buffer[dataOffset + 5] !== 0x2a
  ) {
    return null;
  }
  return {
    width: buffer.readUInt16LE(dataOffset + 6) & 0x3fff,
    height: buffer.readUInt16LE(dataOffset + 8) & 0x3fff,
  };
}

function webpDimensions(buffer) {
  if (!isWebp(buffer)) return null;

  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkType = buffer.subarray(offset, offset + 4).toString("ascii");
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    if (dataOffset + chunkSize > buffer.length) return null;

    if (chunkType === "VP8X") return parseVp8xDimensions(buffer, dataOffset, chunkSize);
    if (chunkType === "VP8L") return parseVp8lDimensions(buffer, dataOffset, chunkSize);
    if (chunkType === "VP8 ") return parseVp8Dimensions(buffer, dataOffset, chunkSize);

    offset = dataOffset + chunkSize + (chunkSize % 2);
  }

  return null;
}

function hasJpegMagic(buffer) {
  return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}

function unknownDimensions(mimeType) {
  return { width: null, height: null, mimeType };
}

export async function imageDimensions(path) {
  const buffer = await readFile(path);

  if (
    buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
    || buffer.subarray(0, PNG_SIGNATURE_PREFIX.length).equals(PNG_SIGNATURE_PREFIX)
  ) {
    try {
      const png = PNG.sync.read(buffer);
      return { width: png.width, height: png.height, mimeType: "image/png" };
    } catch {
      return unknownDimensions("image/png");
    }
  }

  if (hasJpegMagic(buffer)) {
    try {
      const decoded = jpeg.decode(buffer, { useTArray: true });
      return { width: decoded.width, height: decoded.height, mimeType: "image/jpeg" };
    } catch {
      return unknownDimensions("image/jpeg");
    }
  }

  if (isWebp(buffer)) {
    const dimensions = webpDimensions(buffer);
    return {
      width: dimensions?.width ?? null,
      height: dimensions?.height ?? null,
      mimeType: "image/webp",
    };
  }

  return unknownDimensions("unknown");
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

export function normalizeBBox(box, dimensions) {
  if (
    !box
    || !dimensions
    || !finiteNumber(dimensions.width)
    || !finiteNumber(dimensions.height)
    || dimensions.width <= 0
    || dimensions.height <= 0
    || !finiteNumber(box.x)
    || !finiteNumber(box.y)
    || !finiteNumber(box.width)
    || !finiteNumber(box.height)
    || box.x < 0
    || box.y < 0
    || box.width < 0
    || box.height < 0
    || box.x + box.width > dimensions.width
    || box.y + box.height > dimensions.height
  ) {
    return null;
  }

  return {
    x: box.x / dimensions.width,
    y: box.y / dimensions.height,
    width: box.width / dimensions.width,
    height: box.height / dimensions.height,
  };
}
