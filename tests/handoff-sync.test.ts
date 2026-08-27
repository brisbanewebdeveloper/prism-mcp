/**
 * Handoff-sync engine tests.
 *
 * The properties that matter:
 *   1. CONSENT: disabled (default) / free plan / signed out → NOT ONE request.
 *   2. E2E: what reaches the wire is ciphertext — the handoff text must not
 *      appear in any request body, and a full round trip (machine A seals →
 *      relay echo → machine B opens) yields the exact handoff on B only when
 *      B was a listed device.
 *   3. TOFU: sealing to a device this machine has never seen succeeds but
 *      WARNS with the new keyIds — and pins only after a successful push.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, createHash } from 'node:crypto';

vi.mock('../src/utils/entitlements.js', () => ({
  getEntitlements: vi.fn(async () => ({ plan: 'standard' })),
}));
vi.mock('../src/utils/synaluxJwt.js', () => ({
  getSynaluxJwt: vi.fn(async () => 'test-jwt'),
}));

import { pushHandoff, pullHandoff, renderPulledHandoff, _resetHandoffSyncForTest } from '../src/sync/handoffSync.js';
import { getEntitlements } from '../src/utils/entitlements.js';
import { getSynaluxJwt } from '../src/utils/synaluxJwt.js';
import { loadOrCreateDeviceIdentity } from '../src/crypto/deviceKeys.js';
import { rawFromPublicKey, keyIdOf } from '../src/crypto/syncEnvelope.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'handoff-sync-'));
  process.env.PRISM_DATA_DIR = dir; // device key + TOFU pins sandbox
  process.env.PRISM_SYNALUX_BASE_URL = 'https://portal.test';
  delete process.env.PRISM_HANDOFF_SYNC;
  _resetHandoffSyncForTest();
  vi.mocked(getEntitlements).mockResolvedValue({ plan: 'standard' } as never);
  vi.mocked(getSynaluxJwt).mockResolvedValue('test-jwt');
});

afterEach(async () => {
  delete process.env.PRISM_DATA_DIR;
  delete process.env.PRISM_SYNALUX_BASE_URL;
  delete process.env.PRISM_HANDOFF_SYNC;
  await rm(dir, { recursive: true, force: true });
});

const HANDOFF = { project: 'proj-a', summary: 'THE-HANDOFF-CONTENT-77aa', pending_todo: 'finish the gate' };

function otherDevice() {
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  const raw = rawFromPublicKey(publicKey);
  return { privateKey, raw, keyId: keyIdOf(raw), b64: raw.toString('base64') };
}

/** In-memory relay faithful to the portal contract: register, list, put, get. */
function makeRelay() {
  const devices: Array<{ device_id: string; public_key: string; label: null; revoked: boolean }> = [];
  const blobs = new Map<string, { envelope: unknown; origin_device_id: string; updated_at: string }>();
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/sync/devices') && init?.method === 'POST') {
      const body = JSON.parse(init.body as string) as { device_id: string; public_key: string };
      const derived = createHash('sha256').update(Buffer.from(body.public_key, 'base64')).digest('hex').slice(0, 16);
      if (derived !== body.device_id) return new Response('{"error":"mismatch"}', { status: 400 });
      if (!devices.some(d => d.device_id === body.device_id)) {
        devices.push({ device_id: body.device_id, public_key: body.public_key, label: null, revoked: false });
      }
      return new Response('{"ok":true}', { status: 200 });
    }
    if (u.pathname.endsWith('/sync/devices')) {
      return new Response(JSON.stringify({ devices }), { status: 200 });
    }
    if (u.pathname.endsWith('/sync/blob') && init?.method === 'PUT') {
      const body = JSON.parse(init.body as string) as { project: string; envelope: unknown; origin_device_id: string };
      blobs.set(body.project, { envelope: body.envelope, origin_device_id: body.origin_device_id, updated_at: new Date().toISOString() });
      return new Response('{"ok":true}', { status: 200 });
    }
    if (u.pathname.endsWith('/sync/blob')) {
      const blob = blobs.get(u.searchParams.get('project') ?? '');
      return blob
        ? new Response(JSON.stringify(blob), { status: 200 })
        : new Response('{"error":"none"}', { status: 404 });
    }
    return new Response('{"error":"unexpected"}', { status: 500 });
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
  return { fetchImpl, devices, blobs };
}

