import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSupabaseGet = vi.fn();
const mockSupabaseRpc = vi.fn();

vi.mock("../../src/utils/supabaseApi.js", () => ({
  supabaseDelete: vi.fn(),
  supabaseGet: (...args: unknown[]) => mockSupabaseGet(...args),
  supabasePatch: vi.fn(),
  supabasePost: vi.fn(),
  supabaseRpc: (...args: unknown[]) => mockSupabaseRpc(...args),
}));

vi.mock("../../src/storage/configStorage.js", () => ({
  getAllSettings: vi.fn(async () => ({})),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
}));

vi.mock("../../src/storage/supabaseMigrations.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/storage/supabaseMigrations.js")>(
    "../../src/storage/supabaseMigrations.js"
  );

  return { ...actual, runAutoMigrations: vi.fn(async () => {}) };
});

describe("Supabase role-scoped semantic search migration", () => {
  it("ships matching automatic and checked-in migration definitions", async () => {
    const migrationSql = await readFile(
      new URL("../../supabase/migrations/045_role_scoped_semantic_search_handoff_embeddings.sql", import.meta.url),
      "utf8"
    );
    const { MIGRATIONS } = await import("../../src/storage/supabaseMigrations.js");
    const migration = MIGRATIONS.find((entry) => entry.version === 45);

    for (const column of ["embedding", "embedding_compressed", "embedding_format", "embedding_turbo_radius"]) {
      expect(migrationSql).toContain(`ADD COLUMN IF NOT EXISTS ${column}`);
      expect(migration?.sql).toContain(`ADD COLUMN IF NOT EXISTS ${column}`);
    }

    expect(migrationSql).toContain("p_role TEXT DEFAULT NULL");
    expect(migrationSql).toContain("(p_role IS NULL OR sl.role = p_role)");
    expect(migration?.sql).toContain("p_role TEXT DEFAULT NULL");
    expect(migration?.sql).toContain("(p_role IS NULL OR sl.role = p_role)");
  });
});

describe("SupabaseStorage semantic search", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("passes the optional role to the semantic-search RPC", async () => {
    mockSupabaseRpc.mockResolvedValue([]);

    const { SupabaseStorage } = await import("../../src/storage/supabase.js");
    const storage = new SupabaseStorage();

    await storage.searchMemory({
      queryEmbedding: "[0.1,0.2]",
      project: "prism-mcp",
      limit: 5,
      similarityThreshold: 0.7,
      userId: "user-1",
      role: "dev",
    });

    expect(mockSupabaseRpc).toHaveBeenCalledWith("semantic_search_ledger", {
      p_query_embedding: "[0.1,0.2]",
      p_project: "prism-mcp",
      p_limit: 5,
      p_similarity_threshold: 0.7,
      p_user_id: "user-1",
      p_role: "dev",
    });
  });
});
