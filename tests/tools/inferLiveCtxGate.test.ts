import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { runInfer, type InferDeps, type PrismInferArgs } from "../../src/tools/prismInferHandler.js";
import { _setCacheForTest, _resetEntitlementsForTest, type PrismEntitlements } from "../../src/utils/entitlements.js";

/**
 * The ctx gate must believe the MODEL, not the table — but only when the model
 * actually says something.
 *
 * MODEL_TIERS.ctxTokens mirrors each Modelfile's num_ctx, and that mirror went
 * stale: the 2026-08-14 vision push republished prism-coder:9b with no PARAMETER
 * lines, so the table kept declaring 4_096 while Ollama granted more. Measured
 * through the real MCP path, a ~6k-token prompt produced:
 *
 *   attempts=[{27b, ctx_insufficient}, {9b, ctx_insufficient}] -> backend=ollama-4b
 *
 * The two best tiers refused work they could do, on a prompt the 9b answers at
 * 18,575 tokens without truncation. That is the entire reason the local path
 * under-performed on large inputs.
 *
 * The fix reads num_ctx live. The asymmetry is the point and is what these tests
 * pin: a pinned value is trusted in BOTH directions, and an absent one falls
 * back to the table rather than to the architecture maximum. Absent means "this
 * tag's packaging is broken" — which is exactly when guessing high would
 * silently truncate a prompt, the failure §5.4 exists to prevent.
 */

const GB = 1024 ** 3;

const ENT: PrismEntitlements = {
    plan: "enterprise",
    model_ceiling: "27b",
    daily_infer_limit: 100000,
    max_tokens: 4096,
    max_seats: 25,
    features: {
        cloud_fallback: false,
        grounding_verifier: false,
        knowledge_search_unlimited: true,
        session_memory_unlimited: true,
        analytics_dashboard: true,
    },
    upgrade_url: "https://synalux.ai/pricing",
};

beforeEach(() => _setCacheForTest(ENT, 60_000));
afterAll(() => _resetEntitlementsForTest());

/** ~6k tokens: far above the table's 4_096 for the 9b, far below a pinned 32_768. */
const BIG_PROMPT = "x".repeat(24_000);

function makeDeps(
    served: string[],
    liveCtx: (model: string) => number | null,
    installed: string[],
): InferDeps {
    return {
        freemem: () => 30 * GB,
        listTags: async () => new Set(installed),
        listLoaded: async () => new Set<string>(),
        callLocal: async (_u, model) => {
            served.push(model);
            return { ok: true as const, text: "a sufficiently long answer", doneReason: "stop" };
        },
        callCloud: async () => ({ ok: false as const, reason: "no_cloud" }),
        ollamaUrl: "http://localhost:11434",
        callLayer1: async () => "OBVIOUS_NOT_RESERVED",
        probeNumCtx: async (_u, model) => liveCtx(model),
    };
}

const args = (): PrismInferArgs => ({ prompt: BIG_PROMPT, mode: "code", escalation: "report" });

describe("the ctx gate prefers the live num_ctx over the table", () => {
    it("a tier whose Modelfile PINS a large ctx is used, even though the table says 4_096", async () => {
        const served: string[] = [];
        // 9b reports 32_768 — what scripts/prism-coder-9b.Modelfile pins.
        await runInfer(args(), makeDeps(served, () => 32_768, ["prism-coder:9b", "prism-coder:4b"]));

        expect(served[0], "the 9b was skipped despite reporting a 32k window").toBe("prism-coder:9b");
    });

    it("a tier reporting NOTHING keeps the table's conservative value and is skipped", async () => {
        const served: string[] = [];
        // This is prism-coder:9b as currently published: parameters absent.
        const r = await runInfer(args(), makeDeps(served, () => null, ["prism-coder:9b", "prism-coder:4b"]));

        expect(served[0], "an unpinned tier was trusted with an oversize prompt").toBe("prism-coder:4b");
        expect(r.attempts.some(a => a.tier.includes("9b") && a.reason.startsWith("ctx_insufficient"))).toBe(true);
    });

    it("a live value SMALLER than the table also wins — the model is authoritative both ways", async () => {
        const served: string[] = [];
        // 4b's table row says 32_768; pretend its Modelfile was republished at 2_048.
        const r = await runInfer(
            args(),
            makeDeps(served, (m) => (m.includes("4b") ? 2_048 : null), ["prism-coder:4b", "prism-coder:2b"]),
        );

        expect(served[0], "trusted the table over a smaller pinned value — would truncate").toBe("prism-coder:2b");
        expect(
            r.attempts.some(a => a.tier.includes("4b") && a.reason === "ctx_insufficient:live_2048"),
            "the reason should name the live value, so a stale table is visible in the trace",
        ).toBe(true);
    });

    it("a probe that throws is treated as absent, not as permission", async () => {
        const served: string[] = [];
        await runInfer(
            args(),
            {
                ...makeDeps(served, () => null, ["prism-coder:9b", "prism-coder:4b"]),
                probeNumCtx: async () => { throw new Error("ollama unreachable"); },
            },
        );

        expect(served[0], "a failed probe must not unlock an under-declared tier").toBe("prism-coder:4b");
    });
});
