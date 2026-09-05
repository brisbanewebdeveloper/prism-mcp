#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Every version the MCP Registry serves for this server, so a publish cannot
 * ship a listing that disagrees with the npm tarball.
 *
 * Why this guard exists (2026-08-05): the registry advertised 1.5.0 and
 * server.json carried 2.3.4 while npm latest was 20.6.0. Nothing tied the two
 * files together, so the public discovery surface — the default place Claude
 * and Codex users look for servers — silently drifted ~19 majors behind the
 * shipping build. The failure was invisible because npm publish succeeded
 * every time; only the storefront was stale.
 */
export function serverManifestVersionMismatches(packageJson, serverJson) {
  const expected = packageJson.version;
  const problems = [];
  if (serverJson.version !== expected) {
    problems.push(`server.json version is ${serverJson.version}, expected ${expected}`);
  }
  for (const [index, pkg] of (serverJson.packages ?? []).entries()) {
    if (pkg.identifier === packageJson.name && pkg.version !== expected) {
      problems.push(`server.json packages[${index}].version is ${pkg.version}, expected ${expected}`);
    }
  }
  return problems;
}

/**
 * Every OTHER manifest that carries a version and is published to a
 * storefront. The Codex plugin manifest sat at 20.6.0 through the 20.7.0
 * release and was caught only by reading it before a marketplace submission
 * — server.json was guarded, this was not. Any file listed here is held to
 * the same rule: if it declares a version, it must be package.json's.
 */
export const VERSIONED_MANIFESTS = [
  "plugins/prism/.codex-plugin/plugin.json",
  "plugins/prism/.claude-plugin/plugin.json",
  // The brand-alias package, published to npm as `prism-coder` and version-
  // locked in lockstep with prism-mcp-server. Every release commit bumps it, but
  // nothing enforced that — a review of the 20.13.0 staging caught it still at
  // 20.12.1 while every other manifest had moved, which would have shipped the
  // `prism-coder` npm listing a full release behind (publish-prism-coder.yml
  // reads its version and skips an already-published one). This is the exact
  // drift this guard exists to stop, one file wider than it previously reached.
  "packages/prism-coder/package.json",
];

/**
 * package-lock.json states the package version TWICE and neither field is
 * updated by editing package.json. Found 2026-08-11 by an external review:
 * the lockfile had said 20.8.1 across three shipped releases (20.8.2, 20.9.0,
 * 20.9.1) because nothing checked it. Harmless to the published tarball —
 * npm rewrites the version on pack — but it makes the lockfile lie to every
 * contributor, to `npm ci` provenance, and to anyone diffing a release. Same
 * failure the manifest guard above already exists for, one file wider.
 */
