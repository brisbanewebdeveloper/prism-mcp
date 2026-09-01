import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
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

describe("versioned-manifest coverage", () => {
  it("guards every manifest that a release bumps in lockstep", () => {
    // The brand-alias package is published to npm and version-locked with
    // prism-mcp-server, but was NOT in this list — a review of the 20.13.0
    // staging caught it left a full release behind while every other manifest
    // moved, which the guard would not have flagged. Pin it so it cannot fall
    // out of coverage silently.
    //
    // Read via SUBPROCESS, not import(): a top-level import of this .mjs
    // under vitest fails to parse on Windows — the exact failure mode the
    // published-version guard below already documents — and the 20.13.0
    // release reintroduced the import anyway, turning main's Windows CI red.
    // The path travels via env, NOT argv: the script's IS_MAIN guard compares
    // argv[1] to its own path, so passing it as an argument executes the full
    // publish check against this repo (exit 1 on any released version).
    const out = spawnSync(process.execPath, [
      "-e",
      "const{pathToFileURL}=require('node:url');import(pathToFileURL(process.env.GUARD_SCRIPT).href).then(m=>console.log(JSON.stringify(m.VERSIONED_MANIFESTS)))",
    ], { encoding: "utf8", env: { ...process.env, GUARD_SCRIPT: SCRIPT } });
    expect(out.status, out.stderr).toBe(0);
    const manifests: string[] = JSON.parse(out.stdout);
    expect(manifests).toContain("packages/prism-coder/package.json");
    expect(manifests).toContain("plugins/prism/.codex-plugin/plugin.json");
    expect(manifests).toContain("plugins/prism/.claude-plugin/plugin.json");
  });
});

describe("mcp launcher pin guard", () => {
  // The plugin catalogs reject unpinned auto-exec MCP launchers (their CI
  // gate landed 2026-08-19 while synalux-prism sat in review with exactly
  // `npx -y prism-mcp-server`). The pin is now a lockstep surface: this
  // exercises the exported checker with inline fixtures via the same
  // subprocess pattern the manifest-coverage test documents (top-level
  // import of the .mjs breaks vitest on Windows).
  it("flags unpinned and wrong-version launchers, passes the exact pin", () => {
    const out = spawnSync(process.execPath, [
      "-e",
      `const{pathToFileURL}=require('node:url');import(pathToFileURL(process.env.GUARD_SCRIPT).href).then(m=>{
        const f=m.mcpLauncherPinMismatches;
        console.log(JSON.stringify([
          f({mcpServers:{a:{command:'npx',args:['-y','prism-mcp-server']}}}, '1.2.3').length,
          f({mcpServers:{a:{command:'npx',args:['-y','prism-mcp-server@1.0.0']}}}, '1.2.3').length,
          f({mcpServers:{a:{command:'npx',args:['-y','prism-mcp-server@1.2.3']}}}, '1.2.3').length,
          f({mcpServers:{a:{command:'npx',args:['-y','some-other-package']}}}, '1.2.3').length,
          f({}, '1.2.3').length,
        ]))})`,
    ], { encoding: "utf8", env: { ...process.env, GUARD_SCRIPT: SCRIPT } });
    expect(out.status, out.stderr).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual([1, 1, 0, 0, 0]);
  });

  it("WIRING: the gate itself fails a repo whose only defect is a stale pin", () => {
    // Mutant analysis during authoring showed the two tests below never
    // exercise checkManifestVersions' wiring: dropping the checkMcpLauncherPin
    // call left them green. This drives the composed gate over a fixture repo
    // that is version-consistent EVERYWHERE except the launcher pin.
    const dir = mkdtempSync(resolve(tmpdir(), "pin-wiring-"));
    tempRepos.push(dir);
    const { mkdirSync } = require("node:fs");
    mkdirSync(resolve(dir, "plugins/prism"), { recursive: true });
    writeFileSync(resolve(dir, "package.json"), JSON.stringify({ name: "prism-mcp-server", version: "9.9.9" }));
    writeFileSync(resolve(dir, "server.json"), JSON.stringify({
      version: "9.9.9", description: "x",
      packages: [{ identifier: "prism-mcp-server", version: "9.9.9" }],
    }));
    writeFileSync(resolve(dir, "plugins/prism/.mcp.json"), JSON.stringify({
      mcpServers: { "prism-mcp": { command: "npx", args: ["-y", "prism-mcp-server@1.0.0"] } },
    }));
    const out = spawnSync(process.execPath, [
      "-e",
      `const{pathToFileURL}=require('node:url');import(pathToFileURL(process.env.GUARD_SCRIPT).href).then(m=>console.log(JSON.stringify(m.checkManifestVersions(process.env.FIXTURE))))`,
    ], { encoding: "utf8", env: { ...process.env, GUARD_SCRIPT: SCRIPT, FIXTURE: dir } });
    expect(out.status, out.stderr).toBe(0);
    const problems: string[] = JSON.parse(out.stdout);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('must be pinned "prism-mcp-server@9.9.9"');
  });

  it("the REAL plugin manifest is pinned to the REAL package version", () => {
    const mcp = JSON.parse(readFileSync(resolve(process.cwd(), "plugins/prism/.mcp.json"), "utf8"));
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));
    const args: string[] = mcp.mcpServers["prism-mcp"].args;
    expect(args).toContain(`prism-mcp-server@${pkg.version}`);
    expect(args).not.toContain("prism-mcp-server");
  });
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

