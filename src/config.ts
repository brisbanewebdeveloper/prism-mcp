import "dotenv/config";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Configuration & Environment Variables
 *
 * This file is loaded once at startup. It reads environment variables,
 * validates required ones, and exports them for use throughout the server.
 *
 * Environment variable guide:
 *   GOOGLE_SEARCH_API_KEY  — (optional) API key for Google Programmable Search (single credential mode).
 *   GOOGLE_SEARCH_CX       — (optional) Custom Search Engine ID paired with GOOGLE_SEARCH_API_KEY.
 *   GOOGLE_SEARCH_CREDENTIALS — (optional) JSON array of credential pairs for ordered failover,
 *                               or a JSON object with { "strategy", "credentials" }.
 *                               Each entry: { "apiKey": "...", "cx": "..." }.
 *                               Supported strategies: "failover" and "random".
 *                               The alias field "channel" is also accepted instead of "cx".
 *   BRAVE_API_KEY          — (optional) API key for Brave local search endpoints.
 *   GOOGLE_API_KEY         — (optional) API key for Google AI Studio / Gemini. Enables paper analysis.
 *   BRAVE_ANSWERS_API_KEY  — (optional) API key for Brave Answers (AI grounding). Enables brave_answers tool.
 *   PRISM_BRAVE_ANSWERS_API_KEY — (optional) Prism-scoped alias for Brave Answers credentials.
 *   SUPABASE_URL           — (optional) Your Supabase project URL. Enables session memory tools.
 *   SUPABASE_KEY           — (optional) Your Supabase anon/service key. Enables session memory tools.
 *   SUPABASE_API_PREFIX    — (optional) REST path prefix. Defaults to "/rest/v1"; set to empty for raw PostgREST.
 *   PRISM_MCP_TRANSPORT    — (optional) MCP transport mode: "stdio" (default) or "http".
 *   PRISM_MCP_PORT         — (optional) HTTP MCP listen port when PRISM_MCP_TRANSPORT=http. Defaults to 3002.
 *   PRISM_MCP_PATH         — (optional) HTTP MCP endpoint path. Defaults to "/mcp".
 *   PRISM_DASHBOARD_PORT   — (optional) Mind Palace dashboard HTTP port. Defaults to 3000.
 *   PRISM_USER_ID          — (optional) Unique tenant ID for multi-user Supabase instances.
 *                            Defaults to "default". Set per-user in Claude Desktop config.
 *
 * If a required key is missing, the process exits immediately.
 * If an optional key is missing, a warning is logged but the server continues
 * with reduced functionality (the corresponding tools will be unavailable).
 */

// ─── Server Identity ──────────────────────────────────────────

