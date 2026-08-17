import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MODEL_TIERS } from "../../src/utils/modelPicker.js";

/**
 * Vision, exercised against the real models rather than a mock.
 *
 * The 2b/4b/9b tags gained a vision tower on 2026-08-14 (a separate `projector`
 * layer in the ollama manifest, 0.68–0.92 GB); the 27b has none. Nothing in the
 * unit suite proves an image ever reaches the tower — `ollama show` capability
 * flags and tokenizer contents both lie about this, so the only trustworthy
 * check is putting known pixels in and reading the answer out.
 *
 * Fixtures are GENERATED, not checked in. Prism is a public repository and the
 * real screenshots on hand are product UI; a solid-colour PNG also gives an
 * unarguable ground truth, where "describe this UI" would need a judge.
 *
 * Skips when Ollama or the tags are unavailable so CI stays green off-box.
 */

const OLLAMA = process.env.PRISM_LOCAL_LLM_URL ?? "http://localhost:11434";

/** Minimal RGB PNG encoder — no dependency, exact pixels, deterministic bytes. */
function makePng(width: number, height: number, rgb: (x: number, y: number) => [number, number, number]): Buffer {
    const raw = Buffer.alloc(height * (1 + width * 3));
    let o = 0;
    for (let y = 0; y < height; y++) {
        raw[o++] = 0; // filter: none
        for (let x = 0; x < width; x++) {
            const [r, g, b] = rgb(x, y);
            raw[o++] = r; raw[o++] = g; raw[o++] = b;
        }
    }
    const chunk = (type: string, data: Buffer) => {
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
        const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
        const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
        return Buffer.concat([len, td, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; ihdr[9] = 2; // 8-bit, truecolour
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", ihdr),
        chunk("IDAT", deflateSync(raw)),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}

let CRC_TABLE: number[] | null = null;
function crc32(buf: Buffer): number {
    if (!CRC_TABLE) {
        CRC_TABLE = [];
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            CRC_TABLE[n] = c;
        }
    }
    let c = 0xffffffff;
    for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
    return c ^ 0xffffffff;
}

const dir = mkdtempSync(join(tmpdir(), "prism-vision-"));
function fixture(name: string, png: Buffer): string {
    const p = join(dir, name);
    writeFileSync(p, png);
    return p;
}

const RED = fixture("red.png", makePng(320, 320, () => [220, 20, 20]));
const BLUE = fixture("blue.png", makePng(320, 320, () => [20, 40, 210]));
// Left half green, right half black — tests spatial reading, not just an average.
const SPLIT = fixture("split.png", makePng(320, 320, x => (x < 160 ? [20, 200, 60] : [0, 0, 0])));

// Generated fixtures are temp files; remove them so repeated runs do not
// accumulate PNGs in the system temp directory.
afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

let installed = new Set<string>();
let ollamaUp = false;

beforeAll(async () => {
    try {
        const res = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(3_000) });
        if (!res.ok) return;
        installed = new Set(((await res.json()) as { models: { name: string }[] }).models.map(m => m.name));
        ollamaUp = true;
    } catch { /* left false — every case skips */ }
});

function resolve(tag: string): string | null {
    if (installed.has(tag)) return tag;
    for (const a of installed) if (a.endsWith(`/${tag}`)) return a;
    return null;
}

