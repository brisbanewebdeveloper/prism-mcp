import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = resolve(process.cwd(), "scripts/check-publish-clean.mjs");
const tempRepos: string[] = [];

function createCommittedRepo(): string {
  const repo = mkdtempSync(resolve(tmpdir(), "prism-publish-guard-"));
  tempRepos.push(repo);

  execFileSync("git", ["init", "--quiet"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "tests@prism.invalid"], {
    cwd: repo,
  });
  execFileSync("git", ["config", "user.name", "Prism Tests"], { cwd: repo });
  writeFileSync(resolve(repo, ".gitignore"), "dist/\n");
  writeFileSync(resolve(repo, "tracked.txt"), "committed\n");
  execFileSync("git", ["add", ".gitignore", "tracked.txt"], { cwd: repo });
  execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: repo });
  return repo;
}

function runGuard(repo: string) {
  return spawnSync(process.execPath, [SCRIPT], {
    cwd: repo,
    encoding: "utf8",
  });
}

afterEach(() => {
  for (const repo of tempRepos.splice(0)) {
    rmSync(repo, { recursive: true, force: true });
  }
});

describe("npm publish cleanliness guard", () => {
  it("allows a release only when its artifact is reproducible from Git", () => {
    const result = runGuard(createCommittedRepo());

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("blocks modified tracked source before npm can build it", () => {
    const repo = createCommittedRepo();
    writeFileSync(resolve(repo, "tracked.txt"), "uncommitted\n");

    const result = runGuard(repo);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("working tree is not clean");
    expect(result.stderr).toContain("tracked.txt");
  });

  it("blocks untracked source from entering an immutable package", () => {
    const repo = createCommittedRepo();
    writeFileSync(resolve(repo, "untracked.ts"), "export const leaked = true;\n");

    const result = runGuard(repo);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("working tree is not clean");
    expect(result.stderr).toContain("untracked.ts");
  });
});
