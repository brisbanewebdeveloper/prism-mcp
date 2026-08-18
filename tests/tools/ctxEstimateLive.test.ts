import { describe, it, expect, beforeAll } from "vitest";
import { randomBytes } from "node:crypto";
import { estimateTokens } from "../../src/utils/inferenceMetrics.js";

/**
 * LIVE proof for the ctx-gate estimate and the truncation detector. Run with:
 *
 *   PRISM_LIVE_TEST=1 npx vitest run tests/tools/ctxEstimateLive.test.ts
 *
 * Everything here needs a real tokenizer. The mocked suite can pin the
 * arithmetic — that a collapsed prompt_eval_count is treated as truncation —
 * but it cannot tell you what any given payload actually tokenises to, and that
 * is the whole question. The numbers in the source comments came from runs like
 * this one; this file re-derives them instead of trusting them.
 *
 * Why it matters: the estimate feeds the §5.4 ctx gate, so UNDERCOUNTING gets
 * an oversized prompt accepted, silently truncated by ollama, and answered from
 * whatever survived — with a normal done_reason. Overcounting only costs an
 * escalation.
 */

const LIVE = !!process.env.PRISM_LIVE_TEST;
const OLLAMA = process.env.PRISM_LOCAL_LLM_URL ?? "http://localhost:11434";
const MODEL = "prism-coder:4b";

async function evaluatedTokens(text: string): Promise<number> {
    const res = await fetch(`${OLLAMA}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model: MODEL,
            messages: [{ role: "user", content: text }],
            stream: false, think: false,
            options: { num_predict: 1, temperature: 0 },
        }),
    });
    const json = await res.json() as { prompt_eval_count?: number };
    return json.prompt_eval_count ?? 0;
}

async function liveNumCtx(): Promise<number> {
    const res = await fetch(`${OLLAMA}/api/show`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: MODEL }),
    });
    const json = await res.json() as { parameters?: string };
    const m = /^\s*num_ctx\s+(\d+)\s*$/m.exec(json.parameters ?? "");
    return m ? Number(m[1]) : 0;
}

describe.skipIf(!LIVE)("live: the ctx estimate against a real tokenizer", () => {
    beforeAll(async () => {
        // Fail loudly rather than passing vacuously if the model is absent.
        const res = await fetch(`${OLLAMA}/api/show`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: MODEL }),
        });
        if (!res.ok) throw new Error(`PRISM_LIVE_TEST=1 but ${MODEL} is unavailable at ${OLLAMA}`);
    }, 30_000);

    // The classes the divisors are tuned for. All must OVERCOUNT.
    //
    // "typescript" is here on measurement, not faith: this exact sample
    // tokenises at 2.92 chars/token and undercounted under the old 3.3 divisor.
    // That failure is what moved the divisor to 2.5.
    const mainstream: Array<[string, () => string]> = [
        ["prose", () => "The quarterly reconciliation report indicates the balance was adjusted. ".repeat(600)],
        ["typescript", () => "    const value = compute(input);\n    if (value > 0) { return { ok: true }; }\n".repeat(700)],
        ["minified source", () => "function a(b,c){return b?c:[b,c].map(x=>x*2).filter(Boolean)};".repeat(600)],
        ["dense JSON", () => JSON.stringify(Array.from({ length: 700 }, (_v, i) => ({ id: i, sku: "SKU-" + i, r: "north" })))],
        ["base64", () => randomBytes(24_000).toString("base64").slice(0, 40_000)],
    ];

    for (const [name, build] of mainstream) {
        it(`overcounts ${name} rather than undercounting it`, async () => {
            const text = build();
            const actual = await evaluatedTokens(text);
            expect(actual, "no token count returned — the model did not run").toBeGreaterThan(0);
            expect(estimateTokens(text), `${name}: estimate must not fall below the real token count`)
                .toBeGreaterThanOrEqual(actual);
        }, 120_000);
    }

    it("KNOWN GAP: indented dense data still undercounts", async () => {
        // ~1.95 chars/token while the code bucket assumes 2.5. Covering it needs
        // a divisor that would refuse ordinary source at half its real size, so
        // the truncation detector covers this instead of the estimate. Pinned so
        // the gap is a decision on record rather than folklore.
        const config = '  "key_x": "value",\n  "other_key": 42,\n'.repeat(1200);
        expect(estimateTokens(config)).toBeLessThan(await evaluatedTokens(config));
    }, 120_000);

    it("KNOWN GAP: unicode-heavy payloads still undercount", async () => {
        // Pinned deliberately rather than left as folklore. Rare CJK is counted
        // at 1 token/char and really costs ~1.9; symbol blocks are counted as
        // latin and really cost ~2.6. Tightening these would tax ordinary
        // Chinese text several-fold, so the truncation detector — not the
        // estimator — is what protects these payloads.
        //
        // If this test ever FAILS, the estimator got better and the expectation
        // should be moved up into `mainstream` above.
        const symbols = Array.from({ length: 12_000 }, (_v, i) => String.fromCodePoint(0x2200 + ((i * 131) % 2000))).join("");
        const actual = await evaluatedTokens(symbols);
        expect(estimateTokens(symbols)).toBeLessThan(actual);
    }, 120_000);

    it("truncation collapses the evaluated count to exactly num_ctx/2", async () => {
        // The signature the detector keys on. It does NOT saturate near num_ctx
        // — believing that is what made me call truncation undetectable.
        const ctx = await liveNumCtx();
        expect(ctx, "no live num_ctx to compare against").toBeGreaterThan(0);
        const huge = "The quarterly reconciliation report was adjusted. ".repeat(9_000);
        const evaluated = await evaluatedTokens(huge);
        expect(Math.abs(evaluated - Math.floor(ctx / 2)), `evaluated ${evaluated}, num_ctx/2 is ${Math.floor(ctx / 2)}`)
            .toBeLessThanOrEqual(8);
    }, 180_000);

    it("a payload that beats the estimator is caught by the collapse", async () => {
        // The case that makes the detector load-bearing rather than theoretical.
        // Emoji estimate at 1.5 tokens each and really cost more, so this clears
        // the ctx gate and is then truncated — exactly the situation the gate
        // cannot see, and exactly what the detector exists for.
        const ctx = await liveNumCtx();
        const emoji = "🜁🜂🜃🜄🝰🝱🝲🝳".repeat(2_500);
        const est = estimateTokens(emoji);
        const evaluated = await evaluatedTokens(emoji);
        expect(est, "payload no longer clears the ctx gate — pick a denser one").toBeLessThanOrEqual(ctx);
        expect(est, "detector floor requires an estimate of at least half a window").toBeGreaterThanOrEqual(Math.floor(ctx / 2));
        expect(Math.abs(evaluated - Math.floor(ctx / 2)), `evaluated ${evaluated} — not the truncation signature`)
            .toBeLessThanOrEqual(8);
    }, 180_000);
});
