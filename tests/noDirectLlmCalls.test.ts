import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Every model call inside prism goes through prism_infer.
 *
 * A thin `POST /api/chat` helper skips the entitlement ceiling, the RAM gate,
 * the tier walk and fallback, the quality gate, the hard-truncation retry, the
 * per-tier thinking policy and token floor, the route contract, and the Layer 1
 * reserved-content classifier. Three handlers did exactly that — task routing,
 * ledger compaction, and entity extraction — each hardcoding `prism-coder:9b`,
 * which is the tier with the most special handling of the four: the only one
 * that needs think=true, the only one with a token floor, and the one whose
 * envelope the route parser could not read until 2026-08-15.
 *
 * The audit that found them initially reported TWO, because it grepped for
 * `import ... from`. nerExtractor.ts used `await import(...)`, so a static
 * import grep never saw it. This test matches the module specifier itself,
 * which catches both forms.
 */

const SRC = new URL("../src", import.meta.url).pathname;

/** The one module allowed to hold a raw local-model HTTP call. */
const OWNER = "tools/prismInferHandler.ts";

/**
 * Modules permitted to reference the low-level helper directly.
 * localLlm.ts is the helper. layer1.ts is the reserved-content classifier that
 * runs BEFORE tier selection — it is part of the infer pipeline, not a caller
 * of it, and routing it through runInfer would recurse.
 */
const ALLOWED = new Set([
    "utils/localLlm.ts",
    "utils/layer1.ts",
    OWNER,
]);

function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            if (entry === "__tests__" || entry === "node_modules") continue;
            walk(full, out);
        } else if (entry.endsWith(".ts")) {
            out.push(full);
        }
    }
    return out;
}

const FILES = walk(SRC).map(f => ({ rel: f.slice(SRC.length + 1), text: readFileSync(f, "utf8") }));

describe("no module bypasses prism_infer to reach a model", () => {
    it("nothing imports the low-level local-LLM helper", () => {
        // Matches static AND dynamic imports: `from "./localLlm.js"` and
        // `await import("./localLlm.js")` both contain the specifier.
        const offenders = FILES
            .filter(f => !ALLOWED.has(f.rel))
            .filter(f => /["'][^"']*localLlm(\.js)?["']/.test(f.text))
            .map(f => f.rel);

        expect(offenders, `these call a model outside prism_infer: ${offenders.join(", ")}`).toEqual([]);
    });

    it("only the infer handler and layer 1 talk to Ollama over HTTP", () => {
        const offenders = FILES
            .filter(f => !ALLOWED.has(f.rel))
            .filter(f => /\/api\/(chat|generate)`/.test(f.text) || /["'][^"']*\/api\/(chat|generate)["']/.test(f.text))
            .map(f => f.rel);

        expect(offenders, `raw Ollama HTTP outside the handler: ${offenders.join(", ")}`).toEqual([]);
    });

    it("the allowlist stays small and every entry still exists", () => {
        // A growing allowlist is how this rule would quietly die.
        expect(ALLOWED.size).toBeLessThanOrEqual(3);
        for (const rel of ALLOWED) {
            expect(FILES.some(f => f.rel === rel), `allowlisted file is gone: ${rel}`).toBe(true);
        }
    });
});
