import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("commander", () => {
  class Command {
    name(): this { return this; }
    description(): this { return this; }
    version(): this { return this; }
    command(): this { return this; }
    option(): this { return this; }
    requiredOption(): this { return this; }
    action(): this { return this; }
    async parseAsync(): Promise<this> { return this; }
  }
  return { Command };
});

const {
  mockCloseStorage,
  mockGetSetting,
  mockSessionBootstrapHandler,
  mockVerifyBehaviorHandler,
} = vi.hoisted(() => ({
  mockCloseStorage: vi.fn(async () => {}),
  mockGetSetting: vi.fn(async (_key: string, fallback = "") => fallback),
  mockSessionBootstrapHandler: vi.fn(),
  mockVerifyBehaviorHandler: vi.fn(),
}));
vi.mock("../../src/storage/index.js", () => ({
  getStorage: vi.fn(),
  closeStorage: mockCloseStorage,
}));

vi.mock("../../src/storage/configStorage.js", () => ({
  getSetting: mockGetSetting,
}));

vi.mock("../../src/utils/git.js", () => ({
  getCurrentGitState: vi.fn(() => ({ isRepo: false })),
}));

vi.mock("../../src/config.js", () => ({
  PRISM_USER_ID: "test-user",
  SERVER_CONFIG: { name: "prism-test", version: "test" },
}));

vi.mock("../../src/connect.js", () => ({
  configureClaudeNativeStartup: vi.fn(),
  configureCodexNativeStartup: vi.fn(),
  configureGeminiNativeStartup: vi.fn(),
  connectHosts: vi.fn(),
  migrateLegacyClaudeHooks: vi.fn(),
  migrateLegacyClaudeInstructions: vi.fn(),
  migrateLegacyClaudeManagedStartup: vi.fn(),
  migrateLegacyClaudeProjectMcp: vi.fn(),
  normalizeHostName: vi.fn(),
}));

vi.mock("../../src/tools/ledgerHandlers.js", () => ({
  sessionBootstrapHandler: mockSessionBootstrapHandler,
  sessionLoadContextHandler: vi.fn(),
  sessionSaveLedgerHandler: vi.fn(),
  sessionSaveHandoffHandler: vi.fn(),
}));

vi.mock("../../src/tools/behavioralVerifierHandler.js", () => ({
  verifyBehaviorHandler: mockVerifyBehaviorHandler,
}));

import { runBootstrapCommand, runVerifyBehaviorCommand } from "../../src/cli.js";

const CANONICAL_BOOTSTRAP_TEXT = "👋 Welcome back, Dmitri.\n\n> **Prism System Ready**";
const ORIGINAL_SYNALUX_BASE_URL = process.env.PRISM_SYNALUX_BASE_URL;
const ORIGINAL_SYNALUX_API_KEY = process.env.PRISM_SYNALUX_API_KEY;

