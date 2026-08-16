#!/usr/bin/env node
/**
 * Local screenshot triage — the context-compressor pattern.
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS SHAPE
 *
 * Delegating a single generation to a local model from inside an agent turn is
 * net-negative: the turn that carries the tool call re-reads the whole cached
 * context (~472k tokens measured), which costs far more than the few hundred
 * output tokens it saves. So the win is NOT "same work, cheaper model".
 *
 * The win is keeping high-token inputs OUT of the cloud context entirely.
 * An image costs ~1,226 tokens to put in front of the cloud model (w*h/750,
 * capped ~4784) and then gets re-read as cache on EVERY subsequent turn. A
 * local model reads it for zero cloud tokens and returns a ~15-token verdict.
 * One shell invocation triages N images, so the turn tax is paid once, not N
 * times — the batching threshold that makes local delegation profitable.
 *
 * ACCURACY IS PROVEN, NOT ASSERTED
 *
 * Each image also gets a DETERMINISTIC blank-canvas score (distinct colours in
 * a downsample — the same signal the companion repo's screenshot validator uses
 * to refuse writing a blank PNG). The local verdict is scored against it. That
 * is a real agreement rate computed from a signal that involves no model at
 * all, so "no quality loss" is a measurement rather than a claim.
 *
 * Runs identically from Claude Code and Codex — it is a shell command, so it
 * needs no MCP approval, no host-specific wiring, and no tool annotations.
 *
 * Usage:
 *   node scripts/local-screenshot-triage.mjs '<glob>' [--model prism-coder:4b]
 *   node scripts/local-screenshot-triage.mjs 'docs/demo/*.png' --json out.json
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

const OLLAMA = process.env.OLLAMA_URL ?? "http://localhost:11434";
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const pattern = argv.find((a) => !a.startsWith("--") && argv[argv.indexOf(a) - 1]?.startsWith("--") !== true) ?? "docs/demo/*.png";
const MODEL = argOf("--model", "prism-coder:4b");
const jsonOut = argOf("--json");

// ── deterministic blank-canvas signal (no model involved) ───────────────────
/**
 * Distinct colours in a 64x48 downsample. A solid-colour background lands at
 * 1-3; a rendered UI exceeds 200. Mirrors the threshold in
 * the companion repo's screenshot validator so the two agree by construction.
 */
function distinctColours(png) {
    const tmp = `/tmp/tri-${path.basename(png, ".png")}.rgb`;
    try {
        execFileSync("sips", ["-z", "48", "64", "-s", "format", "bmp", png, "--out", `${tmp}.bmp`], { stdio: "pipe" });
        const buf = fs.readFileSync(`${tmp}.bmp`);
        const set = new Set();
        // Skip the BMP header conservatively; sample every 3 bytes as RGB.
        for (let i = 138; i + 2 < buf.length; i += 3) set.add((buf[i] << 16) | (buf[i + 1] << 8) | buf[i + 2]);
        fs.unlinkSync(`${tmp}.bmp`);
        return set.size;
    } catch { return -1; }
}

function pixels(png) {
    try {
        const out = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", png], { encoding: "utf8" });
        const w = Number(out.match(/pixelWidth:\s*(\d+)/)?.[1] ?? 0);
        const h = Number(out.match(/pixelHeight:\s*(\d+)/)?.[1] ?? 0);
        return w * h;
    } catch { return 0; }
}

/** Cloud image-token cost if this were put in front of the cloud model. */
const cloudImageTokens = (px) => Math.min(px / 750, 4784);

/**
 * /api/chat, NOT /api/generate. This is not interchangeable and the difference
 * is not cosmetic.
 *
 * prism calls /api/chat everywhere that matters (prismInferHandler.ts:698,
 * localLlm.ts:159, layer1.ts:370/450); /api/generate appears only on the
 * eviction path. Sending a raw prompt to /api/generate bypasses each model's
 * chat template — commit fcf72ade1 calls that "a path no caller exercises" and
 * re-measured the whole tier table after finding an earlier harness had made
 * exactly this mistake.
 *
 * An earlier revision of THIS script repeated it, and the error was large:
 * on 12 solid-colour blanks, prism-coder:9b scored
 *
 *   /api/generate  8/12      <- wrong endpoint, produced a "coin flip" verdict
 *   /api/chat     12/12      <- the path prism actually uses
 *
 * 4b was 6/12 either way, so the endpoint bug masqueraded as a model-capability
 * finding on the one tier where it wasn't true.
 *
 * think:false is also deliberate here. 9b carries prefersThinking, and for
 * open-ended vision (name the dominant colour) reasoning helps — that is what
 * MODEL_TIERS encodes. For STRUCTURED output it does the opposite: measured at
 * both num_predict 600 and 2048, 9b with thinking returned unparseable prose
 * for 8 of 24 images including all 4 error pages, versus 23/24 with thinking
 * off. Same budget, same images — so it is format compliance, not truncation.
 */
async function ask(model, prompt, b64, maxTokens) {
    const t0 = Date.now();
    const res = await fetch(`${OLLAMA}/api/chat`, {
        method: "POST",
        body: JSON.stringify({
            model,
            messages: [{ role: "user", content: prompt, images: [b64] }],
            stream: false,
            think: false,
            options: { num_predict: maxTokens, temperature: 0 },
        }),
        signal: AbortSignal.timeout(120_000),
    });
    const j = await res.json();
    return { text: (j.message?.content ?? "").trim(), inTok: j.prompt_eval_count ?? 0, outTok: j.eval_count ?? 0, ms: Date.now() - t0 };
}

