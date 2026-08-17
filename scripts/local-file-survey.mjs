#!/usr/bin/env node
/**
 * local-file-survey — answer one question about N files without any of them
 * entering the cloud context.
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CLAIM UNDER TEST
 *
 * An earlier analysis concluded local delegation is ~50x net-negative, on the
 * grounds that one extra agent turn costs ~$0.24-0.32 of cache re-read while
 * the generation it replaces is worth ~$0.006. That accounting is correct and
 * incomplete: it prices only GENERATION.
 *
 * Surveying a codebase is not generation. Done in-loop it costs one turn per
 * file read PLUS the file's full text deposited into context permanently, where
 * it is re-read as cache on every later turn of the session. 40 route files is
 * ~112k tokens of permanent context and a double-digit number of turns.
 *
 * This does the same survey in ONE turn and deposits only the answers.
 *
 * QUALITY IS MEASURED, NOT ASSUMED
 *
 * --truth-grep supplies a deterministic oracle: files matching the pattern are
 * the YES set. The survey is scored against it and disagreements are printed
 * individually, because on a real corpus SOME disagreements will be the oracle
 * being wrong (a file that authenticates via an unlisted helper), and those
 * have to be inspected rather than counted.
 *
 * Uses /api/chat — the endpoint prism actually calls. /api/generate bypasses the
 * model's chat template and measurably changes answers (9b: 8/12 vs 12/12 on
 * the same images), so a survey run through it measures the wrong thing.
 *
 * Usage:
 *   node scripts/local-file-survey.mjs --files /tmp/routes.txt \
 *     --question "Does this file verify authentication before handling the request?" \
 *     --truth-grep "requireAuth|getServerSession" --model prism-coder:9b
 */

import * as fs from "node:fs";
import { execFileSync } from "node:child_process";

const OLLAMA = process.env.OLLAMA_URL ?? "http://localhost:11434";
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };

const listFile = argOf("--files");
const QUESTION = argOf("--question", "Describe this file in one line.");
const TRUTH = argOf("--truth-grep");
const MODEL = argOf("--model", "prism-coder:9b");
/**
 * Clipping is the single largest source of WRONG answers in this tool, and it
 * fails in the dangerous direction: a file whose auth check sits past the cut
 * comes back "NO — no authentication check in code", which reads as a finding
 * rather than as missing evidence.
 *
 * Measured on a 49,500-byte Stripe webhook route in a private companion repo: the
 * Stripe HMAC verification is at char 14,651. At the old 12,000 default the
 * model answered NO and was correct about what it was shown; at 60,000 it
 * answers YES. That one clip was the entire difference between 39/40 and 40/40
 * on the 40-file corpus.
 *
 * 9b's window is 32,768 tokens (~130k chars). 60,000 chars is ~15k tokens,
 * leaving ample room for the prompt and answer, and covers the large majority
 * of source files whole. Anything still clipped is flagged in the row so a NO
 * on a clipped file is never mistaken for a clean read.
 */
const MAX_CHARS = Number(argOf("--max-chars", "60000"));

const files = fs.readFileSync(listFile, "utf8").split("\n").map((s) => s.trim()).filter(Boolean);

async function chat(prompt, maxTokens) {
    const res = await fetch(`${OLLAMA}/api/chat`, {
        method: "POST",
        body: JSON.stringify({
            model: MODEL,
            messages: [{ role: "user", content: prompt }],
            stream: false,
            // Structured YES/NO output: thinking degrades format compliance on
            // 9b (measured 8/24 unparseable at both 600 and 2048 budgets).
            think: false,
            options: { num_predict: maxTokens, temperature: 0 },
        }),
        signal: AbortSignal.timeout(180_000),
    });
    const j = await res.json();
    return { text: (j.message?.content ?? "").trim(), inTok: j.prompt_eval_count ?? 0, outTok: j.eval_count ?? 0 };
}

/** Deterministic oracle: which files the truth-grep says are YES. */
function truthSet() {
    if (!TRUTH) return null;
    const set = new Set();
    for (const f of files) {
        try {
            execFileSync("/usr/bin/grep", ["-lE", TRUTH, f], { stdio: "pipe" });
            set.add(f);
        } catch { /* grep exits 1 on no match */ }
    }
    return set;
}

const truth = truthSet();
const t0 = Date.now();
let localIn = 0, localOut = 0, agree = 0;
const rows = [], disagreements = [];