describe('consent gates — not one request leaves', () => {
  it.each([
    ['disabled (default)', () => {}, 'disabled'],
    ['free plan', () => { process.env.PRISM_HANDOFF_SYNC = '1';
      vi.mocked(getEntitlements).mockResolvedValue({ plan: 'free' } as never); }, 'free_plan'],
    ['signed out', () => { process.env.PRISM_HANDOFF_SYNC = '1';
      vi.mocked(getSynaluxJwt).mockResolvedValue(null); }, 'no_jwt'],
  ])('%s → no request', async (_label, setup, reason) => {
    setup();
    const { fetchImpl } = makeRelay();
    const r = await pushHandoff('proj-a', HANDOFF, fetchImpl);
    expect(r).toMatchObject({ pushed: false, reason });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('pull also requires the opt-in', async () => {
    const { fetchImpl } = makeRelay();
    const r = await pullHandoff('proj-a', fetchImpl);
    expect(r).toMatchObject({ ok: false, reason: 'disabled' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects hostile project names before any request', async () => {
    process.env.PRISM_HANDOFF_SYNC = '1';
    const { fetchImpl } = makeRelay();
    expect((await pushHandoff('../etc', HANDOFF, fetchImpl)).reason).toBe('bad_project');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('E2E round trip', () => {
  it('the wire carries ciphertext only — never the handoff content', async () => {
    process.env.PRISM_HANDOFF_SYNC = '1';
    const relay = makeRelay();
    const r = await pushHandoff('proj-a', HANDOFF, relay.fetchImpl);
    expect(r.pushed).toBe(true);

    for (const call of relay.fetchImpl.mock.calls as Array<[string, RequestInit?]>) {
      const body = (call[1]?.body as string) ?? '';
      expect(body).not.toContain('THE-HANDOFF-CONTENT-77aa');
      expect(body).not.toContain(Buffer.from('THE-HANDOFF-CONTENT-77aa').toString('base64'));
      expect(body).not.toContain('finish the gate');
    }
  });

  it('machine A pushes, the same machine pulls back the exact handoff', async () => {
    process.env.PRISM_HANDOFF_SYNC = '1';
    const relay = makeRelay();
    expect((await pushHandoff('proj-a', HANDOFF, relay.fetchImpl)).pushed).toBe(true);
    const r = await pullHandoff('proj-a', relay.fetchImpl);
    expect(r.ok).toBe(true);
    expect(r.payload!.handoff).toEqual(HANDOFF);
    expect(renderPulledHandoff(r)).toContain('THE-HANDOFF-CONTENT-77aa'); // plaintext exists ONLY after local open
  });

  it('a second registered device can open; the blob refuses a device added later', async () => {
    process.env.PRISM_HANDOFF_SYNC = '1';
    const relay = makeRelay();
    // Machine B registers FIRST, so A seals to both.
    const b = otherDevice();
    relay.devices.push({ device_id: b.keyId, public_key: b.b64, label: null, revoked: false });

    expect((await pushHandoff('proj-a', HANDOFF, relay.fetchImpl)).sealed_to).toBe(2);

    // Open as B directly against the sealed envelope the relay holds.
    const { openSealed } = await import('../src/crypto/syncEnvelope.js');
    const stored = relay.blobs.get('proj-a')!;
    const opened = openSealed(stored.envelope as never, b.privateKey, b.raw, 'prism-sync:v1:proj-a:handoff');
    expect(JSON.parse(opened.toString()).handoff).toEqual(HANDOFF);

    // A device that did NOT exist at seal time cannot open.
    const late = otherDevice();
    expect(() => openSealed(stored.envelope as never, late.privateKey, late.raw, 'prism-sync:v1:proj-a:handoff'))
      .toThrow(/not a recipient/);
  });

  it('pull maps the not-a-recipient case to guidance instead of an error dump', async () => {
    process.env.PRISM_HANDOFF_SYNC = '1';
    const relay = makeRelay();
    // Seal ONLY to a foreign device, then pull as this machine.
    const b = otherDevice();
    const { sealFor } = await import('../src/crypto/syncEnvelope.js');
    const envelope = sealFor([b.raw], Buffer.from(JSON.stringify({ v: 1, project: 'proj-a', saved_at: 'x', origin_device_id: b.keyId, handoff: {} })), 'prism-sync:v1:proj-a:handoff');
    relay.blobs.set('proj-a', { envelope, origin_device_id: b.keyId, updated_at: 'now' });

    const r = await pullHandoff('proj-a', relay.fetchImpl);
    expect(r).toMatchObject({ ok: false, reason: 'not_recipient' });
    expect(renderPulledHandoff(r)).toMatch(/sealed before this device joined/);
  });

  it('no blob → clean reason', async () => {
    process.env.PRISM_HANDOFF_SYNC = '1';
    const relay = makeRelay();
    expect((await pullHandoff('proj-a', relay.fetchImpl)).reason).toBe('no_blob');
  });
});

describe('TOFU pinning', () => {
  it('warns with the exact new keyIds on first seal, pins them, and stays quiet after', async () => {
    process.env.PRISM_HANDOFF_SYNC = '1';
    const relay = makeRelay();
    const b = otherDevice();
    relay.devices.push({ device_id: b.keyId, public_key: b.b64, label: null, revoked: false });

    const first = await pushHandoff('proj-a', HANDOFF, relay.fetchImpl);
    expect(first.pushed).toBe(true);
    const self = loadOrCreateDeviceIdentity();
    expect(first.new_devices).toEqual(expect.arrayContaining([b.keyId, self.keyId]));

    const pinFile = join(dir, 'known-sync-devices.json');
    expect(existsSync(pinFile)).toBe(true);
    expect(JSON.parse(readFileSync(pinFile, 'utf8')).device_ids).toEqual(
      expect.arrayContaining([b.keyId, self.keyId]));

    const second = await pushHandoff('proj-a', HANDOFF, relay.fetchImpl);
    expect(second.pushed).toBe(true);
    expect(second.new_devices).toBeUndefined();
  });

  it('does NOT pin when the push fails — the warning must survive to a successful push', async () => {
    process.env.PRISM_HANDOFF_SYNC = '1';
    const relay = makeRelay();
    // Make the blob PUT fail while registration/list succeed.
    const failingFetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/sync/blob') && init?.method === 'PUT') {
        return new Response('{"error":"nope"}', { status: 503 });
      }
      return (relay.fetchImpl as unknown as (u: string, i?: RequestInit) => Promise<Response>)(url, init);
    }) as unknown as typeof fetch;

    const r = await pushHandoff('proj-a', HANDOFF, failingFetch);
    expect(r).toMatchObject({ pushed: false, reason: 'portal_rejected' });
    expect(existsSync(join(dir, 'known-sync-devices.json'))).toBe(false);
  });

  it('surfaces a key-SWAP under a pinned device_id — TOFU keys on the derived kid, not the portal id', async () => {
    // Adversarial review Finding 1 (HIGH): the mitigation must catch a
    // compromised portal that reuses an already-pinned device_id with a
    // swapped public_key. If TOFU trusted the portal's device_id, this seals
    // to the attacker with NO warning. It must instead see a new identity
    // (the kid derived from the swapped key) and warn, and must never seal to
    // the attacker's key silently.
    process.env.PRISM_HANDOFF_SYNC = '1';
    const relay = makeRelay();
    const b = otherDevice();
    relay.devices.push({ device_id: b.keyId, public_key: b.b64, label: null, revoked: false });

    // Push 1: honest list pins {self, B-by-derived-kid}.
    const first = await pushHandoff('proj-a', HANDOFF, relay.fetchImpl);
    expect(first.pushed).toBe(true);

    // Portal is now hostile: same device_id string, attacker's key.
    const attacker = otherDevice();
    relay.devices.length = 0;
    const self = loadOrCreateDeviceIdentity();
    relay.devices.push({ device_id: self.keyId, public_key: self.rawPublicKey.toString('base64'), label: null, revoked: false });
    relay.devices.push({ device_id: b.keyId, public_key: attacker.b64, label: null, revoked: false }); // SWAP

    const second = await pushHandoff('proj-a', HANDOFF, relay.fetchImpl);
    expect(second.pushed).toBe(true);
    // The swapped key is a NEW identity → warned, not silent.
    expect(second.new_devices).toEqual([attacker.keyId]);

    // And the attacker's key WAS among the recipients only as a newly-warned
    // device — the point is the user is told. Confirm the warning names the
    // attacker's derived kid, not B's pinned id.
    expect(second.new_devices).not.toContain(b.keyId);
  });

  it('drops list entries whose asserted device_id ≠ keyIdOf(public_key) is irrelevant — sealing follows the key', async () => {
    // A portal that lies about device_id cannot cause a seal to an unintended
    // identity: TOFU and sealing both use the derived kid, so a mismatched
    // asserted id simply has no effect on either.
    process.env.PRISM_HANDOFF_SYNC = '1';
    const relay = makeRelay();
    const b = otherDevice();
    relay.devices.push({ device_id: 'ffffffffffffffff', public_key: b.b64, label: null, revoked: false }); // wrong id
    const r = await pushHandoff('proj-a', HANDOFF, relay.fetchImpl);
    expect(r.pushed).toBe(true);
    // Warned by B's TRUE derived kid, never the bogus asserted id.
    expect(r.new_devices).toContain(b.keyId);
    expect(r.new_devices).not.toContain('ffffffffffffffff');
  });

  it('revoked devices are excluded from sealing entirely', async () => {
    process.env.PRISM_HANDOFF_SYNC = '1';
    const relay = makeRelay();
    const b = otherDevice();
    relay.devices.push({ device_id: b.keyId, public_key: b.b64, label: null, revoked: true });
    const r = await pushHandoff('proj-a', HANDOFF, relay.fetchImpl);
    expect(r.pushed).toBe(true);
    expect(r.sealed_to).toBe(1); // self only — the revoked device is not a recipient
  });
});