// ── Private-identifier leak guard (mirrors .github/workflows/ci.yml) ─────────
// The CI guard checked ONE term (the private repo name) and stayed green while
// a private Vercel team slug and a private client project name shipped in the
// published npm package. Running it here too means it fails at `npm test`,
// before a publish, not after. Terms are split so this file cannot self-match.
describe("private identifiers must not appear in tracked files", () => {
  const TERMS = [
    "synalux" + "-private",
    "dcostencos" + "-projects",
    "bcba" + "-private",
    "prism-aac" + "-internal",
    "/Users/" + "admin",
  ];
  const IGNORE = /package-lock\.json|\.github\/workflows\/ci\.yml|tests\/publish-clean-guard\.test\.ts/;

  it.each(TERMS)("no tracked file contains %s", (term) => {
    const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" })
      .split("\n").filter(Boolean).filter((f) => !IGNORE.test(f));
    const hits = spawnSync("grep", ["-ln", term, ...tracked], { encoding: "utf8" })
      .stdout.split("\n").filter(Boolean);
    expect(hits, `private identifier leaked into: ${hits.join(", ")}`).toEqual([]);
  });
});

describe("published-version conflict guard", () => {
    // The manifest guard proves server.json and package.json AGREE. It says
    // nothing about whether the version ADVANCED — so main accumulated a
    // session of shipped work while both files sat at 20.6.0, agreeing with
    // each other and with npm, and disagreeing with reality. npm only
    // rejected it after a full build and pack.
    //
    // Driven through the SUBPROCESS, not import(): importing this .mjs under
    // vitest fails on Windows, while spawning it is already proven here.
    function runGuardWithPublished(repo: string, published: string) {
        return spawnSync(process.execPath, [SCRIPT], {
            cwd: repo,
            encoding: "utf8",
            env: { ...process.env, PRISM_GUARD_PUBLISHED_VERSION: published },
        });
    }

    function repoWithPackage(name: string, version: string): string {
        const repo = createCommittedRepo();
        writeFileSync(resolve(repo, "package.json"), JSON.stringify({ name, version }, null, 2));
        execFileSync("git", ["add", "package.json"], { cwd: repo });
        execFileSync("git", ["commit", "--quiet", "-m", "package"], { cwd: repo });
        return repo;
    }

    it("blocks a version npm already serves", () => {
        // Pinned via the seam, NOT the live registry: hard-coding a real
        // published version made this test fail the moment 20.7.0 shipped.
        const result = runGuardWithPublished(repoWithPackage("pkg", "20.6.0"), "20.6.0");
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("already published");
        expect(result.stderr).toContain("server.json");
    });

    it("allows a version that advances past the published one", () => {
        const result = runGuardWithPublished(repoWithPackage("pkg", "20.7.0"), "20.6.0");
        expect(result.stderr).not.toContain("already published");
        expect(result.status).toBe(0);
    });

    // The MCP Registry rejects a description over 100 chars with a 422 — at
    // publish time, on main, after every local gate passed. Measured
    // 2026-08-06 when a 369-char description rewrite failed exactly there.
    // The guard must catch it before a PR merges, not after.
    function repoWithDescription(description: string): string {
        const repo = repoWithPackage("pkg", "1.0.0");
        writeFileSync(
            resolve(repo, "server.json"),
            JSON.stringify({ name: "io.github.x/pkg", version: "1.0.0", description }, null, 2),
        );
        execFileSync("git", ["add", "server.json"], { cwd: repo });
        execFileSync("git", ["commit", "--quiet", "-m", "server"], { cwd: repo });
        return repo;
    }

    it("blocks a server.json description the registry would 422", () => {
        const result = spawnSync(process.execPath, [SCRIPT, "--manifest-only"], {
            cwd: repoWithDescription("x".repeat(101)),
            encoding: "utf8",
            env: { ...process.env },
        });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("MCP Registry rejects over 100");
    });

    it("allows a description at exactly the registry limit", () => {
        const result = spawnSync(process.execPath, [SCRIPT, "--manifest-only"], {
            cwd: repoWithDescription("x".repeat(100)),
            encoding: "utf8",
            env: { ...process.env },
        });
        expect(result.stderr).not.toContain("MCP Registry");
        expect(result.status).toBe(0);
    });

    it("--manifest-only skips the published check, because the registry republish runs AFTER npm publish", () => {
        // Without this the guard blocks the very republish it exists to
        // protect: the registry workflow runs post-publish, so "this version
        // is on npm" is its correct precondition. Observed on 20.7.0.
        const repo = repoWithPackage("pkg", "20.6.0");
        const full = runGuardWithPublished(repo, "20.6.0");
        expect(full.status).toBe(1);
        expect(full.stderr).toContain("already published");

        const scoped = spawnSync(process.execPath, [SCRIPT, "--manifest-only"], {
            cwd: repo,
            encoding: "utf8",
            env: { ...process.env, PRISM_GUARD_PUBLISHED_VERSION: "20.6.0" },
        });
        expect(scoped.status).toBe(0);
        expect(scoped.stderr).not.toContain("already published");
    });

    it("fails OPEN for a package the registry does not know", () => {
        // A first release must still work, so an unknown package cannot block.
        const result = runGuardWithPublished(repoWithPackage("pkg", "1.0.0"), "");
        expect(result.stderr).not.toContain("already published");
        expect(result.status).toBe(0);
    });
});
