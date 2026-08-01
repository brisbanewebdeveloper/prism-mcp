import { afterAll, beforeAll, describe, it, expect, vi, beforeEach } from "vitest";
import { createServer, type Server } from "node:http";
import { searchYahooFree, scrapeArticleLocal } from "../../src/scholar/freeSearch.js";

// Mock the global fetch API
const originalFetch = global.fetch;

describe("Free Local Search & Scraping (Zero-Config Fallback)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("searchYahooFree", () => {
    it("should parse standard Yahoo Search HTML results and extract links", async () => {
      // Create a mock Yahoo Search HTML response using the `.algo` class
      const mockYahooHtml = `
        <html>
          <body>
            <div class="algo">
              <h3 class="title"><a href="https://example.com/result1">Result 1 Title</a></h3>
              <div class="compText">Snippet 1 text</div>
            </div>
            <div class="algo">
              <h3 class="title"><a href="https://example.com/result2">Result 2 Title</a></h3>
              <div class="compText">Snippet 2 text</div>
            </div>
          </body>
        </html>
      `;

      vi.spyOn(global, "fetch").mockResolvedValueOnce(
        new Response(mockYahooHtml, { status: 200, statusText: "OK" })
      );

      const results = await searchYahooFree("test query", 2);
      
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("https://search.yahoo.com/search?p=test%20query"),
        expect.any(Object)
      );

      expect(results.length).toBe(2);
      expect(results[0].url).toBe("https://example.com/result1");
      expect(results[0].title).toBe("Result 1 Title");
      expect(results[1].url).toBe("https://example.com/result2");
    });

    it("should handle Yahoo redirect URLs and extract the clean destination URL", async () => {
      // Yahoo often wraps URLs in redirects like:
      // https://r.search.yahoo.com/_ylt=.../RU=https://real-site.com/article/RK=...
      const mockYahooHtml = `
        <html>
          <body>
            <div class="algo">
              <h3 class="title"><a href="https://r.search.yahoo.com/_ylt=abc/RU=https://real-site.com/article/RK=0">Redirect Title</a></h3>
              <div class="compText">Snippet 1</div>
            </div>
            <div class="algo">
              <h3 class="title"><a href="https://r.search.yahoo.com/_ylt=def/RU=http%3A%2F%2Fencoded-site.com%2Fpath/RK=0">Encoded Title</a></h3>
              <div class="compText">Snippet 2</div>
            </div>
          </body>
        </html>
      `;

      vi.spyOn(global, "fetch").mockResolvedValueOnce(
        new Response(mockYahooHtml, { status: 200, statusText: "OK" })
      );

      const results = await searchYahooFree("redirect test", 2);
      
      expect(results.length).toBe(2);
      // The logic should extract the 'RU=' part and decode it
      expect(results[0].url).toBe("https://real-site.com/article");
      expect(results[1].url).toBe("http://encoded-site.com/path");
    });

    it("should elegantly handle empty search results", async () => {
      // HTML without any matching class names
      const mockYahooHtml = `<html><body><div>No results found for your query.</div></body></html>`;

      vi.spyOn(global, "fetch").mockResolvedValueOnce(
        new Response(mockYahooHtml, { status: 200, statusText: "OK" })
      );

      const results = await searchYahooFree("empty query", 3);
      
      expect(results.length).toBe(0);
    });

    it("should throw an error if Yahoo Search fails (e.g. 429 Too Many Requests)", async () => {
      vi.spyOn(global, "fetch").mockResolvedValueOnce(
        new Response("Too Many Requests", { status: 429, statusText: "Too Many Requests" })
      );

      await expect(searchYahooFree("blocked query", 3)).rejects.toThrow("Yahoo Search failed with status: 429");
    });

    it("should handle malformed Yahoo Search HTML without crashing", async () => {
      // If Yahoo changes their HTML structure significantly, it should return an empty array, not crash.
      const malformedHtml = `<html><body><div class="algo">just some text no tags</div></body></html>`;

      vi.spyOn(global, "fetch").mockResolvedValueOnce(
        new Response(malformedHtml, { status: 200, statusText: "OK" })
      );

      const results = await searchYahooFree("malformed query", 3);
      
      expect(results.length).toBe(0);
    });

    it("should correctly limit the number of search results returned", async () => {
      const mockYahooHtml = `
        <html>
          <body>
            <div class="algo"><h3 class="title"><a href="https://example.com/1">Result 1</a></h3></div>
            <div class="algo"><h3 class="title"><a href="https://example.com/2">Result 2</a></h3></div>
            <div class="algo"><h3 class="title"><a href="https://example.com/3">Result 3</a></h3></div>
            <div class="algo"><h3 class="title"><a href="https://example.com/4">Result 4</a></h3></div>
          </body>
        </html>
      `;

      vi.spyOn(global, "fetch").mockResolvedValueOnce(
        new Response(mockYahooHtml, { status: 200, statusText: "OK" })
      );

      // Request only LIMIT=2
      const results = await searchYahooFree("limit query", 2);
      
      expect(results.length).toBe(2);
      expect(results[0].url).toBe("https://example.com/1");
      expect(results[1].url).toBe("https://example.com/2");
    });
  });

  // scrapeArticleLocal no longer uses global.fetch: it resolves the host,
  // validates every answer, then connects over a pinned lookup so the name
  // cannot be re-resolved to a local address (DNS rebinding). A fetch spy
  // therefore intercepts nothing — these serve real HTML over loopback
  // instead, which exercises resolution, pinning and parsing together.
  describe("scrapeArticleLocal", () => {
    const ARTICLE_HTML = `
      <!DOCTYPE html>
      <html>
        <head><title>My Awesome Article</title></head>
        <body>
          <nav>This is a menu, it should be ignored by Readability.</nav>
          <article>
            <h1>Main Article Heading</h1>
            <p>This is the first paragraph with some <strong>bold</strong> text.</p>
            <div class="ads">Buy our product!</div>
            <p>This is the second paragraph.</p>
          </article>
          <footer>Copyright 2026</footer>
        </body>
      </html>
    `;
    const NO_TITLE_HTML = `
      <!DOCTYPE html>
      <html>
        <head></head>
        <body>
          <article>
            <p>This article has plenty of content but absolutely no title tags or headings!</p>
            <p>Just some paragraphs for readability to latch onto.</p>
          </article>
        </body>
      </html>
    `;

    let server: Server;
    let origin: string;
    let previousDevMode: string | undefined;

    beforeAll(async () => {
      previousDevMode = process.env.PRISM_DEV_MODE;
      // Loopback targets are refused in production; this suite serves its
      // fixtures locally, so it opts in explicitly.
      process.env.PRISM_DEV_MODE = "1";

      server = createServer((req, res) => {
        if (req.url === "/forbidden") {
          res.writeHead(403, "Forbidden");
          res.end("Forbidden");
          return;
        }
        if (req.url === "/empty") {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(`<html><head><title>Empty</title></head><body></body></html>`);
          return;
        }
        if (req.url === "/no-title") {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(NO_TITLE_HTML);
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(ARTICLE_HTML);
      });
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      origin = `http://127.0.0.1:${port}`;
    });

    afterAll(async () => {
      if (previousDevMode === undefined) delete process.env.PRISM_DEV_MODE;
      else process.env.PRISM_DEV_MODE = previousDevMode;
      await new Promise<void>((done) => server.close(() => done()));
    });

    it("should fetch an article, parse with Readability, and output clean Markdown", async () => {
      const scraped = await scrapeArticleLocal(`${origin}/article`);

      expect(scraped.title).toBe("My Awesome Article");
      expect(scraped.content).toContain("# Main Article Heading");
      expect(scraped.content).toContain("This is the first paragraph with some **bold** text.");
      expect(scraped.content).toContain("This is the second paragraph.");

      // Readability should strip out nav and footer, Turndown shouldn't see them
      expect(scraped.content).not.toContain("This is a menu");
      expect(scraped.content).not.toContain("Copyright");
    });

    it("should throw an error if the URL cannot be fetched (e.g., 403 Forbidden cloudflare block)", async () => {
      await expect(scrapeArticleLocal(`${origin}/forbidden`))
        .rejects.toThrow(/Failed to fetch article HTML: 403/);
    });

    it("should throw an error if Readability cannot parse the main content", async () => {
      await expect(scrapeArticleLocal(`${origin}/empty`))
        .rejects.toThrow("Readability could not parse the article content.");
    });

    it("should handle articles with missing titles gracefully, reverting to Unknown Title", async () => {
      const scraped = await scrapeArticleLocal(`${origin}/no-title`);

      expect(scraped.title).toBe("Unknown Title");
      expect(scraped.content).toContain("This article has plenty of content");
    });

    it("refuses a public URL whose name resolves to this machine", async () => {
      // The rebinding shape: string checks pass, resolution betrays it.
      process.env.PRISM_DEV_MODE = "";
      await expect(scrapeArticleLocal(`${origin}/article`))
        .rejects.toThrow(/loopback/i);
      process.env.PRISM_DEV_MODE = "1";
    });
  });
});
