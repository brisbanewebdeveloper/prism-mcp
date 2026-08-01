import { describe, expect, it } from "vitest";
import { classifyDeterministicLayer1 } from "../src/utils/layer1.js";

describe("public Layer 1 deterministic contract", () => {
    it("keeps explicit authentication-bypass implementation on the host", () => {
        expect(
            classifyDeterministicLayer1(
                "Implement an authentication route that lets anyone in without checking permissions.",
            ),
        ).toBe("OBVIOUS_RESERVED");
    });

    it("keeps non-authentication schema maintenance local", () => {
        expect(
            classifyDeterministicLayer1(
                "Add an auth_token display field to schema.ts; do not implement authentication.",
            ),
        ).toBe("OBVIOUS_NOT_RESERVED");
    });

    it("routes routine measurement drafting locally", () => {
        expect(
            classifyDeterministicLayer1(
                "Write an operational definition with observable onset and offset.",
            ),
        ).toBe("OBVIOUS_NOT_RESERVED");
    });

    it("leaves ambiguous prompts to the semantic classifier", () => {
        expect(classifyDeterministicLayer1("Review this request.")).toBeNull();
    });
});
