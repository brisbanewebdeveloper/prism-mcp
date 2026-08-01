/**
 * session_search_memory must say HOW results were found.
 *
 * The portal's hybrid fusion annotates rows with semantic_rank/lexical_rank.
 * The renderer previously hardcoded "semantically similar" and printed
 * "N/A similar" for a lexical-only rescue — the same class of honesty gap as
 * knowledge_search's match_mode: correct data, misleading presentation.
 */
import { describe, it, expect } from "vitest";
import { isHybridSearchResults, searchResultsHeader, formatHitScore } from "../src/tools/graphHandlers.js";

describe("search result honesty", () => {
    it("detects hybrid retrieval from per-row lexical ranks", () => {
        expect(isHybridSearchResults([{ similarity: 0.8 }])).toBe(false);
        expect(isHybridSearchResults([{ similarity: 0.8, lexical_rank: 0 }])).toBe(true);
    });

    it("labels hybrid result sets as hybrid, not semantic", () => {
        expect(searchResultsHeader(3, true)).toContain("hybrid retrieval");
        expect(searchResultsHeader(3, false)).toContain("semantically similar");
    });

    it("shows both arms for a fused hit", () => {
        expect(formatHitScore({ similarity: 0.803, semantic_rank: 5, lexical_rank: 0 }))
            .toBe("80.3% similar (sem#6 + lex#1)");
    });

    it("never prints N/A for a lexical-only rescue", () => {
        const s = formatHitScore({ lexical_rank: 2 });
        expect(s).toBe("exact-term match (lex#3)");
        expect(s).not.toContain("N/A");
    });

    it("keeps the plain similarity form for pure-semantic rows", () => {
        expect(formatHitScore({ similarity: 0.92 })).toBe("92.0% similar");
    });
});
