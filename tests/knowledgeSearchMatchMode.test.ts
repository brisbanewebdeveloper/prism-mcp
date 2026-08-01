/**
 * knowledge_search match_mode contract + presentation
 *
 * WHY THIS EXISTS:
 *   The portal's ranked knowledge_search (migration 20260728000000) falls
 *   back to a widened OR match when no entry matches every query term, and
 *   reports which happened via `match_mode`. Two defects were found on the
 *   client side of that wire:
 *
 *     D1 — synalux.ts returned only {count, results}, so `match_mode` was
 *          dropped and a widened guess reached the agent worded exactly
 *          like an exact hit.
 *     D2 — KnowledgeSearchResponseSchema existed but was imported nowhere.
 *          Only the REQUEST was validated, so a portal-side response change
 *          would have gone unnoticed on both sides — the same class as the
 *          2026-05-24 queryText/query incident that portalContracts.ts was
 *          created to prevent.
 *
 * These tests fail against the pre-fix implementation.
 */
import { describe, it, expect } from "vitest";
import { KnowledgeSearchResponseSchema } from "../src/storage/portalContracts.js";
import { formatKnowledgeHeader } from "../src/tools/graphHandlers.js";

const VALID_BASE = {
    status: "success" as const,
    action: "knowledge_search" as const,
    count: 1,
    results: [{ id: "k-1", summary: "closest entry" }],
};

describe("knowledge_search response contract", () => {
    it("accepts a relaxed match_mode from the ranked portal search", () => {
        const parsed = KnowledgeSearchResponseSchema.safeParse({
            ...VALID_BASE,
            match_mode: "relaxed",
        });
        expect(parsed.success).toBe(true);
        if (parsed.success) expect(parsed.data.match_mode).toBe("relaxed");
    });

    it("accepts every mode the portal RPC can report", () => {
        for (const mode of ["strict", "relaxed", "unfiltered", "none"]) {
            expect(KnowledgeSearchResponseSchema.safeParse({ ...VALID_BASE, match_mode: mode }).success)
                .toBe(true);
        }
    });

    it("still validates a response with no match_mode (older portal deployment)", () => {
        // Back-compat matters: prism-mcp ships independently of the portal, so
        // a client update must not hard-fail against a portal that predates
        // the ranked search RPC.
        expect(KnowledgeSearchResponseSchema.safeParse(VALID_BASE).success).toBe(true);
    });

    it("rejects an unknown match_mode rather than passing it through", () => {
        const parsed = KnowledgeSearchResponseSchema.safeParse({
            ...VALID_BASE,
            match_mode: "fuzzy",
        });
        expect(parsed.success).toBe(false);
    });

    it("tolerates the portal's extra top-level fields (scope) without failing", () => {
        // The portal also returns `scope`. Zod strips unknown keys by default;
        // pin that so response validation can be enabled without breaking prod.
        expect(KnowledgeSearchResponseSchema.safeParse({ ...VALID_BASE, scope: "workspace" }).success)
            .toBe(true);
    });

    it("still rejects genuine contract drift on required fields", () => {
        const { count, ...missingCount } = VALID_BASE;
        expect(KnowledgeSearchResponseSchema.safeParse(missingCount).success).toBe(false);
        expect(KnowledgeSearchResponseSchema.safeParse({ ...VALID_BASE, action: "search" }).success)
            .toBe(false);
    });
});

describe("relaxed results are not presented as exact hits", () => {
    // Exercises the SHIPPED function from graphHandlers, not a copy of its
    // logic — a mirrored implementation would pass even if the handler
    // regressed, which is the failure mode this suite exists to catch.
    const header = formatKnowledgeHeader;

    it("labels a widened search so the agent cannot read it as a confirmed answer", () => {
        const text = header(3, "relaxed");
        expect(text).toContain("No exact match");
        expect(text).toContain("treat as leads");
        expect(text).not.toContain("Found 3 knowledge entries");
    });

    it("uses singular wording for a single relaxed hit", () => {
        expect(header(1, "relaxed")).toContain("1 closest entry");
    });

    it("leaves exact matches worded as before", () => {
        expect(header(2, "strict")).toBe("🧠 Found 2 knowledge entries:");
    });

    it("defaults to exact wording when the backend reports no mode (local SQLite)", () => {
        expect(header(2, undefined)).toBe("🧠 Found 2 knowledge entries:");
    });
});
