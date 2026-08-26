/**
 * Sealed envelope for cross-machine sync — the E2E foundation of Phase 2.
 *
 * The local-first contract this enforces: the sync relay stores CIPHERTEXT
 * ONLY. A blob is encrypted to the set of the user's registered DEVICE public
 * keys before it leaves the machine; the server never holds a key that opens
 * anything. That property is what makes "your agent's memory never exists
 * unencrypted off your machines" a statement of architecture rather than of
 * policy, so nothing in this module may weaken it for convenience:
 *
 *   - No shared master secret exists, so nothing secret is ever transported.
 *     Adding a device means publishing its PUBLIC key; each blob carries the
 *     content key wrapped once per recipient device (the age/libsodium
 *     sealed-box model).
 *   - Everything is node:crypto (X25519 + HKDF-SHA256 + AES-256-GCM). No new
 *     dependency: a wasm/native crypto package would widen the supply-chain
 *     surface of an npm-distributed MCP server for zero capability gain.
 *   - Envelopes are versioned and self-describing. v1 is the only version;
 *     opening anything else fails loudly rather than guessing.
 *   - The AAD binds a context string (e.g. "prism-sync:v1:<project>") into the
 *     payload AEAD, so a valid blob replayed under a different project fails
 *     authentication instead of decrypting somewhere it does not belong.
 *
 * Wire shapes are JSON-safe (base64 strings) because blobs travel through the
 * portal API and land in a database column.
 */

import {
    createCipheriv,
    createDecipheriv,
    createHash,
    createPrivateKey,
    createPublicKey,
    diffieHellman,
    generateKeyPairSync,
    hkdfSync,
    randomBytes,
    type KeyObject,
} from "node:crypto";

export const ENVELOPE_VERSION = 1;
export const ENVELOPE_ALG = "x25519-hkdf-sha256+aes-256-gcm";

/** Raw X25519 public keys are exactly 32 bytes. */
const X25519_RAW_LEN = 32;
const GCM_NONCE_LEN = 12;
const GCM_TAG_LEN = 16;
const CEK_LEN = 32;
/** DER prefix for an X25519 SubjectPublicKeyInfo — lets us accept raw 32-byte
 *  keys at the API boundary while node:crypto works with SPKI objects. */
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

export class EnvelopeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "EnvelopeError";
    }
}

export interface EnvelopeRecipient {
    /** Recipient key id — first 16 hex chars of sha256(raw public key). */
    kid: string;
    /** Ephemeral X25519 public key for this recipient, base64 raw 32B. */
    epk: string;
    /** Nonce for the CEK wrap, base64 12B. */
    n: string;
    /** Wrapped content key: AES-256-GCM ciphertext||tag, base64. */
    ck: string;
}

export interface SealedEnvelope {
    v: number;
    alg: string;
    recipients: EnvelopeRecipient[];
    /** Payload nonce, base64 12B. */
    n: string;
    /** Payload ciphertext||tag, base64. */
    ct: string;
    /** Context string bound into the payload AAD. Cleartext BY DESIGN — the
     *  relay routes on it — so it must never contain content. */
    aad: string;
}

/** Key id every party derives identically from the raw public key. */
export function keyIdOf(rawPublicKey: Buffer): string {
    if (rawPublicKey.length !== X25519_RAW_LEN) {
        throw new EnvelopeError(`public key must be ${X25519_RAW_LEN} raw bytes, got ${rawPublicKey.length}`);
    }
    return createHash("sha256").update(rawPublicKey).digest("hex").slice(0, 16);
}

function publicKeyFromRaw(raw: Buffer): KeyObject {
    if (raw.length !== X25519_RAW_LEN) {
        throw new EnvelopeError(`public key must be ${X25519_RAW_LEN} raw bytes, got ${raw.length}`);
    }
    return createPublicKey({
        key: Buffer.concat([X25519_SPKI_PREFIX, raw]),
        format: "der",
        type: "spki",
    });
}

