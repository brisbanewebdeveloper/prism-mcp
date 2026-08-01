/**
 * Scholar scrape-target SSRF contract.
 *
 * The URL passed to scrapeArticleLocal comes from search-engine output, so it
 * is attacker-influenceable via SEO poisoning, and a successful fetch is
 * persisted into the memory corpus. The 2026-07-29 review found four working
 * bypasses of the previous string-prefix guard — every one of them is pinned
 * here.
 */
import { describe, expect, it } from 'vitest';
import { assertSafeScrapeTarget, classifyScrapeHost } from '../../src/scholar/freeSearch.js';

function allowed(url: string, devMode = false): boolean {
  try {
    assertSafeScrapeTarget(url, devMode);
    return true;
  } catch {
    return false;
  }
}

describe('scholar scrape-target guard', () => {
  it('blocks the four bypasses the previous prefix guard allowed', () => {
    // Each of these reached the local host under the old check:
    //   [::1]                 — URL.hostname keeps the brackets
    //   127.0.0.2             — only 127.0.0.1 was enumerated
    //   0.0.0.0               — not considered at all
    //   [::ffff:127.0.0.1]    — IPv4-mapped IPv6 was not decoded
    expect(allowed('http://[::1]/')).toBe(false);
    expect(allowed('http://127.0.0.2/')).toBe(false);
    expect(allowed('http://0.0.0.0/')).toBe(false);
    expect(allowed('http://[::ffff:127.0.0.1]/')).toBe(false);
    expect(allowed('http://[::ffff:7f00:1]/')).toBe(false);
  });

  it('blocks the two bypasses the adversarial review found in the fixed guard', () => {
    // A trailing dot is a valid FQDN spelling that Node preserves on named
    // hosts. `localhost.` resolves to 127.0.0.1 and defeated every suffix
    // check at once — .localhost, .internal and .local alike.
    expect(allowed('http://localhost./')).toBe(false);
    expect(allowed('http://app.localhost./')).toBe(false);
    expect(allowed('http://wiki.internal./')).toBe(false);
    expect(allowed('http://printer.local./')).toBe(false);

    // NAT64 (RFC 6052) embeds IPv4 in the low bits of 64:ff9b::/96, so it
    // reaches loopback wherever a NAT64 gateway is routable.
    expect(allowed('http://[64:ff9b::7f00:1]/')).toBe(false);
    expect(allowed('http://[64:ff9b::127.0.0.1]/')).toBe(false);
    expect(allowed('http://[64:ff9b::a00:1]/')).toBe(false);
    expect(allowed('http://[64:ff9b:1::7f00:1]/')).toBe(false);
  });

  it('blocks loopback in every spelling', () => {
    for (const url of [
      'http://127.0.0.1/',
      'http://127.1/',
      'http://127.255.255.254/',
      'http://2130706433/',
      'http://0177.0.0.1/',
      'http://localhost/',
      'http://app.localhost/',
      'https://localhost:3000/dashboard',
    ]) {
      expect(allowed(url), url).toBe(false);
    }
  });

  it('blocks private, link-local, and cloud-metadata ranges', () => {
    for (const url of [
      'http://10.0.0.5/',
      'http://172.16.0.1/',
      'http://172.31.255.255/',
      'http://192.168.1.1/',
      'http://169.254.169.254/latest/meta-data/',  // AWS/GCP metadata
      'http://100.64.0.1/',                        // CGNAT
      'http://198.18.0.1/',                        // benchmarking
      'http://224.0.0.1/',                         // multicast
      'http://[fd00::1]/',                         // IPv6 unique-local
      'http://[fe80::1]/',                         // IPv6 link-local
      'http://wiki.internal/',
      'http://printer.local/',
    ]) {
      expect(allowed(url), url).toBe(false);
    }
  });

  it('blocks non-http protocols', () => {
    for (const url of [
      'file:///etc/passwd',
      'gopher://127.0.0.1/',
      'ftp://example.com/',
      'data:text/html,hi',
      'not a url at all',
    ]) {
      expect(allowed(url), url).toBe(false);
    }
  });

  it('allows ordinary public targets', () => {
    for (const url of [
      'https://example.com/',
      'https://pubmed.ncbi.nlm.nih.gov/12345/',
      'http://eric.ed.gov/?id=ED123',
      'https://8.8.8.8/',
      'https://172.15.0.1/',   // just outside RFC1918
      'https://172.32.0.1/',   // just outside RFC1918
      'https://192.169.0.1/',  // just outside 192.168/16
    ]) {
      expect(allowed(url), url).toBe(true);
    }
  });

  it('lets dev mode reach loopback but never a private network', () => {
    expect(allowed('http://127.0.0.1:3000/', true)).toBe(true);
    expect(allowed('http://localhost:3000/', true)).toBe(true);
    expect(allowed('http://[::1]:3000/', true)).toBe(true);

    // A shared LAN can host other tenants, so RFC1918 stays blocked even here.
    expect(allowed('http://192.168.1.50/', true)).toBe(false);
    expect(allowed('http://10.0.0.5/', true)).toBe(false);
    expect(allowed('http://169.254.169.254/', true)).toBe(false);
  });

  it('classifies hosts with the brackets URL.hostname leaves on IPv6', () => {
    expect(classifyScrapeHost('[::1]')).toBe('loopback');
    expect(classifyScrapeHost('::1')).toBe('loopback');
    expect(classifyScrapeHost('127.0.0.9')).toBe('loopback');
    expect(classifyScrapeHost('0.0.0.0')).toBe('loopback');
    expect(classifyScrapeHost('192.168.0.1')).toBe('private');
    expect(classifyScrapeHost('example.com')).toBe('public');
  });

  it('reports why a target was rejected', () => {
    expect(() => assertSafeScrapeTarget('http://192.168.1.1/', false))
      .toThrow(/private network/i);
    expect(() => assertSafeScrapeTarget('http://127.0.0.1/', false))
      .toThrow(/loopback/i);
    expect(() => assertSafeScrapeTarget('file:///etc/passwd', false))
      .toThrow(/protocol/i);
  });
});
