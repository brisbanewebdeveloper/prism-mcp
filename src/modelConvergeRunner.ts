/**
 * Production wiring for model convergence — real Ollama, real registry.
 *
 * Kept out of cli.ts so the pure logic (utils/modelConverge.ts) stays
 * testable with injected deps, and out of utils/ because this half owns
 * process spawning. `ollama pull` runs with inherited stdio deliberately:
 * a multi-GB download with no progress bar reads as a hang, and ollama's
 * own progress output is better than anything we would reimplement.
 */
import { spawn } from "node:child_process";
import { convergeModels, type TierOutcome } from "./utils/modelConverge.js";

const OLLAMA_URL = process.env.PRISM_LOCAL_LLM_URL || "http://localhost:11434";

function runOllama(args: string[], inheritStdio: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn("ollama", args, {
            stdio: inheritStdio ? "inherit" : "ignore",
        });
        child.on("error", (err) => reject(new Error(`ollama ${args[0]}: ${err.message}`)));
        child.on("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`ollama ${args.join(" ")} exited ${code}`));
        });
    });
}

export async function runOllamaConverge(opts: { dryRun?: boolean } = {}): Promise<TierOutcome[]> {
    console.log("\nConverging local models against the registry…");
    const outcomes = await convergeModels({
        listTags: async () => {
            const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(5_000) });
            if (!res.ok) throw new Error(`Ollama /api/tags HTTP ${res.status}`);
            const data = (await res.json()) as { models?: Array<{ name: string; digest: string }> };
            return (data.models ?? []).map((m) => ({ name: m.name, digest: m.digest }));
        },
        pull: (ref) => runOllama(["pull", ref], true),
        copy: (from, to) => runOllama(["cp", from, to], false),
        log: (line) => console.log(`  ${line}`),
        dryRun: opts.dryRun,
    });

    const failed = outcomes.filter((o) => o.action === "failed" && o.detail !== "ollama_unreachable");
    if (failed.length > 0) {
        console.log(`  ⚠ ${failed.length} tier(s) did not converge — re-run \`prism update-models\` when the network allows`);
    }
    return outcomes;
}
