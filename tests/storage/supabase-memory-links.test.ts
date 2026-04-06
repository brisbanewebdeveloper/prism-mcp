import { readFile } from "node:fs/promises";
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSupabaseRpc = vi.fn();
const mockSupabaseGet = vi.fn();
const mockSupabasePost = vi.fn();
const mockSupabasePatch = vi.fn();
const mockSupabaseDelete = vi.fn();

vi.mock("../../src/utils/supabaseApi.js", () => ({
  supabaseRpc: (...args: any[]) => mockSupabaseRpc(...args),
  supabaseGet: (...args: any[]) => mockSupabaseGet(...args),
  supabasePost: (...args: any[]) => mockSupabasePost(...args),
  supabasePatch: (...args: any[]) => mockSupabasePatch(...args),
  supabaseDelete: (...args: any[]) => mockSupabaseDelete(...args),
}));

vi.mock("../../src/storage/configStorage.js", () => ({
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  getAllSettings: vi.fn(async () => ({})),
}));

vi.mock("../../src/storage/supabaseMigrations.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/storage/supabaseMigrations.js")>(
    "../../src/storage/supabaseMigrations.js"
  );

  return {
    ...actual,
    runAutoMigrations: vi.fn(async () => {}),
  };
});

describe("Supabase memory link migration SQL", () => {
  it("uses a constraint-based conflict target in the checked-in SQL migrations", async () => {
    const migration35 = await readFile(
      new URL("../../supabase/migrations/035_rpc_soft_delete_and_write_security.sql", import.meta.url),
      "utf8"
    );
    const migration42 = await readFile(
      new URL("../../supabase/migrations/042_fix_prism_create_link_ambiguity.sql", import.meta.url),
      "utf8"
    );

    expect(migration35).toContain("ON CONFLICT ON CONSTRAINT memory_links_pkey");
    expect(migration42).toContain("ON CONFLICT ON CONSTRAINT memory_links_pkey");
  });

  it("ships the same create-link repair through startup auto-migrations", async () => {
    const { MIGRATIONS } = await import("../../src/storage/supabaseMigrations.js");
    const migration35 = MIGRATIONS.find((migration) => migration.version === 35);
    const migration42 = MIGRATIONS.find((migration) => migration.version === 42);

    expect(migration35?.sql).toContain("ON CONFLICT ON CONSTRAINT memory_links_pkey");
    expect(migration42?.sql).toContain("ON CONFLICT ON CONSTRAINT memory_links_pkey");
  });
});

describe("SupabaseStorage createLink", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockSupabaseRpc.mockReset();
    mockSupabaseGet.mockReset();
    mockSupabasePost.mockReset();
    mockSupabasePatch.mockReset();
    mockSupabaseDelete.mockReset();
  });

  it("calls prism_create_link with the expected payload and prunes related links", async () => {
    mockSupabaseRpc.mockResolvedValueOnce(null);
    mockSupabaseRpc.mockResolvedValueOnce(null);

    const { SupabaseStorage } = await import("../../src/storage/supabase.js");
    const storage = new SupabaseStorage();

    await storage.createLink({
      source_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      target_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      link_type: "related_to",
      strength: 0.42,
      metadata: JSON.stringify({ shared_keywords: 4 }),
    }, "user-123");

    expect(mockSupabaseRpc).toHaveBeenNthCalledWith(1, "prism_create_link", {
      p_user_id: "user-123",
      p_source_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      p_target_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      p_link_type: "related_to",
      p_strength: 0.42,
      p_metadata: { shared_keywords: 4 },
    });

    expect(mockSupabaseRpc).toHaveBeenNthCalledWith(2, "prism_prune_excess_links", {
      p_entry_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      p_link_type: "related_to",
      p_max_links: 25,
    });
  });
});
