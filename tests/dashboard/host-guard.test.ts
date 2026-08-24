/**
 * DNS-rebinding Host/Origin guard for the Mind Palace dashboard.
 *
 * GHSA-9cvx-7x8q-3g6m: with auth disabled by default and no Host/Origin check,
 * a DNS-rebound browser reached the loopback dashboard carrying an attacker
 * Host/Origin and read/exported the developer's whole session memory. The
 * existing dashboard suites only exercise the happy path (loopback requests),
 * so the reject branch that closes the vuln was never asserted. These cases pin
 * it directly, mirroring the negative-branch coverage added for the two July
 * advisories.
 */
import { describe, expect, it } from "vitest";
import {
  isTrustedHost,
  isTrustedOrigin,
  isTrustedRequest,
  isRebindGuardedPath,
} from "../../src/dashboard/hostGuard.js";

const NO_ORIGIN = {}; // default install: auth off, no operator origin configured

describe("dashboard DNS-rebinding host guard (GHSA-9cvx-7x8q-3g6m)", () => {
  it.each([
    "localhost:3000",
    "localhost",
    "127.0.0.1:3000",
    "127.0.0.1",
    "[::1]:3000",
    "[::1]",
    "localhost:3001", // bound-port fallback (PORT+1 on conflict) must stay trusted
    "localhost:8089", // the port used in the advisory PoC
  ])("trusts the loopback Host %s on any port", (host) => {
    expect(isTrustedHost(host, NO_ORIGIN)).toBe(true);
  });

  it.each([
    "attacker.example:3000",
    "attacker.example",
    "prism.attacker.test",
    "169.254.169.254", // cloud metadata
    "evil.localhost.attacker.com", // substring 'localhost' must not leak
    "127.0.0.1.attacker.com", // substring '127.0.0.1' must not leak
  ])("rejects the forged Host %s", (host) => {
    expect(isTrustedHost(host, NO_ORIGIN)).toBe(false);
  });

  it("rejects a missing Host header", () => {
    expect(isTrustedHost(undefined, NO_ORIGIN)).toBe(false);
  });

  it("trusts only the operator-configured origin host, not look-alikes", () => {
    const cfg = { configuredOrigin: "https://prism.team.example" };
    expect(isTrustedHost("prism.team.example", cfg)).toBe(true);
    expect(isTrustedHost("prism.team.example:443", cfg)).toBe(true);
    expect(isTrustedHost("prism.team.example.attacker.com", cfg)).toBe(false);
    expect(isTrustedHost("attacker.example", cfg)).toBe(false);
  });

  describe("Origin header", () => {
    it("defers to the Host check when Origin is absent", () => {
      expect(isTrustedOrigin(undefined, NO_ORIGIN)).toBe(true);
    });

    it("trusts a loopback Origin", () => {
      expect(isTrustedOrigin("http://localhost:3000", NO_ORIGIN)).toBe(true);
    });

    it.each([
      "http://attacker.example:3000",
      "null", // sandboxed / opaque origin
      "http://127.0.0.1.attacker.com",
    ])("rejects the forged or opaque Origin %s", (origin) => {
      expect(isTrustedOrigin(origin, NO_ORIGIN)).toBe(false);
    });
  });

  describe("combined request gate", () => {
    it("serves a legitimate same-origin dashboard request", () => {
      expect(
        isTrustedRequest({ host: "localhost:3000", origin: "http://localhost:3000" }, NO_ORIGIN),
      ).toBe(true);
    });

    it("blocks the exact DNS-rebinding request shape from the advisory PoC", () => {
      // GET /api/settings  Host: attacker.example:8089  Origin: http://attacker.example:8089
      expect(
        isTrustedRequest(
          { host: "attacker.example:8089", origin: "http://attacker.example:8089" },
          NO_ORIGIN,
        ),
      ).toBe(false);
    });

    it("blocks a rebound Host even when the Origin header is stripped", () => {
      expect(isTrustedRequest({ host: "attacker.example:3000" }, NO_ORIGIN)).toBe(false);
    });

    it("blocks a loopback Host paired with a forged Origin", () => {
      // A rebound page cannot forge both to loopback, but pin the AND semantics.
      expect(
        isTrustedRequest(
          { host: "127.0.0.1:3000", origin: "http://attacker.example:3000" },
          NO_ORIGIN,
        ),
      ).toBe(false);
    });
  });

  // The guard's route scoping must match the router's NORMALIZED pathname, or a
  // dot-segment path slips past a raw-string prefix check while the router still
  // serves the data. This class was a live bypass caught in adversarial review:
  // `--path-as-is /x/../api/settings` with a forged Host returned 200 + settings.
  describe("guarded-route scoping (path normalization)", () => {
    it.each([
      "/api/settings",
      "/api/project?name=x",
      "/api/export/vault?project=x",
      "/sse",
      "/messages",
      "/messages?sessionId=x",
      "/x/../api/settings", // dot-segment collapses to /api/settings — the bypass
      "/api/../api/export/vault",
      "/./api/project",
      "/x/..\\api/settings", // backslash is normalized to a slash for http URLs
      "/sse/../sse",
    ])("guards the sensitive target %s", (target) => {
      expect(isRebindGuardedPath(target)).toBe(true);
    });

    it.each([
      "/",
      "/index.html",
      "/manifest.json",
      "/sw.js",
      "/offline.html",
      "/icon-192.svg",
      "/apple-touch-icon.png",
      "/.well-known/mcp/server-card.json", // public Smithery manifest — no session data
      "/SSE", // routes are case-sensitive; router won't serve this either
      "//api/settings", // protocol-relative → pathname is /settings, no /api route
      "/api%2fsettings", // %2f stays encoded; matches no /api/* route
    ])("leaves the public/non-data target %s out of scope", (target) => {
      expect(isRebindGuardedPath(target)).toBe(false);
    });

    it("fails closed on an unparseable request target", () => {
      // If the path can't be parsed we cannot prove it is public, so guard it.
      expect(isRebindGuardedPath("http://[")).toBe(true);
    });
  });
});
