/**
 * Tests — the runner's daemon-targeting env (adversarial review, pre-20.14.0).
 *
 * The defect this pins: listTags read /api/tags from PRISM_LOCAL_LLM_URL
 * while spawned `ollama pull` / `ollama cp` used the shell's ambient
 * OLLAMA_HOST (default localhost). With a remote Ollama configured,
 * convergence read one daemon's tags and mutated another daemon's models.
 * The spawn env must pin OLLAMA_HOST to the exact url the tags came from.
 */
import { describe, it, expect } from "vitest";
import { convergeEnv } from "../../src/modelConvergeRunner.js";

describe("convergeEnv", () => {
    it("pins OLLAMA_HOST to the url the tags were read from", () => {
        const env = convergeEnv({ PATH: "/usr/bin" }, "http://gpu-box:11434");
        expect(env.OLLAMA_HOST).toBe("http://gpu-box:11434");
        expect(env.PATH).toBe("/usr/bin");
    });

    it("OVERRIDES an ambient shell OLLAMA_HOST — the split-brain case", () => {
        // Shell says remote, prism is configured for localhost: the CLI must
        // act on the daemon prism reads tags from, not the shell's.
        const env = convergeEnv(
            { OLLAMA_HOST: "http://somewhere-else:9999" },
            "http://localhost:11434",
        );
        expect(env.OLLAMA_HOST).toBe("http://localhost:11434");
    });

    it("does not mutate the input env object", () => {
        const base: NodeJS.ProcessEnv = { OLLAMA_HOST: "http://a:1" };
        convergeEnv(base, "http://b:2");
        expect(base.OLLAMA_HOST).toBe("http://a:1");
    });
});
