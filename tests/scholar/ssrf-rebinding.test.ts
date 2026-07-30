/**
 * DNS-rebinding contract for scholar scrape targets.
 *
 * The hostname checks in ssrf-guard.test.ts only inspect the string, so a
 * name the attacker controls passes them and can still resolve to a local
 * address. These cases pin the resolve-then-validate step that closes it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const lookupMock = vi.hoisted(() => vi.fn());

vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns')>();
  return { ...actual, default: actual, lookup: lookupMock };
});

const { resolveAndValidateHost } = await import('../../src/scholar/freeSearch.js');

/** Answer a lookup with the given addresses, callback-style. */
function resolvesTo(...addresses: { address: string; family: number }[]) {
  lookupMock.mockImplementation((_host: string, _opts: unknown, cb: Function) => {
    cb(null, addresses);
  });
}

function fails(code = 'ENOTFOUND') {
  lookupMock.mockImplementation((_host: string, _opts: unknown, cb: Function) => {
    cb(Object.assign(new Error(code), { code }));
  });
}

const v4 = (address: string) => ({ address, family: 4 });
const v6 = (address: string) => ({ address, family: 6 });

describe('scholar DNS-rebinding guard', () => {
  beforeEach(() => {
    lookupMock.mockReset();
  });

  it('rejects a public hostname that resolves to loopback', async () => {
    // The exact attack: the name is legitimately public and passes every
    // string check, but the A record points at the local machine.
    resolvesTo(v4('127.0.0.1'));
    await expect(resolveAndValidateHost('research-paper.example', false))
      .rejects.toThrow(/loopback address \(127\.0\.0\.1\)/);
  });

  it('rejects a public hostname that resolves into a private network', async () => {
    resolvesTo(v4('192.168.1.50'));
    await expect(resolveAndValidateHost('cdn.example', false))
      .rejects.toThrow(/private address \(192\.168\.1\.50\)/);
  });

  it('rejects cloud-metadata and IPv6 loopback answers', async () => {
    resolvesTo(v4('169.254.169.254'));
    await expect(resolveAndValidateHost('metadata.example', false))
      .rejects.toThrow(/private address/);

    resolvesTo(v6('::1'));
    await expect(resolveAndValidateHost('six.example', false))
      .rejects.toThrow(/loopback address/);
  });

  it('rejects when ANY answer is local, not just the first', async () => {
    // A mixed answer set is the rebinding shape itself. Connecting to the
    // public one would make the attack racy rather than blocked.
    resolvesTo(v4('93.184.216.34'), v4('127.0.0.1'));
    await expect(resolveAndValidateHost('mixed.example', false))
      .rejects.toThrow(/loopback address/);

    resolvesTo(v4('93.184.216.34'), v4('10.1.2.3'));
    await expect(resolveAndValidateHost('mixed2.example', false))
      .rejects.toThrow(/private address/);
  });

  it('returns every answer when all are public, preserving dual-stack fallback', async () => {
    // All of them are validated, so handing back the full set lets Node's
    // autoSelectFamily fall back when the leading address is unreachable.
    resolvesTo(v6('2606:4700::1111'), v4('93.184.216.34'));
    await expect(resolveAndValidateHost('example.com', false))
      .resolves.toEqual([
        { address: '2606:4700::1111', family: 6 },
        { address: '93.184.216.34', family: 4 },
      ]);
  });

  it('fails closed when the name does not resolve or answers empty', async () => {
    fails();
    await expect(resolveAndValidateHost('nx.example', false))
      .rejects.toThrow(/could not resolve/);

    resolvesTo();
    await expect(resolveAndValidateHost('empty.example', false))
      .rejects.toThrow(/no addresses/);
  });

  it('does not resolve a literal address', async () => {
    // assertSafeScrapeTarget already ruled on literals; a lookup here would
    // be a pointless round trip and a second chance to be poisoned.
    await expect(resolveAndValidateHost('93.184.216.34', false))
      .resolves.toEqual([{ address: '93.184.216.34', family: 4 }]);
    await expect(resolveAndValidateHost('[2606:4700::1111]', false))
      .resolves.toEqual([{ address: '2606:4700::1111', family: 6 }]);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('lets dev mode reach a loopback answer but never a private one', async () => {
    resolvesTo(v4('127.0.0.1'));
    await expect(resolveAndValidateHost('local.test', true))
      .resolves.toEqual([{ address: '127.0.0.1', family: 4 }]);

    resolvesTo(v4('192.168.1.50'));
    await expect(resolveAndValidateHost('lan.test', true))
      .rejects.toThrow(/private address/);
  });
});
