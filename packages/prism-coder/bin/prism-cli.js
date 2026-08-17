#!/usr/bin/env node
// Thin shim — delegates to prism-mcp-server's CLI (prism connect, route-prompt, …).
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

let cliPath;
try {
  cliPath = require.resolve('prism-mcp-server/dist/cli.js');
} catch {
  process.stderr.write(
    'prism-coder: could not resolve prism-mcp-server. Run: npm install\n'
  );
  process.exit(1);
}

await import(cliPath);
