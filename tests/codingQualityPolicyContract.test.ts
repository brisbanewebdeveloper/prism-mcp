import { describe, expect, it } from "vitest";
import { passesCodingQualityGate } from "../src/utils/codingQualityPolicy.js";

describe("public coding-quality contract", () => {
    it("accepts a complete implementation with ordinary trailing explanation", () => {
        const output = [
            "def add(a, b):",
            "    return a + b",
            "",
            "This returns the sum.",
        ].join("\n");

        expect(passesCodingQualityGate("Implement function add.", output)).toEqual({
            pass: true,
        });
    });

    it("rejects placeholder implementations", () => {
        const output = "def add(a, b):\n    # TODO: implement this";

        expect(passesCodingQualityGate("Implement function add.", output)).toEqual({
            pass: false,
            reason: "code_placeholder",
        });
    });

    it("rejects invalid Python instead of serving malformed source", () => {
        const output = "def add(a, b)\n    return a + b";

        expect(passesCodingQualityGate("Implement function add.", output)).toEqual({
            pass: false,
            reason: "python_syntax_error",
        });
    });

    it("does not apply Python syntax rules to TypeScript", () => {
        const output =
            "export function add(a: number, b: number): number {\n" +
            "  return a + b;\n" +
            "}";

        expect(passesCodingQualityGate("Implement function add.", output)).toEqual({
            pass: true,
        });
    });
});
