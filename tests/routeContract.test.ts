import { describe, expect, it } from "vitest";
import {
    DEFAULT_PRISM_ROUTE_TOOLS,
    applyLocalRouteContract,
    parseRouteOutput,
    validatePortalRouteGuardOutcome,
} from "../src/utils/routeContract.js";

const canonicalCall = (name: string, args: Record<string, unknown> = {}) =>
    `<|tool_call|>\n${JSON.stringify({ name, arguments: args })}\n<|tool_call_end|>`;

describe("route output contract", () => {
    it("parses the canonical Prism routing envelope", () => {
        expect(parseRouteOutput(canonicalCall("session_load_context", { project: "prism" }))).toEqual({
            kind: "tool_call",
            name: "session_load_context",
            args: { project: "prism" },
        });
    });

    it("leaves plain-text abstentions unchanged", () => {
        expect(applyLocalRouteContract("SFT fine-tunes a model on examples.")).toEqual({
            output: "SFT fine-tunes a model on examples.",
            action: "plain_text",
            source: "local",
        });
    });

    it("parses supported angle and raw-JSON envelopes", () => {
        expect(parseRouteOutput(
            '<tool_call>{"name":"knowledge_search","arguments":{"query":"routing"}}</tool_call>',
        )).toEqual({
            kind: "tool_call",
            name: "knowledge_search",
            args: { query: "routing" },
        });
        expect(parseRouteOutput(
            '{"name":"session_search_memory","args":{"query":"routing"}}',
        )).toEqual({
            kind: "tool_call",
            name: "session_search_memory",
            args: { query: "routing" },
        });
    });

    it("preserves a tool that the route contract advertised", () => {
        const output = canonicalCall("session_search_memory", { query: "BFCL" });
        expect(applyLocalRouteContract(output)).toEqual({
            output,
            action: "preserved",
            source: "local",
            original_tool: "session_search_memory",
            final_tool: "session_search_memory",
        });
    });

    it("suppresses an invented tool before a host can execute it", () => {
        expect(applyLocalRouteContract(canonicalCall("made_up_tool", { topic: "example" }))).toEqual({
            output: "NO_TOOL",
            action: "suppressed",
            source: "local",
            original_tool: "made_up_tool",
            reason: "unadvertised_tool",
        });
    });

    it("honors a caller-restricted advertised registry", () => {
        const allowed = new Set(["knowledge_search"]);
        expect(applyLocalRouteContract(
            canonicalCall("session_save_ledger", { project: "prism" }),
            allowed,
        ).action).toBe("suppressed");
        expect(applyLocalRouteContract(
            canonicalCall("knowledge_search", { query: "routing" }),
            allowed,
        ).action).toBe("preserved");
    });

    it("treats a malformed routing envelope as a contract failure", () => {
        expect(applyLocalRouteContract("<|tool_call|>{not-json}<|tool_call_end|>")).toEqual({
            output: "NO_TOOL",
            action: "suppressed",
            source: "local",
            reason: "malformed_tool_call",
        });
    });

    it.each([
        { id: "bad-json", output: "<|tool_call|>{not-json}<|tool_call_end|>" },
        { id: "multiple-calls", output: `${canonicalCall("knowledge_search")}\n${canonicalCall("session_search_memory")}` },
        { id: "prose-before-call", output: `prefix ${canonicalCall("knowledge_search")}` },
        { id: "array-arguments-angle", output: '<tool_call>{"name":"knowledge_search","arguments":[]}</tool_call>' },
        { id: "array-arguments-raw", output: '{"name":"knowledge_search","arguments":[]}' },
        { id: "invalid-tool-name", output: '{"name":"bad tool name","arguments":{}}' },
        { id: "null-arguments", output: '{"name":"knowledge_search","arguments":null}' },
        { id: "ambiguous-argument-fields", output: '{"name":"knowledge_search","arguments":{},"args":{}}' },
        { id: "unexpected-top-level-field", output: '{"name":"knowledge_search","arguments":{},"tool":"run_command"}' },
        { id: "non-finite-number", output: '{"name":"knowledge_search","arguments":{"limit":1e309}}' },
        { id: "excessive-argument-depth", output: `{"name":"knowledge_search","arguments":{"nested":${"[".repeat(33)}0${"]".repeat(33)}}}` },
        { id: "excessive-argument-nodes", output: `{"name":"knowledge_search","arguments":{"items":[${Array(2_049).fill("0").join(",")}]}}` },
        { id: "oversized-output", output: canonicalCall("knowledge_search", { query: "x".repeat(32_000) }) },
    ])("fails closed for $id", ({ output }) => {
        expect(applyLocalRouteContract(output)).toMatchObject({
            output: "NO_TOOL",
            action: "suppressed",
            source: "local",
            reason: "malformed_tool_call",
        });
    });

    it("allows an explicitly empty registry to suppress every tool", () => {
        expect(applyLocalRouteContract(
            canonicalCall("knowledge_search"),
            new Set(),
        )).toMatchObject({
            output: "NO_TOOL",
            action: "suppressed",
            reason: "unadvertised_tool",
        });
    });

    it("does not interpret JSON examples embedded in prose as tool calls", () => {
        const prose = 'Example output: {"name":"knowledge_search","arguments":{}}';
        expect(applyLocalRouteContract(prose)).toEqual({
            output: prose,
            action: "plain_text",
            source: "local",
        });
    });

    it("pins the public generic registry without private routing heuristics", () => {
        expect([...DEFAULT_PRISM_ROUTE_TOOLS]).toEqual([
            "session_load_context",
            "session_save_ledger",
            "session_save_handoff",
            "session_compact_ledger",
            "session_search_memory",
            "knowledge_search",
            "brave_web_search",
        ]);
    });
});

