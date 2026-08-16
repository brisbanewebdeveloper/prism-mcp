#!/usr/bin/env node
/**
 * MCP host parity check — does prism_infer work identically for Claude Code and Codex?
 * ────────────────────────────────────────────────────────────────────────────────────
 * Both hosts launch the SAME binary. `~/.claude.json` and `~/.codex/config.toml`
 * each register prism-mcp as `node <prism>/dist/server.js` over stdio, so the
 * contract under test is one stdio MCP session, not two integrations.
 *
 * This spawns that server directly and drives the real JSON-RPC handshake, which
 * is what both hosts do. It deliberately does NOT reuse an already-running
 * server: a long-lived host session holds the dist it loaded at startup, so a
 * freshly built fix is invisible to it until restart. Spawning fresh is the only
 * way to test the build on disk.
 *
 * Asserts, per case:
 *   - the tool is exposed
 *   - a real local model answers (used_cloud=false)
 *   - the answer is verified deterministically, not eyeballed
 *
 * Usage:
 *   node scripts/mcp-host-parity-check.mjs
 */

import { spawn } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

const PRISM_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(PRISM_ROOT, "dist", "server.js");

function loadDotenv(file) {
    const out = {};
    if (!fs.existsSync(file)) return out;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
        if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
    return out;
}

class McpSession {
    constructor(env) {
        this.proc = spawn(process.execPath, [SERVER], {
            stdio: ["pipe", "pipe", "pipe"],
            env: { ...process.env, ...env },
        });
        this.buf = "";
        this.pending = new Map();
        this.id = 0;
        this.proc.stdout.on("data", (d) => {
            this.buf += d.toString();
            let nl;
            while ((nl = this.buf.indexOf("\n")) >= 0) {
                const line = this.buf.slice(0, nl).trim();
                this.buf = this.buf.slice(nl + 1);
                if (!line) continue;
                let msg;
                try { msg = JSON.parse(line); } catch { continue; }
                const r = this.pending.get(msg.id);
                if (r) { this.pending.delete(msg.id); r(msg); }
            }
        });
        this.proc.stderr.on("data", () => {}); // prism logs diagnostics here
    }
    send(method, params, timeoutMs = 180_000) {
        const id = ++this.id;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
            this.pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
            this.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        });
    }
    close() { try { this.proc.kill(); } catch { /* already gone */ } }
}

const env = loadDotenv(path.join(PRISM_ROOT, ".env"));
const s = new McpSession(env);

const init = await s.send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "mcp-host-parity-check", version: "1" },
});
console.log(`server: ${init.result?.serverInfo?.name} ${init.result?.serverInfo?.version}`);
s.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

const tools = await s.send("tools/list", {});
const names = (tools.result?.tools ?? []).map((t) => t.name);
console.log(`prism_infer exposed: ${names.includes("prism_infer")}`);
if (!names.includes("prism_infer")) { s.close(); process.exit(1); }

// Deterministic cases — same shape as local-capability-bench, driven through MCP.
const CASES = [
    {
        name: "code/4b",
        args: { prompt: "Write a JavaScript function named addOne(n) that returns n + 1. Return ONLY a fenced javascript code block.", mode: "code", model_ceiling: "4b", max_tokens: 400, escalation: "report", cloud_fallback: false },
        verify: (t) => /function\s+addOne\s*\(\s*n\s*\)/.test(t) && /n\s*\+\s*1/.test(t),
    },
    {
        name: "parse/4b",
        // mode:"code", NOT "route". Route mode applies the MCP tool-call guard
        // and replaces any non-tool-call answer with NO_TOOL
        // (route_guard=local:suppressed:malformed_tool_call), so extraction
        // cannot use it. With thinking now tier-gated off on 4b/2b, "code" is
        // the extraction mode on the small tiers: free text, no reasoning spend.
        args: { prompt: 'Extract fields into JSON.\n\nLINE:\n2026-08-14T09:12:44Z ERROR [billing.worker] tenant=acme-42 attempt=3 code=card_declined\n\nReturn ONLY a JSON object with keys: level, tenant, code. No prose.', mode: "code", model_ceiling: "4b", max_tokens: 200, escalation: "report", cloud_fallback: false },
        verify: (t) => /"?level"?\s*:\s*"ERROR"/.test(t) && /acme-42/.test(t) && /card_declined/.test(t),
    },
    {
        name: "classify/2b",
        args: { prompt: 'Classify as exactly one word: BUG, FEATURE, or QUESTION.\n\nTicket: "The checkout button does nothing on Safari 17."\n\nAnswer (one word):', mode: "route", model_ceiling: "2b", max_tokens: 8, escalation: "report", cloud_fallback: false },
        verify: (t) => /\bBUG\b/i.test(t),
    },
];

let pass = 0;
for (const c of CASES) {
    const t0 = Date.now();
    const r = await s.send("tools/call", { name: "prism_infer", arguments: c.args });
    const text = (r.result?.content ?? []).map((b) => b.text ?? "").join("\n");
    const usedCloud = /used_cloud=true/.test(text);
    const ok = c.verify(text) && !usedCloud;
    if (ok) pass++;
    const backend = text.match(/backend=(\S+)/)?.[1] ?? "?";
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${c.name.padEnd(12)} backend=${backend.padEnd(12)} ${String(Date.now() - t0).padStart(6)}ms${ok ? "" : `  :: ${text.replace(/\s+/g, " ").slice(0, 400)}`}`);
}

s.close();
console.log(`\n${pass}/${CASES.length} passed over a real stdio MCP session`);
process.exit(pass === CASES.length ? 0 : 1);
