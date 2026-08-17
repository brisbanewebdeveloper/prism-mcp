import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The leak guard needs its own guard.
 *
 * The first version of check-no-private-content.mjs reported "no private content
 * found" on a repo containing every pattern it blocks. It passed JavaScript
 * regex source (\b, \s, \w) to `git grep -E`, which speaks POSIX ERE and matches
 * none of it — and a `git grep` with no matches exits 1, which is
 * indistinguishable from a clean scan. Four of five content rules were dead.
 *
 * It shipped because there was no test for the script at all, and because the
 * one manual mutation used to check it happened to trip the target-layer literal — the
 * single rule that is a plain literal, and therefore the only one ERE could
 * match. A guard verified by one hand-picked positive is a guard verified by
 * luck.
 *
 * These tests run the REAL script as a subprocess against throwaway repos, the
 * same way publish-clean-guard.test.ts drives its guard, because the defect
 * lived in the interaction between the regex dialect and the git binary — not in
 * anything reachable by importing a function.
 */

const SCRIPT = resolve(process.cwd(), "scripts/check-no-private-content.mjs");
const tempRepos: string[] = [];

function repoWith(files: Record<string, string>): string {
    const repo = mkdtempSync(resolve(tmpdir(), "prism-leakguard-"));
    tempRepos.push(repo);
    execFileSync("git", ["init", "--quiet"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "tests@prism.invalid"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Prism Tests"], { cwd: repo });
    // The script scans the repo it runs in, so it has to live there too.
    mkdirSync(resolve(repo, "scripts"), { recursive: true });
    cpSync(SCRIPT, resolve(repo, "scripts/check-no-private-content.mjs"));
    for (const [path, body] of Object.entries(files)) {
        const full = resolve(repo, path);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, body);
    }
    execFileSync("git", ["add", "-A", "-f"], { cwd: repo });
    execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: repo });
    return repo;
}

function run(repo: string) {
    return spawnSync(process.execPath, [resolve(repo, "scripts/check-no-private-content.mjs")], {
        cwd: repo,
        encoding: "utf8",
    });
}

afterEach(() => {
    for (const repo of tempRepos.splice(0)) rmSync(repo, { recursive: true, force: true });
});

describe("the leak guard blocks what it claims to block", () => {
    it("passes a repo with nothing private in it", () => {
        const r = run(repoWith({ "README.md": "# hello\n", "src/index.ts": "export const x = 1;\n" }));
        expect(r.stderr).toBe("");
        expect(r.status).toBe(0);
        expect(r.stdout).toContain("self-tested");
    });

    // Each of these is a rule that was DEAD in the first version. Table-driven so
    // a rule added without a working pattern fails here rather than in production.
    it.each([
        ["LoRA rank", "docs/models.md", "fine-tuned with LoRA (r" + "=128) across the stack", "LoRA rank"],
        ["architecture name", "docs/models.md", "a Qwen3.5 Delta" + "Net backbone", "architecture detail"],
        ["target layers", "docs/models.md", "adapters on all 64" + " layers", "target layers"],
        ["hyperparameters", "notes.md", "learning" + "_rate 3e-5 and num" + "_epochs 4", "hyperparameter"],
        ["BFCL mislabel", "docs/table.md", "| Tag | BFCL" + " Accuracy | Tier |", "leaderboard submission"],
    ])("blocks %s", (_label, path, body, expected) => {
        const r = run(repoWith({ [path]: `${body}\n` }));
        expect(r.status, `guard passed on: ${body}`).toBe(1);
        expect(r.stderr, "exited 1 by crashing, not by detecting").toContain("BLOCKED");
        expect(r.stderr).toContain(expected);
    });

    it.each([
        ["nested training dir", "research/training/dataset.jsonl"],
        ["nested private monorepo", "scripts/prism-training/build_v3.py"],
        ["nested portal source", "docs/portal/secrets.md"],
        ["nested benchmark corpus", "ml/data/bfcl/eval.json"],
        ["a real env file", ".env.production.local"],
        ["an ssh key", "deploy/id_rsa"],
        ["a training corpus", "data/train_v2.jsonl"],
    ])("blocks %s — a leak one directory deep is still a leak", (_label, path) => {
        const r = run(repoWith({ [path]: "payload\n" }));
        expect(r.status, `guard passed on tracked path: ${path}`).toBe(1);
        // Status 1 is also what an uncaught throw produces. Without this the
        // whole table passes when the guard crashes on startup — which is
        // exactly how it passed while detecting nothing.
        expect(r.stderr, "exited 1 by crashing, not by detecting").toContain("BLOCKED");
    });

    it("still allows .env.example, which is a template", () => {
        const r = run(repoWith({ ".env.example": "API_KEY=your-key-here\n" }));
        expect(r.status).toBe(0);
    });

    it("exempts the ARCHITECTURE footnote from the BFCL rule ONLY", () => {
        // The footnote quotes the old column label to record the rename.
        const ok = run(repoWith({ "docs/ARCHITECTURE.md": 'previously read "BFCL' + ' Accuracy", which claimed\n' }));
        expect(ok.status, "the documented rename should be allowed").toBe(0);

        // But the same file must not become a blind spot for every other rule.
        const bad = run(repoWith({ "docs/ARCHITECTURE.md": "trained with LoRA (r" + "=128)\n" }));
        expect(bad.status, "a file-wide exemption would hide a real recipe leak").toBe(1);
        expect(bad.stderr).toContain("LoRA rank");
    });

    it("fails LOUDLY when a pattern cannot match its own sample", () => {
        // Simulates the original defect: swap the PCRE flag for ERE, under which
        // \b and \s match nothing. The guard must refuse to run, not report clean.
        const repo = repoWith({ "docs/models.md": "fine-tuned with LoRA (r" + "=128)\n" });
        const script = resolve(repo, "scripts/check-no-private-content.mjs");
        const src = execFileSync("cat", [script], { encoding: "utf8" });
        writeFileSync(script, src.replaceAll('"-lIiP"', '"-lIiE"'));

        const r = run(repo);
        expect(r.status, "a broken regex dialect must not report success").not.toBe(0);
        expect(r.stderr).toContain("SELF-TEST FAILED");
    });
});
