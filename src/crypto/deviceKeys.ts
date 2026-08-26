/**
 * Device identity for E2E sync — one X25519 keypair per machine.
 *
 * The private key is generated here, written with 0600 permissions, and NEVER
 * leaves this machine — not to the portal, not into a blob, not into logs.
 * Only the PUBLIC key is published (at device registration) so other devices
 * can seal envelopes to it. Losing the file means this device can no longer
 * open blobs sealed to it; that is the designed failure mode, strictly better
 * than any recovery path that would require the key to exist somewhere else.
 *
 * Storage: <dataDir>/sync-device-key.pem (PKCS8 PEM), alongside the config DB.
 * Resolution mirrors the ledger's: PRISM_DATA_DIR (test sandbox / relocation)
 * else ~/.prism-mcp. Tests must never touch a real device key.
 */

import {
    createPrivateKey,
    createPublicKey,
    generateKeyPairSync,
    type KeyObject,
} from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { keyIdOf, rawFromPublicKey, EnvelopeError } from "./syncEnvelope.js";

const KEY_FILENAME = "sync-device-key.pem";

function keyPath(): string {
    const dir = process.env.PRISM_DATA_DIR
        ? resolve(process.env.PRISM_DATA_DIR)
        : resolve(homedir(), ".prism-mcp");
    return resolve(dir, KEY_FILENAME);
}

export interface DeviceIdentity {
    privateKey: KeyObject;
    publicKey: KeyObject;
    /** Raw 32-byte public key — the shape published at registration. */
    rawPublicKey: Buffer;
    /** Stable id other parties derive from the public key. */
    keyId: string;
    /** True when this call created the key (first run on this machine). */
    created: boolean;
}

/**
 * Load this machine's device key, creating it on first use.
 *
 * Never overwrites: an existing file is authoritative even if unreadable as a
 * key — failing loudly beats silently rotating an identity that other devices
 * have already sealed blobs to.
 */
export function loadOrCreateDeviceIdentity(): DeviceIdentity {
    const path = keyPath();
    if (existsSync(path)) {
        let privateKey: KeyObject;
        try {
            privateKey = createPrivateKey(readFileSync(path, "utf8"));
        } catch (e) {
            throw new EnvelopeError(
                `device key at ${path} exists but cannot be parsed — refusing to rotate an established ` +
                `identity automatically (${e instanceof Error ? e.message : e})`);
        }
        if (privateKey.asymmetricKeyType !== "x25519") {
            throw new EnvelopeError(`device key at ${path} is ${privateKey.asymmetricKeyType}, expected x25519`);
        }
        const publicKey = createPublicKey(privateKey);
        const rawPublicKey = rawFromPublicKey(publicKey);
        return { privateKey, publicKey, rawPublicKey, keyId: keyIdOf(rawPublicKey), created: false };
    }

    const { privateKey, publicKey } = generateKeyPairSync("x25519");
    const pem = privateKey.export({ format: "pem", type: "pkcs8" }) as string;
    const dir = resolve(path, "..");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Write then chmod: writeFileSync's mode is masked by umask, and a device
    // key readable by group/other for even a moment is a defect.
    writeFileSync(path, pem, { mode: 0o600 });
    chmodSync(path, 0o600);
    const rawPublicKey = rawFromPublicKey(publicKey);
    return { privateKey, publicKey, rawPublicKey, keyId: keyIdOf(rawPublicKey), created: true };
}
