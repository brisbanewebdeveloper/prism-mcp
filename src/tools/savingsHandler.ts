/**
 * Local-serving meter — what prism's routing actually displaced, in tokens.
 *
 * The counters existed (utils/inferenceMetrics.ts, storage/inferMetricsLedger.ts)
 * but only surfaced as a footer on prism_infer responses and a raw dump from
 * inference_metrics. Nothing answered the question a user actually asks: "is
 * this doing anything for me?"
 *
 * The unit is TOKENS, not money, and that is a deliberate limit rather than a
 * missing feature. Prism cannot honestly price this:
 *
 *   - Rates are not knowable at build time. A bundled price table is wrong on a
 *     timer, and silently so. Gemini tiers by context length with separate
 *     cached-input rates and expiring promos; OpenAI tiers differently again.
 *   - Prism does not know WHICH model it displaced. The host picks per call and
 *     never tells us — Haiku vs Opus is roughly a 5x spread on the same tokens.
 *   - Most users are on flat plans (Claude Code Pro/Max, Codex on a ChatGPT
 *     plan, Gemini CLI free tier), where a dollar figure means nothing.
 *
 * Tokens are immune to all three: prism counted them itself. If a user wants
 * money, the honest shape is them supplying their own rate — prism rendering
 * the user's number, never asserting one.
 *
 * Everything here understates rather than overstates. See the caveat block in
 * the rendered output; the counters behind it live in LocalSavings.
 */

import { queryLocalSavings, type LocalSavings } from "../storage/inferMetricsLedger.js";
import { getInferenceSnapshot } from "../utils/inferenceMetrics.js";

export type SavingsPeriod = "session" | "month" | "all";

const DAY_MS = 86_400_000;

/** Start of the trailing 30-day window. Passed in so tests are not clock-bound. */
export function windowStart(period: SavingsPeriod, nowMs: number): number | undefined {
    return period === "month" ? nowMs - 30 * DAY_MS : undefined;
}

function fmt(n: number): string {
    return n.toLocaleString("en-US");
}

