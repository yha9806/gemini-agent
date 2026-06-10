import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  inferMediaKind,
  inferMediaMime,
  mediaReferenceMetadata,
  syntheticMediaBasename,
} from "../src/media-metadata.mjs";

async function tempDir() {
  return mkdtemp(join(tmpdir(), "gemini-agent-media-"));
}

test("inferMediaMime covers common image and document extensions", () => {
  assert.equal(inferMediaMime("mockup.svg"), "image/svg+xml");
  assert.equal(inferMediaMime("capture.gif"), "image/gif");
  assert.equal(inferMediaMime("photo.heic"), "image/heic");
  assert.equal(inferMediaMime("paper.pdf"), "application/pdf");
});

test("inferMediaKind classifies documents, screenshots, designs, and images", () => {
  assert.equal(inferMediaKind({ mimeType: "application/pdf", reference: "paper.pdf" }), "document");
  assert.equal(inferMediaKind({ mimeType: "image/png", reference: "checkout-screenshot.png" }), "screenshot");
  assert.equal(inferMediaKind({ mimeType: "image/png", reference: "figma-mockup.png" }), "design");
  assert.equal(inferMediaKind({ mimeType: "image/jpeg", reference: "photo.jpg" }), "image");
  assert.equal(inferMediaKind({ mimeType: null, reference: "notes.txt" }), "unknown");
});

test("syntheticMediaBasename masks original filenames with a non-public salt", () => {
  const first = syntheticMediaBasename("confidential-customer-screen.png", { salt: "install_alpha" });
  const second = syntheticMediaBasename("confidential-customer-screen.png", { salt: "install_alpha" });
  const differentSalt = syntheticMediaBasename("confidential-customer-screen.png", { salt: "install_beta" });
  assert.equal(first, second);
  assert.notEqual(first, differentSalt);
  assert.match(first, /^media-[a-f0-9]{12}\.png$/);
  assert.doesNotMatch(first, /confidential|customer|screen/);
});

test("mediaReferenceMetadata uses real files inside root and synthetic basename", async () => {
  const root = await tempDir();
  await mkdir(join(root, "outputs"), { recursive: true });
  const file = join(root, "outputs", "checkout-screenshot.png");
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  await writeFile(file, bytes);

  const metadata = await mediaReferenceMetadata("outputs/checkout-screenshot.png", { root });

  assert.equal(metadata.mime_type, "image/png");
  assert.equal(metadata.byte_size, bytes.length);
  assert.equal(metadata.media_kind, "screenshot");
  assert.match(metadata.basename, /^media-[a-f0-9]{12}\.png$/);
  assert.doesNotMatch(JSON.stringify(metadata), /checkout-screenshot/);
});

test("mediaReferenceMetadata rejects outside paths and symlinks", async () => {
  const root = await tempDir();
  const outside = await tempDir();
  await writeFile(join(outside, "secret.png"), "secret");
  await symlink(join(outside, "secret.png"), join(root, "linked.png"));

  assert.equal(await mediaReferenceMetadata(`../${outside.split("/").at(-1)}/secret.png`, { root }), null);
  assert.equal(await mediaReferenceMetadata("linked.png", { root }), null);
});
