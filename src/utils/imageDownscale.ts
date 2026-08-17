/**
 * Shrink oversized screenshots before they reach a vision model.
 *
 * A native-resolution Retina capture is the dominant cost on the vision path,
 * and almost none of that cost buys accuracy. Measured 2026-08-15 against
 * prism-coder:9b on two real captures, ground truth read by hand, questions
 * chosen to target the finest text on screen:
 *
 *   real_capture.png 2992x1800  ->  5/5 at 2992 (16.4s), 5/5 at 1600 (7.2s),
 *                                   5/5 at 1200 (5.5s),  5/5 at 900 (7.3s)
 *   full_screen.png  2992x1934  ->  5/5 at 2992 (28.0s), 5/5 at 1200 (13.3s)
 *
 * Image tokens fall 4077 -> 1559 at a 1600 cap. On screenshots nothing was
 * lost: the 1200px render still reads "5.6 Sol", the smallest text on screen,
 * and the exact digits of a `-R 0,0,1600,900` argument in small mono.
 *
 * Screenshots are not the only input, so three other classes were measured
 * against a true native baseline (downscaling disabled), same questions:
 *
 *   photograph, 5712x4284 handheld, motion-blurred equipment label
 *       native 4/5 26.6s   ->   2000-capped 4/5 14.6s
 *   non-Latin, 7 scripts (zh/ja/ko/ru/el/he/ar)
 *       native 5/5 47.0s   ->   2000-capped 5/5 13.8s, no script degraded
 *   dense table, 34 rows x 11 cols
 *       native 8/8 21.0s   ->   2000-capped 5/5, 1600 7/8
 *
 * The two hard classes pull in OPPOSITE directions, which is why the cap is
 * not simply "as small as possible", reading a printed serial off the photo:
 *
 *   native  P1240625004551  wrong by one digit, 3/3
 *   2000    P1240625004551  identical to native, 3/3
 *   1600    P1240625004651  CORRECT 3/3 — the resample denoises the blur
 *
 * So 1600 is better on a blurry photo and worse on a dense table. The rule
 * that settles it: the cap must never make an answer worse than sending the
 * original. 2000 meets that on every class measured — it matches native where
 * it does not beat it. 1600 does not, so it is an opt-in, not the default.
 *
 * THE HAZARD THIS MODULE EXISTS TO AVOID
 * `sips -Z` resamples in BOTH directions. Handed an image already under the
 * cap it UPSCALES it. That shipped in 20.11.0 (`_enforce_max_edge`): every
 * macOS capture came out at exactly the cap on its long edge, a 1440x900
 * viewport written as 1900x1187, and every acceptance gate built on "this
 * screenshot is viewport-bound" had been reading a resampled image. Verified
 * still true 2026-08-15 — `sips -Z 1600` on a 900px file returns 1600px.
 *
 * So: measure first, shrink only, and verify the result actually got smaller
 * before accepting it. Every failure path returns the ORIGINAL bytes — a
 * slower correct answer beats a fast one about an image we mangled.
 *
 * BYTES CAN GROW EVEN AS PIXELS SHRINK. sips re-encodes, and on PNG that often
 * costs bytes: a real 2992x1934 capture went 877,949 -> 926,739 (+5.6%) at
 * 2000px, a rendered one +59%; JPEG behaves as advertised (1.38MB -> 0.40MB).
 * This is NOT a reason to keep the original — what the model charges for is
 * pixels, and prompt_eval_count on the same image fell 5163 -> 3654. It does
 * mean MAX_IMAGE_BYTES / MAX_IMAGE_BYTES_TOTAL, enforced in prepareImages
 * BEFORE this runs, bound the input rather than the final payload.
 *
 * EXIF ORIENTATION, checked by hand 2026-08-15 and not covered by a test:
 * an iPhone capture stores landscape pixels with orientation=6 and displays
 * portrait. `sips -Z` preserves that tag (5712x4284 orient=6 -> 1600x1200
 * orient=6), so photos do not arrive at the model rotated. Dimensions here are
 * read from the STORED pixels, which is what decode actually costs, so the cap
 * decision is consistent with what the resizer operates on.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Long-edge cap.
 *
 * 2000, not the faster 1600, because 1600 was measured LOSING data. On a dense
 * 34x11 table rendered at 2992px, "Q1 value for row 1" reads:
 *
 *   native  $4,265   correct      2000  $4,265  correct (3/3)
 *   2200    $4,265   correct      1600  $2,605  WRONG   (3/3)
 *   1900    $4,265   correct
 *
 * Not noise, not a refusal — a stable, confident misread of a number nobody
 * can eyeball-check. Every other cell survived 1600; this one did not, and on
 * a spreadsheet that is the whole value of the answer.
 *
 * 2000 also means a 1920-wide desktop capture passes through UNTOUCHED, which
 * is the second half of the 20.11.0 lesson: a 1900 cap rewrote the single most
 * common viewport width for no benefit.
 *
 * The remaining win is still large — a 2992px Retina capture drops from ~16-28s
 * to ~10s. Operators who want the extra second can set PRISM_MAX_IMAGE_EDGE.
 */