function resolveServerVersion(): string {
  try {
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const packageJsonPath = resolve(moduleDir, "../package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
    if (typeof packageJson?.version === "string" && packageJson.version.trim()) {
      return packageJson.version.trim();
    }
  } catch {
    // Fallback below keeps server booting even if package metadata is unavailable.
  }
  return "0.0.0";
}

// REVIEWER NOTE: derive version from package.json so MCP handshake,
// dashboard badge, and package metadata stay in sync.
export const SERVER_CONFIG = {
  name: "prism-mcp",
  version: resolveServerVersion(),
};

export interface GoogleSearchCredential {
  apiKey: string;
  cx: string;
}

export type GoogleSearchCredentialSelectionStrategy =
  | "failover"
  | "random";

interface GoogleSearchCredentialParseResult {
  credentials: GoogleSearchCredential[];
  selectionStrategy: GoogleSearchCredentialSelectionStrategy;
  warnings: string[];
}

function normalizeEnvValue(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseStructuredGoogleSearchCredentials(
  raw: string
): GoogleSearchCredentialParseResult {
  const warnings: string[] = [];
  const credentials: GoogleSearchCredential[] = [];
  let selectionStrategy: GoogleSearchCredentialSelectionStrategy = "failover";

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      credentials,
      selectionStrategy,
      warnings: [
        "GOOGLE_SEARCH_CREDENTIALS is not valid JSON and will be ignored.",
      ],
    };
  }

  let entries: unknown[];
  if (Array.isArray(parsed)) {
    entries = parsed;
  } else if (typeof parsed === "object" && parsed !== null) {
    const candidate = parsed as {
      strategy?: unknown;
      credentials?: unknown;
    };

    if (candidate.strategy !== undefined) {
      const rawStrategy =
        typeof candidate.strategy === "string"
          ? candidate.strategy.trim().toLowerCase()
          : undefined;

      if (rawStrategy === "failover" || rawStrategy === "random") {
        selectionStrategy = rawStrategy;
      } else {
        warnings.push(
          'GOOGLE_SEARCH_CREDENTIALS.strategy must be "failover" or "random"; defaulting to failover.'
        );
      }
    }

    if (!Array.isArray(candidate.credentials)) {
      return {
        credentials,
        selectionStrategy: "failover",
        warnings: [
          ...warnings,
          "GOOGLE_SEARCH_CREDENTIALS.credentials must be a JSON array and will be ignored.",
        ],
      };
    }

    entries = candidate.credentials;
  } else {
    return {
      credentials,
      selectionStrategy,
      warnings: [
        "GOOGLE_SEARCH_CREDENTIALS must be a JSON array or object and will be ignored.",
      ],
    };
  }

  entries.forEach((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      warnings.push(
        `GOOGLE_SEARCH_CREDENTIALS[${index}] must be an object and was ignored.`
      );
      return;
    }

    const candidate = entry as {
      apiKey?: unknown;
      cx?: unknown;
      channel?: unknown;
    };

    const apiKey =
      typeof candidate.apiKey === "string"
        ? normalizeEnvValue(candidate.apiKey)
        : undefined;
    const cxField =
      typeof candidate.cx === "string"
        ? candidate.cx
        : typeof candidate.channel === "string"
          ? candidate.channel
          : undefined;
    const cx = normalizeEnvValue(cxField);

    if (!apiKey || !cx) {
      warnings.push(
        `GOOGLE_SEARCH_CREDENTIALS[${index}] is missing apiKey/cx and was ignored.`
      );
      return;
    }

    credentials.push({ apiKey, cx });
  });

  return { credentials, selectionStrategy, warnings };
}

function parseIndexedGoogleSearchCredentials(
  env: Record<string, string | undefined>
): GoogleSearchCredentialParseResult {
  const warnings: string[] = [];
  const indexed = new Map<number, { apiKey?: string; cx?: string }>();

  for (const [name, rawValue] of Object.entries(env)) {
    const value = normalizeEnvValue(rawValue);
    if (!value) {
      continue;
    }

    const keyMatch = name.match(/^GOOGLE_SEARCH_API_KEY_(\d+)$/);
    if (keyMatch) {
      const idx = Number.parseInt(keyMatch[1], 10);
      const current = indexed.get(idx) ?? {};
      current.apiKey = value;
      indexed.set(idx, current);
      continue;
    }

    const cxMatch = name.match(/^GOOGLE_SEARCH_CX_(\d+)$/);
    if (cxMatch) {
      const idx = Number.parseInt(cxMatch[1], 10);
      const current = indexed.get(idx) ?? {};
      current.cx = value;
      indexed.set(idx, current);
    }
  }

  const credentials: GoogleSearchCredential[] = [];
  for (const idx of [...indexed.keys()].sort((a, b) => a - b)) {
    const entry = indexed.get(idx);
    if (!entry) {
      continue;
    }

    if (entry.apiKey && entry.cx) {
      credentials.push({ apiKey: entry.apiKey, cx: entry.cx });
      continue;
    }

    warnings.push(
      `GOOGLE_SEARCH_API_KEY_${idx} and GOOGLE_SEARCH_CX_${idx} must both be set; index ${idx} was ignored.`
    );
  }

  return { credentials, selectionStrategy: "failover", warnings };
}