function checkLockfileVersion(repoRoot, expected) {
  let raw;
  try {
    raw = readFileSync(join(repoRoot, "package-lock.json"), "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
  const lock = JSON.parse(raw);
  const problems = [];
  if (lock.version !== expected) {
    problems.push(`package-lock.json version is ${lock.version}, expected ${expected}`);
  }
  const rootPackage = lock.packages?.[""];
  if (rootPackage && rootPackage.version !== expected) {
    problems.push(`package-lock.json packages[""].version is ${rootPackage.version}, expected ${expected}`);
  }
  return problems;
}

/**
 * The plugin's MCP launcher must be PINNED to the release version. An
 * unpinned `npx -y prism-mcp-server` executes whatever npm serves at install
 * time — which the Claude plugin catalogs now reject outright (their CI added
 * a "deterministic static pin check for auto-exec MCP launchers" on
 * 2026-08-19, while our submission sat in review with exactly that shape).
 * Once pinned, the version becomes one more lockstep surface: a release that
 * bumps package.json but not the launcher would ship a plugin that installs
 * the PREVIOUS server — so it is held to the same rule as every manifest
 * above.
 */
export function mcpLauncherPinMismatches(mcpJson, expected) {
  const problems = [];
  for (const [name, server] of Object.entries(mcpJson.mcpServers ?? {})) {
    const args = Array.isArray(server?.args) ? server.args : [];
    for (const arg of args) {
      if (typeof arg !== "string" || !arg.startsWith("prism-mcp-server")) continue;
      const pinned = `prism-mcp-server@${expected}`;
      if (arg !== pinned) {
        problems.push(
          `plugins/prism/.mcp.json server "${name}" launches "${arg}" — must be pinned "${pinned}"`,
        );
      }
    }
    const cmd = server?.command;
    if (typeof cmd === "string" && cmd.includes("prism-mcp-server") && !cmd.includes(`@${expected}`)) {
      problems.push(
        `plugins/prism/.mcp.json server "${name}" command "${cmd}" is not pinned to ${expected}`,
      );
    }
  }
  return problems;
}

function checkMcpLauncherPin(repoRoot, expected) {
  let raw;
  try {
    raw = readFileSync(join(repoRoot, "plugins/prism/.mcp.json"), "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return []; // fixture repos have no plugin
    throw error;
  }
  return mcpLauncherPinMismatches(JSON.parse(raw), expected);
}

function checkVersionedManifests(repoRoot, expected) {
  const problems = [];
  for (const relative of VERSIONED_MANIFESTS) {
    let raw;
    try {
      raw = readFileSync(join(repoRoot, relative), "utf8");
    } catch (error) {
      if (error && error.code === "ENOENT") continue; // not this repo's concern
      throw error;
    }
    const manifest = JSON.parse(raw);
    if (manifest.version !== undefined && manifest.version !== expected) {
      problems.push(`${relative} version is ${manifest.version}, expected ${expected}`);
    }
  }
  return problems;
}

/**
 * The release notes are a version surface too. CHANGELOG.md's first
 * versioned heading and each README's first "What's New in vX.Y.Z" are
 * written while the feature is built — before the bump — so at publish time
 * they can announce a version package.json does not carry (20.18.0 notes on
 * a 20.17.3 package, caught in review 2026-09-01 with nothing guarding it).
 * npm and the registry would then ship notes for a release that does not
 * exist.
 *
 * The rule is "never AHEAD of the package", not "equal to it": the notes
 * lag by convention (CHANGELOG led with 20.15.0 through the 20.16.0–20.17.3
 * releases), and an equality guard would have blocked every one of those
 * publishes. Only the FIRST versioned heading is read — older entries are
 * history — and only outside fenced code, where a heading is just text. A
 * README range like "v20.10.0 – v20.11.0" announces its NEWER bound: the
 * whole heading line is scanned and the highest version on it is compared
 * (reading the first capture alone let "v20.17.3 – v20.18.0" pass on a
 * 20.17.3 package — round-11 review). The whole-line scan widens the
 * known false-positive class from "heading starts with a date" to "heading
 * mentions any higher version-shaped token" (`## 1.0.0 — requires Node
 * 22.1.0` blocks, naming 22.1.0); zero such headings in 1,286 commits of
 * history, and the failure is loud and in the safe direction, so it is
 * accepted rather than special-cased. A pre-release package (1.0.0-rc.1)
 * compares on its numeric triple, so 1.0.0 notes are not "ahead" of it. A
 * repo with no docs has nothing to drift.
 */
const DOC_VERSION_HEADINGS = {
  changelog: /^#{1,6}\s+\[?v?\d+\.\d+(?:\.\d+)?\b.*$/m, // "## 20.18.0 — 2026-09-01"
  // Typographic apostrophe too: "What’s" silently disabled the README half.
  readme: /^#{1,6}\s+What['’]s New in v\d+\.\d+(?:\.\d+)?\b.*$/m,
};

function docHeadingFor(path) {
  return /(^|[\\/])CHANGELOG\.md$/i.test(path) ? DOC_VERSION_HEADINGS.changelog : DOC_VERSION_HEADINGS.readme;
}

function parseVersionTriple(text) {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(text ?? "").trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : null;
}

function compareVersionTriples(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/** The highest version-shaped token on one heading line — what the heading announces. */
function newestVersionOnLine(line) {
  let newest = null;
  for (const [, raw] of line.matchAll(/\bv?(\d+\.\d+(?:\.\d+)?)\b/g)) {
    const triple = parseVersionTriple(raw);
    if (triple && (!newest || compareVersionTriples(triple, newest.triple) > 0)) newest = { raw, triple };
  }
  return newest;
}

function withoutFencedBlocks(markdown) {
  const kept = [];
  let inFence = false;
  // A BOM glued to a first-line heading hid it from the anchored regex.
  for (const line of markdown.replace(/^\uFEFF/, "").split("\n")) {
    if (/^\s*(?:`{3,}|~{3,})/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) kept.push(line);
  }
  return kept.join("\n");
}

export function docsVersionMismatches(docs, expected) {
  const expectedTriple = parseVersionTriple(expected);
  if (!expectedTriple) return []; // an unparseable package version fails the manifest checks instead
  const problems = [];
  for (const { path, text } of docs) {
    if (!text) continue;
    const heading = withoutFencedBlocks(text).match(docHeadingFor(path));
    const newest = heading && newestVersionOnLine(heading[0]);
    if (newest && compareVersionTriples(newest.triple, expectedTriple) > 0) {
      problems.push(`${path} leads with ${newest.raw}, ahead of package.json ${expected}`);
    }
  }
  return problems;
}

function readOptional(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return null; // fixture repos have no docs
    throw error;
  }
}

export function releaseNoteDocPaths(repoRoot) {
  let translated = [];
  try {
    // Repo-relative names are reported verbatim and are the same document on
    // every OS, so they use `/` regardless of host — `path.join` produced
    // `docs\i18n\README_ja.md` on the Windows CI leg. `join(repoRoot, name)`
    // below still resolves a `/` name correctly on Windows.
    translated = readdirSync(join(repoRoot, "docs", "i18n"))
      .filter((name) => /^README_[A-Za-z-]+\.md$/.test(name))
      .sort()
      .map((name) => posix.join("docs", "i18n", name));
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
  return ["CHANGELOG.md", "README.md", ...translated];
}

function checkDocsVersion(repoRoot, expected) {
  return docsVersionMismatches(
    releaseNoteDocPaths(repoRoot).map((path) => ({ path, text: readOptional(join(repoRoot, path)) })),
    expected,
  );
}

export function checkManifestVersions(repoRoot) {
  // A repo without a registry manifest has nothing to drift: repos that never
  // published to the MCP Registry (and the guard's own test fixtures) must
  // pass untouched. Only an EXISTING manifest is held to the sync contract —
  // a present-but-corrupt server.json still fails loudly via the caller.
  let rawServer;
  let rawPackage;
  try {
    rawServer = readFileSync(join(repoRoot, "server.json"), "utf8");
    rawPackage = readFileSync(join(repoRoot, "package.json"), "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
  const packageJson = JSON.parse(rawPackage);
  const serverJson = JSON.parse(rawServer);
  return [
    ...serverManifestVersionMismatches(packageJson, serverJson),
    ...checkVersionedManifests(repoRoot, packageJson.version),
    ...checkLockfileVersion(repoRoot, packageJson.version),
    ...checkMcpLauncherPin(repoRoot, packageJson.version),
    ...checkDocsVersion(repoRoot, packageJson.version),
    ...serverDescriptionTooLong(serverJson),
  ];
}

/**
 * The MCP Registry rejects a server.json description over 100 characters
 * (422 "expected length <= 100" — measured live 2026-08-06, when a 369-char
 * description rewrite sailed through local CI and every manifest check, then
 * failed the publish workflow on main). The registry validates in Go, so we
 * bound BYTES, the stricter reading — a limit that passes here must pass
 * there regardless of how it counts.
 */
const REGISTRY_DESCRIPTION_MAX = 100;

export function serverDescriptionTooLong(serverJson) {
  const description = serverJson?.description;
  if (typeof description !== "string") return [];
  const bytes = Buffer.byteLength(description, "utf8");
  return bytes > REGISTRY_DESCRIPTION_MAX
    ? [`server.json description is ${bytes} bytes; the MCP Registry rejects over ${REGISTRY_DESCRIPTION_MAX} (422 at publish time)`]
    : [];
}

/**
 * Refuse a version that npm already serves.
 *
 * Why (2026-08-05): the manifest guard above proves server.json and
 * package.json AGREE — it says nothing about whether the version ADVANCED.
 * So `main` accumulated a session's worth of shipped work while both files
 * sat at 20.6.0, agreeing with each other and with npm, and disagreeing with
 * reality. The publish ran the full build and pack before npm rejected it
 * with "You cannot publish over the previously published versions".
 *
 * Fails OPEN on network trouble or an unpublished package: a first release
 * and an offline release must both still work. Only a definite match blocks.
 */
export function publishedVersionConflict(name, version, lookup) {
  let published;
  try {
    published = lookup(name);
  } catch {
    return null; // never published, offline, or registry unreachable
  }
  if (!published || published !== version) return null;
  return `${name}@${version} is already published. Bump the version in ` +
    `package.json, server.json (incl. packages[].version), and every entry in ` +
    `VERSIONED_MANIFESTS — naming only some of them is how the Codex plugin ` +
    `manifest drifted a full release behind.`;
}

function npmLatestVersion(name) {
  // Test seam. Without it this check's own tests assert against the LIVE
  // registry, so they encode whatever is published at the moment they were
  // written — and publishing 20.7.0 immediately falsified a test that had
  // hard-coded 20.6.0 as "already published". A guard whose tests break every
  // time you release is worse than no tests.
  const override = process.env.PRISM_GUARD_PUBLISHED_VERSION;
  if (override !== undefined) {
    if (override === "") throw new Error("simulated: package not published");
    return override;
  }
  return execFileSync("npm", ["view", name, "version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 15_000,
  }).trim();
}

function workingTreeStatus(repoRoot) {
  return execFileSync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
}

// Only gate when run as the prepublishOnly script. Importing this module —
// which the regression test does — must stay side-effect free, or the checks
// below would run against the test's cwd and set a failing exit code.
const IS_MAIN = process.argv[1]
  && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);

if (IS_MAIN) {
  try {
    const status = workingTreeStatus(process.cwd());
    if (status) {
      console.error(
        "npm publish blocked: the Prism working tree is not clean.\n" +
          "Commit, move, or restore every change before publishing:\n" +
          status,
      );
      process.exitCode = 1;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`npm publish blocked: unable to verify Git state: ${message}`);
    process.exitCode = 1;
  }

  try {
    const problems = checkManifestVersions(process.cwd());
    if (problems.length) {
      console.error(
        "npm publish blocked: a versioned manifest disagrees with package.json.\n" +
          "The MCP Registry listing would ship stale versions:\n  " +
          problems.join("\n  "),
      );
      process.exitCode = 1;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`npm publish blocked: unable to verify the versioned manifests: ${message}`);
    process.exitCode = 1;
  }

  // --manifest-only: verify the manifests agree, but SKIP the
  // already-published check. The registry publish workflow runs AFTER npm
  // publish, so "this version is on npm" is its correct precondition, not an
  // error — without this flag the guard blocks the very republish it exists
  // to protect (it did, on 20.7.0). npm publish itself passes no flag and
  // still gets the full gate.
  const manifestOnly = process.argv.includes("--manifest-only");

  if (manifestOnly) {
    console.log("manifest-only mode: skipping the published-version check.");
  } else try {
    let raw;
    try {
      raw = readFileSync(join(process.cwd(), "package.json"), "utf8");
    } catch (error) {
      // No package.json means nothing to publish (and is the shape of this
      // guard's own fixtures). Stay silent — a stderr warning here would make
      // the reproducibility test, which asserts empty stderr, fail.
      if (error && error.code === "ENOENT") raw = null;
      else throw error;
    }
    if (raw) {
      const pkg = JSON.parse(raw);
      const conflict = publishedVersionConflict(pkg.name, pkg.version, npmLatestVersion);
      if (conflict) {
        console.error(`npm publish blocked: ${conflict}`);
        process.exitCode = 1;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`npm publish: skipped the published-version check (${message})`);
  }
}