export const MAX_IMAGE_EDGE = 2000;

/** Bound the resizer. It is a 40-110ms operation; anything near this ceiling
 *  is a hung process, and waiting on it costs more than the resize saves. */
const RESIZE_TIMEOUT_MS = 5_000;

/** Smallest cap worth honouring. Below this an operator is not tuning, they
 *  have fat-fingered something, and obeying it would destroy the image. */
const MIN_SENSIBLE_EDGE = 256;

/**
 * Operator override: `PRISM_MAX_IMAGE_EDGE`.
 *
 * The measurements behind the 2000 default cover screenshots, one photograph,
 * a dense table and seven scripts — not every image anyone will ever send. An
 * off switch means a class this hurts can be fixed in an env var instead of a
 * release. `0`/`off`/`none` disables downscaling; garbage falls back to the
 * default rather than silently disabling a working feature.
 */
export function resolveMaxImageEdge(env: NodeJS.ProcessEnv = process.env): number {
    const raw = env.PRISM_MAX_IMAGE_EDGE?.trim().toLowerCase();
    if (!raw) return MAX_IMAGE_EDGE;
    if (raw === "0" || raw === "off" || raw === "none" || raw === "false") return 0;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < MIN_SENSIBLE_EDGE) return MAX_IMAGE_EDGE;
    return Math.floor(n);
}

export interface ImageDims { width: number; height: number }

/** Beyond this a "dimension" is a misparse, not an image. JPEG cannot exceed
 *  it at all, and no real PNG approaches it — treating an absurd value as
 *  unknown means the image passes through untouched, which is the safe
 *  direction. Without this bound a misread produces a gigantic number that
 *  trivially clears the cap check and gets a small image resampled.
 *
 *  Known cost, accepted: PNG permits 2^31-1 per axis, so a legitimate extreme
 *  panorama (measured: a valid 70000x20 PNG) is no longer downscaled. It is
 *  slower, never wrong, and the alternative — validating the IHDR tail's bit
 *  depth and colour type instead — buys back that rare case at the price of a
 *  bound that also catches misparse classes nobody has thought of yet. */
const MAX_PLAUSIBLE_DIMENSION = 65_535;

function sane(width: number, height: number): ImageDims | null {
    if (width <= 0 || height <= 0) return null;
    if (width > MAX_PLAUSIBLE_DIMENSION || height > MAX_PLAUSIBLE_DIMENSION) return null;
    return { width, height };
}

/**
 * Read pixel dimensions from an image header.
 *
 * PNG and JPEG only — those are what screen captures are. Any other format
 * (GIF, WebP, HEIC, TIFF) returns null and is passed through untouched rather
 * than guessed at. A wrong dimension read is worse than no downscale: it is
 * how an image gets upscaled or skipped incorrectly.
 */
export function readImageDimensions(buf: Buffer): ImageDims | null {
    // PNG: 8-byte signature, then a chunk list. IHDR is REQUIRED to be first by
    // the spec — and Apple ships PNGs that break that rule. Xcode's pngcrush
    // emits a 4-byte `CgBI` chunk ahead of IHDR; 105 such files exist under
    // /Applications and /System on this machine, and macOS decodes them fine.
    //
    // Reading width/height from fixed offsets 16/20 lands on the CgBI payload
    // for those files. Measured on a real 1920x1080 Apple asset: 1342185478 x
    // 750286694, which sails past the "already under the cap" check and gets
    // the image UPSCALED to 2000x1125 — the exact 20.11.0 regression this
    // module exists to prevent, reintroduced through the back door because the
    // shrink-verification compares against the MISPARSED dimensions, not real
    // ones. So find IHDR by walking the chunk list rather than assuming it.
    if (buf.length >= 24
        && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
        && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) {
        let off = 8;
        // Bounded: every iteration advances by at least 12 bytes.
        while (off + 12 <= buf.length) {
            const chunkLen = buf.readUInt32BE(off);
            // latin1, not ascii: ascii masks the high bit, so chunk-type bytes
            // C9 C8 C4 D2 decode to "IHDR" and a forged chunk placed before the
            // real one wins. Not reachable through this pipeline today — such a
            // file is undecodable, sips refuses it and the resize fails open —
            // but the parser should not depend on the next stage catching it.
            const type = buf.toString("latin1", off + 4, off + 8);
            if (type === "IHDR") {
                if (chunkLen < 13 || off + 8 + 13 > buf.length) return null;
                return sane(buf.readUInt32BE(off + 8), buf.readUInt32BE(off + 12));
            }
            // A length that overflows the buffer means we cannot trust the walk.
            if (chunkLen > buf.length) return null;
            off += 12 + chunkLen;
        }
        return null;
    }

    // JPEG: walk the marker chain to a Start-Of-Frame. Dimensions are NOT at a
    // fixed offset — EXIF/ICC segments precede the frame and vary in size.
    if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
        let off = 2;
        while (off + 9 < buf.length) {
            // Advance to the next marker byte. Note this does NOT correctly skip
            // a legal run of 0xFF fill bytes before a marker — such a run is read
            // as a segment header and the parse gives up. That returns null, so
            // the image passes through un-downscaled: slower, never wrong.
            if (buf[off] !== 0xff) { off++; continue; }
            const marker = buf[off + 1];
            // SOF0-3, SOF5-7, SOF9-11, SOF13-15 carry dimensions. C4/C8/CC are
            // DHT/JPG/DAC — same numeric range, NOT frame headers.
            if (marker >= 0xc0 && marker <= 0xcf
                && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
                return sane(buf.readUInt16BE(off + 7), buf.readUInt16BE(off + 5));
            }
            if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { off += 2; continue; }
            const segLen = buf.readUInt16BE(off + 2);
            if (segLen < 2) return null;      // malformed; do not loop forever
            off += 2 + segLen;
        }
        return null;
    }

    return null;
}

