/**
 * Savings sync — the paid layer that makes `prism savings` answer for a TEAM,
 * not just this machine.
 *
 * What leaves the machine, exactly: per-UTC-day COUNTERS — call counts and
 * token totals. No prompts, no completions, no model output, no file paths,
 * no project names. That is why this channel is NOT E2E-sealed like handoff
 * sync (src/crypto/): a sealed blob is opaque to the server, and an opaque
 * blob cannot be aggregated across a team, which is this feature's entire
 * point. The two channels have different contents and deliberately different
 * privacy designs; do not "unify" them.
 *
 * Consent model, in order:
 *   1. OPT-IN — savings_sync_enabled must be set (config or env). Default off:
 *      local-first means nothing leaves silently, not even counters.
 *   2. PAID — client-side entitlement gate (plan !== free) to avoid pointless
 *      uploads; the portal enforces the real gate server-side.
 *   3. FAIL-SOFT — sync failures never break the session; they debugLog and
 *      return. The local ledger remains the source of truth; upload is
 *      re-sendable at any time because rows are absolute per-day upserts.
 *
 * The device is identified by the Phase-2 device identity's keyId — one
 * stable id per machine, derived from a public key, carrying no user data.
 */

import { debugLog } from "../utils/logger.js";
import { getEntitlements } from "../utils/entitlements.js";
import { getSynaluxJwt } from "../utils/synaluxJwt.js";
import { getSetting } from "../storage/configStorage.js";
import { queryDailyLocalSavings, type DailySavingsRow } from "../storage/inferMetricsLedger.js";
import { loadOrCreateDeviceIdentity } from "../crypto/deviceKeys.js";
import { PRISM_SYNALUX_BASE_URL } from "../config.js";
import { abbreviate } from "../tools/savingsHandler.js";

const DAY_MS = 86_400_000;
/** Trailing window re-sent on every push. Wide enough that a machine offline
 *  for a month still converges; small enough to stay one cheap request. */
const PUSH_WINDOW_DAYS = 35;
const PUSH_TIMEOUT_MS = 10_000;

export interface SavingsPushResult {
    pushed: boolean;
    reason:
        | "ok"
        | "disabled"
        | "free_plan"
        | "no_jwt"
        | "no_base_url"
        | "ledger_unavailable"
        | "nothing_to_push"
        | "portal_rejected"
        | "error";
    days?: number;
}

async function syncEnabled(): Promise<boolean> {
    if (process.env.PRISM_SAVINGS_SYNC === "1") return true;
    if (process.env.PRISM_SAVINGS_SYNC === "0") return false;
    const setting = (await getSetting("PRISM_SAVINGS_SYNC", "")).trim();
    return setting === "1" || setting.toLowerCase() === "true";
}

function baseUrl(): string {
    return (
        process.env.PRISM_SYNALUX_BASE_URL?.trim() ||
        process.env.SYNALUX_BASE_URL?.trim() ||
        PRISM_SYNALUX_BASE_URL ||
        ""
    ).replace(/\/+$/, "");
}

/**
 * Push the trailing window of daily savings counters to the portal.
 * Fire-and-forget safe: never throws.
 */
export async function pushSavings(fetchImpl: typeof fetch = fetch): Promise<SavingsPushResult> {
    try {
        if (!(await syncEnabled())) return { pushed: false, reason: "disabled" };

        const ent = await getEntitlements();
        if (ent.plan === "free") return { pushed: false, reason: "free_plan" };

        const url = baseUrl();
        if (!url) return { pushed: false, reason: "no_base_url" };

        const jwt = await getSynaluxJwt();
        if (!jwt) return { pushed: false, reason: "no_jwt" };

        const rows = await queryDailyLocalSavings(Date.now() - PUSH_WINDOW_DAYS * DAY_MS);
        if (rows === null) return { pushed: false, reason: "ledger_unavailable" };
        if (rows.length === 0) return { pushed: false, reason: "nothing_to_push" };

        const device = loadOrCreateDeviceIdentity();
        const res = await fetchImpl(`${url}/api/v1/prism/savings`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${jwt}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ device_id: device.keyId, days: rows }),
            signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
        });
        if (!res.ok) {
            debugLog(`[savings-sync] portal rejected push: HTTP ${res.status}`);
            return { pushed: false, reason: "portal_rejected" };
        }
        debugLog(`[savings-sync] pushed ${rows.length} day row(s)`);
        return { pushed: true, reason: "ok", days: rows.length };
    } catch (e) {
        debugLog(`[savings-sync] push failed: ${e instanceof Error ? e.message : e}`);
        return { pushed: false, reason: "error" };
    }
}

