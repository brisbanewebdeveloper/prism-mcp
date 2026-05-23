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
});
