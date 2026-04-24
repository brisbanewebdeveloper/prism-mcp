import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseGoogleSearchCredentials,
  type GoogleSearchCredential,
  type GoogleSearchCredentialSelectionStrategy,
} from "../../src/config.js";
import { performWebSearchRawWithCredentials } from "../../src/utils/braveApi.js";

describe("parseGoogleSearchCredentials", () => {
  it("accepts PRISM_GOOGLE_SEARCH_CREDENTIALS as a structured alias", () => {
    const env = {
      PRISM_GOOGLE_SEARCH_CREDENTIALS: JSON.stringify({
        strategy: "random",
        credentials: [
          { apiKey: "prism-key-1", cx: "prism-cx-1" },
          { apiKey: "prism-key-2", channel: "prism-cx-2" },
        ],
      }),
    };

    const result = parseGoogleSearchCredentials(env);

    expect(result.credentials).toEqual([
      { apiKey: "prism-key-1", cx: "prism-cx-1" },
      { apiKey: "prism-key-2", cx: "prism-cx-2" },
    ]);
    expect(result.selectionStrategy).toBe("random");
  });

  it("prefers GOOGLE_SEARCH_CREDENTIALS JSON entries", () => {
    const env = {
      GOOGLE_SEARCH_CREDENTIALS:
        '[{"apiKey":"key-json-1","channel":"cx-json-1"},{"apiKey":"key-json-2","cx":"cx-json-2"}]',
      GOOGLE_SEARCH_API_KEY: "single-key",
      GOOGLE_SEARCH_CX: "single-cx",
    };

    const result = parseGoogleSearchCredentials(env);

    expect(result.credentials).toEqual([
      { apiKey: "key-json-1", cx: "cx-json-1" },
      { apiKey: "key-json-2", cx: "cx-json-2" },
    ]);
    expect(result.selectionStrategy).toBe("failover");
  });

  it("parses object-form credentials with a random selection strategy", () => {
    const env = {
      GOOGLE_SEARCH_CREDENTIALS: JSON.stringify({
        strategy: "random",
        credentials: [
          { apiKey: "key-random-1", cx: "cx-random-1" },
          { apiKey: "key-random-2", channel: "cx-random-2" },
        ],
      }),
    };

    const result = parseGoogleSearchCredentials(env);

    expect(result.credentials).toEqual([
      { apiKey: "key-random-1", cx: "cx-random-1" },
      { apiKey: "key-random-2", cx: "cx-random-2" },
    ]);
    expect(result.selectionStrategy).toBe("random");
  });

  it("falls back to indexed and single credentials when JSON is invalid", () => {
    const env = {
      GOOGLE_SEARCH_CREDENTIALS: "not-valid-json",
      GOOGLE_SEARCH_API_KEY_1: "key-1",
      GOOGLE_SEARCH_CX_1: "cx-1",
      GOOGLE_SEARCH_API_KEY_2: "key-2",
      GOOGLE_SEARCH_CX_2: "cx-2",
      GOOGLE_SEARCH_API_KEY: "key-2",
      GOOGLE_SEARCH_CX: "cx-2",
    };

    const result = parseGoogleSearchCredentials(env);

    expect(result.credentials).toEqual([
      { apiKey: "key-1", cx: "cx-1" },
      { apiKey: "key-2", cx: "cx-2" },
    ]);
    expect(result.warnings.some((warning) => warning.includes("valid JSON"))).toBe(
      true
    );
    expect(result.selectionStrategy).toBe("failover");
  });

  it("ignores incomplete indexed or single credentials", () => {
    const env = {
      GOOGLE_SEARCH_API_KEY_1: "key-1",
      GOOGLE_SEARCH_CX_2: "cx-2",
      GOOGLE_SEARCH_API_KEY: "single-key",
    };

    const result = parseGoogleSearchCredentials(env);

    expect(result.credentials).toEqual([]);
    expect(result.selectionStrategy).toBe("failover");
    expect(
      result.warnings.some((warning) =>
        warning.includes("GOOGLE_SEARCH_API_KEY_1 and GOOGLE_SEARCH_CX_1")
      )
    ).toBe(true);
    expect(
      result.warnings.some((warning) =>
        warning.includes("GOOGLE_SEARCH_API_KEY and GOOGLE_SEARCH_CX")
      )
    ).toBe(true);
  });

  it("falls back to Prism-scoped single credentials", () => {
    const env = {
      PRISM_GOOGLE_SEARCH_API_KEY: "prism-single-key",
      PRISM_GOOGLE_SEARCH_CX: "prism-single-cx",
    };

    const result = parseGoogleSearchCredentials(env);

    expect(result.credentials).toEqual([
      { apiKey: "prism-single-key", cx: "prism-single-cx" },
    ]);
    expect(result.selectionStrategy).toBe("failover");
  });

  it("does not treat the Brave Answers alias as Google search credentials", () => {
    const env = {
      PRISM_BRAVE_ANSWERS_API_KEY: "brave-answers-only",
    };

    const result = parseGoogleSearchCredentials(env);

    expect(result.credentials).toEqual([]);
    expect(result.selectionStrategy).toBe("failover");
  });

  it("prefers unscoped Google credentials when both alias sets are present", () => {
    const env = {
      GOOGLE_SEARCH_CREDENTIALS: JSON.stringify([
        { apiKey: "google-key", cx: "google-cx" },
      ]),
      PRISM_GOOGLE_SEARCH_CREDENTIALS: JSON.stringify([
        { apiKey: "prism-key", cx: "prism-cx" },
      ]),
      PRISM_GOOGLE_SEARCH_API_KEY: "prism-single-key",
      PRISM_GOOGLE_SEARCH_CX: "prism-single-cx",
    };

    const result = parseGoogleSearchCredentials(env);

    expect(result.credentials).toEqual([
      { apiKey: "google-key", cx: "google-cx" },
    ]);
    expect(result.selectionStrategy).toBe("failover");
  });
});

