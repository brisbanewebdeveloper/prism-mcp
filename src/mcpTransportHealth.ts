const DEFAULT_KEEPALIVE_INTERVAL_MS = 60_000;
const DEFAULT_PING_TIMEOUT_MS = 15_000;

type PingableServer = {
  ping: () => Promise<unknown>;
  onclose?: () => void;
};

type MonitorOptions = {
  intervalMs?: number;
  timeoutMs?: number;
  onFailure: (reason: string, error?: Error) => void;
};

/**
 * Keeps long-idle stdio MCP sessions active and converts a silently dead
 * client transport into a clean server shutdown. Some hosts retain the child
 * pipes after their protocol worker closes, so stdin "close" alone cannot
 * detect the failure.
 */
export function monitorMcpTransport(
  server: PingableServer,
  options: MonitorOptions,
): () => void {
  const intervalMs = options.intervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PING_TIMEOUT_MS;
  const previousOnClose = server.onclose;
  let stopped = false;
  let pingInFlight = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    if (server.onclose === handleClose) {
      server.onclose = previousOnClose;
    }
  };

  const fail = (reason: string, error?: Error) => {
    if (stopped) return;
    stop();
    options.onFailure(reason, error);
  };

  const handleClose = () => {
    let closeError: Error | undefined;
    try {
      previousOnClose?.();
    } catch (error) {
      closeError = error instanceof Error ? error : new Error(String(error));
    } finally {
      fail("MCP_TRANSPORT_CLOSED", closeError);
    }
  };

  server.onclose = handleClose;

  const check = async () => {
    if (stopped || pingInFlight) return;
    pingInFlight = true;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    try {
      await Promise.race([
        server.ping(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error(`MCP keepalive timed out after ${timeoutMs}ms`)),
            timeoutMs,
          );
        }),
      ]);
    } catch (error) {
      fail(
        "MCP_KEEPALIVE_FAILED",
        error instanceof Error ? error : new Error(String(error)),
      );
    } finally {
      if (timeout) clearTimeout(timeout);
      pingInFlight = false;
    }
  };

  const timer = setInterval(() => {
    void check();
  }, intervalMs);
  timer.unref?.();

  return stop;
}
