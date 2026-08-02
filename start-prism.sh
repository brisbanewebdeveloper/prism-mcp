#!/bin/bash

# Start the actual server — exec keeps stdio pipes attached for MCP
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "$0" 2>/dev/null || echo "$0")")" && pwd)"
exec /usr/bin/env node "$SCRIPT_DIR/dist/server.js" "$@"
