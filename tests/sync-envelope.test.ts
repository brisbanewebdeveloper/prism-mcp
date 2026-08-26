/**
 * E2E envelope tests — the Phase-2 crypto foundation.
 *
 * The property under test is the local-first contract itself: a sealed blob is
 * opaque to everyone except a listed recipient device, and any tampering —
 * with the ciphertext, the wrapped keys, the recipient list, or the context it
 * is bound to — fails authentication rather than decrypting somewhere wrong.
 * These are the tests that must exist BEFORE any sync feature ships on top.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import {
  sealFor,
  openSealed,
  keyIdOf,
  rawFromPublicKey,
  isSealedEnvelope,
  EnvelopeError,
  ENVELOPE_VERSION,
  type SealedEnvelope,
} from '../src/crypto/syncEnvelope.js';
import { loadOrCreateDeviceIdentity } from '../src/crypto/deviceKeys.js';

const CTX = 'prism-sync:v1:test-project';

function newDevice() {
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  const raw = rawFromPublicKey(publicKey);
  return { privateKey, publicKey, raw, kid: keyIdOf(raw) };
}

describe('sealFor / openSealed', () => {
  it('round-trips for a single recipient', () => {
    const dev = newDevice();
    const plaintext = Buffer.from('handoff: resume from commit abc123, TODO: fix the gate');
    const env = sealFor([dev.raw], plaintext, CTX);
    const out = openSealed(env, dev.privateKey, dev.raw, CTX);
    expect(out.equals(plaintext)).toBe(true);
  });

  it('every listed device can open; an unlisted device cannot', () => {
    const a = newDevice(); const b = newDevice(); const outsider = newDevice();
    const plaintext = Buffer.from('multi-device blob');
    const env = sealFor([a.raw, b.raw], plaintext, CTX);
    expect(openSealed(env, a.privateKey, a.raw, CTX).equals(plaintext)).toBe(true);
    expect(openSealed(env, b.privateKey, b.raw, CTX).equals(plaintext)).toBe(true);
    expect(() => openSealed(env, outsider.privateKey, outsider.raw, CTX))
      .toThrow(/not a recipient/);
  });

  it('the envelope never contains plaintext or the content key', () => {
    // The property the relay depends on: serialize the whole envelope and
    // check the secret is not in it. Catches any future "debug field" slip.
    const dev = newDevice();
    const secret = 'THE-SECRET-HANDOFF-CONTENT-9f8e7d';
    const env = sealFor([dev.raw], Buffer.from(secret), CTX);
    const wire = JSON.stringify(env);
    expect(wire).not.toContain(secret);
    expect(wire).not.toContain(Buffer.from(secret).toString('base64'));
  });

  it('a device key that merely SHARES the kid cannot open (kid is routing, not auth)', () => {
    // Forge a recipient entry pointing at our kid but wrapped for someone
    // else: the unwrap must fail authentication, proving the kid lookup is
    // convenience and the DH+GCM is what actually gates access.
    const a = newDevice(); const b = newDevice();
    const env = sealFor([a.raw], Buffer.from('x'), CTX);
    const forged: SealedEnvelope = {
      ...env,
      recipients: [{ ...env.recipients[0]!, kid: keyIdOf(b.raw) }],
    };
    expect(() => openSealed(forged, b.privateKey, b.raw, CTX)).toThrow(EnvelopeError);
  });
});

describe('tamper resistance', () => {
  const dev = newDevice();
  const plaintext = Buffer.from('tamper-target');

  function flipByteInB64(b64: string, at = 0): string {
    const buf = Buffer.from(b64, 'base64');
    buf[at] = buf[at]! ^ 0xff;
    return buf.toString('base64');
  }

  it('rejects tampered payload ciphertext', () => {
    const env = sealFor([dev.raw], plaintext, CTX);
    env.ct = flipByteInB64(env.ct);
    expect(() => openSealed(env, dev.privateKey, dev.raw, CTX)).toThrow(/authentication failed/);
  });

  it('rejects a tampered wrapped key', () => {
    const env = sealFor([dev.raw], plaintext, CTX);
    env.recipients[0]!.ck = flipByteInB64(env.recipients[0]!.ck);
    expect(() => openSealed(env, dev.privateKey, dev.raw, CTX)).toThrow(/authentication failed/);
  });

  it('rejects a swapped ephemeral key', () => {
    const env = sealFor([dev.raw], plaintext, CTX);
    const other = sealFor([dev.raw], plaintext, CTX);
    env.recipients[0]!.epk = other.recipients[0]!.epk;
    expect(() => openSealed(env, dev.privateKey, dev.raw, CTX)).toThrow(/authentication failed/);
  });

  it('rejects a blob replayed under a different context, even with a lying aad field', () => {
    // The attack the AAD exists for: take a valid blob from project A and
    // present it as project B. Overwriting the envelope's own aad field must
    // not help — the caller's expected context is what the AEAD is checked
    // against, not the attacker-controlled field.
    const env = sealFor([dev.raw], plaintext, 'prism-sync:v1:project-a');
    expect(() => openSealed(env, dev.privateKey, dev.raw, 'prism-sync:v1:project-b'))
      .toThrow(/context does not match/);
    const lying = { ...env, aad: 'prism-sync:v1:project-b' };
    expect(() => openSealed(lying, dev.privateKey, dev.raw, 'prism-sync:v1:project-b'))
      .toThrow(/authentication failed/);
  });

  it('rejects unknown versions and algorithms instead of guessing', () => {
    const env = sealFor([dev.raw], plaintext, CTX);
    expect(() => openSealed({ ...env, v: 2 }, dev.privateKey, dev.raw, CTX)).toThrow(/version/);
    expect(() => openSealed({ ...env, alg: 'rot13' }, dev.privateKey, dev.raw, CTX)).toThrow(/algorithm/);
  });
});

describe('sealing preconditions', () => {
  it('refuses zero recipients — the blob would be unopenable forever', () => {
    expect(() => sealFor([], Buffer.from('x'), CTX)).toThrow(/zero recipients/);
  });

  it('refuses an empty context — unbound blobs can be replayed anywhere', () => {
    const dev = newDevice();
    expect(() => sealFor([dev.raw], Buffer.from('x'), '')).toThrow(/aadContext/);
  });

  it('refuses malformed public keys', () => {
    expect(() => sealFor([Buffer.alloc(31)], Buffer.from('x'), CTX)).toThrow(/32 raw bytes/);
  });

  it('fresh randomness per seal: same input never yields the same wire bytes', () => {
    const dev = newDevice();
    const a = sealFor([dev.raw], Buffer.from('same'), CTX);
    const b = sealFor([dev.raw], Buffer.from('same'), CTX);
    expect(a.ct).not.toBe(b.ct);
    expect(a.n).not.toBe(b.n);
    expect(a.recipients[0]!.epk).not.toBe(b.recipients[0]!.epk);
  });
});

describe('isSealedEnvelope (wire validation)', () => {
  it('accepts a real envelope and rejects structural garbage', () => {
    const dev = newDevice();
    const env = sealFor([dev.raw], Buffer.from('x'), CTX);
    expect(isSealedEnvelope(env)).toBe(true);
    expect(isSealedEnvelope(JSON.parse(JSON.stringify(env)))).toBe(true);
    expect(isSealedEnvelope(null)).toBe(false);
    expect(isSealedEnvelope({})).toBe(false);
    expect(isSealedEnvelope({ ...env, recipients: [] })).toBe(false);
    expect(isSealedEnvelope({ ...env, v: 99 })).toBe(false);
    expect(isSealedEnvelope({ ...env, ct: 42 })).toBe(false);
  });
});

describe('device identity', () => {
  let dir: string;
  const prevDataDir = process.env.PRISM_DATA_DIR;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'device-key-'));
    process.env.PRISM_DATA_DIR = dir;
  });

  afterEach(async () => {
    if (prevDataDir === undefined) delete process.env.PRISM_DATA_DIR;
    else process.env.PRISM_DATA_DIR = prevDataDir;
    await rm(dir, { recursive: true, force: true });
  });

  it('creates on first use, is stable afterwards, and interoperates with sealing', () => {
    const first = loadOrCreateDeviceIdentity();
    expect(first.created).toBe(true);
    const second = loadOrCreateDeviceIdentity();
    expect(second.created).toBe(false);
    expect(second.keyId).toBe(first.keyId);

    const env = sealFor([second.rawPublicKey], Buffer.from('to-this-device'), CTX);
    expect(openSealed(env, second.privateKey, second.rawPublicKey, CTX).toString()).toBe('to-this-device');
  });

  it('writes the private key with 0600 permissions', () => {
    loadOrCreateDeviceIdentity();
    const mode = statSync(join(dir, 'sync-device-key.pem')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('the key file never contains anything but the private key PEM', () => {
    const id = loadOrCreateDeviceIdentity();
    const pem = readFileSync(join(dir, 'sync-device-key.pem'), 'utf8');
    expect(pem).toMatch(/BEGIN PRIVATE KEY/);
    // And the PUBLIC raw key is derivable, so nothing else needs storing.
    expect(id.rawPublicKey.length).toBe(32);
  });

  it('refuses to silently rotate a corrupt existing key', () => {
    loadOrCreateDeviceIdentity();
    writeFileSync(join(dir, 'sync-device-key.pem'), 'not a key', { mode: 0o600 });
    expect(() => loadOrCreateDeviceIdentity()).toThrow(/refusing to rotate/);
  });

  it('rejects a non-x25519 key planted at the path', () => {
    loadOrCreateDeviceIdentity();
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    writeFileSync(join(dir, 'sync-device-key.pem'),
      rsa.privateKey.export({ format: 'pem', type: 'pkcs8' }) as string, { mode: 0o600 });
    expect(() => loadOrCreateDeviceIdentity()).toThrow(/expected x25519/);
  });

  it('version constant is pinned so envelope evolution is deliberate', () => {
    expect(ENVELOPE_VERSION).toBe(1);
  });
});
