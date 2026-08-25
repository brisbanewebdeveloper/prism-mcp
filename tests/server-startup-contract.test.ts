/**
 * Hook-free startup is additive: connecting a host must not trade away the
 * memory, handoff, drift, routing, or inference capabilities users already
 * rely on.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import {
  createSandboxServer,
  createServer,
  getAllPossibleTools,
  PRISM_SERVER_INSTRUCTIONS,
} from "../src/server.js";

type DeferredToolSupport = "none" | "complete" | "incomplete";

interface SyntheticFirstTurnOptions {
  prompt: string;
  bootstrapDirectlyCallable: boolean;
  deferredToolSupport: DeferredToolSupport;
  legacyServer?: boolean;
}

async function runSyntheticCodexFirstTurn(options: SyntheticFirstTurnOptions) {
  const server = createServer() as ReturnType<typeof createServer> & {
    _requestHandlers: Map<string, (request: {
      method: string;
      params: { name: string; arguments?: Record<string, unknown> };
    }) => Promise<unknown>>;
  };
  const bootstrapCalls: Array<Record<string, unknown>> = [];
  const loadContextCalls: Array<Record<string, unknown>> = [];
  if (options.legacyServer) {
    server._requestHandlers.set("tools/list", async () => ({
      tools: getAllPossibleTools().filter(tool => tool.name !== "session_bootstrap"),
    }));
  }
  server._requestHandlers.set("tools/call", async (request) => {
    if (request.params.name === "session_bootstrap") {
      bootstrapCalls.push(request.params.arguments ?? {});
      return { content: [{ type: "text", text: "Synthetic Prism startup display" }] };
    }
    if (request.params.name === "session_load_context") {
      loadContextCalls.push(request.params.arguments ?? {});
      return { content: [{ type: "text", text: "Synthetic legacy context" }] };
    }
    throw new Error(`Unexpected synthetic tool call: ${request.params.name}`);
  });

  const client = new Client(
    { name: "codex-cli", version: "0.149.1" },
    { capabilities: { experimental: { deferredTools: {} } } },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const toolsResult = await client.listTools();
    const instructions = client.getInstructions() ?? "";
    const bootstrapAdvertised = toolsResult.tools.some(tool => tool.name === "session_bootstrap");
    const loadContextAdvertised = toolsResult.tools.some(tool => tool.name === "session_load_context");
    const bootstrapCallable = options.bootstrapDirectlyCallable ||
      (bootstrapAdvertised && options.deferredToolSupport === "complete");
    const hasCallabilityGuard = /only when that tool is model-callable/i.test(instructions);
    const forcesInvalidCall = !bootstrapCallable &&
      /call session_bootstrap exactly once/i.test(instructions) &&
      !hasCallabilityGuard;

    let userFacingText: string;
    if (bootstrapCallable) {
      const result = await client.callTool({
        name: "session_bootstrap",
        arguments: { prompt: options.prompt },
      });
      userFacingText = String((result.content[0] as { text?: string })?.text ?? "");
    } else if (!bootstrapAdvertised && loadContextAdvertised) {
      const result = await client.callTool({
        name: "session_load_context",
        arguments: {
          project: "synthetic-project",
          level: "quick",
          toolAction: "Load legacy context",
          toolSummary: "Synthetic project",
        },
      });
      userFacingText = String((result.content[0] as { text?: string })?.text ?? "");
    } else {
      userFacingText = "Synthetic response to the user request";
    }

    return {
      advertisedToolCount: toolsResult.tools.length,
      bootstrapAdvertised,
      bootstrapCalls,
      loadContextCalls,
      instructions,
      forcesInvalidCall,
      userFacingText,
    };
  } finally {
    await client.close();
  }
}

function expectVerbatimStartupContract(instructions: string): void {
  const normalized = instructions.replace(/\s+/g, " ");
  expect(normalized).toContain(
    "Print the complete tool result verbatim as the entire first-turn startup display, before any optional answer.",
  );
  expect(normalized).toContain(
    "Do not summarize, paraphrase, rename headings, reformat, or omit any returned section.",
  );
  expect(normalized).toContain(
    "For a greeting-only prompt, stop after the verbatim startup display.",
  );
}

describe("Prism startup tool contract", () => {
  it("adds session_bootstrap while preserving the established Prism surface", () => {
    const tools = getAllPossibleTools();
    const names = tools.map((tool) => tool.name);

    expect(names).toEqual(expect.arrayContaining([
      "session_bootstrap",
      "session_load_context",
      "session_save_ledger",
      "session_save_handoff",
      "session_detect_drift",
      "session_task_route",
      "knowledge_search",
      "session_search_memory",
      "memory_history",
      "prism_infer",
    ]));
    expect(new Set(names).size).toBe(names.length);
    expect(tools.find((tool) => tool.name === "session_bootstrap")?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });

    expect(names.indexOf("session_bootstrap")).toBeLessThan(names.indexOf("session_load_context"));
    const bootstrapDescription = tools.find((tool) => tool.name === "session_bootstrap")?.description || "";
    const loadDescription = tools.find((tool) => tool.name === "session_load_context")?.description || "";
    expect(bootstrapDescription).toMatch(/first user turn of every conversation/i);
    expect(bootstrapDescription).toMatch(/only when it is model-callable in the current turn/i);
    expect(bootstrapDescription).toMatch(/tools\/list advertisement .* does not prove model callability/i);
    expect(bootstrapDescription).toMatch(/continue with the user's request silently/i);
    expect(bootstrapDescription).toMatch(/do not guess a function call, claim Prism is offline, announce a fallback/i);
    expect(bootstrapDescription).toMatch(/fabricate a result, or use a shell\/CLI substitute/i);
    // Was /empty object/ — this assertion is why the zero-argument contract
    // survived the 2026-08-02 switch to prompt-passing. The tool DESCRIPTION is
    // what a host reads to decide how to call the tool, so it outranks the
    // server instructions in practice: while it said "with an empty object",
    // hosts passed {} and turn-one keyword routing never fired, defeating the
    // change. Pinned to the new contract, and to its negation.
    expect(bootstrapDescription).toMatch(/verbatim first message as \{prompt: "<first user message>"\}/i);
    expect(bootstrapDescription).toMatch(/ON-DEVICE/);
    expect(bootstrapDescription).toMatch(/never leaves the machine/i);
    expect(bootstrapDescription).not.toMatch(/exactly once with an empty object/i);
    expectVerbatimStartupContract(bootstrapDescription);
    expect(bootstrapDescription).toMatch(/Do not guess or pass a project or depth/i);
    expect(loadDescription).toMatch(/explicit project reload/i);
    expect(loadDescription).toMatch(/fallback only when session_bootstrap is unavailable/i);
    expect(loadDescription).not.toMatch(/at the start of every conversation/i);
    // Was `exactly once with {}` until 2026-08-02. The zero-argument contract
    // meant prompt-keyword routing could never fire on turn one — the turn an
    // incident report arrives on. The prompt is now passed and matched
    // on-device, so both halves are pinned here.
    expect(PRISM_SERVER_INSTRUCTIONS).toMatch(/call session_bootstrap exactly once/i);
    expect(PRISM_SERVER_INSTRUCTIONS).toMatch(/verbatim first message as \{prompt: "<first user message>"\}/i);
    expect(PRISM_SERVER_INSTRUCTIONS).toMatch(/ON-DEVICE/);
    expect(PRISM_SERVER_INSTRUCTIONS).toMatch(/never leaves the machine/i);
    expect(PRISM_SERVER_INSTRUCTIONS).not.toMatch(/exactly once with \{\}/);
    expectVerbatimStartupContract(PRISM_SERVER_INSTRUCTIONS);
    expect(PRISM_SERVER_INSTRUCTIONS).toMatch(/only when that tool is model-callable/i);
    expect(PRISM_SERVER_INSTRUCTIONS).toMatch(/tools\/list advertisement .* does not prove model callability/i);
    expect(PRISM_SERVER_INSTRUCTIONS).toMatch(/continue with the user's request silently/i);
    expect(PRISM_SERVER_INSTRUCTIONS).toMatch(/Do not invent or guess a function call/i);
    expect(PRISM_SERVER_INSTRUCTIONS).toMatch(/Do not tell the user that bootstrap is unavailable or that Prism is offline/i);
    expect(PRISM_SERVER_INSTRUCTIONS).toMatch(/do not announce a fallback/i);
    expect(PRISM_SERVER_INSTRUCTIONS).toMatch(/Do not fabricate a bootstrap result or use a shell\/CLI workaround/i);
    expect(PRISM_SERVER_INSTRUCTIONS).toMatch(/Do not substitute session_load_context/i);
    expect(PRISM_SERVER_INSTRUCTIONS).toMatch(/session_save_handoff to preserve state/i);
    expect(PRISM_SERVER_INSTRUCTIONS).toMatch(/session_detect_drift/i);
    expect(PRISM_SERVER_INSTRUCTIONS).toMatch(/Prism local-first orchestration/i);
    expect(PRISM_SERVER_INSTRUCTIONS).toMatch(/Never create host-native or background subagents for routine work/i);
    expect(PRISM_SERVER_INSTRUCTIONS).toMatch(/A host-native subagent is a last resort: at most one, no nesting/i);
    expect(PRISM_SERVER_INSTRUCTIONS).toMatch(/Prism evidence workflow/i);
    expect(PRISM_SERVER_INSTRUCTIONS).toMatch(/one trustworthy correlated reproduction is enough/i);
    expect(PRISM_SERVER_INSTRUCTIONS).toMatch(/Inspect every artifact used to support the claim/i);
    expect(PRISM_SERVER_INSTRUCTIONS).toMatch(/active agent must open it and compare its visible state/i);
    expect(PRISM_SERVER_INSTRUCTIONS).toMatch(/do not ask the user to verify it/i);
    expect(PRISM_SERVER_INSTRUCTIONS).toMatch(/screenshot is an observation, not absolute truth/i);
  });

  it.each([
    ["greeting", "hello"],
    ["substantive first turn", "fix the synthetic startup fixture"],
  ])("calls bootstrap exactly once for a capable client on a %s", async (_label, prompt) => {
    const result = await runSyntheticCodexFirstTurn({
      prompt,
      bootstrapDirectlyCallable: true,
      deferredToolSupport: "none",
    });

    expect(result.bootstrapCalls).toEqual([{ prompt }]);
    expect(result.userFacingText).toBe("Synthetic Prism startup display");
    expect(result.forcesInvalidCall).toBe(false);
  });

  it("does not force or narrate bootstrap for a client without a model-callable route", async () => {
    const result = await runSyntheticCodexFirstTurn({
      prompt: "hello",
      bootstrapDirectlyCallable: false,
      deferredToolSupport: "none",
    });

    expect(result.advertisedToolCount).toBeGreaterThan(40);
    expect(result.bootstrapAdvertised).toBe(true);
    expect(result.bootstrapCalls).toHaveLength(0);
    expect(result.forcesInvalidCall).toBe(false);
    expect(result.userFacingText).toBe("Synthetic response to the user request");
    expect(result.userFacingText).not.toMatch(/bootstrap|Prism.*offline|fallback/i);
  });

  it("continues silently when deferred-tool support is incomplete", async () => {
    const result = await runSyntheticCodexFirstTurn({
      prompt: "fix the synthetic startup fixture",
      bootstrapDirectlyCallable: false,
      deferredToolSupport: "incomplete",
    });

    expect(result.bootstrapAdvertised).toBe(true);
    expect(result.bootstrapCalls).toHaveLength(0);
    expect(result.forcesInvalidCall).toBe(false);
    expect(result.userFacingText).not.toMatch(/bootstrap|unavailable|offline|fallback/i);
  });

  it("retains the default Codex/OpenAI deferred discovery path exactly once", async () => {
    const result = await runSyntheticCodexFirstTurn({
      prompt: "hello",
      bootstrapDirectlyCallable: false,
      deferredToolSupport: "complete",
    });

    expect(result.bootstrapCalls).toEqual([{ prompt: "hello" }]);
    expect(result.userFacingText).toBe("Synthetic Prism startup display");
  });

  it("retains session_load_context as an explicit legacy-server fallback", async () => {
    const tools = getAllPossibleTools();
    const legacyTool = tools.find(tool => tool.name === "session_load_context");
    const result = await runSyntheticCodexFirstTurn({
      prompt: "continue the synthetic project",
      bootstrapDirectlyCallable: false,
      deferredToolSupport: "none",
      legacyServer: true,
    });

    expect(legacyTool).toBeDefined();
    expect(legacyTool?.description).toMatch(/fallback only when session_bootstrap is unavailable/i);
    expect(legacyTool?.description).toMatch(/explicit project reload/i);
    expect(result.bootstrapAdvertised).toBe(false);
    expect(result.bootstrapCalls).toHaveLength(0);
    expect(result.loadContextCalls).toEqual([{
      project: "synthetic-project",
      level: "quick",
      toolAction: "Load legacy context",
      toolSummary: "Synthetic project",
    }]);
    expect(result.userFacingText).toBe("Synthetic legacy context");
  });

  it.each([
    ["runtime", createServer],
    ["sandbox", createSandboxServer],
  ])("advertises diagnostic logging during the %s initialize handshake", async (_name, factory) => {
    const server = factory();
    const client = new Client(
      { name: "prism-startup-contract-test", version: "1.0.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      expect(client.getServerCapabilities()?.logging).toEqual({});
    } finally {
      await client.close();
    }
  });

  it("emits SDK logging notifications after initialization", async () => {
    const server = createServer();
    const client = new Client(
      { name: "prism-logging-notification-test", version: "1.0.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const notification = new Promise<{ level: string; data: unknown }>((resolve) => {
      client.setNotificationHandler(LoggingMessageNotificationSchema, message => {
        resolve(message.params);
      });
    });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      await server.sendLoggingMessage({
        level: "info",
        data: "Prism diagnostic notification",
      });

      await expect(notification).resolves.toMatchObject({
        level: "info",
        data: "Prism diagnostic notification",
      });
    } finally {
      await client.close();
    }
  });
});
