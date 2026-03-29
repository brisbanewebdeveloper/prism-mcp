/**
 * Server Lifecycle Management
 * Handles singleton PID locking, graceful shutdown, and SQLite handle cleanup.
 *
 * CRITICAL: All logging MUST use console.error() (stderr).
 * Using console.log() (stdout) will corrupt the MCP JSON-RPC stream.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { closeConfigStorage } from "./storage/configStorage.js";
import { getStorage } from "./storage/index.js";
import { shutdownTelemetry } from "./utils/telemetry.js";

const PRISM_DIR = path.join(os.homedir(), ".prism-mcp");

/**
 * Instance-aware PID file.
 * Set PRISM_INSTANCE env var to run multiple Prism MCP servers
 * side-by-side (e.g. "athena-public" and "prism-mcp").
 * Each instance gets its own PID file to prevent lock conflicts.
 */
const INSTANCE_NAME = process.env.PRISM_INSTANCE || "default";
const PID_FILE = path.join(PRISM_DIR, `server-${INSTANCE_NAME}.pid`);

function log(msg: string) {
  console.error(`[Prism Lifecycle] ${msg}`);
}

export interface ShutdownHandlerOptions {
  watchStdin?: boolean;
  onShutdown?: () => Promise<void> | void;
}

let shutdownHandlersRegistered = false;

type ProcessParentState = "managed" | "orphaned" | "missing" | "unknown";

function inspectLinuxParentState(pid: number): ProcessParentState {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8").trim();
    const closingParen = stat.lastIndexOf(")");

    if (closingParen === -1) {
      return "unknown";
    }

    const fields = stat.slice(closingParen + 2).trim().split(/\s+/);
    const ppid = fields[1];

    if (!ppid) {
      return "unknown";
    }

    return ppid === "1" ? "orphaned" : "managed";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "missing";
    }

    log(`Warning: Failed to inspect parent for PID ${pid}: ${error}`);
    return "unknown";
  }
}

function inspectUnixParentState(pid: number): ProcessParentState {
  if (process.platform === "win32") {
    return "managed";
  }

  if (process.platform === "linux") {
    return inspectLinuxParentState(pid);
  }

  return "unknown";
}

/**
 * Checks if a process is an orphan (adopted by init/launchd, PPID=1).
 * Returns a safe state so unknown parent inspection never becomes a blind kill.
 */
function getParentState(pid: number): ProcessParentState {
  return inspectUnixParentState(pid);
}

/**
 * Ensures valid server execution state.
 *
 * LOGIC:
 * 1. If --no-lock is passed, skip everything (testing mode).
 * 2. If PID file exists:
 *    - If process is dead: Overwrite lock.
 *    - If process is alive AND is an orphan (PPID=1): Kill it (Zombie), then overwrite.
 *    - If process is alive AND has a parent: Log warning, allow coexistence (don't kill).
 *    - If process inspection is inconclusive: Preserve the lock and avoid blind cleanup.
 */
export function acquireLock() {
  if (process.argv.includes("--no-lock")) {
    log("Lock acquisition skipped (--no-lock flag)");
    return;
  }

  if (!fs.existsSync(PRISM_DIR)) {
    fs.mkdirSync(PRISM_DIR, { recursive: true });
  }

  if (fs.existsSync(PID_FILE)) {
    try {
      const oldPid = parseInt(fs.readFileSync(PID_FILE, "utf8").trim(), 10);

      if (oldPid && oldPid !== process.pid) {
        let isAlive = false;
        try {
          process.kill(oldPid, 0); // 0 signal checks for existence
          isAlive = true;
        } catch {
          isAlive = false;
        }

        if (isAlive) {
          const parentState = getParentState(oldPid);

          if (parentState === "orphaned") {
            log(`Found zombie process (PID ${oldPid}, PPID=1). Terminating...`);
            try {
              process.kill(oldPid, "SIGTERM");
              // Give it 100ms to die, then force kill if needed
              setTimeout(() => {
                try { process.kill(oldPid, "SIGKILL"); } catch {}
              }, 100);
            } catch (e) {
              log(`Failed to kill zombie: ${e}`);
            }
          } else if (parentState === "managed") {
            // It has a parent (e.g., another VS Code window or Claude Desktop)
            log(`Existing server (PID ${oldPid}) is active and managed. Coexisting...`);
            // We do NOT overwrite the PID file here.
            // If we overwrite it, the *active* server will fail to clean up
            // the PID file when it eventually shuts down.
            return;
          } else if (parentState === "unknown") {
            log(`Warning: Could not verify parent for active PID ${oldPid}. Preserving existing lock.`);
            return;
          }
        }
      }
    } catch (err) {
      log(`Warning: Failed to process existing PID file: ${err}`);
    }
  }

  // Claim the lock for this process
  try {
    fs.writeFileSync(PID_FILE, process.pid.toString(), "utf8");
    log(`Acquired singleton lock (PID ${process.pid})`);
  } catch (err) {
    log(`Warning: Failed to write PID file: ${err}`);
  }
}

/**
 * Registers handlers to close SQLite file handles cleanly when the server stops.
 */
export function registerShutdownHandlers(options: ShutdownHandlerOptions = {}) {
  if (shutdownHandlersRegistered) {
    return;
  }

  shutdownHandlersRegistered = true;
  let shuttingDown = false;

  const shutdown = async (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`Shutting down gracefully (${reason})...`);

    try {
      await options.onShutdown?.();

      // 0. Flush OTel span buffer FIRST — before any DBs are closed.
      //    BatchSpanProcessor holds spans in memory (up to 5s). If we close
      //    DBs first, spans that reference DB operations lose their context.
      //    shutdownTelemetry() is a no-op when otel_enabled=false.
      await shutdownTelemetry();

      // 1. Close system settings DB
      closeConfigStorage();

      // 2. Close main ledger DB
      const storage = await getStorage();
      if (storage && typeof storage.close === "function") {
        await storage.close();
      }

      // 3. Remove PID lockfile (only if WE own it)
      if (fs.existsSync(PID_FILE)) {
        try {
          const storedPid = parseInt(fs.readFileSync(PID_FILE, "utf8").trim(), 10);
          if (storedPid === process.pid) {
            fs.unlinkSync(PID_FILE);
          }
        } catch {
          // Ignore read errors during shutdown
        }
      }
    } catch (err) {
      log(`Error during shutdown cleanup: ${err}`);
    } finally {
      process.exit(0);
    }
  };

  // OS Signals
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGHUP", () => shutdown("SIGHUP"));

  // MCP Client Disconnect (CRITICAL)
  if (options.watchStdin !== false) {
    process.stdin.on("close", () => {
      shutdown("CLIENT_DISCONNECTED_STDIN_CLOSED");
    });
  }
}
