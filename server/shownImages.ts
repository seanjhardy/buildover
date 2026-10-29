/**
 * shownImages.ts — storage behind the ShowImage tool.
 *
 * ShowImage puts an image in front of the user without the model ever seeing
 * it. At call time the file is copied into ~/.buildover/shown-images under a
 * content hash, and the tool result the model gets is one line of text per
 * image carrying that hash as a reference (`[shown:<hash>.<ext>]`). The client
 * reads the reference out of the stored tool result and loads the snapshot from
 * /api/shown-images/<hash>.<ext>.
 *
 * Snapshotting (rather than serving the original path) means the image survives
 * the source being moved, overwritten or deleted, and the serving endpoint can
 * only ever read files this module wrote: names are validated against
 * SHOWN_IMAGE_NAME, so there is no way to ask it for an arbitrary path.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";

export const SHOWN_IMAGES_DIR = join(homedir(), ".buildover", "shown-images");

/** Largest file ShowImage will snapshot. */
const MAX_BYTES = 25 * 1024 * 1024;

export type ShownImageFormat = "png" | "jpg" | "gif" | "webp" | "svg";

export const SHOWN_IMAGE_MIME: Record<ShownImageFormat, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

/** A snapshot's file name: 32 hex chars of sha256 plus the detected format. */
export const SHOWN_IMAGE_NAME = /^[a-f0-9]{32}\.(png|jpg|gif|webp|svg)$/;

/** The reference the tool result carries for each displayed image. */
export const SHOWN_IMAGE_REF = /\[shown:([a-f0-9]{32}\.(?:png|jpg|gif|webp|svg))\]/;

/** Identifies the format from the file's bytes, not its extension. */
export function detectFormat(buf: Buffer): ShownImageFormat | null {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47) return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.toString("latin1", 0, 6))) return "gif";
  if (
    buf.length >= 12 &&
    buf.toString("latin1", 0, 4) === "RIFF" &&
    buf.toString("latin1", 8, 12) === "WEBP"
  ) {
    return "webp";
  }
  const head = buf.toString("utf8", 0, Math.min(buf.length, 4096)).replace(/^﻿/, "");
  if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*<svg[\s>]/i.test(head)) return "svg";
  return null;
}

/** Pixel dimensions read from the image header, or null when they can't be. */
export function imageDimensions(
  buf: Buffer,
  format: ShownImageFormat,
): { width: number; height: number } | null {
  try {
    switch (format) {
      case "png":
        return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
      case "gif":
        return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
      case "jpg": {
        // Walk the marker segments to the first start-of-frame.
        let i = 2;
        while (i + 9 < buf.length) {
          if (buf[i] !== 0xff) return null;
          const marker = buf[i + 1];
          if (marker === 0xff) { i += 1; continue; }
          const len = buf.readUInt16BE(i + 2);
          const isSof =
            marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
          if (isSof) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
          i += 2 + len;
        }
        return null;
      }
      case "webp": {
        const chunk = buf.toString("latin1", 12, 16);
        if (chunk === "VP8X") {
          return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
        }
        if (chunk === "VP8L") {
          const bits = buf.readUInt32LE(21);
          return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
        }
        if (chunk === "VP8 ") {
          return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
        }
        return null;
      }
      case "svg": {
        const tag = /<svg\b[^>]*>/i.exec(buf.toString("utf8", 0, Math.min(buf.length, 8192)))?.[0];
        if (!tag) return null;
        const attr = (n: string) => new RegExp(`\\s${n}\\s*=\\s*["']\\s*([\\d.]+)(px)?\\s*["']`, "i").exec(tag)?.[1];
        const w = attr("width");
        const h = attr("height");
        if (w && h) return { width: Math.round(Number(w)), height: Math.round(Number(h)) };
        const vb = /\sviewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(tag);
        if (vb) return { width: Math.round(Number(vb[1])), height: Math.round(Number(vb[2])) };
        return null;
      }
    }
  } catch {
    return null;
  }
}

export interface ShownImage {
  /** Snapshot file name, e.g. `0123…abcd.png`. */
  name: string;
  format: ShownImageFormat;
  width?: number;
  height?: number;
}

/**
 * Copies an image into the shown-images store and returns its reference.
 * Throws a readable Error when the path is unusable; the tool reports that to
 * the model as text.
 */
export async function snapshotImage(path: string, dir = SHOWN_IMAGES_DIR): Promise<ShownImage> {
  if (!isAbsolute(path)) throw new Error("path must be absolute");
  const info = await stat(path).catch(() => null);
  if (!info) throw new Error("file not found");
  if (!info.isFile()) throw new Error("not a file");
  if (info.size > MAX_BYTES) throw new Error(`file is larger than ${MAX_BYTES / 1024 / 1024} MB`);
  const buf = await readFile(path);
  const format = detectFormat(buf);
  if (!format) throw new Error("not a png, jpg, gif, webp or svg image");
  const name = `${createHash("sha256").update(buf).digest("hex").slice(0, 32)}.${format}`;
  await mkdir(dir, { recursive: true });
  // Content-addressed, so an existing snapshot with this name is identical.
  const existing = await stat(join(dir, name)).catch(() => null);
  if (!existing) await writeFile(join(dir, name), buf);
  const dims = imageDimensions(buf, format);
  return { name, format, ...(dims ? dims : {}) };
}

/**
 * Snapshots each path and builds the tool's text result: one line per input
 * path, in order, so the client can pair line i with paths[i]. The image
 * bytes never appear in it.
 */
export async function showImages(
  paths: string[],
  dir = SHOWN_IMAGES_DIR,
): Promise<{ text: string; shown: number }> {
  let shown = 0;
  const lines: string[] = [];
  for (const p of paths) {
    try {
      const img = await snapshotImage(p, dir);
      const size = img.width && img.height ? ` (${img.width}×${img.height})` : "";
      lines.push(`Displayed ${basename(p)}${size} to the user. [shown:${img.name}]`);
      shown++;
    } catch (e) {
      lines.push(`Could not display ${p}: ${e instanceof Error ? e.message : String(e)}.`);
    }
  }
  return { text: lines.join("\n"), shown };
}
