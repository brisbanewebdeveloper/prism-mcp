import { describe, expect, it } from "vitest";

import { resolveOpenAIEmbeddingModel } from "../../src/utils/llm/adapters/openai.js";

function withSettings(settings: Record<string, string>) {
  return (key: string, defaultValue = "") => settings[key] ?? defaultValue;
}

describe("resolveOpenAIEmbeddingModel", () => {
  it("prefers the explicit embedding model when configured", () => {
    const model = resolveOpenAIEmbeddingModel(withSettings({
      openai_embedding_model: "nomic-embed-text",
      openai_model: "gpt-4o-mini",
      text_provider: "openai",
      embedding_provider: "auto",
    }));

    expect(model).toBe("nomic-embed-text");
  });

  it("reuses an embedding-shaped openai_model for effective OpenAI auto embeddings", () => {
    const model = resolveOpenAIEmbeddingModel(withSettings({
      text_provider: "openai",
      embedding_provider: "auto",
      openai_model: "qwen3-embedding:0.6b",
    }));

    expect(model).toBe("qwen3-embedding:0.6b");
  });

  it("falls back to the default model when the text model is not an embedding model", () => {
    const model = resolveOpenAIEmbeddingModel(withSettings({
      text_provider: "openai",
      embedding_provider: "auto",
      openai_model: "gpt-4o-mini",
    }));

    expect(model).toBe("text-embedding-3-small");
  });
});
