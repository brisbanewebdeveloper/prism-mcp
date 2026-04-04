import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockSaveLedger,
  mockPatchLedger,
  mockDecayImportance,
  mockGetSetting,
  mockGetAllSettings,
  mockToKeywordArray,
  mockGetLLMProvider,
} = vi.hoisted(() => ({
  mockSaveLedger: vi.fn(),
  mockPatchLedger: vi.fn(),
  mockDecayImportance: vi.fn().mockResolvedValue(undefined),
  mockGetSetting: vi.fn(),
  mockGetAllSettings: vi.fn().mockResolvedValue({}),
  mockToKeywordArray: vi.fn(() => ["semantic", "search"]),
  mockGetLLMProvider: vi.fn(),
}));

vi.mock("../../src/storage/index.js", () => ({
  getStorage: vi.fn(async () => ({
    saveLedger: mockSaveLedger,
    patchLedger: mockPatchLedger,
    decayImportance: mockDecayImportance,
  })),
}));

vi.mock("../../src/storage/configStorage.js", () => ({
  getSetting: mockGetSetting,
  getAllSettings: mockGetAllSettings,
  getSettingSync: vi.fn((_: string, defaultValue = "") => defaultValue),
}));

vi.mock("../../src/utils/keywordExtractor.js", () => ({
  toKeywordArray: mockToKeywordArray,
}));

vi.mock("../../src/utils/llm/factory.js", () => ({
  getLLMProvider: mockGetLLMProvider,
}));

vi.mock("../../src/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/config.js")>();
  return {
    ...actual,
    GOOGLE_API_KEY: "",
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

import { sessionSaveLedgerHandler } from "../../src/tools/ledgerHandlers.js";

describe("sessionSaveLedgerHandler embedding queue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("setImmediate", vi.fn());

    mockSaveLedger.mockResolvedValue([
      { id: "entry-1", created_at: "2026-04-05T00:00:00.000Z" },
    ]);
    mockGetSetting.mockImplementation(async (_key: string, defaultValue = "") => defaultValue);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("queues embeddings through the active provider even when GOOGLE_API_KEY is unset", async () => {
    const generateEmbedding = vi.fn().mockResolvedValue([0.1, 0.2, 0.3]);
    mockGetLLMProvider.mockReturnValue({ generateEmbedding });

    const patchCall = new Promise<[string, Record<string, unknown>]>((resolve) => {
      mockPatchLedger.mockImplementation(async (entryId: string, patch: Record<string, unknown>) => {
        resolve([entryId, patch]);
      });
    });

    const result = await sessionSaveLedgerHandler({
      project: "brain-health-test",
      conversation_id: "conv-1",
      summary: "Captured a durable session summary.",
      decisions: ["Used the active embedding provider instead of a Gemini-only gate."],
    });

    const [entryId, patch] = await patchCall;

    expect(mockGetLLMProvider).toHaveBeenCalledOnce();
    expect(generateEmbedding).toHaveBeenCalledWith(
      "Captured a durable session summary.\nUsed the active embedding provider instead of a Gemini-only gate."
    );
    expect(entryId).toBe("entry-1");
    expect(patch).toEqual(expect.objectContaining({
      embedding: JSON.stringify([0.1, 0.2, 0.3]),
    }));

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Embedding generation queued for semantic search");
  });
});
