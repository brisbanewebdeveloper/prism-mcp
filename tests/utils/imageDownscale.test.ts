import { describe, it, expect } from "vitest";
import { deflateSync } from "node:zlib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
    readImageDimensions,
    downscaleImage,
    downscaleImages,
    productionDownscaleDeps,
    resolveMaxImageEdge,
    MAX_IMAGE_EDGE,
    type DownscaleDeps,
} from "../../src/utils/imageDownscale.js";

const execFileAsync = promisify(execFile);

/** Build a REAL, decodable PNG. Header-only fixtures would let a broken
 *  resizer pass — the sips path has to be handed something it can open. */
function makePng(width: number, height: number): Buffer {
    const crcTable: number[] = [];
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crcTable[n] = c >>> 0;
    }
    const crc32 = (b: Buffer) => {
        let c = 0xffffffff;
        for (const byte of b) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
        return (c ^ 0xffffffff) >>> 0;
    };
    const chunk = (type: string, data: Buffer) => {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(data.length);
        const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(crc32(body));
        return Buffer.concat([len, body, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;    // bit depth
    ihdr[9] = 0;    // greyscale
    // One filter byte + one sample per pixel per row.
    const raw = Buffer.alloc((width + 1) * height);
    for (let y = 0; y < height; y++) {
        raw[y * (width + 1)] = 0;
        for (let x = 0; x < width; x++) raw[y * (width + 1) + 1 + x] = (x * 7 + y * 13) & 0xff;
    }
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", ihdr),
        chunk("IDAT", deflateSync(raw)),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}

function makeJpeg(width: number, height: number): Buffer {
    // SOI, a variable-length APP0 (so the frame is NOT at a fixed offset), SOF0.
    const app0 = Buffer.concat([
        Buffer.from([0xff, 0xe0, 0x00, 0x10]),
        Buffer.from("JFIF\0", "ascii"),
        Buffer.alloc(9),
    ]);
    const sof = Buffer.alloc(11);
    sof.writeUInt16BE(0xffc0, 0);
    sof.writeUInt16BE(8, 2);      // segment length
    sof[4] = 8;                   // precision
    sof.writeUInt16BE(height, 5);
    sof.writeUInt16BE(width, 7);
    return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
}

const b64 = (b: Buffer) => b.toString("base64");

function stubDeps(over: Partial<DownscaleDeps> = {}): DownscaleDeps {
    return {
        platform: "darwin",
        resize: async () => { throw new Error("resize not stubbed"); },
        tmpDir: "/tmp",
        readFile: async () => Buffer.alloc(0),
        writeFile: async () => {},
        unlink: async () => {},
        uniqueId: () => "test",
        ...over,
    };
}

describe("dimension reading", () => {
    it("reads PNG dimensions", () => {
        expect(readImageDimensions(makePng(2992, 1800))).toEqual({ width: 2992, height: 1800 });
    });

    it("reads JPEG dimensions past a variable-length APP0", () => {
        // A fixed-offset read would return the JFIF header bytes, not 1920x1080.
        expect(readImageDimensions(makeJpeg(1920, 1080))).toEqual({ width: 1920, height: 1080 });
    });

    it("does not mistake a DHT segment for a frame header", () => {
        // 0xC4 sits inside the SOF numeric range but is a Huffman table. Reading
        // it as a frame yields nonsense dimensions.
        const dht = Buffer.concat([
            Buffer.from([0xff, 0xd8]),
            Buffer.from([0xff, 0xc4, 0x00, 0x06, 0x00, 0x01, 0x02, 0x03]),
            (() => {
                const sof = Buffer.alloc(11);
                sof.writeUInt16BE(0xffc0, 0); sof.writeUInt16BE(8, 2); sof[4] = 8;
                sof.writeUInt16BE(720, 5); sof.writeUInt16BE(1280, 7);
                return sof;
            })(),
        ]);
        expect(readImageDimensions(dht)).toEqual({ width: 1280, height: 720 });
    });

    it("finds IHDR behind Apple's CgBI chunk instead of reading its payload", () => {
        // Xcode's pngcrush emits `CgBI` BEFORE IHDR, violating the spec; 105
        // such files exist under /Applications and /System on a stock Mac and
        // macOS decodes them fine. Reading fixed offset 16/20 returns
        // 1342185478x750286694 for a real 1920x1080 asset, which clears the cap
        // check and gets the image UPSCALED to 2000px — the 20.11.0 bug.
        const png = makePng(1920, 1080);
        const cgbi = Buffer.concat([
            png.subarray(0, 8),
            Buffer.from([0x00, 0x00, 0x00, 0x04]),          // length 4
            Buffer.from("CgBI", "ascii"),
            Buffer.from([0x50, 0x00, 0x20, 0x06]),          // the payload that misparses
            Buffer.alloc(4),                                 // crc
            png.subarray(8),
        ]);
        expect(readImageDimensions(cgbi)).toEqual({ width: 1920, height: 1080 });
    });

    it("does not accept a high-bit chunk type as IHDR", () => {
        // `toString("ascii")` masks the high bit, so bytes C9 C8 C4 D2 decode to
        // "IHDR" and a forged chunk placed first wins. Such a file is not
        // decodable and sips refuses it, so the pipeline fails open — but the
        // parser should not rely on a later stage to catch its own misread.
        const png = makePng(800, 600);
        const forgedIhdr = Buffer.alloc(13);
        forgedIhdr.writeUInt32BE(4000, 0);
        forgedIhdr.writeUInt32BE(3000, 4);
        const spoofed = Buffer.concat([
            png.subarray(0, 8),
            Buffer.from([0x00, 0x00, 0x00, 0x0d]),          // length 13
            Buffer.from([0xc9, 0xc8, 0xc4, 0xd2]),          // "IHDR" with the high bit set
            forgedIhdr,
            Buffer.alloc(4),                                 // crc
            png.subarray(8),
        ]);
        expect(readImageDimensions(spoofed)).toEqual({ width: 800, height: 600 });
    });

    it("rejects an absurd dimension rather than trusting it", () => {
        // Belt to the IHDR braces: any misparse that yields a huge number must
        // read as UNKNOWN (pass through untouched), never as "far above the cap,
        // go resize it".
        const png = makePng(100, 100);
        const forged = Buffer.from(png);
        forged.writeUInt32BE(1_342_185_478, 16);
        expect(readImageDimensions(forged)).toBeNull();
    });

    it("returns null for a format it does not parse", () => {
        expect(readImageDimensions(Buffer.from("GIF89a....", "ascii"))).toBeNull();
        expect(readImageDimensions(Buffer.from("not an image at all"))).toBeNull();
    });

    it("returns null rather than looping on a malformed JPEG segment", () => {
        const bad = Buffer.concat([
            Buffer.from([0xff, 0xd8]),
            Buffer.from([0xff, 0xe0, 0x00, 0x00]),   // segment length 0 -> would not advance
            Buffer.alloc(32),
        ]);
        expect(readImageDimensions(bad)).toBeNull();
    });
});

describe("the 20.11.0 regression: shrink only, never grow", () => {
    it("returns an under-cap image BYTE-IDENTICAL and never calls the resizer", async () => {
        // This is the whole bug. `sips -Z 1600` on a 900px file returns 1600px
        // (verified live 2026-08-15), so a 1440x900 viewport capture was being
        // rewritten to 1900x1187 and asserted as evidence of what rendered.
        let resizeCalls = 0;
        const small = b64(makePng(900, 540));
        const r = await downscaleImage(small, MAX_IMAGE_EDGE, stubDeps({
            resize: async () => { resizeCalls++; },
        }));
        expect(resizeCalls, "resized an image that was already under the cap").toBe(0);
        expect(r.b64, "under-cap image was not returned unchanged").toBe(small);
        expect(r.to).toBeUndefined();
    });

    it("leaves an image sitting exactly ON the cap untouched", async () => {
        let resizeCalls = 0;
        const exact = b64(makePng(MAX_IMAGE_EDGE, 900));
        const r = await downscaleImage(exact, MAX_IMAGE_EDGE, stubDeps({
            resize: async () => { resizeCalls++; },
        }));
        expect(resizeCalls).toBe(0);
        expect(r.b64).toBe(exact);
    });

    it("measures the LONG edge, not the width", async () => {
        // A tall narrow capture (800x2400) exceeds the cap vertically. Checking
        // width alone would pass it through at full size.
        let capSeen = 0;
        const tall = makePng(800, 2400);
        await downscaleImage(b64(tall), MAX_IMAGE_EDGE, stubDeps({
            resize: async (_i, _o, cap) => { capSeen = cap; },
            readFile: async () => makePng(533, 1600),
        }));
        expect(capSeen, "a tall image was never handed to the resizer").toBe(MAX_IMAGE_EDGE);
    });

    it("keeps the original when the resizer hands back something no smaller", async () => {
        // Verify rather than trust: if sips upscales or no-ops, we must not
        // accept the result just because the call succeeded.
        const big = b64(makePng(2992, 1800));
        const r = await downscaleImage(big, MAX_IMAGE_EDGE, stubDeps({
            resize: async () => {},
            readFile: async () => makePng(3200, 1925),   // grew
        }));
        expect(r.b64, "accepted an upscaled result").toBe(big);
        expect(r.to).toBeUndefined();
    });
});

describe("fail open — a slow correct answer beats a fast mangled one", () => {
    it("passes the original through when the resizer throws", async () => {
        const big = b64(makePng(2992, 1800));
        const r = await downscaleImage(big, MAX_IMAGE_EDGE, stubDeps({
            resize: async () => { throw new Error("sips exploded"); },
        }));
        expect(r.b64).toBe(big);
    });

    it("passes the original through on a non-darwin platform", async () => {
        let resizeCalls = 0;
        const big = b64(makePng(2992, 1800));
        const r = await downscaleImage(big, MAX_IMAGE_EDGE, stubDeps({
            platform: "linux",
            resize: async () => { resizeCalls++; },
        }));
        expect(resizeCalls).toBe(0);
        expect(r.b64).toBe(big);
    });

    it("passes through an unparseable format untouched", async () => {
        const gif = Buffer.from("GIF89a" + "x".repeat(200)).toString("base64");
        const r = await downscaleImage(gif, MAX_IMAGE_EDGE, stubDeps());
        expect(r.b64).toBe(gif);
    });

    it("cleans up both temp files even when the resizer throws", async () => {
        const unlinked: string[] = [];
        await downscaleImage(b64(makePng(2992, 1800)), MAX_IMAGE_EDGE, stubDeps({
            resize: async () => { throw new Error("boom"); },
            unlink: async (p) => { unlinked.push(p); },
        }));
        expect(unlinked).toHaveLength(2);
    });
});

describe("list handling", () => {
    it("preserves order and length", async () => {
        const a = b64(makePng(100, 100));
        const b = b64(makePng(2992, 1800));
        const c = b64(makePng(200, 200));
        const r = await downscaleImages([a, b, c], MAX_IMAGE_EDGE, stubDeps({
            resize: async () => {},
            readFile: async () => makePng(1600, 963),
        }));
        expect(r.images).toHaveLength(3);
        expect(r.images[0]).toBe(a);
        expect(r.images[2]).toBe(c);
        expect(r.images[1]).not.toBe(b);
        expect(r.notes).toEqual(["2992x1800->1600x963"]);
    });
});

describe("the cap itself", () => {
    it("is 2000 — 1600 was measured returning a confidently wrong number", () => {
        // On a dense 34x11 table at 2992px, "Q1 for row 1" reads $4,265 at
        // native/2200/2000/1900 and $2,605 at 1600, three runs out of three.
        // Lowering this for speed trades a second for a silently wrong cell.
        expect(MAX_IMAGE_EDGE).toBe(2000);
    });

    it("leaves a 1920-wide desktop capture untouched", async () => {
        // The other half of the 20.11.0 lesson: a 1900 cap rewrote the most
        // common viewport width in existence for no benefit.
        let resizeCalls = 0;
        const shot = b64(makePng(1920, 1080));
        const r = await downscaleImage(shot, MAX_IMAGE_EDGE, stubDeps({
            resize: async () => { resizeCalls++; },
        }));
        expect(resizeCalls).toBe(0);
        expect(r.b64).toBe(shot);
    });
});

describe("operator override", () => {
    it("defaults to the measured cap when unset or blank", () => {
        expect(resolveMaxImageEdge({} as NodeJS.ProcessEnv)).toBe(MAX_IMAGE_EDGE);
        expect(resolveMaxImageEdge({ PRISM_MAX_IMAGE_EDGE: "  " } as NodeJS.ProcessEnv)).toBe(MAX_IMAGE_EDGE);
    });

    it("accepts an explicit cap", () => {
        expect(resolveMaxImageEdge({ PRISM_MAX_IMAGE_EDGE: "1200" } as NodeJS.ProcessEnv)).toBe(1200);
    });

    it("turns downscaling off", () => {
        for (const v of ["0", "off", "none", "false", "OFF"]) {
            expect(resolveMaxImageEdge({ PRISM_MAX_IMAGE_EDGE: v } as NodeJS.ProcessEnv)).toBe(0);
        }
    });

    it("a zero cap passes even a huge image through untouched", async () => {
        let resizeCalls = 0;
        const big = b64(makePng(5712, 4284));
        const r = await downscaleImage(big, 0, stubDeps({ resize: async () => { resizeCalls++; } }));
        expect(resizeCalls).toBe(0);
        expect(r.b64).toBe(big);
    });

    it("falls back to the default on garbage rather than silently disabling", () => {
        // "abc" reading as 0 would turn the feature off for anyone with a typo.
        for (const v of ["abc", "-500", "12", "NaN"]) {
            expect(resolveMaxImageEdge({ PRISM_MAX_IMAGE_EDGE: v } as NodeJS.ProcessEnv)).toBe(MAX_IMAGE_EDGE);
        }
    });
});

describe("the real resizer", () => {
    const onMac = process.platform === "darwin";

    it.runIf(onMac)("actually shrinks an oversized PNG through sips", async () => {
        const deps = await productionDownscaleDeps();
        const r = await downscaleImage(b64(makePng(2992, 1800)), MAX_IMAGE_EDGE, deps);
        expect(r.to, "sips produced no usable smaller image").toBeDefined();
        expect(Math.max(r.to!.width, r.to!.height)).toBeLessThanOrEqual(MAX_IMAGE_EDGE);
        expect(r.to!.width / r.to!.height).toBeCloseTo(2992 / 1800, 1);   // aspect kept
    });

    it.runIf(onMac)("confirms sips itself STILL upscales — the reason for the guard", async () => {
        // If a future sips stops doing this, the guard is merely redundant. If
        // this test ever fails, that assumption changed; the guard stays either
        // way, but the comment explaining it would be stale.
        const fs = await import("node:fs/promises");
        const os = await import("node:os");
        const dir = os.tmpdir();
        const inp = `${dir}/prism-sips-upscale-check.png`;
        const outp = `${dir}/prism-sips-upscale-check-out.png`;
        try {
            await fs.writeFile(inp, makePng(900, 540));
            await execFileAsync("/usr/bin/sips", ["-Z", "1600", inp, "--out", outp]);
            const dims = readImageDimensions(await fs.readFile(outp));
            expect(dims!.width, "sips no longer upscales; guard comment is stale").toBe(1600);
        } finally {
            await fs.unlink(inp).catch(() => {});
            await fs.unlink(outp).catch(() => {});
        }
    });
});
