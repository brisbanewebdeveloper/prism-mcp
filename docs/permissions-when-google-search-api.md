# Permissions When Google Search API Is Configured

`brave_web_search` and `brave_web_search_code_mode` keep their existing MCP tool names, but on this branch they use Google Programmable Search when Google search credentials are configured.

## Key Point

- Tool name stays the same: `brave_web_search`
- Backend changes to Google when one of these is configured:
	- `GOOGLE_SEARCH_CREDENTIALS`
	- `GOOGLE_SEARCH_API_KEY` + `GOOGLE_SEARCH_CX`
	- Indexed pairs such as `GOOGLE_SEARCH_API_KEY_1` + `GOOGLE_SEARCH_CX_1`

If your MCP client uses explicit permission IDs, the permission string is usually the MCP server prefix plus the tool name.

- Raw tool name: `brave_web_search`
- Claude-style permission ID: `mcp__prism-mcp__brave_web_search`

## Important Runtime Behavior

- Most base search and analysis tools are listed by the server even when their API keys are missing.
- `brave_web_search_code_mode` is hidden from the normal runtime tool list and rejects direct calls when `PRISM_DISABLE_BRAVE_WEB_SEARCH_CODE_MODE=true`.
- `brave_answers` is only listed when `BRAVE_ANSWERS_API_KEY` or `PRISM_BRAVE_ANSWERS_API_KEY` is configured.
- Permission alone is not enough. The matching environment variable must also be set or the tool call will fail at runtime.
- Hivemind tools are different: they are only added to the tool list when `PRISM_ENABLE_HIVEMIND=true`.

## Read-Only Permissions For Ask And Plan

For `Ask` and `Plan` modes, the useful set is the read-only subset. Both modes can use the same allow list if you want them to read web, memory, and team context without mutating anything.

### Google Search Credentials

Set one of these:

- `GOOGLE_SEARCH_CREDENTIALS`
- `GOOGLE_SEARCH_API_KEY` + `GOOGLE_SEARCH_CX`
- Indexed pairs such as `GOOGLE_SEARCH_API_KEY_1` + `GOOGLE_SEARCH_CX_1`

Permissions to allow:

- `brave_web_search`
- `brave_web_search_code_mode`

Claude-style permission IDs:

- `mcp__prism-mcp__brave_web_search`
- `mcp__prism-mcp__brave_web_search_code_mode`

Notes:

- These tools now use Google Programmable Search, not Brave web search.
- `brave_web_search_code_mode` is the same search backend plus a JavaScript extraction step.
- If `PRISM_DISABLE_BRAVE_WEB_SEARCH_CODE_MODE=true`, only `brave_web_search` remains in the normal runtime tool list.

### Brave Local Search

Set:

- `BRAVE_API_KEY`

Permissions to allow:

- `brave_local_search`
- `brave_local_search_code_mode`

Claude-style permission IDs:

- `mcp__prism-mcp__brave_local_search`
- `mcp__prism-mcp__brave_local_search_code_mode`

### Brave Answers

Set:

- `BRAVE_ANSWERS_API_KEY`
- `PRISM_BRAVE_ANSWERS_API_KEY` when using the Prism Docker Compose launcher path

Permissions to allow:

- `brave_answers`

Claude-style permission ID:

- `mcp__prism-mcp__brave_answers`

Notes:

- This credential is separate from `GOOGLE_SEARCH_CREDENTIALS` and `PRISM_GOOGLE_SEARCH_CREDENTIALS`.
- The JSON structure used by Google web search credentials has no effect on `brave_answers`.

### Gemini Paper Analysis

Set:

- `GOOGLE_API_KEY`

Permissions to allow:

- `gemini_research_paper_analysis`

Claude-style permission ID:

- `mcp__prism-mcp__gemini_research_paper_analysis`

### Session Memory Read Tools

Set both:

- `SUPABASE_URL`
- `SUPABASE_KEY`

Permissions to allow:

- `session_load_context`
- `knowledge_search`
- `session_search_memory`
- `memory_history`
- `session_view_image`

Claude-style permission IDs:

- `mcp__prism-mcp__session_load_context`
- `mcp__prism-mcp__knowledge_search`
- `mcp__prism-mcp__session_search_memory`
- `mcp__prism-mcp__memory_history`
- `mcp__prism-mcp__session_view_image`

Notes:

- These are the read-oriented memory tools that fit `Ask` and `Plan` well.
- The server broadly advertises session-memory tools, but calls still fail unless `SUPABASE_URL` and `SUPABASE_KEY` are configured.

### Hivemind Team Context

Set:

- `SUPABASE_URL`
- `SUPABASE_KEY`
- `PRISM_ENABLE_HIVEMIND=true`

Permission to allow:

- `agent_list_team`

Claude-style permission ID:

- `mcp__prism-mcp__agent_list_team`

This is the read-only Hivemind tool. The write/update Hivemind tools are `agent_register` and `agent_heartbeat`, which are usually not needed for `Ask` or `Plan` if you want those modes to stay read-only.

## Recommended Allow List

For GitHub Copilot custom agents in VS Code, use MCP tool names in the agent `tools` list, not Claude-style `mcp__...` permission IDs.

If you want `Ask` and `Plan` to have the same read-only Prism access, this is the practical set to grant when the matching environment variables are present:

```yaml
tools:
	- brave_web_search
	- brave_web_search_code_mode
	- brave_local_search
	- brave_local_search_code_mode
	- brave_answers
	- gemini_research_paper_analysis
	- session_load_context
	- knowledge_search
	- session_search_memory
	- memory_history
	- session_view_image
	- agent_list_team
```

You can use that same list in both your `Ask.agent.md` and `Plan.agent.md` files.

Example:

```yaml
---
name: Ask
model: GPT-5 (copilot)
tools:
	- brave_web_search
	- brave_web_search_code_mode
	- brave_local_search
	- brave_local_search_code_mode
	- brave_answers
	- gemini_research_paper_analysis
	- session_load_context
	- knowledge_search
	- session_search_memory
	- memory_history
	- session_view_image
	- agent_list_team
---
```

Only include tools whose environment requirements are actually configured.

If `brave_answers` is missing from the advertised tool list, the runtime does not currently have `BRAVE_ANSWERS_API_KEY` or `PRISM_BRAVE_ANSWERS_API_KEY` available.

If you want to expose every tool from this MCP server to a Copilot custom agent, VS Code also supports the server wildcard form:

```yaml
tools:
	- prism-mcp/*
```

That is broader than a read-only `Ask` or `Plan` setup, so enumerating the specific tools is the safer option.

## Summary

- `brave_web_search` still uses the same permission name.
- With Google search credentials set, that permission now executes against Google Programmable Search.
- For `Ask` and `Plan`, prefer the read-only permissions above so those modes can inspect search, memory, and team context without changing state.
