/**
 * prism-route hook — install machinery and the hook script itself.
 *
 * The failure this feature exists to prevent is "shipped but never activated":
 * hooks that lived on one machine because a bootstrap script ran there once.
 * So the tests that matter are idempotence, preservation of OTHER people's
 * hooks, and the script's never-break-the-turn contract.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  ensurePromptRouteHook,
  PROMPT_ROUTE_HOOK_SCRIPT,
  PROMPT_ROUTE_HOOK_VERSION,
} from "../src/promptRouteHostHook.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "prism-hook-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".codex"), { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const claudeConfig = () => JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
const codexConfig = () => JSON.parse(readFileSync(join(home, ".codex", "hooks.json"), "utf8"));

describe("install", () => {
  it("installs script + registration for BOTH hosts", () => {
    const results = ensurePromptRouteHook({ homeDir: home, env: {} });
    expect(results.map((r) => `${r.host}:${r.script}:${r.config}`).sort()).toEqual([
      "claude:installed:registered",
      "codex:installed:registered",
    ]);
    for (const cfg of [claudeConfig(), codexConfig()]) {
      // JSON.stringify doubles backslashes on Windows; normalize before matching.
      const cmds = JSON.stringify(cfg.hooks.UserPromptSubmit).replace(/\\+/g, "/");
      // The version rides in the CONFIGURED COMMAND: Codex's trust hash covers
      // the definition, not the script file, so a version-refreshed script
      // behind a stable command would silently change trusted content.
      expect(cmds).toContain(`prism-route/on_prompt.py --v${PROMPT_ROUTE_HOOK_VERSION}`);
    }
    expect(existsSync(join(home, ".claude", "hooks", "prism-route", "on_prompt.py"))).toBe(true);
    expect(existsSync(join(home, ".codex", "hooks", "prism-route", "state"))).toBe(true);
  });

  it("is idempotent — second run writes nothing and registers nothing twice", () => {
    ensurePromptRouteHook({ homeDir: home, env: {} });
    const before = readFileSync(join(home, ".claude", "settings.json"), "utf8");
    const results = ensurePromptRouteHook({ homeDir: home, env: {} });
    expect(results.every((r) => r.script === "unchanged" && r.config === "unchanged")).toBe(true);
    expect(readFileSync(join(home, ".claude", "settings.json"), "utf8")).toBe(before);
  });

  it("preserves hooks that are not ours — the config is shared real estate", () => {
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({
        env: { KEEP: "me" },
        hooks: {
          UserPromptSubmit: [
            { matcher: "*", hooks: [{ type: "command", command: "python3 /x/screenshot-first/detect.py", timeout: 5 }] },
          ],
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "/y/gate.py" }] }],
        },
      }),
    );
    ensurePromptRouteHook({ homeDir: home, env: {} });
    const cfg = claudeConfig();
    expect(cfg.env.KEEP).toBe("me");
    expect(cfg.hooks.PreToolUse).toHaveLength(1);
    expect(cfg.hooks.UserPromptSubmit).toHaveLength(2);
    expect(JSON.stringify(cfg.hooks.UserPromptSubmit[0])).toContain("screenshot-first");
  });

  it("a version bump UPDATES the registered command in place — no duplicate, new trust hash", () => {
    ensurePromptRouteHook({ homeDir: home, env: {} });
    // Simulate a previous release: old marker AND an old-style command.
    const cfgPath = join(home, ".codex", "hooks.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    const hook = cfg.hooks.UserPromptSubmit[0].hooks[0];
    hook.command = hook.command.replace(/ --v\d+$/, " --v0");
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    writeFileSync(join(home, ".codex", "hooks", "prism-route", ".prism-managed.json"),
      JSON.stringify({ managedBy: "prism", version: "0" }));

    const results = ensurePromptRouteHook({ homeDir: home, env: {} });
    const codex = results.find((r) => r.host === "codex");
    expect(codex?.config).toBe("updated");
    const after = JSON.parse(readFileSync(cfgPath, "utf8"));
    const cmds = after.hooks.UserPromptSubmit.flatMap((e: { hooks: Array<{ command: string }> }) => e.hooks.map((h) => h.command));
    expect(cmds.filter((c: string) => c.includes("prism-route"))).toHaveLength(1); // replaced, not appended
    expect(cmds[0]).toContain(`--v${PROMPT_ROUTE_HOOK_VERSION}`);
  });

  it("codex registration carries additionalContextLimit: 0 — the default (~2,500 tokens) truncates our payload to a preview", () => {
    ensurePromptRouteHook({ homeDir: home, env: {} });
    const entry = codexConfig().hooks.UserPromptSubmit.find((e: unknown) => JSON.stringify(e).includes("prism-route"));
    expect(entry.hooks[0].additionalContextLimit).toBe(0);
  });

  it("claude registration does NOT carry the codex-only field — no unknown keys in settings.json", () => {
    ensurePromptRouteHook({ homeDir: home, env: {} });
    const entry = claudeConfig().hooks.UserPromptSubmit.find((e: unknown) => JSON.stringify(e).includes("prism-route"));
    expect("additionalContextLimit" in entry.hooks[0]).toBe(false);
  });

  it("a codex entry missing the field is CONVERGED in place — no duplicate entry", () => {
    // The state every machine registered before this fix is in right now.
    ensurePromptRouteHook({ homeDir: home, env: {} });
    const cfgPath = join(home, ".codex", "hooks.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    delete cfg.hooks.UserPromptSubmit[0].hooks[0].additionalContextLimit;
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

    const results = ensurePromptRouteHook({ homeDir: home, env: {} });
    expect(results.find((r) => r.host === "codex")?.config).toBe("updated");
    const after = JSON.parse(readFileSync(cfgPath, "utf8"));
    const ours = after.hooks.UserPromptSubmit.flatMap((e: { hooks: Array<{ command: string }> }) => e.hooks)
      .filter((h: { command: string }) => h.command.includes("prism-route"));
    expect(ours).toHaveLength(1); // converged, not appended
    expect((ours[0] as { additionalContextLimit?: number }).additionalContextLimit).toBe(0);
  });

  it("registers a SessionStart entry matched on `compact` for BOTH hosts — the post-compaction floor re-injection", () => {
    ensurePromptRouteHook({ homeDir: home, env: {} });
    for (const [host, cfg] of [["claude", claudeConfig()], ["codex", codexConfig()]] as const) {
      const ours = (cfg.hooks.SessionStart as Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>)
        .filter((e) => JSON.stringify(e).replace(/\\+/g, "/").includes("prism-route/on_prompt.py"));
      expect(ours, host).toHaveLength(1);
      // Startup/resume/clear must NOT fire it: the bootstrap already carries
      // the digest there and a second copy is pure cost.
      expect(ours[0]!.matcher, host).toBe("compact");
      expect(ours[0]!.hooks).toHaveLength(1);
      const hook = ours[0]!.hooks[0]!;
      expect(hook.type).toBe("command");
      expect(hook.timeout).toBe(15);
      expect(String(hook.command)).toContain(`--v${PROMPT_ROUTE_HOOK_VERSION}`);
      // Same shape rules as the prompt entry: codex needs the limit lifted,
      // claude must not see an unknown key.
      expect("additionalContextLimit" in hook, host).toBe(host === "codex");
      if (host === "codex") expect(hook.additionalContextLimit).toBe(0);
    }
  });

  it("a pre-SessionStart install (v3 config) gains the entry on refresh without duplicating the prompt entry", () => {
    ensurePromptRouteHook({ homeDir: home, env: {} });
    for (const cfgPath of [join(home, ".claude", "settings.json"), join(home, ".codex", "hooks.json")]) {
      const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
      delete cfg.hooks.SessionStart;
      writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    }
    const results = ensurePromptRouteHook({ homeDir: home, env: {} });
    expect(results.map((r) => r.config).sort()).toEqual(["registered", "registered"]);
    for (const cfg of [claudeConfig(), codexConfig()]) {
      const prompt = JSON.stringify(cfg.hooks.UserPromptSubmit).match(/prism-route/g) ?? [];
      const start = JSON.stringify(cfg.hooks.SessionStart).match(/prism-route/g) ?? [];
      expect(prompt).toHaveLength(1);
      expect(start).toHaveLength(1);
    }
    // And a third run is a no-op again.
    expect(ensurePromptRouteHook({ homeDir: home, env: {} }).every((r) => r.config === "unchanged")).toBe(true);
  });

  it("preserves a foreign SessionStart hook next to ours", () => {
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "/z/banner.sh" }] }] } }),
    );
    ensurePromptRouteHook({ homeDir: home, env: {} });
    const entries = claudeConfig().hooks.SessionStart as Array<{ matcher?: string }>;
    expect(entries).toHaveLength(2);
    expect(entries[0]!.matcher).toBe("startup");
    expect(JSON.stringify(entries[0])).toContain("banner.sh");
  });

  it("codex results carry the approval hint — registered is NOT active", () => {
    const results = ensurePromptRouteHook({ homeDir: home, env: {} });
    expect(results.find((r) => r.host === "codex")?.codexApproval).toBe("pending-or-unknown");
    expect(results.find((r) => r.host === "claude")?.codexApproval).toBeUndefined();
  });

  it("a rewritten codex hooks.json VOIDS detected trust — approvals are keyed by definition hash", () => {
    // Round-7 review: a v3 machine whose config.toml already trusts the
    // prompt hook gains a brand-new SessionStart definition on refresh. The
    // old detector still said "detected", so connect printed a green ✓ for a
    // hook Codex would silently skip — the "configured and inert" lie again.
    const codexApproval = () => ensurePromptRouteHook({ homeDir: home, env: {} }).find((r) => r.host === "codex")!;
    const command = `python3 ${home}/.codex/hooks/prism-route/on_prompt.py --v${PROMPT_ROUTE_HOOK_VERSION}`;
    writeFileSync(
      join(home, ".codex", "config.toml"),
      `[hooks.state]\n"abc123" = { command = "${command}", approved = true }\n"def456" = { command = "${command}", approved = true }\n`,
    );

    const first = codexApproval();
    expect(first.config).toBe("registered");
    expect(first.codexApproval).toBe("pending-or-unknown");

    // Untouched config on the next run: prior trust may now apply.
    const second = codexApproval();
    expect(second.config).toBe("unchanged");
    expect(second.codexApproval).toBe("detected");

    // Drop our SessionStart entry (the v3 shape) — the refresh that restores
    // it is a rewrite, and the trust is void again.
    const cfgPath = join(home, ".codex", "hooks.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    delete cfg.hooks.SessionStart;
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    const third = codexApproval();
    expect(third.config).not.toBe("unchanged");
    expect(third.codexApproval).toBe("pending-or-unknown");
  });

  it("trust on file for an OLDER hook version never reads as detected — the command is the key, version included", () => {
    // Round-8 review: the signature was version-agnostic, so a v3 approval
    // read as "detected" from the second connect after every bump — the
    // rewrite voided it for exactly one invocation.
    const codexApproval = () => ensurePromptRouteHook({ homeDir: home, env: {} }).find((r) => r.host === "codex")!;
    const script = `${home}/.codex/hooks/prism-route/on_prompt.py`;
    const state = (...commands: string[]) =>
      `[hooks.state]\n${commands.map((c, i) => `"h${i}" = { command = "${c}", approved = true }`).join("\n")}\n`;
    const current = `python3 ${script} --v${PROMPT_ROUTE_HOOK_VERSION}`;
    const tomlPath = join(home, ".codex", "config.toml");

    // Stale: previous version, or the pre-version bare path — positive
    // evidence the trust is for a definition Codex will not honour now.
    for (const stale of [`python3 ${script} --v3`, `python3 ${script}`]) {
      rmSync(join(home, ".codex", "hooks.json"), { force: true });
      writeFileSync(tomlPath, state(stale, stale));
      expect(codexApproval().config).toBe("registered");
      expect(codexApproval().codexApproval, stale).toBe("pending-or-unknown");
      expect(codexApproval().codexApproval, stale).toBe("pending-or-unknown");
    }

    // One of two entries trusted under the current definition: cannot say
    // which — never "detected", never a false AWAITING either.
    writeFileSync(tomlPath, state(current));
    expect(codexApproval().codexApproval).toBe("state-present-unverifiable");

    // Trust state that never names our script at all (hash-only entries):
    // unverifiable, not stale.
    writeFileSync(tomlPath, `[hooks.state]\n"zzz" = { approved = true }\n`);
    expect(codexApproval().codexApproval).toBe("state-present-unverifiable");

    // Both current entries: detected.
    writeFileSync(tomlPath, state(current, current));
    expect(codexApproval().codexApproval).toBe("detected");

    // No state section at all.
    writeFileSync(tomlPath, `model = "o3"\n`);
    expect(codexApproval().codexApproval).toBe("pending-or-unknown");
  });

  it("matches a Windows approval whose path is TOML-escaped — a run of backslashes is one separator", () => {
    // Round-10 review: Codex writes the command into a TOML basic string, so
    // a Windows path arrives as `C:\\Users\\…`. One-for-one replacement made
    // that `C://Users//…`, which never equals the forward-slash form of the
    // command we register — every Windows operator read as AWAITING TRUST
    // forever. Simulated here by writing the POSIX path with each separator
    // as an escaped backslash pair, and as a single backslash (literal string).
    const codexApproval = () => ensurePromptRouteHook({ homeDir: home, env: {} }).find((r) => r.host === "codex")!;
    const current = `python3 ${home}/.codex/hooks/prism-route/on_prompt.py --v${PROMPT_ROUTE_HOOK_VERSION}`;
    const tomlPath = join(home, ".codex", "config.toml");
    for (const separator of ["\\\\", "\\"]) {
      const escaped = current.replace(/\//g, separator);
      expect(escaped).not.toBe(current);
      writeFileSync(tomlPath, `[hooks.state]\n"a" = { command = "${escaped}", approved = true }\n"b" = { command = "${escaped}", approved = true }\n`);
      codexApproval(); // registers (or leaves unchanged) — approval is read on the unchanged pass
      expect(codexApproval().codexApproval, JSON.stringify(separator)).toBe("detected");
    }
  });

  it("leaves an unparseable host config byte-identical and registers nothing there — the other host still installs", () => {
    // Round-8 review: a settings.json with a trailing comma was REPLACED by
    // {hooks: …} — model, env and permissions gone with the syntax slip.
    const corrupt = `{\n  "model": "opus",\n  "env": { "A": "1" },\n  "permissions": { "allow": ["Bash"] },\n}\n`;
    const settingsPath = join(home, ".claude", "settings.json");
    writeFileSync(settingsPath, corrupt);

    const results = ensurePromptRouteHook({ homeDir: home, env: {} });
    const claude = results.find((r) => r.host === "claude")!;
    expect(claude.config).toBe("skipped-unparseable");
    expect(claude.script).toBe("installed"); // the script is ours to write; the config is not
    expect(readFileSync(settingsPath, "utf8")).toBe(corrupt);
    expect(results.find((r) => r.host === "codex")?.config).toBe("registered");

    // A JSON document that is not an object is the same case.
    writeFileSync(settingsPath, `[1, 2]\n`);
    expect(ensurePromptRouteHook({ homeDir: home, env: {} }).find((r) => r.host === "claude")!.config).toBe("skipped-unparseable");
    expect(readFileSync(settingsPath, "utf8")).toBe(`[1, 2]\n`);

    // Codex: same rule, and trust can never be "detected" for a hook that
    // was not registered.
    const hooksPath = join(home, ".codex", "hooks.json");
    writeFileSync(hooksPath, `{"hooks": {}`);
    writeFileSync(join(home, ".codex", "config.toml"), `[hooks.state]\n"h" = { command = "python3 ${home}/.codex/hooks/prism-route/on_prompt.py --v${PROMPT_ROUTE_HOOK_VERSION}", approved = true }\n`);
    const codex = ensurePromptRouteHook({ homeDir: home, env: {} }).find((r) => r.host === "codex")!;
    expect(codex.config).toBe("skipped-unparseable");
    expect(codex.codexApproval).toBe("pending-or-unknown");
    expect(readFileSync(hooksPath, "utf8")).toBe(`{"hooks": {}`);

    // Fixed file: registration proceeds on the next connect.
    writeFileSync(settingsPath, `{ "model": "opus" }\n`);
    expect(ensurePromptRouteHook({ homeDir: home, env: {} }).find((r) => r.host === "claude")!.config).toBe("registered");
    expect(claudeConfig().model).toBe("opus");
  });

  it("refreshes the script when the version marker is older", () => {
    ensurePromptRouteHook({ homeDir: home, env: {} });
    const marker = join(home, ".claude", "hooks", "prism-route", ".prism-managed.json");
    writeFileSync(marker, JSON.stringify({ managedBy: "prism", version: "0" }));
    const results = ensurePromptRouteHook({ homeDir: home, env: {} });
    const claude = results.find((r) => r.host === "claude");
    expect(claude?.script).toBe("refreshed");
    expect(JSON.parse(readFileSync(marker, "utf8")).version).toBe(PROMPT_ROUTE_HOOK_VERSION);
  });

  it("skips a host whose root does not exist rather than creating it", () => {
    rmSync(join(home, ".codex"), { recursive: true });
    const results = ensurePromptRouteHook({ homeDir: home, env: {} });
    expect(results.map((r) => r.host)).toEqual(["claude"]);
    expect(existsSync(join(home, ".codex"))).toBe(false);
  });

  it("honours CODEX_HOME", () => {
    const alt = join(home, "custom-codex");
    mkdirSync(alt, { recursive: true });
    const results = ensurePromptRouteHook({ homeDir: home, env: { CODEX_HOME: alt } });
    const codex = results.find((r) => r.host === "codex");
    expect(codex?.configPath).toBe(join(alt, "hooks.json"));
    expect(existsSync(join(alt, "hooks", "prism-route", "on_prompt.py"))).toBe(true);
  });
});

describe("opt-out — disabled marker survives upgrades", () => {
  it("a marker with disabled:true blocks reinstall AND re-registration on every path", () => {
    ensurePromptRouteHook({ homeDir: home, env: {} });
    const hookDir = join(home, ".claude", "hooks", "prism-route");
    // Operator turns it off: marks disabled, removes the registration.
    writeFileSync(join(hookDir, ".prism-managed.json"), JSON.stringify({ managedBy: "prism", disabled: true }));
    const cfg = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    cfg.hooks.UserPromptSubmit = [];
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify(cfg, null, 2));

    // Upgrade paths must NOT resurrect it — self-healing must not be
    // self-reinfecting.
    for (const mode of ["explicit", "auto"] as const) {
      const results = ensurePromptRouteHook({ homeDir: home, env: {}, mode });
      expect(results.find((r) => r.host === "claude")).toBeUndefined();
    }
    const after = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    expect(after.hooks.UserPromptSubmit).toEqual([]);
  });
});

describe("consent — auto paths must not touch a stranger's machine", () => {
  // prism-mcp-server is PUBLIC npm. postinstall and server-start run on every
  // machine that installs it, including people who never ran `prism connect`.
  // Rewriting their ~/.claude/settings.json would be consent they never gave.
  it("auto mode installs NOTHING on a host with no prior prism integration", () => {
    const results = ensurePromptRouteHook({ homeDir: home, env: {}, mode: "auto" });
    expect(results).toEqual([]);
    expect(existsSync(join(home, ".claude", "hooks", "prism-route"))).toBe(false);
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
  });

  it("an MCP registration alone is NOT consent — the plugin-install hole (2026-09 directory review)", () => {
    // This test previously asserted the OPPOSITE: registration-as-consent.
    // Installing the Claude Code PLUGIN registers `prism-mcp` in host config,
    // so under that rule a plugin install transitively "consented" to a
    // global UserPromptSubmit hook — flagged as the top objection candidate
    // in the plugin-directory review investigation. Auto paths now refresh
    // only hosts carrying our managed marker from a prior explicit install.
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { "prism-mcp": { command: "npx" } } }));
    writeFileSync(join(home, ".codex", "config.toml"), "[mcp_servers.prism]\ncommand = \"prism-coder\"\n");
    const results = ensurePromptRouteHook({ homeDir: home, env: {}, mode: "auto" });
    expect(results).toEqual([]);
    expect(existsSync(join(home, ".claude", "hooks", "prism-route"))).toBe(false);
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
    expect(existsSync(join(home, ".codex", "hooks.json"))).toBe(false);
  });

  it("auto mode refreshes an existing managed install — the upgrade path stays alive", () => {
    ensurePromptRouteHook({ homeDir: home, env: {} }); // explicit first install
    const marker = join(home, ".claude", "hooks", "prism-route", ".prism-managed.json");
    writeFileSync(marker, JSON.stringify({ managedBy: "prism", version: "0" }));
    const results = ensurePromptRouteHook({ homeDir: home, env: {}, mode: "auto" });
    expect(results.find((r) => r.host === "claude")?.script).toBe("refreshed");
  });

  it("explicit mode (prism connect) needs no prior evidence — connect IS the consent", () => {
    const results = ensurePromptRouteHook({ homeDir: home, env: {}, mode: "explicit" });
    expect(results).toHaveLength(2);
  });
});

// The script itself is exercised with a bash stub CLI and POSIX chmod; the
// hosts this hook serves on Windows execute the same python, but the harness
// is POSIX-only, so the behaviour suite runs on POSIX runners.
describe.skipIf(process.platform === "win32")("the hook script — never breaks the turn", () => {
  // Run the ACTUAL script under python3 with a stub CLI, exactly as a host
  // would: JSON on stdin, JSON on stdout.
  let hookDir: string;
  let script: string;
  let stub: string;

  beforeEach(() => {
    hookDir = join(home, ".claude", "hooks", "prism-route");
    mkdirSync(hookDir, { recursive: true });
    script = join(hookDir, "on_prompt.py");
    writeFileSync(script, PROMPT_ROUTE_HOOK_SCRIPT);
    chmodSync(script, 0o755);
    // Stub prism CLI: routes when --loaded is empty, dedupes when not;
    // answers floor-digest with a fixed digest; logs every invocation so a
    // test can assert the CLI was NOT called.
    stub = join(home, "stub-prism");
    writeFileSync(
      stub,
      `#!/bin/bash
echo "$1" >> "${join(home, "stub-calls.log")}"
if [ "$1" = "floor-digest" ]; then echo '{"names":["prime-directive","ask-first"],"text":"Prism: context was compacted.\\n- floor line"}'; exit 0; fi
if [ "$1" != "route-prompt" ]; then echo '{"names":[],"text":""}'; exit 0; fi
if [ "$3" = "" ]; then echo '{"names":["visual-screenshot-verification"],"text":"SKILL BODY HERE"}'; else echo '{"names":[],"text":""}'; fi
`,
    );
    chmodSync(stub, 0o755);
  });
  const stubCalls = (): string[] => {
    const log = join(home, "stub-calls.log");
    return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
  };

  const run = (payload: unknown): { continue: boolean; suppressOutput?: boolean; hookSpecificOutput?: { hookEventName?: string; additionalContext?: string } } =>
    JSON.parse(
      execFileSync("python3", [script], {
        input: JSON.stringify(payload),
        env: { ...process.env, PRISM_ROUTE_CLI: stub },
        encoding: "utf8",
      }).trim(),
    );

  it("injects context on a routed prompt", () => {
    const out = run({ prompt: "the totals are not sticky", session_id: "s1" });
    expect(out.continue).toBe(true);
    expect(out.hookSpecificOutput?.additionalContext).toBe("SKILL BODY HERE");
  });

  it("dedupes on the second prompt of the same session via its state file", () => {
    run({ prompt: "the totals are not sticky", session_id: "s2" });
    const state = JSON.parse(readFileSync(join(hookDir, "state", "s2.json"), "utf8"));
    expect(state).toEqual(["visual-screenshot-verification"]);
    const out = run({ prompt: "the totals are not sticky", session_id: "s2" });
    expect(out.hookSpecificOutput).toBeUndefined();
  });

  it("passes through micro-prompts and slash commands without invoking the CLI", () => {
    for (const prompt of ["ok", "merge", "/model claude"]) {
      const out = run({ prompt, session_id: "s3" });
      expect(out).toEqual({ continue: true, suppressOutput: true });
    }
  });

  it("passes through when the CLI is missing — a broken install must not block prompts", () => {
    // PATH is emptied so the script's own `which prism` finds nothing; python3
    // itself must then be launched by absolute path.
    const python3 = execFileSync("which", ["python3"], { encoding: "utf8" }).trim();
    const out = JSON.parse(
      execFileSync(python3, [script], {
        input: JSON.stringify({ prompt: "the totals are not sticky" }),
        env: { ...process.env, PRISM_ROUTE_CLI: "/does/not/exist", PATH: "/nonexistent", HOME: home },
        encoding: "utf8",
      }).trim(),
    );
    expect(out).toEqual({ continue: true, suppressOutput: true });
  });

  it("survives stdout pollution from node wrappers (dotenv banners etc.)", () => {
    writeFileSync(stub, `#!/bin/bash
echo "[dotenv] injected env (10) from .env"
echo '{"names":["visual-screenshot-verification"],"text":"BODY"}'
`);
    chmodSync(stub, 0o755);
    const out = run({ prompt: "the totals are not sticky", session_id: "s9" });
    expect(out.hookSpecificOutput?.additionalContext).toBe("BODY");
  });

  describe("SessionStart — the floor comes back after a compaction, and only then", () => {
    it("re-injects the floor digest on source=compact, tagged for the SessionStart event", () => {
      const out = run({ hook_event_name: "SessionStart", source: "compact", session_id: "s-compact" });
      expect(out.continue).toBe(true);
      expect(out.hookSpecificOutput?.hookEventName).toBe("SessionStart");
      expect(out.hookSpecificOutput?.additionalContext).toBe("Prism: context was compacted.\n- floor line");
      expect(stubCalls()).toEqual(["floor-digest"]);
    });

    it("forgets the session's dedupe list on compaction so the routed skills can come back", () => {
      run({ prompt: "the totals are not sticky", session_id: "s-compact-2" });
      const state = join(hookDir, "state", "s-compact-2.json");
      expect(existsSync(state)).toBe(true);
      run({ hook_event_name: "SessionStart", source: "compact", session_id: "s-compact-2" });
      expect(existsSync(state)).toBe(false);
      // The next matching prompt routes again instead of being deduped away.
      const out = run({ prompt: "the totals are not sticky", session_id: "s-compact-2" });
      expect(out.hookSpecificOutput?.additionalContext).toBe("SKILL BODY HERE");
    });

    it.each(["startup", "resume", "clear", ""])("passes through on source=%j without invoking the CLI — the bootstrap already carries the digest", (source) => {
      const out = run({ hook_event_name: "SessionStart", source, session_id: "s-start" });
      expect(out).toEqual({ continue: true, suppressOutput: true });
      expect(stubCalls()).toEqual([]);
    });

    it("passes through when the CLI has no floor to offer (free tier, no manifest)", () => {
      writeFileSync(stub, `#!/bin/bash\necho '{"names":[],"text":""}'\n`);
      chmodSync(stub, 0o755);
      const out = run({ hook_event_name: "SessionStart", source: "compact", session_id: "s-free" });
      expect(out).toEqual({ continue: true, suppressOutput: true });
    });

    it("passes through when the CLI is missing or fails — a compaction must never break the session", () => {
      const python3 = execFileSync("which", ["python3"], { encoding: "utf8" }).trim();
      const out = JSON.parse(
        execFileSync(python3, [script], {
          input: JSON.stringify({ hook_event_name: "SessionStart", source: "compact" }),
          env: { ...process.env, PRISM_ROUTE_CLI: "/does/not/exist", PATH: "/nonexistent", HOME: home },
          encoding: "utf8",
        }).trim(),
      );
      expect(out).toEqual({ continue: true, suppressOutput: true });
      writeFileSync(stub, `#!/bin/bash\nexit 3\n`);
      chmodSync(stub, 0o755);
      expect(run({ hook_event_name: "SessionStart", source: "compact" })).toEqual({ continue: true, suppressOutput: true });
    });

    it("a SessionStart payload never routes as a prompt, even when it carries prompt-like fields", () => {
      const out = run({ hook_event_name: "SessionStart", source: "startup", prompt: "the totals are not sticky" });
      expect(out.hookSpecificOutput).toBeUndefined();
      expect(stubCalls()).toEqual([]);
    });

    // Codex's hook payloads are documented as Claude-COMPATIBLE, and the
    // prompt lookup already hedges three spellings for that reason. The event
    // and source lookups read exactly one spelling each (round-11 review), so
    // a Codex payload spelled hookEventName/trigger fell to the prompt path
    // and passed through — no digest, no signal.
    it.each([
      [{ hookEventName: "SessionStart", source: "compact" }],
      [{ event: "session_start", trigger: "compaction" }],
      [{ event_name: "session-start", reason: "compacted" }],
      [{ eventName: "sessionstart", source: "Compact" }],
    ])("recognises the compaction fire under alternative payload spellings: %j", (payload) => {
      const out = run({ ...payload, session_id: "s-alias" });
      expect(out.hookSpecificOutput?.hookEventName).toBe("SessionStart");
      expect(out.hookSpecificOutput?.additionalContext).toBe("Prism: context was compacted.\n- floor line");
      expect(stubCalls()).toEqual(["floor-digest"]);
    });

    it.each([
      [{ hookEventName: "SessionStart", trigger: "startup" }],
      [{ event: "SessionStart", reason: "resume" }],
      [{ event: "SessionStart", prompt: "the totals are not sticky" }],
      // Round-12 review: a non-string event is not an event (dropping the
      // isinstance guard made this one fire), and PreCompact is a real host
      // event — "pre-compact" must not read as a compaction (`in` vs prefix).
      [{ event: ["SessionStart"], source: "compact" }],
      [{ hook_event_name: "SessionStart", source: "pre-compact" }],
      [{ hook_event_name: "SessionStart", source: 5 }],
    ])("an aliased SessionStart that is not a compaction still passes through without routing: %j", (payload) => {
      const out = run({ ...payload, session_id: "s-alias-start" });
      expect(out).toEqual({ continue: true, suppressOutput: true });
      expect(stubCalls()).toEqual([]);
    });

    it("an aliased event that is NOT SessionStart still routes the prompt", () => {
      const out = run({ hookEventName: "UserPromptSubmit", prompt: "the totals are not sticky", session_id: "s-alias-prompt" });
      expect(out.hookSpecificOutput?.additionalContext).toBe("SKILL BODY HERE");
    });
  });

  it("passes through on garbage stdin", () => {
    const out = JSON.parse(
      execFileSync("python3", [script], {
        input: "not json at all",
        env: { ...process.env, PRISM_ROUTE_CLI: stub },
        encoding: "utf8",
      }).trim(),
    );
    expect(out).toEqual({ continue: true, suppressOutput: true });
  });
});
