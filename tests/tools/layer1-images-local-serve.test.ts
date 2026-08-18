/**
 * Clinical pixels are processed LOCALLY — the leak is cloud, not local.
 *
 * 2026-08-18: the reserved branch refused every image request whose verdict
 * was raised by the picture, on the held-over premise that local models must
 * never answer about reserved content. That premise is backwards for a
 * local-first clinical product: local inference is exactly where clinical
 * screenshots and documents are SAFE — nothing leaves the device. The refusal
 * broke screenshot verification for the enterprise tiers that need it most,
 * while the actual no-leak property (images never reach cloud) was already
 * enforced architecturally.
 *
 * New contract, pinned here:
 *   1. verdict raised by the PIXELS (or the semantic path), words clean of
 *      deterministic reserved rules -> serve LOCALLY, cloud pinned off for
 *      the whole call. Even on an enterprise plan with cloud_fallback=true,
 *      callCloud is never invoked.
 *   2. words matching a deterministic reserved rule -> the refusal stands.
 *      Attaching an image must not become a bypass of the text policy.
 */
import { describe, it, expect } from "vitest";
import { runInfer } from "../../src/tools/prismInferHandler.js";
import { reservedCategory } from "../../src/utils/layer1.js";
import { _setCacheForTest, _resetEntitlementsForTest } from "../../src/utils/entitlements.js";

const B64 = "iVBORw0KGgoAAAANSUhEUg==";

/** Enterprise: the tier where cloud escalation is PERMITTED, so the pin is
 *  load-bearing — on free tiers the old code never tried cloud anyway. */
const ENTERPRISE: any = {
    plan: "enterprise", model_ceiling: "27b", daily_infer_limit: 1e5, max_tokens: 4096, max_seats: 25,
    features: { cloud_fallback: true, grounding_verifier: false, route_guard: false,
                knowledge_search_unlimited: true, session_memory_unlimited: true, analytics_dashboard: true },
    upgrade_url: "https://synalux.ai/pricing",
};

function deps(over: Record<string, unknown> = {}) {
    const cloudCalls: string[] = [];
    const d = {
        freemem: () => 30 * 1024 ** 3,
        listTags: async () => new Set(["prism-coder:9b", "prism-coder:4b"]),
        listLoaded: async () => new Set<string>(),
        callLocal: async () => ({ ok: true as const, text: "The image contains 7 lines.", doneReason: "stop" }),
        callCloud: async (p: string) => { cloudCalls.push(p); return { ok: true as const, output: "cloud answer", backend: "gemini-reserved" }; },
        ollamaUrl: "http://x",
        probeVision: async () => true,
        ...over,
    };
    return { d, cloudCalls };
}

describe("clinical pixels serve locally; cloud stays pinned off", () => {
    it("serves a screen-raised OBVIOUS_RESERVED image request locally on enterprise with cloud allowed", async () => {
        _setCacheForTest(ENTERPRISE, 60_000);
        // The image content screen says the PICTURE is clinical; the words are
        // an operational ask. Old code: reserved refusal. New contract: local.
        const { d, cloudCalls } = deps({ callLayer1: async () => "OBVIOUS_RESERVED" });
        try {
            const r: any = await runInfer(
                { prompt: "How many lines are in this image?", images: [B64], mode: "chat", task_complexity: 5, cloud_fallback: true },
                d as any);
            expect(r.output).toContain("7 lines");
            expect(r.used_cloud).toBe(false);
            expect(cloudCalls, "an image request reached cloud").toHaveLength(0);
            expect(r.attempts?.some((a: any) => a.reason === "layer1_obvious_reserved_image_local_only"),
                   `attempts=${JSON.stringify(r.attempts)}`).toBe(true);
        } finally { _resetEntitlementsForTest(); }
    });

    it("serves an UNCERTAIN image request locally — an unsure screen is not a refusal", async () => {
        _setCacheForTest(ENTERPRISE, 60_000);
        // Live repro 2026-08-18: a fresh VS Code screenshot came back UNCERTAIN
        // and was refused. Uncertainty about pixels must resolve to the safe
        // side that still works: local serve, cloud off.
        const { d, cloudCalls } = deps({ callLayer1: async () => "UNCERTAIN" });
        try {
            const r: any = await runInfer(
                { prompt: "Describe this screenshot in one sentence.", images: [B64], mode: "chat", task_complexity: 5, cloud_fallback: true },
                d as any);
            expect(r.output).toBeTruthy();
            expect(r.used_cloud).toBe(false);
            expect(cloudCalls).toHaveLength(0);
        } finally { _resetEntitlementsForTest(); }
    });

    it("words matching a deterministic reserved rule still refuse — an image is not a bypass", async () => {
        _setCacheForTest(ENTERPRISE, 60_000);
        const prompt = "Write a hold procedure to restrain the student";
        // Self-validating: if the rules drift and stop matching this phrasing,
        // fail HERE with a clear message instead of passing vacuously.
        expect(reservedCategory(prompt), "test premise broken: prompt no longer matches a deterministic rule").toBeTruthy();
        const { d, cloudCalls } = deps({ callLayer1: async () => "OBVIOUS_RESERVED" });
        try {
            await expect(runInfer(
                { prompt, images: [B64], mode: "chat", task_complexity: 5, cloud_fallback: true },
                d as any)).rejects.toThrow(/reserved/i);
            expect(cloudCalls, "a reserved image request reached cloud").toHaveLength(0);
        } finally { _resetEntitlementsForTest(); }
    });

    it("text-only reserved behavior is unchanged — the local-serve path requires images", async () => {
        _setCacheForTest(ENTERPRISE, 60_000);
        // No images: the existing reserved escalation contract stands (cloud
        // reserved path for paid plans). This pins that the fix is scoped.
        const { d, cloudCalls } = deps({ callLayer1: async () => "OBVIOUS_RESERVED" });
        try {
            const r: any = await runInfer(
                { prompt: "How many lines are in this file?", mode: "chat", task_complexity: 5, cloud_fallback: true },
                d as any);
            expect(r.used_cloud).toBe(true);
            expect(cloudCalls).toHaveLength(1);
        } finally { _resetEntitlementsForTest(); }
    });
});
