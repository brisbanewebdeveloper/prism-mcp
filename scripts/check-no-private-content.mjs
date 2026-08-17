#!/usr/bin/env node
/**
 * check-no-private-content — refuse to let private material into a PUBLIC repo.
 * ─────────────────────────────────────────────────────────────────────────────
 * This repository is public. Training corpora, evaluation methodology, roadmap
 * documents, and anything belonging to the private monorepo do not go in it.
 *
 * WHY THIS EXISTS, SPECIFICALLY
 *
 * Two separate incidents, not one:
 *
 *   1. 2026-05-05 — 178 training scripts (Modal orchestration, phase plans,
 *      BFCL evaluation methodology) were committed across the full history and
 *      had to be purged with filter-repo, force-pushing every branch and tag.
 *
 *   2. 2026-05-25 — three weeks after that cleanup, training/data/ landed again:
 *      sft_dataset_v2.jsonl (25.6 MB), grounded_recall_corpus.jsonl, and its
 *      README. They sat in the public tree until 2026-07-05 and remain in
 *      history. The .gitignore rule added by that cleanup was the ONLY control,
 *      and a .gitignore does not apply to a path that is already tracked, nor to
 *      an explicit `git add -f`.
 *
 * The second incident is the argument for this file. Prevention lived in a
 * single ignore rule with nothing verifying it, so the same class of content
 * came back by a route the rule could not see. This check runs in CI, looks at
 * what is actually TRACKED rather than what is ignored, and fails the build.
 *
 * Force-pushing a purge rewrites SHAs but does not undo exposure: anything
 * cloned, forked, or scraped during the window is gone for good. The only
 * control that works is the one that runs before the push.
 */

import { spawnSync } from "node:child_process";

/** Tracked paths that must never appear in a public repo. */
const FORBIDDEN_PATHS = [
    { re: /^training\//i, why: "training corpora and scripts belong in the private repo" },
    { re: /(^|\/)(sft|grounded_recall)[^/]*\.jsonl$/i, why: "training corpus" },
    { re: /(^|\/)corpus[^/]*\.jsonl$/i, why: "training corpus" },
    { re: /^data\/bfcl\//i, why: "benchmark corpus and evaluation methodology" },
    { re: /^prism-training\//i, why: "private training monorepo path" },
    { re: /^portal\//i, why: "private portal source" },
    { re: /^prism-aac\//i, why: "private application source" },
    { re: /(^|\/)(PHASE_[^/]*|PLAN_[^/]*|IMPLEMENTATION_PLAN[^/]*)\.md$/i, why: "roadmap / phase plan" },
    { re: /(^|\/)modal_[^/]*\.py$/i, why: "cloud GPU orchestration" },
    { re: /(^|\/)\.env$/i, why: "environment file (use .env.example)" },
    { re: /(^|\/)[^/]*\.(pem|key|p12|keystore)$/i, why: "private key material" },
];

/**
 * Content that must not appear even in an otherwise allowed path.
 *
 * The training-recipe patterns are here because stripping them once is not a
 * control. `training/` came back three weeks after the first purge; a published
 * hyperparameter comes back the same way, in a doc someone writes next month.
 * Publish the score, not the method that produced it — the scores and their
 * honesty caveats stay, the recipe does not.
 */
// Private IDENTIFIERS (repo names, team slugs, home paths) are deliberately NOT
// repeated here — ci.yml's "Private repo leak guard" step and
// tests/publish-clean-guard.test.ts already cover them, and a second copy would
// drift from the first. Add a new identifier to those, not to this list.
const FORBIDDEN_CONTENT = [
    { re: /\br\s*=\s*128\b/i, why: "LoRA rank — training recipe" },
    { re: /\bDeltaNet\b/i, why: "model architecture detail — training recipe" },
    { re: /all 64 layers/i, why: "LoRA target layers — training recipe" },
    { re: /\b(learning_rate|num_epochs|gradient_accum\w*)\b/i, why: "training hyperparameter" },
    { re: /BFCL Accuracy/i, why: "labels self-run results as a BFCL leaderboard submission" },
];

/** Paths exempt from the CONTENT scan — they legitimately describe the rules. */
const CONTENT_EXEMPT = [
    /^scripts\/check-no-private-content\.mjs$/,
    /^\.gitignore$/,
    // Records that the column was renamed and why. Naming the old label is the
    // point of the note; without this the correction itself trips the rule.
    /^docs\/ARCHITECTURE\.md$/,
];

function git(args) {
    const proc = spawnSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    // An ENOENT or a signal kill yields no stdout, which would otherwise read as
    // "nothing forbidden found" — the failure mode this check exists to prevent.
    if (proc.error) throw new Error(`git ${args[0]} failed to run: ${proc.error.message}`);
    if (proc.status !== 0) throw new Error(`git ${args.join(" ")} exited ${proc.status}: ${proc.stderr?.trim()}`);
    return proc.stdout;
}

const tracked = git(["ls-files"]).split("\n").map(s => s.trim()).filter(Boolean);
if (tracked.length === 0) throw new Error("git ls-files returned nothing — refusing to report a clean result");

const violations = [];

for (const path of tracked) {
    for (const { re, why } of FORBIDDEN_PATHS) {
        if (re.test(path)) violations.push({ path, why, kind: "path" });
    }
}

// Content scan via `git grep`, which searches tracked files only.
for (const { re, why } of FORBIDDEN_CONTENT) {
    const pattern = re.source;
    const proc = spawnSync("git", ["grep", "-lIiE", pattern], { encoding: "utf8" });
    if (proc.error) throw new Error(`git grep failed to run: ${proc.error.message}`);
    // status 1 = no matches (expected); >1 = real error.
    if (proc.status !== 0 && proc.status !== 1) {
        throw new Error(`git grep exited ${proc.status}: ${proc.stderr?.trim()}`);
    }
    for (const path of (proc.stdout ?? "").split("\n").map(s => s.trim()).filter(Boolean)) {
        if (CONTENT_EXEMPT.some(ex => ex.test(path))) continue;
        violations.push({ path, why, kind: "content" });
    }
}

if (violations.length > 0) {
    console.error("BLOCKED: private content is tracked in a PUBLIC repository.\n");
    for (const v of violations) {
        console.error(`  ${v.kind === "path" ? "path   " : "content"}  ${v.path}\n           -> ${v.why}`);
    }
    console.error(
        "\nMove these to the private repository. Note that removing a file in a later" +
        "\ncommit does NOT remove it from history — if it has already been pushed," +
        "\ntreat it as exposed and purge the history deliberately.",
    );
    process.exit(1);
}

console.log(`check-no-private-content: ${tracked.length} tracked paths, no private content found.`);
