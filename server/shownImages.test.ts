import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SHOWN_IMAGE_REF, detectFormat, imageDimensions, showImages } from "./shownImages.js";

// Smallest valid-looking PNG header: signature + IHDR carrying the size.
function pngHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "latin1");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

describe("shownImages", () => {
  it("detects formats by content and reads dimensions", () => {
    const png = pngHeader(1024, 768);
    assert.equal(detectFormat(png), "png");
    assert.deepEqual(imageDimensions(png, "png"), { width: 1024, height: 768 });

    const gif = Buffer.from("GIF89a\x40\x01\xf0\x00", "latin1");
    assert.equal(detectFormat(gif), "gif");
    assert.deepEqual(imageDimensions(gif, "gif"), { width: 320, height: 240 });

    const svg = Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"></svg>');
    assert.equal(detectFormat(svg), "svg");
    assert.deepEqual(imageDimensions(svg, "svg"), { width: 200, height: 100 });

    assert.equal(detectFormat(Buffer.from("hello world")), null);
  });

  it("snapshots images and returns text-only references, one line per path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shown-"));
    const store = join(dir, "store");
    try {
      const png = join(dir, "shot.png");
      const txt = join(dir, "notes.txt");
      await writeFile(png, pngHeader(640, 480));
      await writeFile(txt, "not an image");

      const { text, shown } = await showImages([png, join(dir, "missing.png"), txt], store);
      const lines = text.split("\n");
      assert.equal(shown, 1);
      assert.equal(lines.length, 3);
      assert.match(lines[0], /^Displayed shot\.png \(640×480\) to the user\. \[shown:[a-f0-9]{32}\.png\]$/);
      assert.match(lines[1], /file not found/);
      assert.match(lines[2], /not a png, jpg, gif, webp or svg image/);

      // The snapshot is the only file stored, under the referenced name.
      const ref = SHOWN_IMAGE_REF.exec(lines[0])?.[1];
      assert.deepEqual(await readdir(store), [ref]);

      // Showing the same bytes again reuses the snapshot.
      await showImages([png], store);
      assert.deepEqual(await readdir(store), [ref]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects relative paths", async () => {
    const { text, shown } = await showImages(["shot.png"]);
    assert.equal(shown, 0);
    assert.match(text, /path must be absolute/);
  });
});
