import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawnSyncMock } = vi.hoisted(() => ({
    spawnSyncMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
    spawnSync: spawnSyncMock,
}));

import { passesCodingQualityGate } from "../src/utils/codingQualityPolicy.js";

const READY_SENTINEL = "PRISM_PYTHON_READY\n";

function childResult(status: number, stdout = "", stderr = "") {
    return {
        status,
        stdout,
        stderr,
        error: undefined,
        signal: null,
        pid: 1,
        output: [null, stdout, stderr],
    };
}

describe("Python coding gate runtime selection", () => {
    beforeEach(() => {
        spawnSyncMock.mockReset();
    });

    it("skips a Windows Store python3 alias and accepts valid code through python", () => {
        spawnSyncMock
            .mockReturnValueOnce(childResult(1, "", "Python was not found"))
            .mockReturnValueOnce(childResult(0, READY_SENTINEL));

        const result = passesCodingQualityGate(
            "Implement class TrieNode.",
            "class TrieNode:\n    def __init__(self):\n        self.children = {}",
        );

        expect(result).toEqual({ pass: true });
        expect(spawnSyncMock.mock.calls.map((call) => call[0])).toEqual([
            "python3",
            "python",
        ]);
    });

    it("still rejects invalid Python when the fallback interpreter runs the parser", () => {
        spawnSyncMock
            .mockReturnValueOnce(childResult(1, "", "Python was not found"))
            .mockReturnValueOnce(childResult(1, READY_SENTINEL, "SyntaxError"));

        const result = passesCodingQualityGate(
            "Implement class TrieNode.",
            "class TrieNode:\n    return 1",
        );

        expect(result).toEqual({
            pass: false,
            reason: "python_syntax_error",
        });
        expect(spawnSyncMock.mock.calls.map((call) => call[0])).toEqual([
            "python3",
            "python",
        ]);
    });
});