export interface TeamMemberSavings {
    user_id: string;
    label: string;
    devices: number;
    local_calls: number;
    local_tokens: number;
}

export interface TeamSavings {
    workspace_id: string;
    days: number;
    members: TeamMemberSavings[];
    total_local_calls: number;
    total_cloud_calls: number;
    total_local_tokens: number;
    /** Machines whose rows arrived under more than one member — the portal
     *  counts each once (latest push wins) and reports how many, so the
     *  render can disclose it. Optional: older portals omit it. */
    shared_devices?: number;
    /** Server-rendered display block. Prism is a THIN CLIENT: presentation
     *  lives portal-side so it can evolve without an npm release; the client
     *  prints this verbatim and only falls back to a minimal local summary
     *  when talking to an older portal that omits it. */
    rendered?: string;
}

export function isTeamSavings(value: unknown): value is TeamSavings {
    if (typeof value !== "object" || value === null) return false;
    const o = value as Record<string, unknown>;
    return typeof o.workspace_id === "string" &&
        typeof o.days === "number" &&
        Array.isArray(o.members) &&
        typeof o.total_local_tokens === "number" &&
        typeof o.total_local_calls === "number" &&
        typeof o.total_cloud_calls === "number";
}

export type TeamSavingsResult =
    | { ok: true; team: TeamSavings }
    | { ok: false; reason: "no_jwt" | "no_base_url" | "not_entitled" | "portal_error" | "malformed" | "error"; status?: number };

/**
 * Fetch the team roll-up. The portal owns membership and plan checks; this
 * client treats 401/403 as "not entitled" and everything else as unavailable.
 * Read-only: safe to call from free plans (the portal will refuse).
 */
export async function fetchTeamSavings(
    workspaceId: string | undefined,
    days: number,
    fetchImpl: typeof fetch = fetch,
): Promise<TeamSavingsResult> {
    try {
        const url = baseUrl();
        if (!url) return { ok: false, reason: "no_base_url" };
        const jwt = await getSynaluxJwt();
        if (!jwt) return { ok: false, reason: "no_jwt" };

        const params = new URLSearchParams({ scope: "team", days: String(days) });
        if (workspaceId) params.set("workspace_id", workspaceId);
        const res = await fetchImpl(`${url}/api/v1/prism/savings?${params}`, {
            headers: { "Authorization": `Bearer ${jwt}` },
            signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
        });
        if (res.status === 401 || res.status === 403 || res.status === 402) {
            return { ok: false, reason: "not_entitled", status: res.status };
        }
        if (!res.ok) return { ok: false, reason: "portal_error", status: res.status };
        const data: unknown = await res.json();
        if (!isTeamSavings(data)) return { ok: false, reason: "malformed" };
        return { ok: true, team: data };
    } catch (e) {
        debugLog(`[savings-sync] team fetch failed: ${e instanceof Error ? e.message : e}`);
        return { ok: false, reason: "error" };
    }
}

/**
 * Display text for the team roll-up.
 *
 * Thin-client rule: the portal renders the display (rendered field) and this
 * prints it verbatim. The fallback below exists ONLY for older portals that
 * predate server rendering — one summary line, tokens only, no currency (the
 * no-currency contract applies to both paths and is pinned by tests).
 */
export function renderTeamSavings(t: TeamSavings): string {
    if (typeof t.rendered === "string" && t.rendered.trim().length > 0) {
        return t.rendered;
    }
    if (t.total_local_calls === 0) {
        return `💾 Team local serving — LAST ${t.days} DAYS (workspace ${t.workspace_id})\n` +
            `  No synced local serving yet. Members opt in with: prism savings --sync-enable`;
    }
    return `💾 Team local serving — LAST ${t.days} DAYS (workspace ${t.workspace_id})\n` +
        `  ~${abbreviate(t.total_local_tokens)} tokens kept off cloud models across the team ` +
        `(${t.total_local_calls.toLocaleString("en-US")} local call(s), ${t.members.length} member(s)).\n` +
        `  Older portal: full breakdown unavailable — update the portal for member rows and disclosures.`;
}
