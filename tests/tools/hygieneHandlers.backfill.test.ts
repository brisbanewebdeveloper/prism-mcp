import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetLedgerEntries,
  mockPatchLedger,
  mockGetLLMProvider,
} = vi.hoisted(() => ({
  mockGetLedgerEntries: vi.fn(),
  mockPatchLedger: vi.fn(),
  mockGetLLMProvider: vi.fn(),
}));

vi.mock("../../src/storage/index.js", () => ({
  getStorage: vi.fn(async () => ({
    getLedgerEntries: mockGetLedgerEntries,
    patchLedger: mockPatchLedger,
  })),
}));

vi.mock("../../src/utils/llm/factory.js", () => ({
  getLLMProvider: mockGetLLMProvider,
}));

vi.mock("../../src/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/config.js")>();
  return {
    ...actual,
    PRISM_USER_ID: "default",
    PRISM_AUTO_CAPTURE: false,
    PRISM_CAPTURE_PORTS: "",
  };
});

vi.mock("../../src/utils/turboquant.js", () => ({
  getDefaultCompressor: vi.fn(() => {
    throw new Error("turbo unavailable in test");
  }),
  serialize: vi.fn(),
}));

import { backfillEmbeddingsHandler } from "../../src/tools/hygieneHandlers.js";

describe("backfillEmbeddingsHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports no-text rows separately from repair failures", async () => {
    mockGetLedgerEntries.mockResolvedValue([
      {
        id: "entry-repairable",
        project: "brain-health-test",
        summary: "Recovered usable summary text.",
        decisions: ["Kept the saved embedding content consistent."],
      },
      {
        id: "entry-blank",
        project: "brain-health-test",
        summary: "   ",
        decisions: ["  "],
      },
    ]);
    mockGetLLMProvider.mockReturnValue({
      generateEmbedding: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    });

    const result: any = await backfillEmbeddingsHandler({ dry_run: false, limit: 50 });

    expect(mockPatchLedger).toHaveBeenCalledTimes(2);
    expect(result._stats).toMatchObject({
      repaired: 1,
      failed: 0,
      skippedNoText: 1,
      scanned: 2,
    });

    expect(mockPatchLedger).toHaveBeenNthCalledWith(
      2,
      "entry-blank",
      expect.objectContaining({
        embedding_status: "skipped",
      }),
    );

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Skipped (no text): 1");
    expect(text).toContain("have no summary or decision text");
  });

  it("returns the first repair failure details in the response payload", async () => {
    mockGetLedgerEntries.mockResolvedValue([
      {
        id: "entry-fail",
        project: "brain-health-test",
        summary: "This row has enough text to attempt repair.",
        decisions: [],
      },
    ]);
    mockGetLLMProvider.mockReturnValue({
      generateEmbedding: vi.fn().mockRejectedValue(new Error("embedding quota exceeded")),
    });

    const result: any = await backfillEmbeddingsHandler({ dry_run: false, limit: 50 });

    expect(result._stats.failed).toBe(1);
    expect(mockPatchLedger).toHaveBeenCalledWith(
      "entry-fail",
      expect.objectContaining({
        embedding_status: "failed",
        embedding_retry_count: 1,
      }),
    );
    expect(result._stats.failureDetails).toEqual([
      "entry-fail: embedding quota exceeded",
    ]);

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("embedding quota exceeded");
  });
});