describe("performWebSearchRawWithCredentials", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const failoverStrategy: GoogleSearchCredentialSelectionStrategy = "failover";
  const randomStrategy: GoogleSearchCredentialSelectionStrategy = "random";

  it("maps Google items into the normalized web.results shape", async () => {
    const credentials: GoogleSearchCredential[] = [{ apiKey: "key-1", cx: "cx-1" }];

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [{ title: "Title A", snippet: "Snippet A", link: "https://example.com/a" }],
          }),
          { status: 200, statusText: "OK" }
        )
      );

    const raw = await performWebSearchRawWithCredentials(
      "prism",
      7,
      2,
      credentials,
      failoverStrategy
    );

    expect(JSON.parse(raw)).toEqual({
      web: {
        results: [
          {
            title: "Title A",
            description: "Snippet A",
            url: "https://example.com/a",
          },
        ],
      },
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const firstUrl = new URL(String(fetchSpy.mock.calls[0][0]));
    expect(firstUrl.searchParams.get("key")).toBe("key-1");
    expect(firstUrl.searchParams.get("cx")).toBe("cx-1");
    expect(firstUrl.searchParams.get("num")).toBe("7");
    expect(firstUrl.searchParams.get("start")).toBe("3");
  });

  it("fails over to the next credential on quota/auth errors", async () => {
    const credentials: GoogleSearchCredential[] = [
      { apiKey: "key-1", cx: "cx-1" },
      { apiKey: "key-2", cx: "cx-2" },
    ];

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              message: "Quota exceeded",
              errors: [{ reason: "dailyLimitExceeded", message: "limit" }],
            },
          }),
          { status: 429, statusText: "Too Many Requests" }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [{ title: "Title B", snippet: "Snippet B", link: "https://example.com/b" }],
          }),
          { status: 200, statusText: "OK" }
        )
      );

    const raw = await performWebSearchRawWithCredentials(
      "prism",
      10,
      0,
      credentials,
      failoverStrategy
    );

    expect(JSON.parse(raw)).toEqual({
      web: {
        results: [
          {
            title: "Title B",
            description: "Snippet B",
            url: "https://example.com/b",
          },
        ],
      },
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const firstUrl = new URL(String(fetchSpy.mock.calls[0][0]));
    const secondUrl = new URL(String(fetchSpy.mock.calls[1][0]));
    expect(firstUrl.searchParams.get("key")).toBe("key-1");
    expect(secondUrl.searchParams.get("key")).toBe("key-2");
  });

  it("throws a clear error when no credentials are provided", async () => {
    await expect(
      performWebSearchRawWithCredentials(
        "prism",
        10,
        0,
        [],
        failoverStrategy
      )
    ).rejects.toThrow("Google Search credentials are not configured");
  });

  it("randomizes the first credential for a request", async () => {
    const credentials: GoogleSearchCredential[] = [
      { apiKey: "key-1", cx: "cx-1" },
      { apiKey: "key-2", cx: "cx-2" },
    ];

    vi.spyOn(Math, "random").mockReturnValue(0.9);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [{ title: "Title C", snippet: "Snippet C", link: "https://example.com/c" }],
          }),
          { status: 200, statusText: "OK" }
        )
      );

    const raw = await performWebSearchRawWithCredentials(
      "prism",
      10,
      0,
      credentials,
      randomStrategy
    );

    expect(JSON.parse(raw)).toEqual({
      web: {
        results: [
          {
            title: "Title C",
            description: "Snippet C",
            url: "https://example.com/c",
          },
        ],
      },
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const onlyUrl = new URL(String(fetchSpy.mock.calls[0][0]));
    expect(onlyUrl.searchParams.get("key")).toBe("key-2");
    expect(onlyUrl.searchParams.get("cx")).toBe("cx-2");
  });

  it("fails over after a recoverable 403 when random mode picks an unconfigured project", async () => {
    const credentials: GoogleSearchCredential[] = [
      { apiKey: "key-1", cx: "cx-1" },
      { apiKey: "key-2", cx: "cx-2" },
    ];

    vi.spyOn(Math, "random").mockReturnValue(0.1);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              message:
                "This project does not have the access to Custom Search JSON API.",
              errors: [
                {
                  reason: "accessNotConfigured",
                  message:
                    "This project does not have the access to Custom Search JSON API.",
                },
              ],
            },
          }),
          { status: 403, statusText: "Forbidden" }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [{ title: "Title D", snippet: "Snippet D", link: "https://example.com/d" }],
          }),
          { status: 200, statusText: "OK" }
        )
      );

    const raw = await performWebSearchRawWithCredentials(
      "prism",
      10,
      0,
      credentials,
      randomStrategy
    );

    expect(JSON.parse(raw)).toEqual({
      web: {
        results: [
          {
            title: "Title D",
            description: "Snippet D",
            url: "https://example.com/d",
          },
        ],
      },
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const firstUrl = new URL(String(fetchSpy.mock.calls[0][0]));
    const secondUrl = new URL(String(fetchSpy.mock.calls[1][0]));
    expect(firstUrl.searchParams.get("key")).toBe("key-1");
    expect(secondUrl.searchParams.get("key")).toBe("key-2");
  });

  it("keeps the first credential randomized while preserving later fallbacks", async () => {
    const credentials: GoogleSearchCredential[] = [
      { apiKey: "key-1", cx: "cx-1" },
      { apiKey: "key-2", cx: "cx-2" },
      { apiKey: "key-3", cx: "cx-3" },
    ];

    vi.spyOn(Math, "random").mockReturnValue(0.8);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              message: "Quota exceeded",
              errors: [{ reason: "dailyLimitExceeded", message: "limit" }],
            },
          }),
          { status: 429, statusText: "Too Many Requests" }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              message: "Quota exceeded",
              errors: [{ reason: "dailyLimitExceeded", message: "limit" }],
            },
          }),
          { status: 429, statusText: "Too Many Requests" }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [{ title: "Title E", snippet: "Snippet E", link: "https://example.com/e" }],
          }),
          { status: 200, statusText: "OK" }
        )
      );

    const raw = await performWebSearchRawWithCredentials(
      "prism",
      10,
      0,
      credentials,
      randomStrategy
    );

    expect(JSON.parse(raw)).toEqual({
      web: {
        results: [
          {
            title: "Title E",
            description: "Snippet E",
            url: "https://example.com/e",
          },
        ],
      },
    });

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const firstUrl = new URL(String(fetchSpy.mock.calls[0][0]));
    const secondUrl = new URL(String(fetchSpy.mock.calls[1][0]));
    const thirdUrl = new URL(String(fetchSpy.mock.calls[2][0]));
    expect(firstUrl.searchParams.get("key")).toBe("key-3");
    expect(secondUrl.searchParams.get("key")).toBe("key-1");
    expect(thirdUrl.searchParams.get("key")).toBe("key-2");
  });
});