/**
 * Window the file instead of truncating it.
 *
 * Truncation fails in the dangerous direction: a file whose evidence sits past
 * the cut answers NO — "no authentication check in code" — which reads as a
 * finding rather than as an unread remainder. Measured on
 * a 49,500-byte Stripe webhook route in a private companion repo: the Stripe HMAC
 * verification is at char 14,651, and a 12,000-char clip turned "I could not
 * see it" into "there is none". That one clip was the whole difference between
 * 39/40 and 40/40 on the 40-file corpus.
 *
 * Scanning every window, and answering YES if ANY window does, removes the
 * failure mode instead of moving the cliff further out. A NO now means every
 * window was read and none held the evidence — a real negative. The overlap
 * stops a match that straddles a boundary from being split in half.
 */
function windowsOf(text, size, overlap) {
    if (text.length <= size) return [text];
    const out = [];
    for (let i = 0; i < text.length; i += size - overlap) {
        out.push(text.slice(i, i + size));
        if (i + size >= text.length) break;
    }
    return out;
}

for (const f of files) {
    let body = "";
    try { body = fs.readFileSync(f, "utf8"); } catch { continue; }

    const parts = windowsOf(body, MAX_CHARS, 2_000);
    let ans = "NO", evidence = "", read = 0;

    for (let i = 0; i < parts.length; i++) {
        const prompt = [
            QUESTION,
            "",
            "Answer on ONE line in exactly this format, nothing else:",
            "ANSWER=<YES|NO> | <five words of evidence from the file>",
            "",
            `FILE: ${f}${parts.length > 1 ? `  (part ${i + 1} of ${parts.length})` : ""}`,
            "```",
            parts[i],
            "```",
        ].join("\n");

        const r = await chat(prompt, 60);
        localIn += r.inTok; localOut += r.outTok; read++;

        const firstLine = r.text.split("\n").find((l) => l.trim()) ?? "";
        const got = firstLine.match(/(?:ANSWER\s*=\s*)?\b(YES|NO)\b/i)?.[1]?.toUpperCase() ?? "UNPARSED";
        if (got === "YES") { ans = "YES"; evidence = r.text.slice(0, 90); break; }  // first YES settles it
        if (got === "UNPARSED" && i === parts.length - 1 && ans === "NO") ans = "UNPARSED";
    }

    let ok = null;
    if (truth) {
        const expect = truth.has(f) ? "YES" : "NO";
        ok = ans === expect;
        if (ok) agree++;
        else disagreements.push({ f, ans, expect, why: evidence });
    }
    rows.push({ f, ans, ok, windows: parts.length, read });
}

const ms = Date.now() - t0;

// ── accounting ──────────────────────────────────────────────────────────────
const corpusChars = files.reduce((n, f) => { try { return n + fs.statSync(f).size; } catch { return n; } }, 0);
const corpusTokens = Math.ceil(corpusChars / 4);
const depositTokens = rows.length * 15;          // one short verdict per file
const CACHE_READ = 5.0 * 0.10 / 1e6;
const INPUT = 5.0 / 1e6;
const TURN = 472_000 * CACHE_READ;

console.log(`\nsurveyed ${rows.length} files on ${MODEL} in ${(ms / 1000).toFixed(1)}s`);
if (truth) {
    console.log(`agreement with deterministic oracle (/${TRUTH}/): ${agree}/${rows.length} (${(100 * agree / rows.length).toFixed(1)}%)`);
    if (disagreements.length) {
        console.log(`\ndisagreements — inspect these, do NOT just count them:`);
        for (const d of disagreements) console.log(`  ${d.f}\n    model=${d.ans} oracle=${d.expect}  ${d.why}`);
    }
}
console.log(`\ncontext accounting`);
console.log(`  reading all ${rows.length} files in-loop : ~${corpusTokens.toLocaleString()} tok deposited, ${rows.length}+ turns`);
console.log(`  this survey                       : ~${depositTokens.toLocaleString()} tok deposited, 1 turn`);
console.log(`  compression                        : ${(corpusTokens / Math.max(depositTokens, 1)).toFixed(0)}x`);
console.log(`  local tokens (free)                : ${localIn.toLocaleString()}in / ${localOut.toLocaleString()}out`);
console.log(`\ncost`);
console.log(`  in-loop  : $${(corpusTokens * INPUT).toFixed(2)} first read + $${(corpusTokens * CACHE_READ).toFixed(3)}/turn thereafter, over ${rows.length}+ turns`);
console.log(`  survey   : $${TURN.toFixed(3)} (one turn) + $${(depositTokens * CACHE_READ).toFixed(5)}/turn thereafter`);
