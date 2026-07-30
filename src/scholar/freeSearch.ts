import * as cheerio from 'cheerio';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';

export interface FreeSearchResult {
    title: string;
    url: string;
    snippet: string;
}

export interface LocalArticle {
    title: string;
    content: string; // Markdown content
    excerpt?: string;
    byline?: string;
}

/**
 * Searches Yahoo Web Search and parses the HTML results using Cheerio.
 * Yahoo provides a reliable HTML fallback that does not block basic automated browser requests.
 */
export async function searchYahooFree(query: string, limit: number = 5): Promise<FreeSearchResult[]> {
    const searchUrl = `https://search.yahoo.com/search?p=${encodeURIComponent(query)}`;

    const response = await fetch(searchUrl, {
        method: 'GET',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
        throw new Error(`Yahoo Search failed with status: ${response.status}`);
    }

    const html = await response.text();
    const $ = cheerio.load(html);
    const results: FreeSearchResult[] = [];

    $('.algo').each((_, elem) => {
        if (results.length >= limit) return false;

        const rawUrl = $(elem).find('a').attr('href') || '';
        let url = rawUrl;
        
        // Yahoo wraps outbound links in a redirector. Decode the actual target URL.
        if (rawUrl.includes('/RU=')) {
            const afterRu = rawUrl.split('/RU=')[1];
            if (afterRu) {
                const targetUrl = afterRu.split('/RK=')[0];
                url = decodeURIComponent(targetUrl);
            }
        }

        const title = $(elem).find('h3').text().trim();
        const snippet = $(elem).find('.compText').text().trim();

        if (url && title) {
            results.push({ title, url, snippet });
        }
    });

    return results;
}

/**
 * Fetches an article's HTML, extracts clean content via Readability, 
 * and converts it to Markdown using Turndown.
 */
/** Classification of a scrape target's host. */
export type HostClass = 'public' | 'loopback' | 'private';

function classifyIPv4(octets: number[]): HostClass {
    const [a, b] = octets;
    if (a === 127) return 'loopback';          // 127.0.0.0/8 — not just 127.0.0.1
    if (a === 0) return 'loopback';            // 0.0.0.0/8 routes to the local host
    if (a === 10) return 'private';            // RFC1918
    if (a === 172 && b >= 16 && b <= 31) return 'private';
    if (a === 192 && b === 168) return 'private';
    if (a === 169 && b === 254) return 'private'; // link-local + cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return 'private'; // CGNAT
    if (a === 192 && b === 0) return 'private';   // IETF protocol assignments
    if (a === 198 && (b === 18 || b === 19)) return 'private'; // benchmarking
    if (a >= 224) return 'private';            // multicast + reserved
    return 'public';
}

function parseIPv4(host: string): number[] | null {
    const parts = host.split('.');
    if (parts.length !== 4) return null;
    const octets: number[] = [];
    for (const part of parts) {
        if (!/^\d{1,3}$/.test(part)) return null;
        const value = Number(part);
        if (value > 255) return null;
        octets.push(value);
    }
    return octets;
}

/**
 * Classify a URL's host.
 *
 * Exported so the bypass table can be asserted directly. String-prefix checks
 * are not sufficient here: `URL.hostname` keeps the brackets on IPv6 literals,
 * 127.0.0.0/8 is far wider than 127.0.0.1, and 0.0.0.0 and IPv4-mapped IPv6
 * both reach the local host.
 */
export function classifyScrapeHost(rawHost: string): HostClass {
    // URL.hostname returns IPv6 literals bracketed — strip the brackets. Node
    // keeps a trailing '.' on named hosts (localhost. still resolves to
    // 127.0.0.1), and that dot otherwise defeats every suffix check below.
    const host = rawHost.toLowerCase()
        .replace(/^\[|\]$/g, '')
        .replace(/\.+$/, '');

    if (host === 'localhost' || host.endsWith('.localhost')) return 'loopback';
    if (host.endsWith('.internal') || host.endsWith('.local')) return 'private';

    const ipv4 = parseIPv4(host);
    if (ipv4) return classifyIPv4(ipv4);

    if (host.includes(':')) {
        if (host === '::1') return 'loopback';
        if (host === '::' ) return 'loopback';

        // Prefixes that carry an IPv4 address in their low 32 bits. Node
        // rewrites ::ffff:127.0.0.1 to ::ffff:7f00:1, so both the dotted and
        // hex-pair spellings have to decode.
        const embedding = /^(?:::ffff|64:ff9b(?::1)?::?)[:]?(.+)$/.exec(host);
        if (embedding) {
            const suffix = embedding[1];
            const dotted = parseIPv4(suffix);
            if (dotted) return classifyIPv4(dotted);
            const hexPair = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(suffix);
            if (hexPair) {
                const high = parseInt(hexPair[1], 16);
                const low = parseInt(hexPair[2], 16);
                return classifyIPv4([high >> 8, high & 0xff, low >> 8, low & 0xff]);
            }
            // Reserved translation prefix with an undecodable tail — not public.
            return 'private';
        }
        if (/^64:ff9b:/.test(host)) return 'private';           // NAT64 (RFC 6052/8215)
        if (/^f[cd][0-9a-f]{2}:/.test(host)) return 'private';  // fc00::/7 unique-local
        if (/^fe[89ab][0-9a-f]:/.test(host)) return 'private';  // fe80::/10 link-local
        return 'public';
    }

    return 'public';
}

/**
 * Reject scrape targets that point at the local host or an internal network.
 *
 * The URL reaching here comes from search-engine output, so it is
 * attacker-influenceable via SEO poisoning. A successful fetch would be
 * persisted into the memory corpus, so this fails closed.
 */
export function assertSafeScrapeTarget(url: string, devMode: boolean): void {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw new Error('Invalid URL: could not be parsed');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new Error(`Invalid URL: protocol ${parsed.protocol} is not allowed`);
    }
    const hostClass = classifyScrapeHost(parsed.hostname);
    if (hostClass === 'private') {
        // Never allowed, even in dev mode: on a shared LAN these can reach
        // other machines, and 169.254.169.254 is cloud metadata.
        throw new Error('Invalid URL: private network URLs not allowed');
    }
    if (hostClass === 'loopback' && !devMode) {
        throw new Error('Invalid URL: loopback URLs not allowed in production (set PRISM_DEV_MODE=1 to allow)');
    }
}

export async function scrapeArticleLocal(url: string): Promise<LocalArticle> {
    // SSRF protection: reject private/internal URLs.
    // Set PRISM_DEV_MODE=1 to allow loopback hosts during local dev (testing
    // against a local docs server, internal wiki, etc.). The flag is
    // intentionally OFF in production deploys.
    const devMode = process.env.PRISM_DEV_MODE === '1' || process.env.NODE_ENV === 'development';
    assertSafeScrapeTarget(url, devMode);

    const response = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
        throw new Error(`Failed to fetch article HTML: ${response.statusText}`);
    }

    const html = await response.text();
    
    // Create a virtual DOM for Readability to traverse
    const doc = new JSDOM(html, { url });
    
    // Extract the article content like Firefox Reader View
    const reader = new Readability(doc.window.document as unknown as Document);
    const article = reader.parse();

    if (!article) {
        throw new Error("Readability could not parse the article content.");
    }

    // Convert the cleaned HTML to Markdown
    const turndownService = new TurndownService({
        headingStyle: 'atx',
        codeBlockStyle: 'fenced'
    });
    const markdown = turndownService.turndown(article.content || '');

    return {
        title: article.title || 'Unknown Title',
        content: markdown,
        excerpt: article.excerpt || undefined,
        byline: article.byline || undefined
    };
}
