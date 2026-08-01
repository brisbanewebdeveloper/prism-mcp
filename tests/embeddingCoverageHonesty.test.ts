/**
 * Embedding-coverage honesty.
 *
 * SynaluxStorage.getHealthStats hardcoded missingEmbeddings: 0 on both its
 * success and failure paths, so session_health_check reported "HEALTHY — all
 * clean" through an outage in which 100% of 8,560 rows lacked a vector and
 * semantic search returned nothing for every query. These tests pin the
 * honest behaviour: real count when the portal reports one, explicit
 * "unknown" (-1) when it does not or cannot be reached — never a fabricated
 * zero.
 */
import { describe, it, expect } from "vitest";
import { runHealthCheck } from "../src/utils/healthCheck.js";
import type { HealthStats } from "../src/storage/interface.js";

const baseStats = (missing: number): HealthStats => ({
    missingEmbeddings: missing,
    activeLedgerSummaries: [],
    orphanedHandoffs: [],
    staleRollups: 0,
    totalActiveEntries: 100,
    totalHandoffs: 2,
    totalRollups: 0,
    totalCrdtMerges: 0,
});

describe("embedding coverage in session_health_check", () => {
    it("reports missing embeddings as an error when many are absent", () => {
        const report = runHealthCheck(baseStats(8560));
        const issue = report.issues.find(i => i.check === "missing_embeddings");
        expect(issue).toBeDefined();
        expect(issue!.severity).toBe("error");
        expect(issue!.count).toBe(8560);
    });

    it("stays quiet when coverage is verified complete", () => {
        const report = runHealthCheck(baseStats(0));
        expect(report.issues.find(i => i.check === "missing_embeddings")).toBeUndefined();
    });

    it("says UNKNOWN rather than clean when the count is unavailable", () => {
        // -1 is the sentinel getHealthStats returns when the portal is
        // unreachable or predates the ledger_missing_embeddings field.
        const report = runHealthCheck(baseStats(-1));
        const issue = report.issues.find(i => i.check === "missing_embeddings");
        expect(issue).toBeDefined();
        expect(issue!.message).toMatch(/could not be verified/i);
    });
});
