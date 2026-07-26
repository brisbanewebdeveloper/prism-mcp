#!/usr/bin/env node

import { execFileSync } from "node:child_process";

function workingTreeStatus(repoRoot) {
  return execFileSync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
}

try {
  const status = workingTreeStatus(process.cwd());
  if (status) {
    console.error(
      "npm publish blocked: the Prism working tree is not clean.\n" +
        "Commit, move, or restore every change before publishing:\n" +
        status,
    );
    process.exitCode = 1;
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`npm publish blocked: unable to verify Git state: ${message}`);
  process.exitCode = 1;
}
