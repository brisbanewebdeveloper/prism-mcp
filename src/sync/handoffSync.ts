/**
 * Cross-machine handoff sync — the Phase-2 engine on top of src/crypto/.
 *
 * Flow: on session_save_handoff (and only then), if the user opted in, this
 * seals the handoff to ALL of the account's active device public keys and
 * PUTs the ciphertext to the portal relay. Another machine pulls, opens with
 * its own device key, and resumes. The relay stores ciphertext only — see
 * src/crypto/syncEnvelope.ts for the properties that make that architectural.
 *
 * Consent model (mirrors savingsSync, deliberately):
 *   1. OPT-IN — PRISM_HANDOFF_SYNC (env or stored setting), default OFF.
 *   2. PAID — client-side plan gate; the portal enforces the real one.
 *   3. FAIL-SOFT — sync never breaks a save; failures debugLog and return.
 *
 * Trust boundary, handled rather than hand-waved: the DEVICE LIST comes from
 * the portal, and a compromised portal could inject an attacker's public key
 * to receive readable copies of future blobs. Mitigation is TOFU pinning:
 * every device keyId this machine has ever sealed to is remembered locally
 * (~/.prism-mcp/known-sync-devices.json); when the set GROWS, the push still
 * succeeds (users legitimately add machines) but the result carries a
 * loud warning naming the new keyIds, and the warning repeats until the user
 * has seen a push after the growth. Silent key injection is the attack;
 * unnoticed growth is what TOFU removes.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { debugLog } from "../utils/logger.js";
import { getEntitlements } from "../utils/entitlements.js";
import { getSynaluxJwt } from "../utils/synaluxJwt.js";
import { getSetting } from "../storage/configStorage.js";
import { loadOrCreateDeviceIdentity } from "../crypto/deviceKeys.js";
import { sealFor, openSealed, isSealedEnvelope, EnvelopeError, keyIdOf } from "../crypto/syncEnvelope.js";
import { PRISM_SYNALUX_BASE_URL } from "../config.js";

const TIMEOUT_MS = 10_000;
const PROJECT_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

function baseUrl(): string {
    return (
        process.env.PRISM_SYNALUX_BASE_URL?.trim() ||
        process.env.SYNALUX_BASE_URL?.trim() ||
        PRISM_SYNALUX_BASE_URL ||
        ""
    ).replace(/\/+$/, "");
}

async function syncEnabled(): Promise<boolean> {
    if (process.env.PRISM_HANDOFF_SYNC === "1") return true;
    if (process.env.PRISM_HANDOFF_SYNC === "0") return false;
    const setting = (await getSetting("PRISM_HANDOFF_SYNC", "")).trim();
    return setting === "1" || setting.toLowerCase() === "true";
}

function aadFor(project: string): string {
    return `prism-sync:v1:${project}:handoff`;
}

// ── TOFU pinning ─────────────────────────────────────────────────────────────

function pinPath(): string {
    const dir = process.env.PRISM_DATA_DIR
        ? resolve(process.env.PRISM_DATA_DIR)
        : resolve(homedir(), ".prism-mcp");
    return join(dir, "known-sync-devices.json");
}

function readPins(): Set<string> {
    try {
        const p = pinPath();
        if (!existsSync(p)) return new Set();
        const parsed = JSON.parse(readFileSync(p, "utf8")) as { device_ids?: unknown };
        return new Set(Array.isArray(parsed.device_ids)
            ? parsed.device_ids.filter((d): d is string => typeof d === "string")
            : []);
    } catch {
        // Unreadable pins fail toward WARNING (everything looks new), never
        // toward silence.
        return new Set();
    }
}

function writePins(pins: Set<string>): void {
    try {
        writeFileSync(pinPath(), JSON.stringify({ device_ids: [...pins].sort() }, null, 2) + "\n", { mode: 0o600 });
    } catch (e) {
        debugLog(`[handoff-sync] pin write failed: ${e instanceof Error ? e.message : e}`);
    }
}

// ── Device registry client ───────────────────────────────────────────────────

interface RemoteDevice {
    device_id: string;
    public_key: string;
    label: string | null;
    revoked: boolean;
}

let registeredThisProcess = false;

async function ensureRegistered(jwt: string, fetchImpl: typeof fetch): Promise<boolean> {
    if (registeredThisProcess) return true;
    const device = loadOrCreateDeviceIdentity();
    const res = await fetchImpl(`${baseUrl()}/api/v1/prism/sync/devices`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${jwt}`, "Content-Type": "application/json" },
        body: JSON.stringify({
            device_id: device.keyId,
            public_key: device.rawPublicKey.toString("base64"),
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
        debugLog(`[handoff-sync] device registration failed: HTTP ${res.status}`);
        return false;
    }
    registeredThisProcess = true;
    return true;
}

/** Test hook. */
export function _resetHandoffSyncForTest(): void {
    registeredThisProcess = false;
}

/** A device we will actually seal to: the public key plus the kid DERIVED from
 *  it on THIS machine. The derived kid — not the portal's asserted device_id —
 *  is the identity TOFU and sealing agree on. */
