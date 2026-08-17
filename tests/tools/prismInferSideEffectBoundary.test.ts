import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PRISM_INFER_TOOL } from "../../src/tools/prismInferHandler.js";

/**
 * `readOnlyHint: true` must stay TRUE, not merely convenient.
 *
 * MCP defines readOnlyHint as "the tool does not modify its environment", and
 * prism_infer is annotated read-only on the reading that "its environment"
 * means the caller's domain, not the server's own bookkeeping — the same
 * reading that makes the sibling idempotentHint coherent, since under a literal
 * reading no tool that keeps a log could ever be idempotent.
 *
 * That reading is only defensible while the side-effect boundary actually
 * holds. Measured 2026-08-16: three prism_infer calls appended exactly three
 * rows to infer_metrics and touched prism-config.db-wal, and nothing else on
 * disk — no working-directory writes, no user files. The handler itself
 * performs zero direct filesystem writes; its single write goes through
 * appendInferMetric into prism's own state directory.
 *
 * A comment cannot enforce that. This test can. If someone adds a real
 * filesystem write to the handler, the annotation silently becomes a false
 * statement to every client that reads it — including Codex, which uses it to
 * decide whether to run the tool without a human present. Failing here forces
 * the hint to be re-argued instead of carried forward on inertia.
 *
 * This is deliberately a SOURCE guard. A behavioural test would have to
 * enumerate every path that might write, and would pass while missing the one
 * that does.
 */

const HANDLER_SRC = readFileSync(
    fileURLToPath(new URL("../../src/tools/prismInferHandler.ts", import.meta.url)),
    "utf8",
);

/** Strip comments so the prose ABOUT writes cannot trip the guard. */
function codeOnly(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, "")   // block comments
        .replace(/^\s*\/\/.*$/gm, "");      // line comments
}

describe("prism_infer's read-only claim is enforced, not asserted", () => {
    it("the handler performs no direct filesystem writes", () => {
        const code = codeOnly(HANDLER_SRC);
        // Anything that creates, mutates, or removes a path. Reads are fine.
        const writeCalls = code.match(
            /\b(writeFileSync|writeFile|appendFileSync|appendFile|mkdirSync|mkdir|rmSync|unlinkSync|unlink|createWriteStream|copyFileSync|renameSync|truncateSync)\s*\(/g,
        );
        expect(
            writeCalls,
            `prismInferHandler gained a filesystem write (${writeCalls?.join(", ")}). ` +
            "readOnlyHint: true is now a false statement to every client that reads it, " +
            "including Codex, which uses it to run this tool with no human present. " +
            "Either remove the write or change the hint — do not leave both.",
        ).toBeNull();
    });

    it("still declares itself read-only, so the guard above is load-bearing", () => {
        // If someone flips the hint, the guard becomes decoration. Pin them together.
        expect(PRISM_INFER_TOOL.annotations?.readOnlyHint).toBe(true);
    });

    it("declares the non-read-only truths it does not get to hide behind", () => {
        // Read-only does not mean effect-free. Model output varies, and the tool
        // reaches the network — both must stay declared.
        expect(PRISM_INFER_TOOL.annotations?.idempotentHint).toBe(false);
        expect(PRISM_INFER_TOOL.annotations?.openWorldHint).toBe(true);
        expect(PRISM_INFER_TOOL.annotations?.destructiveHint).toBe(false);
    });
});
