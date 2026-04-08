import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runHealthCheck } from "../../src/utils/healthCheck.js";
import { createTestDb, TEST_USER_ID } from "../helpers/fixtures.ts";

let storage: any;
let cleanup: () => void;

beforeAll(async () => {
  const testDb = await createTestDb("health-check-embeddings");
  storage = testDb.storage;
  cleanup = testDb.cleanup;
}, 15_000);

afterAll(() => {
  cleanup();
});

describe("health check embedding classification", () => {
  it("separates repairable missing embeddings from blank ledger rows", async () => {
    await storage.saveLedger({
      project: "repairable-project",
      conversation_id: "conv-1",
      summary: "This ledger row can generate an embedding.",
      user_id: TEST_USER_ID,
      decisions: [],
    });
    await storage.db.execute({
      sql: `INSERT INTO session_ledger
        (project, conversation_id, user_id, role, summary, decisions, keywords, embedding_status, embedding_retry_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        "blank-project",
        "conv-2",
        TEST_USER_ID,
        "global",
        "   ",
        JSON.stringify(["\n", "  "]),
        JSON.stringify([]),
        null,
        0,
      ],
    });

    const stats = await storage.getHealthStats(TEST_USER_ID);
    expect(stats.missingEmbeddings).toBe(1);
    expect(stats.unrepairableEmbeddings).toBe(1);

    const report = runHealthCheck(stats);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        check: "missing_embeddings",
        count: 1,
      }),
      expect.objectContaining({
        check: "unrepairable_embeddings",
        count: 1,
      }),
    ]));
  });
});