export interface DownscaleDeps {
    platform: string;
    /** Resize `input` to fit `cap` on its long edge, writing `output`. */
    resize: (input: string, output: string, cap: number) => Promise<void>;
    tmpDir: string;
    readFile: (p: string) => Promise<Buffer>;
    writeFile: (p: string, b: Buffer) => Promise<void>;
    unlink: (p: string) => Promise<void>;
    uniqueId: () => string;
}

async function sipsResize(input: string, output: string, cap: number): Promise<void> {
    // Fixed absolute path, argv array, no shell — a caller-controlled filename
    // must never reach a command line.
    await execFileAsync("/usr/bin/sips", ["-Z", String(cap), input, "--out", output], {
        timeout: RESIZE_TIMEOUT_MS,
    });
}

export async function productionDownscaleDeps(): Promise<DownscaleDeps> {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const crypto = await import("node:crypto");
    return {
        platform: process.platform,
        resize: sipsResize,
        tmpDir: os.tmpdir(),
        readFile: (p) => fs.readFile(p),
        writeFile: (p, b) => fs.writeFile(p, b),
        unlink: (p) => fs.unlink(p),
        uniqueId: () => crypto.randomUUID(),
    };
}

/**
 * Downscale one base64 image if — and only if — it exceeds the cap.
 *
 * Returns the original string on every path that is not a verified shrink:
 * unreadable header, unsupported format, already small enough, no resizer on
 * this platform, resizer failure, or a result that did not actually get
 * smaller.
 */
export async function downscaleImage(
    b64: string,
    cap: number,
    deps: DownscaleDeps,
): Promise<{ b64: string; from?: ImageDims; to?: ImageDims }> {
    let buf: Buffer;
    try {
        buf = Buffer.from(b64, "base64");
    } catch {
        return { b64 };
    }
    if (buf.length === 0) return { b64 };
    if (cap <= 0) return { b64 };                                // disabled by operator

    const dims = readImageDimensions(buf);
    if (!dims) return { b64 };                                   // unknown format

    // THE GUARD. Everything above the cap shrinks; everything at or below it is
    // returned byte-identical. This is the 20.11.0 regression.
    if (Math.max(dims.width, dims.height) <= cap) return { b64, from: dims };

    // sips is the only resizer wired today. On any other platform the image
    // goes through at full size — slower, never wrong.
    if (deps.platform !== "darwin") return { b64, from: dims };

    const id = deps.uniqueId();
    const input = `${deps.tmpDir}/prism-img-${id}.in`;
    const output = `${deps.tmpDir}/prism-img-${id}.out`;
    try {
        await deps.writeFile(input, buf);
        await deps.resize(input, output, cap);
        const shrunk = await deps.readFile(output);
        const newDims = readImageDimensions(shrunk);
        // Verify rather than trust. If the resizer returned something we cannot
        // read, or something no smaller than what we gave it, keep the original.
        if (!newDims) return { b64, from: dims };
        if (Math.max(newDims.width, newDims.height) >= Math.max(dims.width, dims.height)) {
            return { b64, from: dims };
        }
        return { b64: shrunk.toString("base64"), from: dims, to: newDims };
    } catch {
        return { b64, from: dims };                              // fail open
    } finally {
        await deps.unlink(input).catch(() => {});
        await deps.unlink(output).catch(() => {});
    }
}

/** Downscale a list, preserving order and length. */
export async function downscaleImages(
    images: string[],
    cap: number,
    deps: DownscaleDeps,
): Promise<{ images: string[]; notes: string[] }> {
    const out: string[] = [];
    const notes: string[] = [];
    for (const img of images) {
        const r = await downscaleImage(img, cap, deps);
        out.push(r.b64);
        if (r.from && r.to) notes.push(`${r.from.width}x${r.from.height}->${r.to.width}x${r.to.height}`);
    }
    return { images: out, notes };
}
