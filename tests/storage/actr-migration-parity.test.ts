import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { ACTR_AUTH_SQL } from "../../src/storage/actrSupabaseMigration.js";
import { MIGRATIONS } from "../../src/storage/supabaseMigrations.js";
describe("legacy ACT-R authorization upgrade", () => {
  it("ships identical runtime and standalone SQL so existing installs receive the reviewed repair", () => {
    expect(readFileSync(new URL("../../supabase/migrations/040_actr_authenticated_history.sql",import.meta.url),"utf8").trim()).toBe(ACTR_AUTH_SQL.trim());
    expect(MIGRATIONS.find(migration => migration.version === 46)).toEqual({version:46,name:"actr_authenticated_history",sql:ACTR_AUTH_SQL});
    expect(MIGRATIONS.at(-1)).toMatchObject({version:47,name:"pipeline_orchestration_overrides_reconcile"});
    expect(MIGRATIONS.at(-1)?.sql).toContain("ADD COLUMN IF NOT EXISTS gate_override");
    expect(MIGRATIONS.at(-1)?.sql).toContain("ADD COLUMN IF NOT EXISTS override_reason");
    expect(new Set(MIGRATIONS.map(migration => migration.version)).size).toBe(MIGRATIONS.length);
  });
  it.each(["027_auto_migration_infra.sql","FULL_MIGRATION_016_to_020.sql"])("keeps alternate installation %s from reintroducing unauthenticated DDL", file => {
    const source=readFileSync(new URL("../../supabase/migrations/"+file,import.meta.url),"utf8");
    const pattern=/CREATE OR REPLACE FUNCTION public\.prism_apply_ddl\([\s\S]*?GRANT EXECUTE ON FUNCTION public\.prism_apply_ddl\(integer,text,text\) TO service_role;/;
    expect(source.match(pattern)?.[0]).toBe(ACTR_AUTH_SQL.match(pattern)?.[0]);
  });
});
