import { afterEach, describe, expect, it, vi } from "vitest";
import { monitorMcpTransport } from "../src/mcpTransportHealth.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("MCP transport health monitor", () => {
  it("pings an idle client without closing a healthy transport", async () => {
    vi.useFakeTimers();
    const server = { ping: vi.fn().mockResolvedValue({}) };
    const onFailure = vi.fn();

    const stop = monitorMcpTransport(server, {
      intervalMs: 1_000,
      timeoutMs: 250,
      onFailure,
    });

    await vi.advanceTimersByTimeAsync(3_000);

    expect(server.ping).toHaveBeenCalledTimes(3);
    expect(onFailure).not.toHaveBeenCalled();
    stop();
  });

  it("reports a failed keepalive once and stops further pings", async () => {
    vi.useFakeTimers();
    const server = { ping: vi.fn().mockRejectedValue(new Error("closed")) };
    const onFailure = vi.fn();

    monitorMcpTransport(server, {
      intervalMs: 1_000,
      timeoutMs: 250,
      onFailure,
    });

    await vi.advanceTimersByTimeAsync(3_000);

    expect(server.ping).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenCalledWith(
      "MCP_KEEPALIVE_FAILED",
      expect.objectContaining({ message: "closed" }),
    );
  });

  it("fails closed when an idle client never answers the ping", async () => {
    vi.useFakeTimers();
    const server = { ping: vi.fn(() => new Promise(() => {})) };
    const onFailure = vi.fn();

    monitorMcpTransport(server, {
      intervalMs: 1_000,
      timeoutMs: 250,
      onFailure,
    });

    await vi.advanceTimersByTimeAsync(1_250);

    expect(onFailure).toHaveBeenCalledWith(
      "MCP_KEEPALIVE_FAILED",
      expect.objectContaining({ message: "MCP keepalive timed out after 250ms" }),
    );
  });

  it("preserves the existing close handler before requesting shutdown", () => {
    const previousOnClose = vi.fn();
    const server = {
      ping: vi.fn().mockResolvedValue({}),
      onclose: previousOnClose,
    };
    const onFailure = vi.fn();

    monitorMcpTransport(server, { onFailure });
    server.onclose?.();

    expect(previousOnClose).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenCalledWith("MCP_TRANSPORT_CLOSED", undefined);
  });

  it("still requests shutdown when the existing close handler throws", () => {
    const previousOnClose = vi.fn(() => {
      throw new Error("close callback failed");
    });
    const server = {
      ping: vi.fn().mockResolvedValue({}),
      onclose: previousOnClose,
    };
    const onFailure = vi.fn();

    monitorMcpTransport(server, { onFailure });
    expect(() => server.onclose?.()).not.toThrow();

    expect(previousOnClose).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenCalledWith(
      "MCP_TRANSPORT_CLOSED",
      expect.objectContaining({ message: "close callback failed" }),
    );
  });
});