interface SealTarget {
    rawKey: Buffer;
    /** keyIdOf(rawKey), computed locally. This is the recipient kid sealFor
     *  will produce, so pinning it makes a swapped key a new identity. */
    derivedKid: string;
    /** What the portal claimed. Kept only to detect and drop a mismatch. */
    assertedId: string;
}

async function fetchActiveDevices(jwt: string, fetchImpl: typeof fetch): Promise<SealTarget[] | null> {
    const res = await fetchImpl(`${baseUrl()}/api/v1/prism/sync/devices`, {
        headers: { "Authorization": `Bearer ${jwt}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { devices?: unknown };
    if (!Array.isArray(data.devices)) return null;

    const out: SealTarget[] = [];
    for (const d of data.devices) {
        if (typeof d !== "object" || d === null) continue;
        const r = d as RemoteDevice;
        if (typeof r.device_id !== "string" || typeof r.public_key !== "string" || r.revoked) continue;

        // The adversary this whole module names is a portal that lies in THIS
        // response. It cannot be trusted to tell the truth about which key
        // belongs to which device_id, so the asserted device_id is not used as
        // an identity anywhere downstream: re-derive the kid from the key that
        // will actually receive the blob. A portal that reuses a pinned
        // device_id with a swapped key produces a DIFFERENT derivedKid here, so
        // TOFU sees a new device and warns — the exact injection the header
        // promises to surface. A portal that also forges the device_id to match
        // its swapped key still surfaces, because the pin is on the derived kid.
        let rawKey: Buffer;
        try {
            rawKey = Buffer.from(r.public_key, "base64");
        } catch {
            continue;
        }
        if (rawKey.length !== 32) continue;
        let derivedKid: string;
        try {
            derivedKid = keyIdOf(rawKey);
        } catch {
            continue;
        }
        out.push({ rawKey, derivedKid, assertedId: r.device_id });
    }
    return out;
}

// ── Push ─────────────────────────────────────────────────────────────────────

export interface HandoffPushResult {
    pushed: boolean;
    reason:
        | "ok" | "disabled" | "free_plan" | "no_jwt" | "no_base_url"
        | "bad_project" | "registration_failed" | "device_list_unavailable"
        | "portal_rejected" | "error";
    sealed_to?: number;
    /** TOFU: device keyIds never seen by this machine before this push. */
    new_devices?: string[];
}

export async function pushHandoff(
    project: string,
    handoff: Record<string, unknown>,
    fetchImpl: typeof fetch = fetch,
): Promise<HandoffPushResult> {
    try {
        if (!(await syncEnabled())) return { pushed: false, reason: "disabled" };
        if (!PROJECT_RE.test(project)) return { pushed: false, reason: "bad_project" };

        const ent = await getEntitlements();
        if (ent.plan === "free") return { pushed: false, reason: "free_plan" };
        if (!baseUrl()) return { pushed: false, reason: "no_base_url" };
        const jwt = await getSynaluxJwt();
        if (!jwt) return { pushed: false, reason: "no_jwt" };

        if (!(await ensureRegistered(jwt, fetchImpl))) {
            return { pushed: false, reason: "registration_failed" };
        }
        const devices = await fetchActiveDevices(jwt, fetchImpl);
        if (!devices || devices.length === 0) {
            return { pushed: false, reason: "device_list_unavailable" };
        }

        const self = loadOrCreateDeviceIdentity();

        // Always seal to SELF from local key material, regardless of the portal
        // list. A hostile (or merely stale) portal that omits this device would
        // otherwise make the origin unable to open its own handoff — a
        // self-inflicted lockout. Deduped by derived kid so a portal that DOES
        // list us is not a double recipient.
        const targets = new Map<string, Buffer>();
        targets.set(self.keyId, self.rawPublicKey);
        for (const d of devices) targets.set(d.derivedKid, d.rawKey);

        // TOFU keys on the DERIVED kid — the same value sealFor puts in the
        // envelope as the recipient — so a swapped key is a new identity here,
        // never a silent reuse of a pinned device_id. Self is never "new".
        const pins = readPins();
        const newDevices = [...targets.keys()].filter((kid) => kid !== self.keyId && !pins.has(kid));

        const payload = Buffer.from(JSON.stringify({
            v: 1,
            project,
            saved_at: new Date().toISOString(),
            origin_device_id: self.keyId,
            handoff,
        }), "utf8");

        const envelope = sealFor([...targets.values()], payload, aadFor(project));

        const res = await fetchImpl(`${baseUrl()}/api/v1/prism/sync/blob`, {
            method: "PUT",
            headers: { "Authorization": `Bearer ${jwt}`, "Content-Type": "application/json" },
            body: JSON.stringify({ project, kind: "handoff", envelope, origin_device_id: self.keyId }),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) {
            debugLog(`[handoff-sync] relay rejected blob: HTTP ${res.status}`);
            return { pushed: false, reason: "portal_rejected" };
        }

        // Pin only AFTER a successful push, so a failed push re-warns next time.
        if (newDevices.length > 0) {
            for (const id of newDevices) pins.add(id);
            writePins(pins);
            debugLog(`[handoff-sync] ⚠ sealed to ${newDevices.length} device(s) this machine had never seen: ${newDevices.join(", ")}`);
        }
        return { pushed: true, reason: "ok", sealed_to: targets.size, ...(newDevices.length ? { new_devices: newDevices } : {}) };
    } catch (e) {
        debugLog(`[handoff-sync] push failed: ${e instanceof Error ? e.message : e}`);
        return { pushed: false, reason: "error" };
    }
}

/** Fire-and-forget adapter for the session_save_handoff dispatch site. */
export async function pushHandoffFromArgs(args: unknown): Promise<void> {
    if (typeof args !== "object" || args === null) return;
    const o = args as Record<string, unknown>;
    const project = typeof o.project === "string" ? o.project : null;
    if (!project) return;
    const result = await pushHandoff(project, o);
    if (result.pushed && result.new_devices?.length) {
        console.error(
            `[handoff-sync] ⚠ NEW sync device(s) on your account: ${result.new_devices.join(", ")}. ` +
            `If you did not add a machine, revoke it: prism sync devices`);
    }
}

// ── Pull ─────────────────────────────────────────────────────────────────────

export interface HandoffPullResult {
    ok: boolean;
    reason:
        | "ok" | "disabled" | "no_jwt" | "no_base_url" | "bad_project"
        | "no_blob" | "not_recipient" | "bad_envelope" | "not_entitled"
        | "portal_error" | "error";
    payload?: { v: number; project: string; saved_at: string; origin_device_id: string; handoff: Record<string, unknown> };
    origin_device_id?: string;
    updated_at?: string;
}

export async function pullHandoff(
    project: string,
    fetchImpl: typeof fetch = fetch,
): Promise<HandoffPullResult> {
    try {
        if (!(await syncEnabled())) return { ok: false, reason: "disabled" };
        if (!PROJECT_RE.test(project)) return { ok: false, reason: "bad_project" };
        if (!baseUrl()) return { ok: false, reason: "no_base_url" };
        const jwt = await getSynaluxJwt();
        if (!jwt) return { ok: false, reason: "no_jwt" };

        const res = await fetchImpl(
            `${baseUrl()}/api/v1/prism/sync/blob?project=${encodeURIComponent(project)}`,
            { headers: { "Authorization": `Bearer ${jwt}` }, signal: AbortSignal.timeout(TIMEOUT_MS) },
        );
        if (res.status === 404) return { ok: false, reason: "no_blob" };
        if (res.status === 401 || res.status === 402 || res.status === 403) {
            return { ok: false, reason: "not_entitled" };
        }
        if (!res.ok) return { ok: false, reason: "portal_error" };

        const body = (await res.json()) as Record<string, unknown>;
        if (!isSealedEnvelope(body.envelope)) return { ok: false, reason: "bad_envelope" };

        const self = loadOrCreateDeviceIdentity();
        let plaintext: Buffer;
        try {
            plaintext = openSealed(body.envelope, self.privateKey, self.rawPublicKey, aadFor(project));
        } catch (e) {
            if (e instanceof EnvelopeError && /not a recipient/.test(e.message)) {
                // Sealed before this device existed (or after it was revoked).
                // The NEXT save from any current device includes this machine.
                return { ok: false, reason: "not_recipient" };
            }
            return { ok: false, reason: "bad_envelope" };
        }

        const payload = JSON.parse(plaintext.toString("utf8")) as HandoffPullResult["payload"];
        if (!payload || payload.v !== 1 || payload.project !== project) {
            return { ok: false, reason: "bad_envelope" };
        }
        return {
            ok: true, reason: "ok", payload,
            origin_device_id: typeof body.origin_device_id === "string" ? body.origin_device_id : undefined,
            updated_at: typeof body.updated_at === "string" ? body.updated_at : undefined,
        };
    } catch (e) {
        debugLog(`[handoff-sync] pull failed: ${e instanceof Error ? e.message : e}`);
        return { ok: false, reason: "error" };
    }
}

/** Human rendering for the tool/CLI pull surfaces. */
export function renderPulledHandoff(r: HandoffPullResult): string {
    if (!r.ok || !r.payload) {
        const why: Record<string, string> = {
            disabled: "Handoff sync is off on this machine. Enable: prism sync enable",
            no_blob: "No synced handoff exists for this project yet.",
            not_recipient: "A handoff exists but was sealed before this device joined — it will include this machine after the next save elsewhere.",
            not_entitled: "Cross-machine sync needs a paid plan and a signed-in account.",
            no_jwt: "No portal credentials on this machine — sign in first.",
            bad_envelope: "The stored blob failed authentication — refusing to use it.",
        };
        return `🔄 ${why[r.reason] ?? `Handoff sync unavailable (${r.reason}).`}`;
    }
    const p = r.payload;
    const lines = [
        `🔄 Synced handoff for ${p.project}`,
        `  From device ${p.origin_device_id} at ${p.saved_at}`,
        "",
        JSON.stringify(p.handoff, null, 2),
    ];
    return lines.join("\n");
}
