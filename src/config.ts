import "dotenv/config";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function firstDefinedEnv(
  env: Record<string, string | undefined>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = normalizeEnvValue(env[key]);
    if (value) {
      return value;
    }
  }

  return undefined;
}

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
 *   PRISM_GOOGLE_SEARCH_API_KEY — (optional) Prism-scoped alias for GOOGLE_SEARCH_API_KEY.
 *   PRISM_GOOGLE_SEARCH_CX — (optional) Prism-scoped alias for GOOGLE_SEARCH_CX.
 *   PRISM_GOOGLE_SEARCH_CREDENTIALS — (optional) Prism-scoped alias for GOOGLE_SEARCH_CREDENTIALS.
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
 *   VOYAGE_API_KEY         — (optional) API key for Voyage AI embeddings. Enables embedding_provider=voyage.
 *                            Voyage AI is the embedding provider recommended by Anthropic for use with
 *                            Claude. Get a free key at https://dash.voyageai.com.
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

  const structuredRaw = firstDefinedEnv(
    env,
    "GOOGLE_SEARCH_CREDENTIALS",
    "PRISM_GOOGLE_SEARCH_CREDENTIALS"
  );
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
      "Falling back to GOOGLE_SEARCH_API_KEY[_N]/PRISM_GOOGLE_SEARCH_API_KEY[_N] and GOOGLE_SEARCH_CX[_N]/PRISM_GOOGLE_SEARCH_CX[_N] variables because GOOGLE_SEARCH_CREDENTIALS had no valid entries."
    );
  }

  const indexed = parseIndexedGoogleSearchCredentials(env);
  warnings.push(...indexed.warnings);

  const singleApiKey = firstDefinedEnv(
    env,
    "GOOGLE_SEARCH_API_KEY",
    "PRISM_GOOGLE_SEARCH_API_KEY"
  );
  const singleCx = firstDefinedEnv(
    env,
    "GOOGLE_SEARCH_CX",
    "PRISM_GOOGLE_SEARCH_CX"
  );
  if ((singleApiKey && !singleCx) || (!singleApiKey && singleCx)) {
    warnings.push(
      "GOOGLE_SEARCH_API_KEY and GOOGLE_SEARCH_CX must both be set for single-credential mode; the incomplete single credential was ignored. PRISM_GOOGLE_SEARCH_API_KEY and PRISM_GOOGLE_SEARCH_CX follow the same rule."
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
export const GOOGLE_SEARCH_API_KEY =
  normalizeEnvValue(process.env.GOOGLE_SEARCH_API_KEY) ??
  normalizeEnvValue(process.env.PRISM_GOOGLE_SEARCH_API_KEY);
export const GOOGLE_SEARCH_CX =
  normalizeEnvValue(process.env.GOOGLE_SEARCH_CX) ??
  normalizeEnvValue(process.env.PRISM_GOOGLE_SEARCH_CX);
if (GOOGLE_SEARCH_CREDENTIALS.length === 0) {
  console.error(
    "Warning: Google Search credentials are missing. Configure GOOGLE_SEARCH_CREDENTIALS, PRISM_GOOGLE_SEARCH_CREDENTIALS, or GOOGLE_SEARCH_API_KEY/PRISM_GOOGLE_SEARCH_API_KEY + GOOGLE_SEARCH_CX/PRISM_GOOGLE_SEARCH_CX for web search tools."
  );
}

// ─── Optional: Brave Search API Key ───────────────────────────
// Used by brave_local_search and brave_local_search_code_mode only.

export const BRAVE_API_KEY = process.env.BRAVE_API_KEY;
if (!BRAVE_API_KEY && process.env.PRISM_DEBUG_LOGGING === "true") {
  console.error("Warning: BRAVE_API_KEY environment variable is missing. Search tools will return errors when called.");
}

// ─── Optional: Google Gemini API Key ──────────────────────────
// Used by the gemini_research_paper_analysis tool.
// Without this, the tool will still appear but will error when called.

export const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
if (!GOOGLE_API_KEY && process.env.PRISM_DEBUG_LOGGING === "true") {
  console.error("Warning: GOOGLE_API_KEY environment variable is missing. Gemini research features will be unavailable.");
}

// ─── Optional: Brave Answers API Key ──────────────────────────
// Used by the brave_answers tool for AI-grounded answers.
// This is a separate API key from the main Brave Search key.

export const BRAVE_ANSWERS_API_KEY =
  normalizeEnvValue(process.env.BRAVE_ANSWERS_API_KEY) ??
  normalizeEnvValue(process.env.PRISM_BRAVE_ANSWERS_API_KEY);
export const SEMANTIC_SCHOLAR_API_KEY = process.env.SEMANTIC_SCHOLAR_API_KEY;
if (!BRAVE_ANSWERS_API_KEY && process.env.PRISM_DEBUG_LOGGING === "true") {
  console.error("Warning: BRAVE_ANSWERS_API_KEY environment variable is missing. Brave Answers tool will be unavailable.");
}

// ─── Optional: Voyage AI API Key ──────────────────────────────
// Used when embedding_provider = "voyage" in the dashboard.
// Voyage AI is the embedding provider recommended by Anthropic for use
// alongside Claude. voyage-3 supports 768-dim output via MRL truncation,
// matching Prism's storage schema for zero-migration drop-in replacement.
// Without this, VoyageAdapter construction will throw at server start if
// embedding_provider=voyage is selected.

export const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY;

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

// ─── v2.0 / v12.1 / v13: Storage Backend Selection ──────────
// Three backends are implemented:
//   "local"    — SQLite, fully offline. Free-tier default.
//   "supabase" — direct Supabase REST. Legacy direct-write path. Deprecated for paid tiers.
//   "synalux"  — thin HTTP client of synalux portal. Paid-tier default. Mediates project
//                validation, tier gating, and audit. See SynaluxStorage.
//
// Auto-resolution (PRISM_STORAGE=auto, the default) picks in this order:
//   1. PRISM_FORCE_LOCAL=true → "local" (override everything)
//   2. SYNALUX_API_KEY + PRISM_SYNALUX_BASE_URL set → "synalux"
//   3. SUPABASE_URL + SUPABASE_KEY set → "supabase" (legacy)
//   4. else → "local"

export const PRISM_STORAGE: "local" | "supabase" | "synalux" | "auto" =
  (process.env.PRISM_STORAGE as "local" | "supabase" | "synalux" | "auto") || "auto";

/**
 * Hard override — when true, forces local SQLite regardless of any cloud
 * credentials. Used by free-tier installs and HIPAA deployments that must
 * never touch the network for memory operations.
 */
export const PRISM_FORCE_LOCAL = process.env.PRISM_FORCE_LOCAL === "true";
// Logged at debug level — see debug() at bottom of file

// ─── Optional: Supabase (Session Memory Module) ───────────────
// When both SUPABASE_URL and SUPABASE_KEY are set, session memory tools
// are registered. These tools allow AI agents to persist and recover
// context between sessions.

function sanitizeEnv(value?: string): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  // Treat unresolved template placeholders as unset (e.g. "${SUPABASE_URL}")
  if (!trimmed || trimmed.includes("${")) return undefined;
  return trimmed;
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export const SUPABASE_URL = sanitizeEnv(process.env.SUPABASE_URL);
export const SUPABASE_KEY = sanitizeEnv(process.env.SUPABASE_KEY);
export const SUPABASE_API_PREFIX = process.env.SUPABASE_API_PREFIX ?? "/rest/v1";
export const SUPABASE_CONFIGURED =
  !!SUPABASE_URL &&
  !!SUPABASE_KEY &&
  isHttpUrl(SUPABASE_URL);

// ─── Synalux Cloud Backend (thin-client mode) ───────────────
// When PRISM_SYNALUX_BASE_URL + PRISM_SYNALUX_API_KEY are set, the MCP
// becomes a thin HTTP client of the synalux portal. This is the paid-tier
// default. Synalux portal owns project validation, tier gating, audit logs,
// and hivemind agent coordination.
export const PRISM_SYNALUX_BASE_URL = sanitizeEnv(process.env.PRISM_SYNALUX_BASE_URL);
export const PRISM_SYNALUX_API_KEY = sanitizeEnv(process.env.PRISM_SYNALUX_API_KEY);
export const SYNALUX_CONFIGURED =
  !!PRISM_SYNALUX_BASE_URL &&
  !!PRISM_SYNALUX_API_KEY &&
  isHttpUrl(PRISM_SYNALUX_BASE_URL);

if (process.env.SUPABASE_URL && !SUPABASE_URL) {
  console.error(
    "Warning: SUPABASE_URL appears unresolved/empty (e.g. template placeholder). Falling back to local storage unless explicitly fixed."
  );
}
if (SUPABASE_URL && !isHttpUrl(SUPABASE_URL)) {
  console.error("Warning: SUPABASE_URL is not a valid http(s) URL. Falling back to local storage.");
}
// Session memory remains core-enabled in both local and Supabase modes.
export const SESSION_MEMORY_ENABLED = true;

// Optional multi-tenant scope ID (used by storage queries and handoffs).
export const PRISM_USER_ID = process.env.PRISM_USER_ID || "default";


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

// ─── v5.3: Hivemind Watchdog Thresholds ──────────────────────
// All values have sane defaults. Override via env vars only for
// testing or production tuning. Dashboard UI exposure deferred to v5.4.
export const WATCHDOG_INTERVAL_MS = parseInt(
  process.env.PRISM_WATCHDOG_INTERVAL_MS || "60000", 10
);
export const WATCHDOG_STALE_MIN = parseInt(
  process.env.PRISM_WATCHDOG_STALE_MIN || "5", 10
);
export const WATCHDOG_FROZEN_MIN = parseInt(
  process.env.PRISM_WATCHDOG_FROZEN_MIN || "15", 10
);
export const WATCHDOG_OFFLINE_MIN = parseInt(
  process.env.PRISM_WATCHDOG_OFFLINE_MIN || "30", 10
);
export const WATCHDOG_LOOP_THRESHOLD = parseInt(
  process.env.PRISM_WATCHDOG_LOOP_THRESHOLD || "5", 10
);

// ─── v5.4: Background Purge Scheduler ────────────────────────
// Automated background maintenance: TTL sweep, importance decay,
// compaction, and deep storage purge. Runs independently from
// the Watchdog (different cadence: 12h vs 60s).
export const PRISM_SCHEDULER_ENABLED =
  process.env.PRISM_SCHEDULER_ENABLED !== "false"; // Default: true
export const PRISM_SCHEDULER_INTERVAL_MS = parseInt(
  process.env.PRISM_SCHEDULER_INTERVAL_MS || "43200000", 10  // 12 hours
);

// ─── v5.4: Autonomous Web Scholar ─────────────────────────────
// Background LLM research pipeline powered by Brave Search + Firecrawl.

export const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY;
export const PRISM_SCHOLAR_ENABLED = process.env.PRISM_SCHOLAR_ENABLED === "true";

if (PRISM_SCHOLAR_ENABLED && !FIRECRAWL_API_KEY) {
  console.error("Warning: FIRECRAWL_API_KEY not set. Web Scholar will fall back to free search.");
}
export const PRISM_SCHOLAR_INTERVAL_MS = parseInt(
  process.env.PRISM_SCHOLAR_INTERVAL_MS || "0", 10  // Default manual-only
);
export const PRISM_SCHOLAR_MAX_ARTICLES_PER_RUN = parseInt(
  process.env.PRISM_SCHOLAR_MAX_ARTICLES_PER_RUN || "3", 10
);
export const PRISM_SCHOLAR_TOPICS = (process.env.PRISM_SCHOLAR_TOPICS || "ai,agents")
  .split(",")
  .map(t => t.trim());

// ─── v6.0: Associative Memory Graph ──────────────────────────
// Controls the age threshold for link strength decay.
// Links not traversed in the last N days lose 0.1 strength per sweep.
export const PRISM_LINK_DECAY_DAYS = parseInt(
  process.env.PRISM_LINK_DECAY_DAYS || "30", 10
);

// ─── v6.5: Cognitive Architecture (HDC Policy Gateway) ─────────────
// Master feature flag for HDC-driven cognitive routing APIs.
export const PRISM_HDC_ENABLED = process.env.PRISM_HDC_ENABLED === "true";

// Explainability payload toggle for cognitive routing responses.
export const PRISM_HDC_EXPLAINABILITY_ENABLED =
  process.env.PRISM_HDC_EXPLAINABILITY_ENABLED !== "false"; // default true

const DEFAULT_HDC_FALLBACK_THRESHOLD = 0.85;
const DEFAULT_HDC_CLARIFY_THRESHOLD = 0.95;

const rawHdcFallbackThreshold = parseFloat(
  process.env.PRISM_HDC_POLICY_FALLBACK_THRESHOLD || String(DEFAULT_HDC_FALLBACK_THRESHOLD)
);
const rawHdcClarifyThreshold = parseFloat(
  process.env.PRISM_HDC_POLICY_CLARIFY_THRESHOLD || String(DEFAULT_HDC_CLARIFY_THRESHOLD)
);

const hdcThresholdsValid =
  Number.isFinite(rawHdcFallbackThreshold) &&
  Number.isFinite(rawHdcClarifyThreshold) &&
  rawHdcFallbackThreshold >= 0 &&
  rawHdcFallbackThreshold < rawHdcClarifyThreshold &&
  rawHdcClarifyThreshold <= 1;

if (!hdcThresholdsValid) {
  console.error(
    "Warning: Invalid HDC policy thresholds. Falling back to defaults " +
    `(fallback=${DEFAULT_HDC_FALLBACK_THRESHOLD}, clarify=${DEFAULT_HDC_CLARIFY_THRESHOLD}).`
  );
}

export const PRISM_HDC_POLICY_FALLBACK_THRESHOLD = hdcThresholdsValid
  ? rawHdcFallbackThreshold
  : DEFAULT_HDC_FALLBACK_THRESHOLD;

export const PRISM_HDC_POLICY_CLARIFY_THRESHOLD = hdcThresholdsValid
  ? rawHdcClarifyThreshold
  : DEFAULT_HDC_CLARIFY_THRESHOLD;

// ─── v6.2: Graph Soft-Pruning ───────────────────────────────
// Soft-pruning filters weak links from graph/retrieval reads while preserving
// underlying rows for provenance. This does NOT delete links.
export const PRISM_GRAPH_PRUNING_ENABLED = process.env.PRISM_GRAPH_PRUNING_ENABLED === "true";
export const PRISM_GRAPH_PRUNE_MIN_STRENGTH = parseFloat(
  process.env.PRISM_GRAPH_PRUNE_MIN_STRENGTH || "0.15"
);

// Scheduler-driven prune sweep controls (WS3)
export const PRISM_GRAPH_PRUNE_PROJECT_COOLDOWN_MS = parseInt(
  process.env.PRISM_GRAPH_PRUNE_PROJECT_COOLDOWN_MS || "600000", 10
);
export const PRISM_GRAPH_PRUNE_SWEEP_BUDGET_MS = parseInt(
  process.env.PRISM_GRAPH_PRUNE_SWEEP_BUDGET_MS || "30000", 10
);
export const PRISM_GRAPH_PRUNE_MAX_PROJECTS_PER_SWEEP = parseInt(
  process.env.PRISM_GRAPH_PRUNE_MAX_PROJECTS_PER_SWEEP || "25", 10
);

// ─── v7.0: ACT-R Cognitive Memory Activation ────────────────
// Scientifically-grounded retrieval re-ranking based on the ACT-R
// cognitive architecture. Replaces simple Ebbinghaus decay with
// a composite similarity + activation model.

/** Master switch for ACT-R activation-based re-ranking. */
export const PRISM_ACTR_ENABLED = process.env.PRISM_ACTR_ENABLED === "true";

/** ACT-R decay parameter d in t^(-d). Higher = faster forgetting. (Paper default: 0.5) */
export const PRISM_ACTR_DECAY = parseFloat(process.env.PRISM_ACTR_DECAY || "0.5");

/** Weight of cosine similarity in composite score. (Default: 0.7 — similarity dominates) */
export const PRISM_ACTR_WEIGHT_SIMILARITY = parseFloat(
  process.env.PRISM_ACTR_WEIGHT_SIMILARITY || "0.7"
);

/** Weight of activation boost in composite score. (Default: 0.3 — activation re-ranks) */
export const PRISM_ACTR_WEIGHT_ACTIVATION = parseFloat(
  process.env.PRISM_ACTR_WEIGHT_ACTIVATION || "0.3"
);

/** Sigmoid midpoint: activation value that maps to 0.5 boost. (Default: -2.0) */
export const PRISM_ACTR_SIGMOID_MIDPOINT = parseFloat(
  process.env.PRISM_ACTR_SIGMOID_MIDPOINT || "-2.0"
);

/** Sigmoid steepness k. Higher = sharper discrimination. (Default: 1.0) */
export const PRISM_ACTR_SIGMOID_STEEPNESS = parseFloat(
  process.env.PRISM_ACTR_SIGMOID_STEEPNESS || "1.0"
);

/** Max access log entries per entry for base-level activation. (Default: 50) */
export const PRISM_ACTR_MAX_ACCESSES_PER_ENTRY = parseInt(
  process.env.PRISM_ACTR_MAX_ACCESSES_PER_ENTRY || "50", 10
);

/** AccessLogBuffer flush interval in milliseconds. (Default: 5000ms) */
export const PRISM_ACTR_BUFFER_FLUSH_MS = parseInt(
  process.env.PRISM_ACTR_BUFFER_FLUSH_MS || "5000", 10
);

/** Days to retain access log entries before pruning. (Default: 90) */
export const PRISM_ACTR_ACCESS_LOG_RETENTION_DAYS = parseInt(
  process.env.PRISM_ACTR_ACCESS_LOG_RETENTION_DAYS || "90", 10
);

// ─── v7.1: Task Router Configuration ─────────────────────────
// Deterministic heuristic-based routing for delegating coding tasks
// between the host cloud model and the local claw-code-agent.
// Set PRISM_TASK_ROUTER_ENABLED=true to unlock the session_task_route tool.

/** Master switch for the task router tool. */
export const PRISM_TASK_ROUTER_ENABLED_ENV = process.env.PRISM_TASK_ROUTER_ENABLED === "true";

/** Confidence threshold below which routing defaults to the host model. (Default: 0.6) */
export const PRISM_TASK_ROUTER_CONFIDENCE_THRESHOLD = parseFloat(
  process.env.PRISM_TASK_ROUTER_CONFIDENCE_THRESHOLD || "0.6"
);

/** Maximum complexity score (1-10) that Claw can handle. Tasks above this → host. (Default: 4) */
export const PRISM_TASK_ROUTER_MAX_CLAW_COMPLEXITY = parseInt(
  process.env.PRISM_TASK_ROUTER_MAX_CLAW_COMPLEXITY || "4", 10
);

/** Hide and reject the web-search code-mode tool when explicitly disabled. */
export const PRISM_DISABLE_BRAVE_WEB_SEARCH_CODE_MODE =
  process.env.PRISM_DISABLE_BRAVE_WEB_SEARCH_CODE_MODE === "true";

// ─── v7.2: Verification Harness ──────────────────────────────

/** Master switch for the v7.2.0 enhanced verification harness. */
export const PRISM_VERIFICATION_HARNESS_ENABLED =
  process.env.PRISM_VERIFICATION_HARNESS_ENABLED === "true";

/** Comma-separated list of verification layers to run. */
export const PRISM_VERIFICATION_LAYERS = (
  process.env.PRISM_VERIFICATION_LAYERS || "data,agent,pipeline"
).split(",").map(l => l.trim()).filter(Boolean);

/** Default severity floor for all assertions. Overrides individual assertion severity when higher. */
export const PRISM_VERIFICATION_DEFAULT_SEVERITY =
  (process.env.PRISM_VERIFICATION_DEFAULT_SEVERITY || "warn") as "warn" | "gate" | "abort";

// ─── v7.3: Dark Factory Orchestration ─────────────────────────
// Autonomous pipeline runner: PLAN → EXECUTE → VERIFY → iterate.
// Opt-in because it executes LLM calls in the background.

/** Master switch for the Dark Factory background runner. */
export const PRISM_DARK_FACTORY_ENABLED =
  process.env.PRISM_DARK_FACTORY_ENABLED === "true"; // Opt-in

/** Poll interval for the runner loop (ms). Default: 30s. */
export const PRISM_DARK_FACTORY_POLL_MS = parseInt(
  process.env.PRISM_DARK_FACTORY_POLL_MS || "30000", 10
);

/** Default max wall-clock time per pipeline (ms). Default: 15 minutes. */
export const PRISM_DARK_FACTORY_MAX_RUNTIME_MS = parseInt(
  process.env.PRISM_DARK_FACTORY_MAX_RUNTIME_MS || "900000", 10
);

// ─── v9.3: TurboQuant ResidualNorm Tiebreaker ─────────────────
// When two compressed cosine scores are within ε of each other,
// prefer the candidate with lower residualNorm (its compressed
// representation captured more signal energy, making its score
// more trustworthy). Empirically validated: ε=0.005 gives +2pp
// R@1, +1pp R@5 on random d=128 vectors. Set to 0 to disable.
//
// Only affects Tier-2 TurboQuant JS-side search (both SQLite and
// Supabase backends). Tier-1 native vector search is unaffected.

/** Tiebreaker threshold for TurboQuant Tier-2 ranking. 0 = disabled (default). */
const rawTiebreakerEpsilon = parseFloat(
  process.env.PRISM_TURBOQUANT_TIEBREAKER_EPSILON || "0"
);
export const PRISM_TURBOQUANT_TIEBREAKER_EPSILON =
  Number.isFinite(rawTiebreakerEpsilon) && rawTiebreakerEpsilon >= 0
    ? rawTiebreakerEpsilon
    : 0;

// ─── v9.x: Local LLM (prism-coder:7b) Integration ─────────────────────────
// Enables background tasks (compaction, task-router fallback, pipeline ops)
// to use a local Ollama model instead of the cloud LLM provider.
//
// Default model is prism-coder:7b — fine-tuned on Prism tool schemas.
// Disabled by default so existing deployments are unaffected.
//
// Set PRISM_LOCAL_LLM_ENABLED=true to activate.
// Set PRISM_LOCAL_LLM_MODEL to override the model tag.
// Set PRISM_LOCAL_LLM_URL to override the Ollama endpoint (default: localhost:11434).
// Set PRISM_LOCAL_LLM_TIMEOUT_MS to override per-call timeout (default: 60000, max: 300000).
// Set PRISM_STRICT_LOCAL_MODE=true to block cloud fallback when local LLM is enabled (HIPAA).

/** Master switch — enables the local prism-coder:7b LLM for background tasks. */
export const PRISM_LOCAL_LLM_ENABLED =
  process.env.PRISM_LOCAL_LLM_ENABLED === "true"; // Opt-in, default false

/** Ollama model tag to use for local LLM calls. */
export const PRISM_LOCAL_LLM_MODEL =
  (process.env.PRISM_LOCAL_LLM_MODEL || "prism-coder:7b").trim();

/** Ollama base URL. Override for remote Ollama instances. */
export const PRISM_LOCAL_LLM_URL =
  (process.env.PRISM_LOCAL_LLM_URL || "http://localhost:11434").trim();

/** Per-call timeout in ms. Prevents stalled background tasks. Capped at 300s. */
export const PRISM_LOCAL_LLM_TIMEOUT_MS = (() => {
  const raw = parseInt(process.env.PRISM_LOCAL_LLM_TIMEOUT_MS || "60000", 10);
  // FIX (integer overflow): values > 2^31-1 cause setTimeout to fire immediately,
  // which silently aborts every local LLM call and forces cloud fallback.
  // Cap at 300s (5 min) — no legitimate compaction call should take longer.
  const MAX_TIMEOUT = 300_000;
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, MAX_TIMEOUT) : 60_000;
})();

/**
 * Strict local mode — blocks cloud LLM fallback when local LLM is enabled.
 * Critical for HIPAA deployments where session data must never leave the device.
 * When true: compaction throws instead of falling back to Gemini.
 * When false (default): graceful cloud fallback on local LLM failure.
 */
export const PRISM_STRICT_LOCAL_MODE =
  process.env.PRISM_STRICT_LOCAL_MODE === "true";

/** Redact credentials from a URL for safe logging (strips user:pass@). */
function redactUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.username || parsed.password) {
      parsed.username = "***";
      parsed.password = "***";
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return "[invalid URL]";
  }
}

