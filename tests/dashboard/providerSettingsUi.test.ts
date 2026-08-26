import { describe, expect, it } from "vitest";

import { renderDashboardHTML } from "../../src/dashboard/ui.js";

describe("Dashboard AI provider settings modal", () => {
  it("renders the OpenAI embedding model control", () => {
    const html = renderDashboardHTML("test-version");

    expect(html).toContain('id="input-openai-embedding-model"');
    expect(html).toContain("openai_embedding_model");
  });

  it("shows OpenAI embedding model settings when auto embeddings resolve to OpenAI", () => {
    const html = renderDashboardHTML("test-version");

    expect(html).toContain("shouldShowOpenAIEmbeddingFields");
    expect(html).toContain("embeddingProvider === 'auto' && textProvider === 'openai'");
  });

  it("renders duplicate review details and gates cleanup on fixable issues", () => {
    const html = renderDashboardHTML("test-version");

    expect(html).toContain("function renderHealthIssues(issues)");
    expect(html).toContain("Review ' + duplicatePairs.length + ' duplicate pair");
    expect(html).toContain("function hasFixableHealthIssue(issues)");
    expect(html).toContain("hasFixableHealthIssue(issues) ? 'inline-block' : 'none'");
    expect(html).toContain("function resolveDuplicateGroup(keepId, duplicateIds)");
    expect(html).toContain("/api/health/duplicates/resolve");
    expect(html).toContain("Keep this entry");
  });
});
