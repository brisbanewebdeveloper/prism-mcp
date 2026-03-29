import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";

vi.mock("fs", () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock("os", () => ({
  homedir: vi.fn(() => "/tmp/prism-test-home"),
}));

vi.mock("../src/storage/configStorage.js", () => ({
  closeConfigStorage: vi.fn(),
}));

vi.mock("../src/storage/index.js", () => ({
  getStorage: vi.fn(async () => null),
}));

vi.mock("../src/utils/telemetry.js", () => ({
  shutdownTelemetry: vi.fn(async () => undefined),
}));

describe("acquireLock() stale PID handling", () => {
  const mockExistsSync = vi.mocked(fs.existsSync);
  const mockReadFileSync = vi.mocked(fs.readFileSync);
  const mockWriteFileSync = vi.mocked(fs.writeFileSync);
  const originalPlatform = process.platform;
  const originalArgv = process.argv;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.spyOn(os, "homedir").mockReturnValue("/tmp/prism-test-home");
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    process.argv = ["node", "server.js"];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    process.argv = originalArgv;
  });

  it("does not kill a live process when parent inspection is inconclusive", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | 0) => {
      if (signal === 0) {
        return true;
      }

      throw new Error(`unexpected kill for pid ${pid}`);
    }) as typeof process.kill);

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation((filePath) => {
      const path = String(filePath);
      if (path.endsWith("server-default.pid")) {
        return "69";
      }

      const error = new Error("permission denied") as NodeJS.ErrnoException;
      error.code = "EACCES";
      throw error;
    });

    const { acquireLock } = await import("../src/lifecycle.js");
    acquireLock();

    expect(killSpy).toHaveBeenCalledWith(69, 0);
    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Could not verify parent for active PID 69")
    );
  });

  it("uses Linux procfs parent inspection instead of ps and reclaims orphaned stale locks", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | 0) => {
      if (signal === 0) {
        return true;
      }

      return true;
    }) as typeof process.kill);

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation((filePath) => {
      const path = String(filePath);
      if (path.endsWith("server-default.pid")) {
        return "69";
      }

      if (path === "/proc/69/stat") {
        return "69 (node) S 1 1 1 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 12345 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0";
      }

      throw new Error(`unexpected read: ${path}`);
    });

    const { acquireLock } = await import("../src/lifecycle.js");
    acquireLock();

    expect(killSpy).toHaveBeenNthCalledWith(1, 69, 0);
    expect(killSpy).toHaveBeenNthCalledWith(2, 69, "SIGTERM");
    vi.runAllTimers();
    expect(killSpy).toHaveBeenNthCalledWith(3, 69, "SIGKILL");
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      "/tmp/prism-test-home/.prism-mcp/server-default.pid",
      process.pid.toString(),
      "utf8"
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Found zombie process (PID 69, PPID=1). Terminating...")
    );
  });
});