if (PRISM_LOCAL_LLM_ENABLED) {
  console.error(
    `[Prism] Local LLM enabled: model=${PRISM_LOCAL_LLM_MODEL}, ` +
    `url=${redactUrl(PRISM_LOCAL_LLM_URL)}, timeout=${PRISM_LOCAL_LLM_TIMEOUT_MS}ms` +
    (PRISM_STRICT_LOCAL_MODE ? ", STRICT LOCAL MODE (no cloud fallback)" : "")
  );
}

// ─── v11.0: Zero-Search Retrieval (HRR) ───────────────────────
// Dynamic dimension selection based on available system memory.
// Higher dimensions = higher fact capacity but slower unbinding.

import { totalmem } from "node:os";

export const PRISM_HRR_DIMENSION = (() => {
  // 1. Manual override via env var
  const envVal = parseInt(process.env.PRISM_HRR_DIMENSION || "0", 10);
  if (envVal > 0) {
    // Ensure power of 2 for FFT
    if ((envVal & (envVal - 1)) !== 0) {
      console.error(`Warning: PRISM_HRR_DIMENSION (${envVal}) is not a power of 2. FFT unbinding may fail.`);
    }
    return envVal;
  }

  // 2. Auto-adjustment based on system RAM
  const totalRamGb = totalmem() / (1024 ** 3);

  if (totalRamGb >= 48) return 8192; // High-end (M4 Max)
  if (totalRamGb >= 32) return 4096; // Mid-high (M3 Pro)
  if (totalRamGb >= 16) return 2048; // Standard (M1/M2/M3)
  return 1024; // Low-memory / Baseline
})();

