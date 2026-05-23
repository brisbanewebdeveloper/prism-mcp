import { describe, expect, it, vi } from "vitest";
import { exec } from "child_process";
import { killPortHolder } from "../../src/dashboard/server.js";

vi.mock("child_process", () => ({
  exec: vi.fn(),
}));

describe("killPortHolder", () => {
  it("quietly skips cleanup when the port lookup command is unavailable", async () => {
    const execMock = vi.mocked(exec);
    execMock.mockImplementation(((_command: string, _options: unknown, callback: unknown) => {
      const done = callback as (error: Error | null, stdout: string, stderr: string) => void;
      done(Object.assign(new Error("lsof: not found"), { code: 127 }), "", "");
    }) as typeof exec);

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await killPortHolder(34001);

    expect(consoleErrorSpy).not.toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });
});