export function rawFromPublicKey(key: KeyObject): Buffer {
    const der = key.export({ format: "der", type: "spki" }) as Buffer;
    const raw = der.subarray(der.length - X25519_RAW_LEN);
    if (der.length < X25519_RAW_LEN || raw.length !== X25519_RAW_LEN) {
        throw new EnvelopeError("could not extract raw X25519 key from SPKI");
    }
    return Buffer.from(raw);
}

/**
 * KEK derivation. The salt commits to BOTH public keys so a key confusion
 * between recipients (or a swapped ephemeral) derives a different KEK and the
 * GCM unwrap fails authentication instead of silently decrypting.
 */
function deriveKek(shared: Buffer, ephemeralRaw: Buffer, recipientRaw: Buffer): Buffer {
    const salt = createHash("sha256")
        .update("prism-sync-v1")
        .update(ephemeralRaw)
        .update(recipientRaw)
        .digest();
    return Buffer.from(hkdfSync("sha256", shared, salt, "prism-sync-kek-v1", CEK_LEN));
}

function gcmSeal(key: Buffer, nonce: Buffer, plaintext: Buffer, aad: Buffer): Buffer {
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(aad);
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([ct, cipher.getAuthTag()]);
}

function gcmOpen(key: Buffer, nonce: Buffer, sealed: Buffer, aad: Buffer): Buffer {
    if (sealed.length < GCM_TAG_LEN) throw new EnvelopeError("ciphertext shorter than a GCM tag");
    const ct = sealed.subarray(0, sealed.length - GCM_TAG_LEN);
    const tag = sealed.subarray(sealed.length - GCM_TAG_LEN);
    // Every crypto call sits INSIDE the try. An adversarial review measured
    // that createDecipheriv on a 0-byte IV (base64 is lenient — a relay can
    // set n:"" and Buffer.from decodes it to 0 bytes) threw a raw TypeError
    // from outside the old try, breaking the uniform-EnvelopeError contract.
    try {
        const decipher = createDecipheriv("aes-256-gcm", key, nonce);
        decipher.setAAD(aad);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ct), decipher.final()]);
    } catch {
        // Deliberately indistinguishable: wrong key, tampered ciphertext,
        // malformed nonce, and swapped-context AAD all present identically.
        throw new EnvelopeError("authentication failed");
    }
}

/**
 * Seal `plaintext` for every recipient device.
 *
 * @param recipientRawPublicKeys raw 32-byte X25519 public keys (the shapes
 *   devices publish at registration)
 * @param aadContext cleartext routing context bound into the AEAD, e.g.
 *   "prism-sync:v1:<project>". Opening with a different context fails.
 */
export function sealFor(
    recipientRawPublicKeys: Buffer[],
    plaintext: Buffer,
    aadContext: string,
): SealedEnvelope {
    if (recipientRawPublicKeys.length === 0) {
        throw new EnvelopeError("refusing to seal for zero recipients — the blob would be unopenable");
    }
    if (!aadContext) {
        throw new EnvelopeError("aadContext is required — unbound blobs can be replayed across contexts");
    }
    const cek = randomBytes(CEK_LEN);
    const payloadNonce = randomBytes(GCM_NONCE_LEN);
    const aad = Buffer.from(aadContext, "utf8");
    const ct = gcmSeal(cek, payloadNonce, plaintext, aad);

    const recipients: EnvelopeRecipient[] = recipientRawPublicKeys.map((recipientRaw) => {
        const recipientKey = publicKeyFromRaw(recipientRaw);
        const eph = generateKeyPairSync("x25519");
        const ephRaw = rawFromPublicKey(eph.publicKey);
        const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: recipientKey });
        const kek = deriveKek(shared, ephRaw, recipientRaw);
        const kid = keyIdOf(recipientRaw);
        const wrapNonce = randomBytes(GCM_NONCE_LEN);
        const ck = gcmSeal(kek, wrapNonce, cek, Buffer.from(kid, "utf8"));
        return {
            kid,
            epk: ephRaw.toString("base64"),
            n: wrapNonce.toString("base64"),
            ck: ck.toString("base64"),
        };
    });

    return {
        v: ENVELOPE_VERSION,
        alg: ENVELOPE_ALG,
        recipients,
        n: payloadNonce.toString("base64"),
        ct: ct.toString("base64"),
        aad: aadContext,
    };
}