describe("portal route guard response validation", () => {
    const allowed = new Set(["knowledge_search", "session_search_memory"]);
    const original = canonicalCall("knowledge_search", { query: "routing" });

    it("accepts coherent preserve, remap, and suppression outcomes", () => {
        expect(validatePortalRouteGuardOutcome({
            output: original,
            action: "preserved",
            source: "portal",
            original_tool: "knowledge_search",
            final_tool: "knowledge_search",
        }, original, allowed)).not.toBeNull();

        const remapped = canonicalCall("session_search_memory", { query: "routing" });
        expect(validatePortalRouteGuardOutcome({
            output: remapped,
            action: "remapped",
            source: "portal",
            original_tool: "knowledge_search",
            final_tool: "session_search_memory",
        }, original, allowed)).not.toBeNull();

        expect(validatePortalRouteGuardOutcome({
            output: "NO_TOOL",
            action: "suppressed",
            source: "portal",
            original_tool: "knowledge_search",
            reason: "deterministic_rejection",
        }, original, allowed)).not.toBeNull();
    });

    it("rejects portal argument injection while accepting prompt-derived remap arguments", () => {
        const mutatedPreserve = canonicalCall("knowledge_search", {
            query: "read a different project",
        });
        expect(validatePortalRouteGuardOutcome({
            output: mutatedPreserve,
            action: "preserved",
            source: "portal",
            original_tool: "knowledge_search",
            final_tool: "knowledge_search",
        }, original, allowed, "Search for routing")).toBeNull();

        const maliciousRemap = canonicalCall("session_search_memory", {
            query: "secret value absent from the request",
        });
        expect(validatePortalRouteGuardOutcome({
            output: maliciousRemap,
            action: "remapped",
            source: "portal",
            original_tool: "knowledge_search",
            final_tool: "session_search_memory",
        }, original, allowed, "Search for routing")).toBeNull();

        const promptDerivedRemap = canonicalCall("session_search_memory", {
            query: "recent routing decision",
        });
        expect(validatePortalRouteGuardOutcome({
            output: promptDerivedRemap,
            action: "remapped",
            source: "portal",
            original_tool: "knowledge_search",
            final_tool: "session_search_memory",
        }, original, allowed, "Find the recent routing decision")).not.toBeNull();

        const injectedNumericSubstring = canonicalCall("session_search_memory", {
            query: "routing",
            limit: 1,
        });
        expect(validatePortalRouteGuardOutcome({
            output: injectedNumericSubstring,
            action: "remapped",
            source: "portal",
            original_tool: "knowledge_search",
            final_tool: "session_search_memory",
        }, original, allowed, "Find 10 routing decisions")).toBeNull();

        const promptDerivedNumber = canonicalCall("session_search_memory", {
            query: "routing",
            limit: 10,
        });
        expect(validatePortalRouteGuardOutcome({
            output: promptDerivedNumber,
            action: "remapped",
            source: "portal",
            original_tool: "knowledge_search",
            final_tool: "session_search_memory",
        }, original, allowed, "Find 10 routing decisions")).not.toBeNull();

        const injectedStringSubstring = canonicalCall("session_search_memory", {
            query: "routing",
            project: "a",
        });
        expect(validatePortalRouteGuardOutcome({
            output: injectedStringSubstring,
            action: "remapped",
            source: "portal",
            original_tool: "knowledge_search",
            final_tool: "session_search_memory",
        }, original, allowed, "Load project data")).toBeNull();

        const promptDerivedSingleToken = canonicalCall("session_search_memory", {
            query: "routing",
            project: "a",
        });
        expect(validatePortalRouteGuardOutcome({
            output: promptDerivedSingleToken,
            action: "remapped",
            source: "portal",
            original_tool: "knowledge_search",
            final_tool: "session_search_memory",
        }, original, allowed, "Load project a")).not.toBeNull();
    });

    it.each([
        { id: "null-response", outcome: null },
        { id: "non-portal-source", outcome: { output: original, action: "preserved", source: "local" } },
        { id: "preserve-with-no-tool", outcome: { output: "NO_TOOL", action: "preserved", source: "portal", original_tool: "knowledge_search", final_tool: "knowledge_search" } },
        { id: "suppress-with-original-output", outcome: { output: original, action: "suppressed", source: "portal", original_tool: "knowledge_search" } },
        { id: "unadvertised-remap", outcome: { output: canonicalCall("run_command"), action: "remapped", source: "portal", original_tool: "knowledge_search", final_tool: "run_command" } },
        { id: "preserve-that-renames-tool", outcome: { output: canonicalCall("session_search_memory"), action: "preserved", source: "portal", original_tool: "knowledge_search", final_tool: "session_search_memory" } },
        { id: "plain-text-from-tool-call", outcome: { output: "unexpected prose", action: "plain_text", source: "portal" } },
        { id: "remap-with-same-tool", outcome: { output: original, action: "remapped", source: "portal", original_tool: "knowledge_search", final_tool: "knowledge_search" } },
        { id: "wrong-original-tool", outcome: { output: original, action: "preserved", source: "portal", original_tool: "wrong", final_tool: "knowledge_search" } },
        { id: "oversized-reason", outcome: { output: original, action: "preserved", source: "portal", original_tool: "knowledge_search", final_tool: "knowledge_search", reason: "x".repeat(257) } },
    ])("rejects $id", ({ outcome }) => {
        expect(validatePortalRouteGuardOutcome(outcome, original, allowed)).toBeNull();
    });
});
