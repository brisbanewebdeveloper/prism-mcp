/**
 * npm postinstall — the operator notice printed at the one moment they are
 * certainly watching. Runs the BUILT dist/postinstall.js under a temp HOME
 * and CODEX_HOME, exactly as `npm install` would, so the assertions cover
 * the artifact that ships and not a re-import of the source.
 *
 * The defect these pin (2026-09 round 9): a Codex hooks.json that no longer
 * parsed was correctly left alone, but the notice still said "installed but
 * NOT yet trusted — press t", sending the operator to /hooks to trust an
 * entry that was never registered.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const POSTINSTALL = resolve("dist/postinstall.js");

let home: string;
let codexHome: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "prism-postinstall-"));
  codexHome = join(home, "codex-home");
  mkdirSync(codexHome, { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

// Auto mode is marker-gated: postinstall only touches hosts that carry the
// marker from a prior explicit `prism connect`.
function markManaged(): void {
  const hookDir = join(codexHome, "hooks", "prism-route");
  mkdirSync(hookDir, { recursive: true });
  writeFileSync(join(hookDir, ".prism-managed.json"), JSON.stringify({ managedBy: "prism", version: "0" }));
}

function runPostinstall(): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolveChild, rejectChild) => {
    const child = spawn(process.execPath, [POSTINSTALL], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        USERPROFILE: home,
        CODEX_HOME: codexHome,
      },
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", rejectChild);
    child.once("close", (status) => resolveChild({ status, stderr }));
  });
}

describe("postinstall notice", () => {
  // No skipIf: an unbuilt tree must FAIL here, not silently pass with the
  // whole suite skipped (round-10 NIT). CI builds before it tests, and the
  // cli-connect suite spawns dist/cli.js under the same contract.
  it("runs against the built artifact — `npm run build` first", () => {
    expect(existsSync(POSTINSTALL), `${POSTINSTALL} is missing — run \`npm run build\` before the tests`).toBe(true);
  });

  it("says the hooks.json is not valid JSON — never 'press t' for a hook that was never registered", async () => {
    markManaged();
    const corrupt = '{\n  "hooks": { "SessionStart": [] },\n}\n';
    writeFileSync(join(codexHome, "hooks.json"), corrupt);

    const { status, stderr } = await runPostinstall();

    expect(status).toBe(0); // a lifecycle script never breaks npm install
    expect(stderr).toContain("is not valid JSON");
    expect(stderr).toContain("prism-route hooks NOT registered");
    expect(stderr).toContain("prism connect --host codex");
    expect(stderr).not.toContain("NOT yet trusted");
    expect(stderr).not.toContain("press t");
    // Left byte-identical: replacing it would have wiped the operator's own
    // settings along with the syntax error.
    expect(readFileSync(join(codexHome, "hooks.json"), "utf8")).toBe(corrupt);
  });

  it("still tells the operator to trust a hook it DID register", async () => {
    markManaged();
    writeFileSync(join(codexHome, "hooks.json"), JSON.stringify({ hooks: {} }));

    const { status, stderr } = await runPostinstall();

    expect(status).toBe(0);
    expect(stderr).toContain("NOT yet trusted");
    expect(stderr).toContain("press t");
    expect(stderr).not.toContain("is not valid JSON");
    const cfg = JSON.parse(readFileSync(join(codexHome, "hooks.json"), "utf8"));
    expect(JSON.stringify(cfg.hooks.UserPromptSubmit)).toContain("prism-route");
  });

  it("prints nothing and writes nothing on a machine with no managed marker", async () => {
    writeFileSync(join(codexHome, "hooks.json"), "{ not json");

    const { status, stderr } = await runPostinstall();

    expect(status).toBe(0);
    expect(stderr).toBe("");
    expect(readFileSync(join(codexHome, "hooks.json"), "utf8")).toBe("{ not json");
    expect(existsSync(join(codexHome, "hooks", "prism-route"))).toBe(false);
  });
});