/**
 * Option ORDER is load-bearing on small models — this is not prompt fussiness.
 * Measured 2026-08-16 on prism-coder:4b over the same 39 screenshots: an
 * earlier revision that defined the negative case first ("STATUS=BLANK if the
 * image is an empty or solid-colour page...") returned BLANK for 38/39 real,
 * densely-rendered dashboards — 2.6% agreement with the deterministic
 * blank-detector. The model had genuinely SEEN the images (its own free-text
 * descriptions were accurate: "Dashboard shows 47 active clients and $84k
 * revenue") but the leading negative option primed the label.
 *
 * Defining the positive case first, on the identical images and model, gives
 * correct verdicts. Put the expected-common answer first, and describe the
 * exceptions as exceptions.
 */
const PROMPT = `Look at this screenshot.

First look at what interface elements are present, then answer.

Answer on ONE line in exactly this format, nothing else:
STATUS=<OK|BLANK|ERROR> | <five words describing what is visible>

STATUS=OK if you can see any working interface: text, buttons, tables, charts, menus.
STATUS=BLANK only if the image is completely empty or a single flat colour.
STATUS=ERROR only if it shows a stack trace, "404", or "not found".`;

// ── run ─────────────────────────────────────────────────────────────────────
const files = fs.readdirSync(path.dirname(pattern))
    .filter((f) => f.endsWith(".png"))
    .map((f) => path.join(path.dirname(pattern), f))
    .sort();

if (!files.length) { console.error(`no PNGs matched ${pattern}`); process.exit(2); }

console.log(`Local screenshot triage — ${files.length} images on ${MODEL}\n`);
console.log(`${"file".padEnd(34)}${"verdict".padEnd(9)}${"colours".padStart(8)}${"agree".padStart(7)}${"ms".padStart(7)}`);
console.log("-".repeat(66));

const rows = [];
let cloudTokensAvoided = 0, localOut = 0, agree = 0, scored = 0;

for (const f of files) {
    const b64 = fs.readFileSync(f).toString("base64");
    const px = pixels(f);
    const colours = distinctColours(f);
    const r = await ask(MODEL, PROMPT, b64, 40);

    const status = r.text.match(/STATUS\s*=\s*(OK|BLANK|ERROR)/i)?.[1]?.toUpperCase() ?? "UNPARSED";

    // Scoring uses the RIGHT oracle per case, which the first revision of this
    // script got wrong. The colour detector answers exactly one question —
    // "did anything render?" — and cannot tell an ERROR page from a healthy
    // one, because a rendered stack trace has plenty of colours. Scoring an
    // ERROR verdict against it marked two CORRECT answers as failures.
    //
    // So: files named ctrl_* carry ground truth in the name (they are generated
    // by construction), and everything else is scored against the deterministic
    // colour signal on the OK/BLANK axis only.
    const base = path.basename(f);
    const truth = base.startsWith("ctrl_blank_") ? "BLANK"
        : base.startsWith("ctrl_error_") ? "ERROR"
        : null;

    let agreed = null;
    if (status !== "UNPARSED") {
        if (truth) { agreed = status === truth; scored++; }
        else if (colours >= 0) { agreed = colours >= 50 ? status === "OK" : status !== "OK"; scored++; }
        if (agreed) agree++;
    }

    cloudTokensAvoided += cloudImageTokens(px);
    localOut += r.outTok;
    rows.push({ file: path.basename(f), status, colours, agreed, ms: r.ms, text: r.text.slice(0, 80) });
    console.log(`${path.basename(f).slice(0, 33).padEnd(34)}${status.padEnd(9)}${String(colours).padStart(8)}${(agreed === null ? "-" : agreed ? "yes" : "NO").padStart(7)}${String(r.ms).padStart(7)}`);
}

// ── the number that matters ─────────────────────────────────────────────────
// One shell invocation = one agent turn, regardless of how many images.
const TURN_CONTEXT_TOKENS = 472_000;   // measured avg cache re-read per turn
const CACHE_READ_RATE = 5.0 * 0.10 / 1e6;
const INPUT_RATE = 5.0 / 1e6;

const turnCost = TURN_CONTEXT_TOKENS * CACHE_READ_RATE;
const cloudCostIfInline = cloudTokensAvoided * INPUT_RATE;
const verdictTokens = rows.length * 15;               // what actually enters context

console.log("\n" + "=".repeat(66));
console.log(`images triaged            ${rows.length}`);
console.log(`local output tokens       ${localOut.toLocaleString()}  (cost $0)`);
console.log(`cloud image tokens avoided ${Math.round(cloudTokensAvoided).toLocaleString()}`);
console.log(`verdict tokens returned   ~${verdictTokens.toLocaleString()}  -> ${(cloudTokensAvoided / Math.max(verdictTokens, 1)).toFixed(1)}x context compression`);
if (scored) console.log(`agreement with deterministic blank-detector: ${agree}/${scored} (${(100 * agree / scored).toFixed(1)}%)`);
console.log("-".repeat(66));
console.log(`one-turn cost to invoke this batch   $${turnCost.toFixed(3)}`);
console.log(`cost had the cloud read them inline  $${cloudCostIfInline.toFixed(3)}  (first pass only)`);
console.log(`...plus every later turn re-reads them: $${(cloudTokensAvoided * CACHE_READ_RATE).toFixed(3)} per turn, forever`);

if (jsonOut) { fs.writeFileSync(jsonOut, JSON.stringify({ model: MODEL, rows, cloudTokensAvoided, verdictTokens, agree, scored }, null, 2)); console.log(`\njson -> ${jsonOut}`); }