describe("prism bootstrap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("prints the exact session_bootstrap display without project or depth arguments", async () => {
    mockSessionBootstrapHandler.mockResolvedValue({
      content: [{ type: "text", text: CANONICAL_BOOTSTRAP_TEXT }],
      isError: false,
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await runBootstrapCommand();

    expect(mockSessionBootstrapHandler).toHaveBeenCalledOnce();
    expect(mockSessionBootstrapHandler).toHaveBeenCalledWith({});
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(CANONICAL_BOOTSTRAP_TEXT);
    expect(process.exitCode).toBeUndefined();
    expect(mockCloseStorage).toHaveBeenCalledOnce();
  });

  it("falls back to local last-good context when cloud startup is rate limited", async () => {
    const previousStorage = process.env.PRISM_STORAGE;
    process.env.PRISM_STORAGE = "synalux";
    const storageModes: Array<string | undefined> = [];
    mockSessionBootstrapHandler.mockImplementation(async () => {
      storageModes.push(process.env.PRISM_STORAGE);
      if (storageModes.length === 1) {
        throw new Error("[SynaluxStorage] /api/v1/prism/memory failed: Rate limit exceeded");
      }
      return {
        content: [{ type: "text", text: CANONICAL_BOOTSTRAP_TEXT }],
        isError: false,
      };
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await runBootstrapCommand();

      expect(storageModes).toEqual(["synalux", "local"]);
      expect(log).toHaveBeenCalledOnce();
      expect(log).toHaveBeenCalledWith(CANONICAL_BOOTSTRAP_TEXT);
      expect(error).toHaveBeenCalledWith(
        "Prism cloud startup unavailable; using local last-good context for this startup.",
      );
      expect(process.env.PRISM_STORAGE).toBe("synalux");
      expect(process.exitCode).toBeUndefined();
      expect(mockCloseStorage).toHaveBeenCalledTimes(2);
    } finally {
      if (previousStorage === undefined) delete process.env.PRISM_STORAGE;
      else process.env.PRISM_STORAGE = previousStorage;
    }
  });

  it("fails loud when the canonical handler cannot produce a display", async () => {
    mockSessionBootstrapHandler.mockRejectedValue(new Error("unexpected formatter failure"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await runBootstrapCommand();

    expect(error).toHaveBeenCalledWith("Bootstrap failed: unexpected formatter failure");
    expect(process.exitCode).toBe(1);
    expect(mockCloseStorage).toHaveBeenCalledOnce();
  });
});

describe("prism verify-behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSetting.mockImplementation(async (_key: string, fallback = "") => fallback);
    delete process.env.PRISM_SYNALUX_BASE_URL;
    delete process.env.PRISM_SYNALUX_API_KEY;
    process.exitCode = undefined;
  });

  afterEach(() => {
    if (ORIGINAL_SYNALUX_BASE_URL === undefined) delete process.env.PRISM_SYNALUX_BASE_URL;
    else process.env.PRISM_SYNALUX_BASE_URL = ORIGINAL_SYNALUX_BASE_URL;
    if (ORIGINAL_SYNALUX_API_KEY === undefined) delete process.env.PRISM_SYNALUX_API_KEY;
    else process.env.PRISM_SYNALUX_API_KEY = ORIGINAL_SYNALUX_API_KEY;
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("prints the canonical verifier scenario and forwards every scope field", async () => {
    mockVerifyBehaviorHandler.mockResolvedValue({
      content: [{ type: "text", text: "REAL VERIFIER SCENARIO" }],
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await runVerifyBehaviorCommand({
      file: "src/payments/capture.ts",
      summary: "fail closed after declined incremental auth",
      project: "workspace-app",
      workspaceId: "workspace-1",
    });

    expect(mockVerifyBehaviorHandler).toHaveBeenCalledWith({
      file_path: "src/payments/capture.ts",
      change_summary: "fail closed after declined incremental auth",
      project: "workspace-app",
      workspace_id: "workspace-1",
    });
    expect(log).toHaveBeenCalledWith("REAL VERIFIER SCENARIO");
    expect(process.exitCode).toBeUndefined();
  });

  it("loads the subscription credential from local Prism config before invoking the handler", async () => {
    mockGetSetting.mockImplementation(async (key: string, fallback = "") => {
      if (key === "PRISM_SYNALUX_BASE_URL") return "https://portal.test/";
      if (key === "PRISM_SYNALUX_API_KEY") return "synalux_sk_test";
      return fallback;
    });
    mockVerifyBehaviorHandler.mockImplementation(async () => ({
      content: [{
        type: "text",
        text: `${process.env.PRISM_SYNALUX_BASE_URL}|${process.env.PRISM_SYNALUX_API_KEY}`,
      }],
    }));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await runVerifyBehaviorCommand({
      file: "src/payments/capture.ts",
      summary: "guard capture",
    });

    expect(log).toHaveBeenCalledWith("https://portal.test|synalux_sk_test");
    expect(process.exitCode).toBeUndefined();
  });

  it("fails loud instead of inviting a self-authored scenario", async () => {
    mockVerifyBehaviorHandler.mockResolvedValue({ content: [] });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await runVerifyBehaviorCommand({
      file: "src/payments/capture.ts",
      summary: "guard capture",
    });

    expect(error).toHaveBeenCalledWith(
      "Behavioral verification failed: verify_behavior returned no scenario",
    );
    expect(process.exitCode).toBe(1);
  });
});