if (PRISM_DEBUG_LOGGING) {
  console.error(`[Prism] HRR Zero-Search Dimension: ${PRISM_HRR_DIMENSION} (Total RAM: ${(totalmem() / (1024 ** 3)).toFixed(1)}GB)`);
}

// ─── v12.1: Implicit Memory NER ──────────────────────────────
// Automatically extracts entities from raw conversation text.
// Rule-based extraction is always available. LLM extraction requires
// PRISM_LOCAL_LLM_ENABLED=true.

/** Master switch for auto-NER on session_save_ledger calls. */
export const PRISM_NER_AUTO_EXTRACT =
  process.env.PRISM_NER_AUTO_EXTRACT === "true"; // Opt-in

/** Minimum confidence threshold for NER results. Default: 0.6 */
export const PRISM_NER_MIN_CONFIDENCE = parseFloat(
  process.env.PRISM_NER_MIN_CONFIDENCE || "0.6"
);

// ─── v12.1: Onboarding Wizard ────────────────────────────────
// First-run setup experience for new users.

/** If true, show onboarding wizard on first load_context call. Default: true */
export const PRISM_ONBOARDING_ENABLED =
  process.env.PRISM_ONBOARDING_ENABLED !== "false"; // Default: true

// ─── v12.2: API Usage Analytics ──────────────────────────────
// Tracks tool invocations for per-project usage reporting.

