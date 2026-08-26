/**
 * Host / Origin allow-listing for the Mind Palace dashboard.
 *
 * GHSA-9cvx-7x8q-3g6m: the dashboard auto-starts on every MCP boot, binds
 * loopback, and by default runs with auth disabled. Loopback binding does NOT
 * stop DNS rebinding — a page the developer merely visits can rebind its own
 * hostname to 127.0.0.1 and reach this server as "same-origin", carrying an
 * attacker-chosen Host/Origin. The server must therefore reject any request
 * whose Host (or, when present, Origin) is not a trusted local name or the
 * operator-configured public origin, BEFORE any route runs and independent of
 * whether auth is configured. This mirrors the standard fix for the class
 * (Host-header validation, cf. CVE-2025-10193).
 *
 * Matching by hostname only (port-agnostic) is deliberate and safe: the attack
 * requires an attacker-controlled *name*, so `localhost` / `127.0.0.1` / `[::1]`
 * are trustworthy on any port — which also keeps the guard correct when the
 * server falls back to PORT+1/PORT+2 on an address-in-use conflict.
 */

export interface HostGuardConfig {
  /** Operator-configured public origin, e.g. https://prism.team.example. */
  configuredOrigin?: string;
}

/** Loopback host names browsers use for the local dashboard. Exact match only. */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Lowercased hostname (never the port) of a Host authority (`host[:port]`) or a
 * full Origin URL. Returns null when the value cannot be parsed — a malformed or
 * opaque value (e.g. the literal `null` Origin) is never trusted.
 */
function hostnameOf(value: string, asUrl = false): string | null {
  try {
    const u = asUrl ? new URL(value) : new URL(`http://${value}`);
    return u.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** The set of hostnames that may be served: loopback + configured origin. */
function trustedHostnames(cfg: HostGuardConfig): Set<string> {
  const names = new Set(LOOPBACK_HOSTNAMES);
  if (cfg.configuredOrigin) {
    const h = hostnameOf(cfg.configuredOrigin, true);
    if (h) names.add(h);
  }
  return names;
}

/**
 * True when a request target addresses a sensitive dashboard route — the memory
 * API (`/api/*`) or the MCP HTTP transport (`/sse`, `/messages`) — and must
 * therefore pass the Host/Origin gate.
 *
 * Scoping MUST use the same normalized pathname the router resolves, or a
 * dot-segment target like `/x/../api/settings` slips past a raw-string prefix
 * check while the router still collapses it to `/api/settings` and serves the
 * data. A fixed base keeps this independent of the attacker-supplied Host; an
 * unparseable target is treated as guarded (fail closed). Public routes (the
 * static shell, PWA assets, the Smithery manifest) carry no session data and
 * are intentionally out of scope.
 */
export function isRebindGuardedPath(requestTarget: string | undefined): boolean {
  let pathname: string;
  try {
    pathname = new URL(requestTarget || "/", "http://prism-dashboard.invalid").pathname;
  } catch {
    return true; // unparseable target → fail closed
  }
  return pathname.startsWith("/api/") || pathname === "/sse" || pathname === "/messages";
}

/** True when the HTTP Host header names a trusted local or configured host. */
export function isTrustedHost(hostHeader: string | undefined, cfg: HostGuardConfig): boolean {
  if (!hostHeader) return false; // HTTP/1.1 requires Host; absence is not trusted.
  const name = hostnameOf(hostHeader);
  return name !== null && trustedHostnames(cfg).has(name);
}

/**
 * True when the Origin header (if the request carries one) is trusted. A request
 * with no Origin — a top-level navigation or a non-CORS GET — is not rejected on
 * Origin grounds; the Host check is the load-bearing gate there.
 */
export function isTrustedOrigin(originHeader: string | undefined, cfg: HostGuardConfig): boolean {
  if (!originHeader) return true; // absent Origin defers to the Host check
  const name = hostnameOf(originHeader, true);
  return name !== null && trustedHostnames(cfg).has(name);
}

/**
 * Combined DNS-rebinding gate: the request must pass BOTH the Host and the
 * (when present) Origin check. Call this before serving any sensitive route.
 */
export function isTrustedRequest(
  headers: { host?: string; origin?: string },
  cfg: HostGuardConfig,
): boolean {
  return isTrustedHost(headers.host, cfg) && isTrustedOrigin(headers.origin, cfg);
}
