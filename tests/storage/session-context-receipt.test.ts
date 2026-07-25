import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let dir: string;
let storage: typeof import("../../src/storage/configStorage.js");

const receipt = {
  conversationHash: "a".repeat(64),
  projectHash: "b".repeat(64),
  project: "prism",
  boundariesVersion: "23",
  loadedAt: 1_700_000_000_000,
  lastSeen: 1_700_000_001_000,
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "prism-session-receipt-"));
  process.env.PRISM_CONFIG_PATH = join(dir, "config.db");
  storage = await import("../../src/storage/configStorage.js");
  await storage.initConfigStorage();
});

afterAll(async () => {
  storage.closeConfigStorage();
  delete process.env.PRISM_CONFIG_PATH;
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" || !["EBUSY", "EPERM", "ENOTEMPTY"].includes(code ?? "")) {
      throw error;
    }
  }
});

describe("durable session context receipts", () => {
  it("round-trips an opaque project-scoped receipt", async () => {
    await storage.saveSessionContextReceipt(receipt, receipt.loadedAt - 1);

    await expect(storage.getSessionContextReceipt(
      receipt.conversationHash,
      receipt.projectHash,
    )).resolves.toEqual(receipt);
    await expect(storage.getSessionContextReceipt(
      receipt.conversationHash,
      "c".repeat(64),
    )).resolves.toBeNull();
  });

  it("prunes expired receipts while preserving active rows", async () => {
    const expired = {
      ...receipt,
      conversationHash: "d".repeat(64),
      lastSeen: receipt.loadedAt - 10,
    };
    await storage.saveSessionContextReceipt(expired, 0);
    await storage.saveSessionContextReceipt(receipt, receipt.loadedAt);

    await expect(storage.getSessionContextReceipt(
      expired.conversationHash,
      expired.projectHash,
    )).resolves.toBeNull();
    await expect(storage.getSessionContextReceipt(
      receipt.conversationHash,
      receipt.projectHash,
    )).resolves.toEqual(receipt);
  });

  it("rejects malformed receipt hashes before touching storage", async () => {
    await expect(storage.saveSessionContextReceipt(
      { ...receipt, conversationHash: "plain-conversation-id" },
      0,
    )).rejects.toThrow("Invalid session context receipt");
  });
});
