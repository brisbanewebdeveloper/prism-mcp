import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { runInfer, type InferDeps, type PrismInferArgs } from "../../src/tools/prismInferHandler.js";
import { _setCacheForTest, _resetEntitlementsForTest, type PrismEntitlements } from "../../src/utils/entitlements.js";

/**
 * Thinking is a TIER capability, not a MODE preference.
 *
 * resolveThinkingMode used to end in `return mode !== "route"`, which turned
 * reasoning on for every chat/code call regardless of which tier answered.
 * Tiers carrying `prefersThinking` also carry a `minLocalTokens` floor
 * (MODEL_TIERS) so reasoning cannot crowd out the answer. 4b and 2b carry
 * neither — so on those tiers the reasoning drew down the same num_predict
 * budget the answer needed.
 *
 * Measured 2026-08-16 against live Ollama, prism-coder:4b and :2b:
 *
 *   code generation, num_predict 1600
 *     think=true   -> 319 tokens, ALL reasoning, response "" (done=stop)
 *     think=false  -> correct function, 4/4 executed assertions pass
 *
 *   extractive/vision, num_predict 600
 *     think=true   -> 2503/2641 chars reasoning, response "" (done=length)
 *     think=false  -> correct answer in 23 tokens
 *
 * This is the same shape as the gate_failed_served rows in infer_metrics
 * (completion_tokens 2-8 on 4b/9b code-mode calls). prismInferTruncation.test
 * covers the RETRY that salvages such a call; this file covers not provoking it.
 *
 * The IMAGE path already deferred to the tier. These tests pin the TEXT path to
 * the same rule, in both directions.
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

const INSTALLED = new Set(["prism-coder:9b", "prism-coder:4b", "prism-coder:2b"]);

beforeEach(() => _setCacheForTest(ENT, 60_000));
afterAll(() => _resetEntitlementsForTest());

function makeDeps(seen: Array<{ model: string; think?: boolean }>, overrides: Partial<InferDeps> = {}): InferDeps {
    return {
        freemem: () => 30 * GB,
        listTags: async () => INSTALLED,
        listLoaded: async () => new Set<string>(),
        callLocal: async (_u, model, _p, _s, _mt, _t, _to, think) => {
            seen.push({ model, think });
            return { ok: true as const, text: "function ok() { return 1; }", doneReason: "stop" };
        },
        callCloud: async () => ({ ok: false as const, reason: "no_cloud" }),
        ollamaUrl: "http://localhost:11434",
        callLayer1: async () => "OBVIOUS_NOT_RESERVED",
        ...overrides,
    };
}

const args = (extra: Partial<PrismInferArgs> = {}): PrismInferArgs =>
    ({ prompt: "Write a JavaScript function that chunks an array into groups of n.", mode: "code", ...extra });

describe("thinking follows the tier, not the mode", () => {
    it("code mode does NOT think on 4b — the tier has no minLocalTokens floor", async () => {
        const seen: Array<{ model: string; think?: boolean }> = [];
        await runInfer(args({ model_ceiling: "4b" }), makeDeps(seen));

        const call = seen.find(c => c.model === "prism-coder:4b");
        expect(call, "4b never ran").toBeDefined();
        expect(call!.think, "code mode enabled thinking on a tier that cannot afford it").toBe(false);
    });

    it("code mode does NOT think on 2b", async () => {
        const seen: Array<{ model: string; think?: boolean }> = [];
        await runInfer(args({ model_ceiling: "2b" }), makeDeps(seen));

        const call = seen.find(c => c.model === "prism-coder:2b");
        expect(call, "2b never ran").toBeDefined();
        expect(call!.think).toBe(false);
    });

    it("code mode DOES think on 9b — prefersThinking plus a 2048-token floor", async () => {
        const seen: Array<{ model: string; think?: boolean }> = [];
        await runInfer(args({ model_ceiling: "9b" }), makeDeps(seen));

        const call = seen.find(c => c.model === "prism-coder:9b");
        expect(call, "9b never ran").toBeDefined();
        expect(call!.think, "regressed the 9b routing gain (83.5% -> 95.7%)").toBe(true);
    });

    it("an explicit caller think=true still wins on a non-thinking tier", async () => {
        // The tier rule is a DEFAULT. A caller who has sized max_tokens for
        // reasoning must still be able to ask for it.
        const seen: Array<{ model: string; think?: boolean }> = [];
        await runInfer(args({ model_ceiling: "4b", think: true }), makeDeps(seen));

        expect(seen.find(c => c.model === "prism-coder:4b")!.think).toBe(true);
    });

    it("route mode still never thinks on a non-thinking tier", async () => {
        const seen: Array<{ model: string; think?: boolean }> = [];
        await runInfer(args({ model_ceiling: "4b", mode: "route" }), makeDeps(seen));

        expect(seen.find(c => c.model === "prism-coder:4b")!.think).toBe(false);
    });
});