/** Compact token counts: 1_240_000 → "1.2M". Headline numbers only. */
export function abbreviate(n: number): string {
    if (!Number.isFinite(n) || n < 0) return "0";
    if (n < 1_000) return String(Math.round(n));
    if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}K`;
    return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
}

function spanOf(s: LocalSavings): string {
    if (s.first_ts == null || s.last_ts == null) return "no local calls yet";
    const d = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const from = d(s.first_ts);
    const to = d(s.last_ts);
    return from === to ? from : `${from} → ${to}`;
}

/**
 * Caveats that materially change how the headline should be read.
 *
 * Emitted as part of the output rather than buried in docs: the undercount
 * sources are invisible to the user and, unlisted, a conservative number reads
 * as a precise one.
 */
export function caveatsFor(s: LocalSavings): string[] {
    const out: string[] = [];
    if (s.local_calls_without_tokens > 0) {
        out.push(
            `${fmt(s.local_calls_without_tokens)} local call(s) recorded no token counts and contribute 0 above — ` +
            `the real total is higher.`);
    }
    if (s.local_calls_with_cached_prompt > 0) {
        out.push(
            `${fmt(s.local_calls_with_cached_prompt)} local call(s) hit the KV cache, so Ollama reported 0 prompt ` +
            `tokens for context that was really submitted — prompt tokens are undercounted.`);
    }
    if (s.excluded_refusals > 0) {
        out.push(
            `${fmt(s.excluded_refusals)} refused call(s) excluded — nothing was served, so nothing was displaced.`);
    }
    return out;
}

/** The assumption the headline rests on. Always shown; it is the whole basis. */
const COUNTERFACTUAL =
    "Counts tokens a local model handled instead of your cloud model. Assumes each " +
    "locally-served call would otherwise have gone to the cloud — prism cannot observe " +
    "the call your host would have made, so treat this as an upper bound on displacement.";

export interface SavingsRender {
    text: string;
    /** Machine-readable, for the dashboard card and tests. */
    data: LocalSavings & { period: SavingsPeriod };
}

export function renderSavings(s: LocalSavings, period: SavingsPeriod): SavingsRender {
    const label = period === "month" ? "LAST 30 DAYS" : period === "all" ? "ALL TIME" : "THIS SESSION";
    const lines: string[] = [];

    lines.push(`💾 Local serving — ${label} (${spanOf(s)})`);

    if (s.local_calls === 0) {
        lines.push("");
        lines.push("  No calls served locally yet.");
        lines.push(period === "session"
            ? "  Delegate work with prism_infer, or use session_task_route to pick targets automatically."
            : "  Once prism starts serving locally, displaced token volume shows up here.");
        return { text: lines.join("\n"), data: { ...s, period } };
    }

    const totalRouted = s.local_calls + s.cloud_calls;
    const localPct = totalRouted > 0 ? Math.round((s.local_calls / totalRouted) * 100) : 0;

    lines.push("");
    lines.push(`  ~${abbreviate(s.local_total_tokens)} tokens kept off your cloud model`);
    lines.push(`  ${fmt(s.local_calls)} call(s) served locally of ${fmt(totalRouted)} routed (${localPct}%)`);
    lines.push(`  Breakdown: ${fmt(s.local_prompt_tokens)} prompt + ${fmt(s.local_completion_tokens)} completion`);

    const models = Object.entries(s.by_model).sort((a, b) => b[1].calls - a[1].calls);
    if (models.length > 0) {
        lines.push("");
        lines.push("  By model:");
        for (const [name, m] of models) {
            const t = m.prompt_tokens + m.completion_tokens;
            lines.push(`    ${name}: ${fmt(m.calls)} call(s), ~${abbreviate(t)} tokens`);
        }
    }

    lines.push("");
    lines.push(`  ${COUNTERFACTUAL}`);

    const caveats = caveatsFor(s);
    if (caveats.length > 0) {
        lines.push("");
        lines.push("  Known undercounts:");
        for (const c of caveats) lines.push(`    · ${c}`);
    }

    return { text: lines.join("\n"), data: { ...s, period } };
}

/**
 * Session view, built from the in-memory accumulators.
 *
 * Shaped into LocalSavings so one renderer serves every period. The session
 * accumulators already exclude refusals and safety-gate calls at record time,
 * hence the zeros for the ledger-only honesty counters — the per-call detail
 * they are derived from is not retained in memory.
 */
export function sessionSavings(): LocalSavings {
    const snap = getInferenceSnapshot();
    const by_model: Record<string, { calls: number; prompt_tokens: number; completion_tokens: number }> = {};
    for (const [name, m] of Object.entries(snap.byModelLocal)) {
        by_model[name] = {
            calls: m.calls,
            prompt_tokens: m.promptTokensSubmittedEst,
            completion_tokens: m.completionTokens,
        };
    }
    return {
        local_calls: snap.localCalls,
        cloud_calls: snap.cloudCalls,
        local_prompt_tokens: snap.localPromptTokensEst,
        local_completion_tokens: snap.localCompletionTokens,
        local_total_tokens: snap.cloudTokensSavedEst,
        local_calls_without_tokens: 0,
        local_calls_with_cached_prompt: 0,
        excluded_refusals: 0,
        first_ts: null,
        last_ts: null,
        by_model,
    };
}

export async function savingsHandler(args?: { period?: string }): Promise<{
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
}> {
    const raw = (args?.period ?? "all").toLowerCase();
    const period: SavingsPeriod =
        raw === "session" ? "session" : raw === "month" ? "month" : "all";

    if (period === "session") {
        return { content: [{ type: "text", text: renderSavings(sessionSavings(), period).text }] };
    }

    const s = await queryLocalSavings(windowStart(period, Date.now()));
    if (!s) {
        return {
            content: [{
                type: "text",
                text: "💾 Local serving — ledger unavailable, so no durable figure can be reported.\n" +
                      "  Session-only view: run with period 'session'.",
            }],
            isError: true,
        };
    }
    return { content: [{ type: "text", text: renderSavings(s, period).text }] };
}
