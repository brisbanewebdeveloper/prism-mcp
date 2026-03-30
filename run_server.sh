#!/bin/bash
set -euo pipefail

has_google_search_credentials=0

if [ -n "${GOOGLE_SEARCH_CREDENTIALS:-}" ]; then
	has_google_search_credentials=1
elif [ -n "${GOOGLE_SEARCH_API_KEY:-}" ] && [ -n "${GOOGLE_SEARCH_CX:-}" ]; then
	has_google_search_credentials=1
elif printenv | grep -Eq '^GOOGLE_SEARCH_API_KEY_[0-9]+=.*' && printenv | grep -Eq '^GOOGLE_SEARCH_CX_[0-9]+=.*'; then
	has_google_search_credentials=1
fi

if [ "$has_google_search_credentials" -ne 1 ]; then
	echo "GOOGLE web search credentials are required. Set GOOGLE_SEARCH_CREDENTIALS, GOOGLE_SEARCH_API_KEY + GOOGLE_SEARCH_CX, or indexed GOOGLE_SEARCH_API_KEY_N + GOOGLE_SEARCH_CX_N pairs." >&2
	exit 1
fi

: "${GOOGLE_API_KEY:?GOOGLE_API_KEY is required}"

echo "Starting Brave-Gemini Research MCP Server..."
# Run the server
node dist/server.js
