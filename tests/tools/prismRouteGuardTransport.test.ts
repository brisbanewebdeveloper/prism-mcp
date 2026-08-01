/**
 * Synalux route-guard transport contract.
 *
 * The route guard is optional and its response is still validated locally,
 * but authenticated paid callers must get a bounded, one-retry HTTP path.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
    PORTAL,
    mockGetSynaluxJwt,
    mockInvalidateSynaluxJwt,
} = vi.hoisted(() => ({
    PORTAL: "https://portal.test",
    mockGetSynaluxJwt: vi.fn<() => Promise<string | null>>(),
    mockInvalidateSynaluxJwt: vi.fn(),
}));

vi.mock("../../src/config.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../src/config.js")>();
    return {
        ...actual,
        PRISM_SYNALUX_BASE_URL: PORTAL,
        SYNALUX_CONFIGURED: true,
    };
});

vi.mock("../../src/utils/synaluxJwt.js", () => ({
    getSynaluxJwt: mockGetSynaluxJwt,
    invalidateSynaluxJwt: mockInvalidateSynaluxJwt,
}));

import { callSynaluxRouteGuard } from "../../src/tools/prismInferHandler.js";

const REQUEST = {
    prompt: "Search my session memory for routing",
    draft: [
        "<|tool_call|>",
        '{"name":"session_search_memory","arguments":{"query":"routing"}}',
        "<|tool_call_end|>",
    ].join("\n"),
    allowedTools: ["session_search_memory"],
};

const OUTCOME = {
    output: REQUEST.draft,
    action: "preserved",
    source: "portal",
    original_tool: "session_search_memory",
    final_tool: "session_search_memory",
};

function response(status: number, body: string): Response {
    return new Response(body, { status });
}

beforeEach(() => {
    vi.clearAllMocks();
    mockGetSynaluxJwt.mockResolvedValue("jwt-current");
    vi.stubGlobal("fetch", vi.fn(async () =>
        response(200, JSON.stringify(OUTCOME))));
});

describe("callSynaluxRouteGuard", () => {
    it("posts the bounded route request with bearer auth and redirect blocking", async () => {
        await expect(callSynaluxRouteGuard(REQUEST)).resolves.toEqual(OUTCOME);

        const fetchMock = vi.mocked(globalThis.fetch);
        expect(fetchMock).toHaveBeenCalledOnce();
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe(`${PORTAL}/api/v1/prism/route-guard`);
        expect(init.method).toBe("POST");
        expect(init.redirect).toBe("error");
        expect(init.signal).toBeInstanceOf(AbortSignal);
        expect(init.headers).toEqual({
            "Authorization": "Bearer jwt-current",
            "Content-Type": "application/json",
        });
        expect(JSON.parse(String(init.body))).toEqual({
            prompt: REQUEST.prompt,
            draft: REQUEST.draft,
            allowed_tools: REQUEST.allowedTools,
        });
    });

    it("invalidates a rejected JWT and retries exactly once with a fresh JWT", async () => {
        mockGetSynaluxJwt
            .mockResolvedValueOnce("jwt-stale")
            .mockResolvedValueOnce("jwt-fresh");
        vi.stubGlobal("fetch", vi.fn()
            .mockResolvedValueOnce(response(401, "{}"))
            .mockResolvedValueOnce(response(200, JSON.stringify(OUTCOME))));

        await expect(callSynaluxRouteGuard(REQUEST)).resolves.toEqual(OUTCOME);
        expect(mockInvalidateSynaluxJwt).toHaveBeenCalledOnce();
        expect(globalThis.fetch).toHaveBeenCalledTimes(2);
        const calls = vi.mocked(globalThis.fetch).mock.calls;
        expect((calls[0][1]?.headers as Record<string, string>).Authorization)
            .toBe("Bearer jwt-stale");
        expect((calls[1][1]?.headers as Record<string, string>).Authorization)
            .toBe("Bearer jwt-fresh");
    });

    it("does not send an unauthenticated request when JWT exchange fails", async () => {
        mockGetSynaluxJwt.mockResolvedValue(null);
        await expect(callSynaluxRouteGuard(REQUEST))
            .rejects.toThrow("jwt_exchange_failed");
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("fails after a 401 when JWT refresh cannot produce a token", async () => {
        mockGetSynaluxJwt
            .mockResolvedValueOnce("jwt-stale")
            .mockResolvedValueOnce(null);
        vi.stubGlobal("fetch", vi.fn(async () => response(401, "{}")));

        await expect(callSynaluxRouteGuard(REQUEST))
            .rejects.toThrow("jwt_refresh_failed");
        expect(mockInvalidateSynaluxJwt).toHaveBeenCalledOnce();
        expect(globalThis.fetch).toHaveBeenCalledOnce();
    });

    it("retries a rejected JWT only once", async () => {
        mockGetSynaluxJwt
            .mockResolvedValueOnce("jwt-stale")
            .mockResolvedValueOnce("jwt-still-rejected");
        vi.stubGlobal("fetch", vi.fn(async () => response(401, "{}")));

        await expect(callSynaluxRouteGuard(REQUEST))
            .rejects.toThrow("synalux_route_guard_http_401");
        expect(mockInvalidateSynaluxJwt).toHaveBeenCalledOnce();
        expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    it("rejects an invalid or oversized request before any network call", async () => {
        for (const invalid of [
            { ...REQUEST, prompt: "" },
            { ...REQUEST, prompt: "p".repeat(32_001) },
            { ...REQUEST, draft: "d".repeat(32_001) },
            { ...REQUEST, allowedTools: ["bad tool name"] },
            { ...REQUEST, allowedTools: Array(65).fill("knowledge_search") },
        ]) {
            await expect(callSynaluxRouteGuard(invalid))
                .rejects.toThrow("synalux_route_guard_request_invalid");
        }
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("aborts a route-guard request after the five-second deadline", async () => {
        const controller = new AbortController();
        const timeoutSpy = vi.spyOn(AbortSignal, "timeout")
            .mockReturnValue(controller.signal);
        try {
            vi.stubGlobal("fetch", vi.fn((_url: string | URL | Request, init?: RequestInit) =>
                new Promise<Response>((_resolve, reject) => {
                    if (init?.signal?.aborted) {
                        reject(init.signal.reason);
                        return;
                    }
                    init?.signal?.addEventListener(
                        "abort",
                        () => reject(init.signal?.reason),
                        { once: true },
                    );
                })));
            const assertion = expect(callSynaluxRouteGuard(REQUEST))
                .rejects.toThrow(/timeout|aborted/i);
            controller.abort(new DOMException(
                "The operation was aborted due to timeout",
                "TimeoutError",
            ));
            await assertion;
            expect(timeoutSpy).toHaveBeenCalledWith(5_000);
        } finally {
            timeoutSpy.mockRestore();
        }
    });

    it("surfaces non-success HTTP status for local fail-loud fallback", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => response(403, "{}")));
        await expect(callSynaluxRouteGuard(REQUEST))
            .rejects.toThrow("synalux_route_guard_http_403");
    });

    it.each([
        ["invalid JSON", "not-json"],
        ["oversized JSON", JSON.stringify({ value: "x".repeat(64_001) })],
    ])("rejects %s response bodies before the caller can trust them", async (_case, body) => {
        vi.stubGlobal("fetch", vi.fn(async () => response(200, body)));
        await expect(callSynaluxRouteGuard(REQUEST))
            .rejects.toThrow("synalux_route_guard_malformed");
    });
});