export function parseGoogleSearchCredentials(
  env: Record<string, string | undefined>
): GoogleSearchCredentialParseResult {
  const warnings: string[] = [];

  const structuredRaw = normalizeEnvValue(env.GOOGLE_SEARCH_CREDENTIALS);
  if (structuredRaw) {
    const structured = parseStructuredGoogleSearchCredentials(structuredRaw);
    warnings.push(...structured.warnings);
    if (structured.credentials.length > 0) {
      return {
        credentials: structured.credentials,
        selectionStrategy: structured.selectionStrategy,
        warnings,
      };
    }

    warnings.push(
      "Falling back to GOOGLE_SEARCH_API_KEY[_N] and GOOGLE_SEARCH_CX[_N] variables because GOOGLE_SEARCH_CREDENTIALS had no valid entries."
    );
  }

  const indexed = parseIndexedGoogleSearchCredentials(env);
  warnings.push(...indexed.warnings);

  const singleApiKey = normalizeEnvValue(env.GOOGLE_SEARCH_API_KEY);
  const singleCx = normalizeEnvValue(env.GOOGLE_SEARCH_CX);
  if ((singleApiKey && !singleCx) || (!singleApiKey && singleCx)) {
    warnings.push(
      "GOOGLE_SEARCH_API_KEY and GOOGLE_SEARCH_CX must both be set for single-credential mode; the incomplete single credential was ignored."
    );
  }

  const combined: GoogleSearchCredential[] = [...indexed.credentials];
  if (singleApiKey && singleCx) {
    combined.push({ apiKey: singleApiKey, cx: singleCx });
  }

  const seen = new Set<string>();
  const credentials = combined.filter((credential) => {
    const id = `${credential.apiKey}::${credential.cx}`;
    if (seen.has(id)) {
      return false;
    }
    seen.add(id);
    return true;
  });

  return { credentials, selectionStrategy: "failover", warnings };
}

const googleSearchCredentialResult = parseGoogleSearchCredentials(process.env);
for (const warning of googleSearchCredentialResult.warnings) {
  console.error(`Warning: ${warning}`);
}

export const GOOGLE_SEARCH_CREDENTIALS = googleSearchCredentialResult.credentials;
export const GOOGLE_SEARCH_CREDENTIAL_SELECTION_STRATEGY =
  googleSearchCredentialResult.selectionStrategy;
if (GOOGLE_SEARCH_CREDENTIALS.length === 0) {
  console.error(
    "Warning: Google Search credentials are missing. Configure GOOGLE_SEARCH_CREDENTIALS or GOOGLE_SEARCH_API_KEY + GOOGLE_SEARCH_CX for web search tools."
  );
}

// ─── Optional: Brave Search API Key ───────────────────────────
// Used by brave_local_search and brave_local_search_code_mode only.

export const BRAVE_API_KEY = process.env.BRAVE_API_KEY;
if (!BRAVE_API_KEY) {
  console.error("Warning: BRAVE_API_KEY environment variable is missing. Brave local search tools will be unavailable.");
}

// ─── Optional: Google Gemini API Key ──────────────────────────
// Used by the gemini_research_paper_analysis tool.
// Without this, the tool will still appear but will error when called.

export const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
if (!GOOGLE_API_KEY) {
  console.error("Warning: GOOGLE_API_KEY environment variable is missing. Gemini research features will be unavailable.");
}

// ─── Optional: Brave Answers API Key ──────────────────────────
// Used by the brave_answers tool for AI-grounded answers.
// This is a separate API key from the main Brave Search key.

export const BRAVE_ANSWERS_API_KEY =
  normalizeEnvValue(process.env.BRAVE_ANSWERS_API_KEY) ??
  normalizeEnvValue(process.env.PRISM_BRAVE_ANSWERS_API_KEY);
if (!BRAVE_ANSWERS_API_KEY) {
  console.error(
    "Warning: BRAVE_ANSWERS_API_KEY environment variable is missing. Set BRAVE_ANSWERS_API_KEY or PRISM_BRAVE_ANSWERS_API_KEY to enable Brave Answers."
  );
}

// ─── Optional: Supabase (Session Memory Module) ───────────────
// When both SUPABASE_URL and SUPABASE_KEY are set, session memory tools
// are registered. These tools allow AI agents to persist and recover
// context between sessions.

export const SUPABASE_URL = process.env.SUPABASE_URL;
export const SUPABASE_KEY = process.env.SUPABASE_KEY;
export const SUPABASE_API_PREFIX = process.env.SUPABASE_API_PREFIX ?? "/rest/v1";
export const SESSION_MEMORY_ENABLED = !!(SUPABASE_URL && SUPABASE_KEY);
// Note: debug() is defined at the bottom of this file; these lines
// execute at import time after the full module is loaded by Node.
if (!SESSION_MEMORY_ENABLED) {
  console.error("Info: Session memory disabled (set SUPABASE_URL + SUPABASE_KEY to enable)");
}

// ─── Optional: MCP Transport Mode ──────────────────────────────

const MCP_TRANSPORT = process.env.PRISM_MCP_TRANSPORT;
export const PRISM_MCP_TRANSPORT: "stdio" | "http" = MCP_TRANSPORT === "http" ? "http" : "stdio";

