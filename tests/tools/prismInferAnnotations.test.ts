import { describe, it, expect } from "vitest";
import { PRISM_INFER_TOOL } from "../../src/tools/prismInferHandler.js";

/**
 * prism_infer must declare MCP annotations, or non-interactive hosts refuse it.
 *
 * Under the MCP spec an ABSENT `readOnlyHint` defaults to FALSE — a tool that
 * declares nothing is treated as potentially environment-modifying. Codex
 * running `codex exec` sits at approval:never with a read-only sandbox, so it
 * auto-denies such a tool: there is no user present to approve it.
 *
 * Measured 2026-08-16 against codex-cli 0.146.0, same dist/server.js both hosts
 * launch:
 *
 *   before — result {"Err":"user cancelled MCP tool call"},
 *            duration {secs:0, nanos:0}   (rejected before any work)
 *   after  — mcp: prism-mcp/prism_infer (completed),
 *            backend=ollama-4b used_cloud=false latency=494ms
 *
 * session_bootstrap already declared readOnlyHint and completed throughout,
 * which is what isolated the cause to the annotation rather than the transport,
 * the timeout, or the sandbox.
 *
 * This is a host-interop contract, so it is asserted on the exported definition
 * rather than through a live host.
 */
describe("prism_infer declares MCP annotations for non-interactive hosts", () => {
    it("declares annotations at all", () => {
        expect(
            PRISM_INFER_TOOL.annotations,
            "no annotations: readOnlyHint defaults to false and Codex/CI auto-denies the call",
        ).toBeDefined();
    });

    it("is marked read-only — it touches no workspace file and no user data", () => {
        expect(PRISM_INFER_TOOL.annotations?.readOnlyHint).toBe(true);
    });

    it("is marked non-destructive", () => {
        expect(PRISM_INFER_TOOL.annotations?.destructiveHint).toBe(false);
    });

    it("is marked non-idempotent — model output varies run to run", () => {
        expect(PRISM_INFER_TOOL.annotations?.idempotentHint).toBe(false);
    });

    it("is marked open-world — cloud_fallback egresses, and Ollama is an HTTP call", () => {
        expect(PRISM_INFER_TOOL.annotations?.openWorldHint).toBe(true);
    });
});