async function describeImage(model: string, path: string, prompt: string): Promise<string> {
    const b64 = (await import("node:fs")).readFileSync(path).toString("base64");
    const res = await fetch(`${OLLAMA}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model, stream: false, think: false,
            messages: [{ role: "user", content: prompt, images: [b64] }],
            options: { num_predict: 128, temperature: 0 },
        }),
        signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) throw new Error(`ollama ${res.status}`);
    const data = (await res.json()) as { message?: { content?: string } };
    return (data.message?.content ?? "").toLowerCase();
}

/** Tiers whose ollama manifest carries a projector layer. */
const VISION_TIERS = ["prism-coder:2b", "prism-coder:4b", "prism-coder:9b"];

describe("vision tiers actually read pixels", () => {
    for (const tag of VISION_TIERS) {
        it(`${tag} names the dominant colour`, async ctx => {
            if (!ollamaUp || !resolve(tag)) return ctx.skip();
            const answer = await describeImage(resolve(tag)!, RED, "What single colour fills this image? Reply with just the colour name.");
            expect(answer, `${tag} did not see red: ${answer.slice(0, 120)}`).toMatch(/red|crimson|scarlet/);
        }, 200_000);

        it(`${tag} distinguishes a second colour (not a canned answer)`, async ctx => {
            if (!ollamaUp || !resolve(tag)) return ctx.skip();
            // Guards the failure mode a single-colour test cannot catch: a blind
            // model that always says "red" would pass the case above.
            const answer = await describeImage(resolve(tag)!, BLUE, "What single colour fills this image? Reply with just the colour name.");
            expect(answer, `${tag} answered without looking: ${answer.slice(0, 120)}`).toMatch(/blue|navy|azure/);
            expect(answer).not.toMatch(/\bred\b/);
        }, 200_000);
    }

    it("reads spatial layout, not just an average colour", async ctx => {
        const tag = resolve("prism-coder:9b");
        if (!ollamaUp || !tag) return ctx.skip();
        const answer = await describeImage(tag, SPLIT, "This image has two halves. What colour is the LEFT half? Reply with just the colour name.");
        expect(answer, `left half misread: ${answer.slice(0, 120)}`).toMatch(/green|lime/);
    }, 200_000);
});

describe("the tier table matches the artifacts", () => {
    it("every vision tier is present in MODEL_TIERS", () => {
        for (const tag of VISION_TIERS) {
            expect(MODEL_TIERS.some(t => t.tag === tag), `${tag} missing from MODEL_TIERS`).toBe(true);
        }
    });

    it("probeVision reports the projector layer truthfully", async ctx => {
        if (!ollamaUp) return ctx.skip();
        const { probeVision } = await import("../../src/tools/prismInferHandler.js");
        const blind = resolve("prism-coder:27b");
        const seeing = resolve("prism-coder:9b");
        if (blind) expect(await probeVision(OLLAMA, blind), "27b reported as vision-capable").toBe(false);
        if (seeing) expect(await probeVision(OLLAMA, seeing), "9b reported as blind").toBe(true);
    }, 60_000);

    it("never sends an image to a text-only tier", async ctx => {
        if (!ollamaUp || !resolve("prism-coder:27b")) return ctx.skip();
        // This is the guarantee that matters, and it has to be asserted at the
        // HANDLER, not at Ollama. Asked directly, the text-only 27b answers
        // "red" about a picture it cannot see — a confident, blind guess. The
        // handler must never give it the chance.
        const { runInfer, callOllamaGenerate } = await import("../../src/tools/prismInferHandler.js");
        const ent = await import("../../src/utils/entitlements.js");
        ent._setCacheForTest({
            plan: "enterprise", model_ceiling: "27b", daily_infer_limit: 99999,
            max_tokens: 2048, max_seats: 9,
            features: { cloud_fallback: false, grounding_verifier: false,
                        knowledge_search_unlimited: true, session_memory_unlimited: true,
                        analytics_dashboard: true },
            upgrade_url: "x",
        } as never, 600_000);

        const b64 = (await import("node:fs")).readFileSync(RED).toString("base64");
        let attempts: Array<{ tier: string; reason: string }> = [];
        try {
            await runInfer(
                { prompt: "What colour is this?", images: [b64], mode: "chat", model_ceiling: "27b" },
                {
                    freemem: () => 40 * 1024 ** 3,
                    listTags: async () => new Set([resolve("prism-coder:27b")!]), // only the blind tier
                    listLoaded: async () => new Set<string>(),
                    callLocal: callOllamaGenerate,
                    callCloud: async () => ({ ok: false as const, reason: "no_cloud" }),
                    ollamaUrl: OLLAMA,
                    callLayer1: async () => "OBVIOUS_NOT_RESERVED",
                } as never,
            );
        } catch (err) {
            attempts = JSON.parse(String((err as Error).message).match(/attempts=(\[.*?\])/s)?.[1] ?? "[]");
        } finally {
            ent._resetEntitlementsForTest();
        }
        expect(attempts.some(a => a.reason === "no_vision"),
               "an image was sent to a tier with no projector layer").toBe(true);
    }, 200_000);
});
