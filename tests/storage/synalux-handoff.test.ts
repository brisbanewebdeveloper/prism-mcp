/**
 * SynaluxStorage save-handoff contract.
 *
 * The portal's canonical response places the OCC result under `result`.
 * Losing that envelope makes a durable save look like version `undefined`
 * and prevents downstream snapshot/embedding work from recognizing success.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PORTAL_URL = "https://portal.test";
const REFRESH_TOKEN = "synalux_sk_abcdef1234567890";

vi.mock("../../src/storage/supabase.js", () => ({
  SupabaseStorage: class {},
}));

vi.mock("../../src/utils/logger.js", () => ({
  debugLog: vi.fn(),
}));

async function importStorage() {
  vi.resetModules();
  process.env.PRISM_SYNALUX_BASE_URL = PORTAL_URL;
  process.env.PRISM_SYNALUX_API_KEY = REFRESH_TOKEN;
  return (await import("../../src/storage/synalux.js")).SynaluxStorage;
}

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("SynaluxStorage.saveHandoff", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.PRISM_SYNALUX_BASE_URL;
    delete process.env.PRISM_SYNALUX_API_KEY;
  });

  it("unwraps the portal result envelope with the authoritative OCC version", async () => {
    fetchMock
      .mockResolvedValueOnce(response({ status: "success", jwt: "jwt-1", expires_in: 900 }))
      .mockResolvedValueOnce(response({
        status: "success",
        action: "save_handoff",
        result: { status: "updated", version: 16 },
      }));

    const SynaluxStorage = await importStorage();
    const storage = new SynaluxStorage();
    const result = await storage.saveHandoff({
      project: "prismcoach",
      user_id: "ignored-by-server",
      last_summary: "Verified durable handoff",
      pending_todo: ["Restart host"],
    }, 15);

    expect(result).toEqual({ status: "updated", version: 16 });
    const request = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(request).toMatchObject({
      action: "save_handoff",
      project: "prismcoach",
      expected_version: 15,
    });
  });

  it("retains compatibility with the legacy handoff envelope", async () => {
    fetchMock
      .mockResolvedValueOnce(response({ status: "success", jwt: "jwt-1", expires_in: 900 }))
      .mockResolvedValueOnce(response({
        status: "success",
        handoff: { status: "created", version: 1 },
      }));

    const SynaluxStorage = await importStorage();
    const storage = new SynaluxStorage();
    const result = await storage.saveHandoff({
      project: "new-project",
      user_id: "ignored-by-server",
    });

    expect(result).toEqual({ status: "created", version: 1 });
  });

  it("normalizes the older version-only RPC result", async () => {
    fetchMock
      .mockResolvedValueOnce(response({ status: "success", jwt: "jwt-1", expires_in: 900 }))
      .mockResolvedValueOnce(response({
        status: "success",
        action: "save_handoff",
        result: { version: 7 },
      }));

    const SynaluxStorage = await importStorage();
    const storage = new SynaluxStorage();

    await expect(storage.saveHandoff({
      project: "rolling-upgrade",
      user_id: "ignored-by-server",
    })).resolves.toEqual({ status: "updated", version: 7 });
  });

  it.each([
    { name: "null", result: null, error: "missing result" },
    { name: "unversioned", result: { status: "updated" }, error: "malformed OCC result" },
    { name: "unknown status", result: { status: "success", version: 4 }, error: "malformed OCC result" },
  ])("fails loud for a $name handoff result", async ({ result, error }) => {
    fetchMock
      .mockResolvedValueOnce(response({ status: "success", jwt: "jwt-1", expires_in: 900 }))
      .mockResolvedValueOnce(response({
        status: "success",
        action: "save_handoff",
        result,
      }));

    const SynaluxStorage = await importStorage();
    const storage = new SynaluxStorage();

    await expect(storage.saveHandoff({
      project: "invalid-response",
      user_id: "ignored-by-server",
    })).rejects.toThrow(error);
  });

  it("routes handoff history snapshots through the authenticated portal", async () => {
    fetchMock
      .mockResolvedValueOnce(response({ status: "success", jwt: "jwt-1", expires_in: 900 }))
      .mockResolvedValueOnce(response({
        status: "success",
        action: "save_history_snapshot",
        project: "prismcoach",
        version: 21,
      }));

    const SynaluxStorage = await importStorage();
    const storage = new SynaluxStorage();
    await storage.saveHistorySnapshot({
      project: "prismcoach",
      user_id: "ignored-by-server",
      version: 21,
      last_summary: "Verified snapshot persistence",
      pending_todo: ["Restart host"],
    }, "main");

    const request = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(request).toMatchObject({
      action: "save_history_snapshot",
      project: "prismcoach",
      version: 21,
      branch: "main",
      snapshot: {
        last_summary: "Verified snapshot persistence",
      },
    });
  });
});
