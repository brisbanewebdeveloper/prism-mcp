import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetStorage,
  mockGetLLMProvider,
  mockBackfillEmbeddingsHandler,
} = vi.hoisted(() => ({
  mockGetStorage: vi.fn(),
  mockGetLLMProvider: vi.fn(),
  mockBackfillEmbeddingsHandler: vi.fn(),
}));

vi.mock("../src/storage/index.js", () => ({
  getStorage: mockGetStorage,
}));

vi.mock("../src/utils/llm/factory.js", () => ({
  getLLMProvider: mockGetLLMProvider,
}));

vi.mock("../src/tools/hygieneHandlers.js", () => ({
  backfillEmbeddingsHandler: mockBackfillEmbeddingsHandler,
}));

vi.mock("../src/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config.js")>();
  return {
    ...actual,
    PRISM_USER_ID: "default",
    PRISM_SCHOLAR_ENABLED: false,
    PRISM_SCHOLAR_INTERVAL_MS: 0,
    PRISM_GRAPH_PRUNING_ENABLED: false,
    PRISM_GRAPH_PRUNE_MIN_STRENGTH: 0.15,
    PRISM_GRAPH_PRUNE_PROJECT_COOLDOWN_MS: 600000,
    PRISM_GRAPH_PRUNE_SWEEP_BUDGET_MS: 30000,
    PRISM_GRAPH_PRUNE_MAX_PROJECTS_PER_SWEEP: 25,
    PRISM_ACTR_ENABLED: false,
    PRISM_ACTR_ACCESS_LOG_RETENTION_DAYS: 30,
  };
});

import { runSchedulerSweep } from "../src/backgroundScheduler.js";

describe("runSchedulerSweep embedding retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetStorage.mockResolvedValue({
      getSetting: vi.fn().mockResolvedValue(null),
      setSetting: vi.fn().mockResolvedValue(undefined),
      listProjectsWithMissingEmbeddings: vi.fn().mockResolvedValue(["ledger-only-project"]),
      listProjects: vi.fn().mockResolvedValue([]),
    });
    mockGetLLMProvider.mockReturnValue({ generateEmbedding: vi.fn() });
    mockBackfillEmbeddingsHandler
      .mockResolvedValueOnce({
        _stats: {
          repaired: 2,
          failed: 1,
          skippedNoText: 0,
          scanned: 50,
          last_id: "cursor-1",
        },
      })
      .mockResolvedValueOnce({
        _stats: {
          repaired: 0,
          failed: 0,
          skippedNoText: 0,
          scanned: 0,
        },
      });
  });

  it("retries ledger projects that only exist in session_ledger", async () => {
    const result = await runSchedulerSweep({
      intervalMs: 1000,
      enableTTLSweep: false,
      enableDecay: false,
      enableCompaction: false,
      enableDeepPurge: false,
      enableEmbeddingRetry: true,
      enableSdmFlush: false,
      enableEdgeSynthesis: false,
      enableGraphPruning: false,
      enableAccessLogPrune: false,
      purgeOlderThanDays: 30,
      compactionThreshold: 50,
      compactionKeepRecent: 10,
      decayDays: 30,
      embeddingRetryMaxRetries: 3,
      embeddingRetryBackoffMs: 1000,
      embeddingRetryBatchSize: 50,
      edgeSynthesisCooldownMs: 600000,
      edgeSynthesisBudgetMs: 60000,
      edgeSynthesisMaxRetries: 1,
      edgeSynthesisBackoffMs: 1800000,
      graphPruneMinStrength: 0.15,
      graphPruneProjectCooldownMs: 600000,
      graphPruneSweepBudgetMs: 30000,
      graphPruneMaxProjectsPerSweep: 25,
      accessLogRetentionDays: 30,
    });

    expect(mockBackfillEmbeddingsHandler).toHaveBeenCalledWith(expect.objectContaining({
      project: "ledger-only-project",
      _max_retry_count: 3,
    }));
    expect(result.tasks.embeddingRetry).toMatchObject({
      ran: true,
      projectsAttempted: 1,
      projectsRetried: 1,
      repaired: 2,
      failed: 1,
    });
  });
});