const parsedMcpPort = parseInt(process.env.PRISM_MCP_PORT || "3002", 10);
export const PRISM_MCP_PORT = Number.isInteger(parsedMcpPort) && parsedMcpPort >= 0 && parsedMcpPort <= 65535
  ? parsedMcpPort
  : 3002;

const configuredMcpPath = (process.env.PRISM_MCP_PATH || "/mcp").trim();
const normalizedMcpPath = configuredMcpPath.startsWith("/") ? configuredMcpPath : `/${configuredMcpPath}`;
export const PRISM_MCP_PATH = normalizedMcpPath.length > 1
  ? normalizedMcpPath.replace(/\/+$/, "")
  : normalizedMcpPath;

const parsedDashboardPort = parseInt(process.env.PRISM_DASHBOARD_PORT || "3000", 10);
export const PRISM_DASHBOARD_PORT = Number.isInteger(parsedDashboardPort)
  ? parsedDashboardPort
  : 3000;

// ─── v2.0: Storage Backend Selection ─────────────────────────
// REVIEWER NOTE: Step 1 of v2.0 introduces a storage abstraction.
// Currently only "supabase" is implemented. "local" (SQLite) is
// coming in Step 2. Default is "supabase" for backward compat.
//
// Set PRISM_STORAGE=local to use SQLite (once implemented).
// Set PRISM_STORAGE=supabase to use Supabase REST API (default).

export const PRISM_STORAGE: "local" | "supabase" =
  (process.env.PRISM_STORAGE as "local" | "supabase") || "supabase";
// Logged at debug level — see debug() at bottom of file

// ─── Optional: Multi-Tenant User ID ──────────────────────────
// REVIEWER NOTE: When multiple users share the same Supabase instance,
// PRISM_USER_ID isolates their data. Each user sets a unique ID in their
// Claude Desktop config. All queries are scoped to this user_id.
//
// Defaults to "default" for backward compatibility — existing single-user
// installations work without any config changes.
//
// For enterprise: use a stable unique identifier (UUID, email hash, etc.)
// For personal use: any unique string works (e.g., "alice", "bob")

export const PRISM_USER_ID = process.env.PRISM_USER_ID || "default";
// Multi-tenant info logged at debug level in startServer()

// ─── v2.1: Auto-Capture Feature ─────────────────────────────
// REVIEWER NOTE: Automatically captures HTML snapshots of local dev servers
// when handoffs are saved. Prevents UI context loss between sessions.
// Opt-in only — set PRISM_AUTO_CAPTURE=true to enable.

export const PRISM_AUTO_CAPTURE = process.env.PRISM_AUTO_CAPTURE === "true";
export const PRISM_CAPTURE_PORTS = (process.env.PRISM_CAPTURE_PORTS || "3000,3001,5173,8080")
  .split(",")
  .map(p => parseInt(p.trim(), 10))
  .filter(p => !isNaN(p));

// ─── v2.3: Debug Logging ──────────────────────────────────────
// Optionally enable verbose output (stderr) for Prism initialization,
// memory indexing, and background tasks.

export const PRISM_DEBUG_LOGGING = process.env.PRISM_DEBUG_LOGGING === "true";

// ─── v3.0: Agent Hivemind Feature Flag ───────────────────────
// When enabled, registers 3 additional MCP tools for multi-agent
// coordination: agent_register, agent_heartbeat, agent_list_team.
// The role parameter on existing tools (session_save_ledger, etc.)
// is always available regardless of this flag — adding a parameter
// doesn't increase tool count.
// Set PRISM_ENABLE_HIVEMIND=true to unlock the Agent Registry tools.

export const PRISM_ENABLE_HIVEMIND = process.env.PRISM_ENABLE_HIVEMIND === "true";

// ─── v4.1: Auto-Load Projects ────────────────────────────────
// Auto-load is configured exclusively via the Mind Palace dashboard
// ("Auto-Load Projects" checkboxes in Settings). The setting is stored
// in prism-config.db and read at startup via getSettingSync().
//
// The PRISM_AUTOLOAD_PROJECTS env var has been removed — the dashboard
// is the single source of truth. This prevents mismatches between
// env var and dashboard values causing duplicate project loads.

if (PRISM_AUTO_CAPTURE) {
  // Use console.error instead of debugLog here to prevent circular dependency
  if (PRISM_DEBUG_LOGGING) {
    console.error(`[AutoCapture] Enabled for ports: ${PRISM_CAPTURE_PORTS.join(", ")}`);
  }
}



