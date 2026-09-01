/**
 * Overflow sink for routed skill text that cannot fit an inline budget.
 *
 * Extracted from cli.ts (the UserPromptSubmit hook path) so the BOOTSTRAP path
 * can use the same mechanism. Before this was shared, bootstrap had no overflow
 * at all: it clipped a routed rule at SYMPTOM_SKILL_INLINE_MAX (1,800 chars)
 * and appended "… (rule truncated to fit the startup budget)". Every
 * super-skill is 8-15 KB, so a symptom-routed super-skill always arrived at
 * 12-23% of its text — while the same display told the agent to "follow them
 * before proposing any change". An agent cannot comply with a rule it can only
 * see a fifth of, and nothing pointed at the rest.
 */

import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** One file per over-budget routed payload, pruned after a week. */
const RETENTION_MS = 7 * 86_400_000;

export function routeOffloadDir(): string {
  return join(homedir(), ".prism-mcp", "route-context");
}

/**
 * Write `fullText` to the offload directory and return its path.
 *
 * Returns undefined on any failure — callers MUST degrade loudly in-band
 * rather than assume the text was delivered. Never throws: this runs inside
 * startup, which must not fail over an unwritable disk.
 */
export function writeRouteOffload(fullText: string, prefix = "route"): string | undefined {
  try {
    const dir = routeOffloadDir();
    mkdirSync(dir, { recursive: true });
    try {
      // Bounded: this runs synchronously on the STARTUP hot path (adversarial
      // review). A directory that has somehow accumulated thousands of files
      // must not turn bootstrap into an O(n) stat storm — cap the work and let
      // later calls finish the prune incrementally.
      const entries = readdirSync(dir);
      const PRUNE_SCAN_LIMIT = 256;
      for (const f of entries.slice(0, PRUNE_SCAN_LIMIT)) {
        const p = join(dir, f);
        try {
          if (Date.now() - statSync(p).mtimeMs > RETENTION_MS) rmSync(p);
        } catch { /* skip unstat-able entries */ }
      }
    } catch { /* prune failure never blocks the write */ }
    const target = join(dir, `${prefix}-${Date.now()}-${process.pid}.md`);
    writeFileSync(target, fullText);
    return target;
  } catch {
    return undefined;
  }
}