/** Master switch for API usage analytics tracking. Default: true */
export const PRISM_ANALYTICS_ENABLED =
  process.env.PRISM_ANALYTICS_ENABLED !== "false"; // Default: true

/** Buffer flush threshold (number of invocations before writing). Default: 25 */
export const PRISM_ANALYTICS_FLUSH_THRESHOLD = parseInt(
  process.env.PRISM_ANALYTICS_FLUSH_THRESHOLD || "25", 10
);

// ─── v12.2: Notification System ──────────────────────────────
// Sends alerts for significant memory events.

/** Webhook URL for notifications. Set to enable webhook channel. */
export const PRISM_NOTIFICATION_WEBHOOK = process.env.PRISM_NOTIFICATION_WEBHOOK;

/** Slack webhook URL for notifications. Set to enable Slack channel. */
export const PRISM_NOTIFICATION_SLACK = process.env.PRISM_NOTIFICATION_SLACK;

/** Minimum severity for notifications: info, warning, critical. Default: warning */
export const PRISM_NOTIFICATION_MIN_SEVERITY =
  (process.env.PRISM_NOTIFICATION_MIN_SEVERITY || "warning") as "info" | "warning" | "critical";

// ─── v12.2: Automated Backup ─────────────────────────────────
// Scheduled SQLite database backups.

/** Backup schedule: hourly, daily, weekly, manual. Default: manual (disabled). */
export const PRISM_BACKUP_SCHEDULE =
  (process.env.PRISM_BACKUP_SCHEDULE || "manual") as "hourly" | "daily" | "weekly" | "manual";

/** Maximum number of backups to retain. Default: 7 */
export const PRISM_BACKUP_MAX = parseInt(
  process.env.PRISM_BACKUP_MAX || "7", 10
);

/** Custom backup directory. Default: ~/.prism/backups/ */
export const PRISM_BACKUP_DIR = process.env.PRISM_BACKUP_DIR || "";

/** Enable automated backup scheduler at startup. */
export const PRISM_BACKUP_ENABLED =
  PRISM_BACKUP_SCHEDULE !== "manual";

if (PRISM_BACKUP_ENABLED && PRISM_DEBUG_LOGGING) {
  console.error(`[Prism] Backup scheduler: ${PRISM_BACKUP_SCHEDULE}, max=${PRISM_BACKUP_MAX}`);
}

