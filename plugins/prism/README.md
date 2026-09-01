# prism-coder plugin

Persistent session memory for Claude Code, backed by the
[`prism-mcp-server`](https://www.npmjs.com/package/prism-mcp-server) MCP
server. See the [repository README](../../README.md) for what Prism does;
this file documents what the **plugin** itself does to your machine, because
that list is deliberately short.

## Security posture

- **The MCP launcher is deterministic.** `.mcp.json` launches
  `prism-mcp-server` pinned to an exact published version (never a floating
  tag), with npm lifecycle scripts disabled
  (`npm_config_ignore_scripts=true`). Installing or launching the plugin
  runs no install-time scripts from this package or its dependencies.
- **Installing the plugin modifies no host configuration.** The server's
  optional prompt-routing hook is only ever first-installed by the explicit
  `prism connect` command, which exists to manage host configuration and is
  the user's consent to do so. The npm package's own maintenance paths
  refresh that hook only where a prior `prism connect` left a managed
  marker; on every other machine — including every plugin install — they
  write nothing.
- **Local-first by default.** Memory lives in SQLite under `~/.prism-mcp`.
  Nothing leaves the machine unless a Synalux account is connected.
- **One skill, read-only.** The bundled `prism-startup` skill instructs the
  agent to call `session_bootstrap` on the first turn; it executes nothing
  itself.

## Contents

| Path | Purpose |
| --- | --- |
| `.claude-plugin/plugin.json` | Claude Code manifest |
| `.codex-plugin/plugin.json` | Codex manifest (same plugin-root path conventions) |
| `.mcp.json` | Pinned, script-free MCP server registration |
| `skills/prism-startup/` | First-turn bootstrap skill |