/**
 * Open an envelope with this device's private key.
 *
 * @param expectedAadContext the context the CALLER expects this blob to belong
 *   to. Passed explicitly rather than read from the envelope: trusting the
 *   attacker-controlled `aad` field would turn the binding into decoration.
 */
export function openSealed(
    envelope: SealedEnvelope,
    devicePrivateKey: KeyObject,
    deviceRawPublicKey: Buffer,
    expectedAadContext: string,
): Buffer {
    if (envelope.v !== ENVELOPE_VERSION) {
        throw new EnvelopeError(`unsupported envelope version ${envelope.v}`);
    }
    if (envelope.alg !== ENVELOPE_ALG) {
        throw new EnvelopeError(`unsupported algorithm ${envelope.alg}`);
    }
    if (envelope.aad !== expectedAadContext) {
        throw new EnvelopeError("envelope context does not match the expected context");
    }
    const ourKid = keyIdOf(deviceRawPublicKey);
    const entry = envelope.recipients.find((r) => r.kid === ourKid);
    if (!entry) {
        throw new EnvelopeError("this device is not a recipient of this envelope");
    }
    const ephRaw = Buffer.from(entry.epk, "base64");
    let shared: Buffer;
    try {
        // Node rejects low-order X25519 points by THROWING a raw OpenSSL
        // error (it never returns an all-zero secret). The epk is
        // relay-controlled, so that throw must collapse to the uniform
        // failure like every other adversarial-input path.
        const ephKey = publicKeyFromRaw(ephRaw);
        shared = diffieHellman({ privateKey: devicePrivateKey, publicKey: ephKey });
    } catch {
        throw new EnvelopeError("authentication failed");
    }
    const kek = deriveKek(shared, ephRaw, deviceRawPublicKey);
    const cek = gcmOpen(kek, Buffer.from(entry.n, "base64"), Buffer.from(entry.ck, "base64"), Buffer.from(ourKid, "utf8"));
    return gcmOpen(cek, Buffer.from(envelope.n, "base64"), Buffer.from(envelope.ct, "base64"), Buffer.from(expectedAadContext, "utf8"));
}

/** More devices than any user has; far below any allocation hazard. */
export const MAX_ENVELOPE_RECIPIENTS = 64;
/** Handoff/ledger blobs are text; 16 MiB of base64 is well past any real one. */
export const MAX_ENVELOPE_CT_CHARS = 16 * 1024 * 1024;

/** Structural validation for envelopes arriving off the wire. Bounds sizes so
 *  a hostile relay cannot make the opener allocate unbounded memory before
 *  any authentication happens. */
export function isSealedEnvelope(value: unknown): value is SealedEnvelope {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const o = value as Record<string, unknown>;
    if (o.v !== ENVELOPE_VERSION || o.alg !== ENVELOPE_ALG) return false;
    if (typeof o.n !== "string" || typeof o.ct !== "string" || typeof o.aad !== "string") return false;
    if (o.n.length > 64 || o.aad.length > 512) return false;
    if (o.ct.length > MAX_ENVELOPE_CT_CHARS) return false;
    if (!Array.isArray(o.recipients) || o.recipients.length === 0) return false;
    if (o.recipients.length > MAX_ENVELOPE_RECIPIENTS) return false;
    return o.recipients.every((r) => {
        if (typeof r !== "object" || r === null) return false;
        const e = r as Record<string, unknown>;
        return typeof e.kid === "string" && e.kid.length <= 32 &&
            typeof e.epk === "string" && e.epk.length <= 64 &&
            typeof e.n === "string" && e.n.length <= 64 &&
            typeof e.ck === "string" && e.ck.length <= 256;
    });
}

/** Re-exported for deviceKeys; not part of the public sealing API. */
export const _internal = { publicKeyFromRaw, createPrivateKey };
