/**
 * Minimum evidence contract shared by every MCP host.
 *
 * Native-skill hosts also receive the full evidence-first protocol. Keep this
 * compact copy in MCP initialize instructions so hosts without a filesystem
 * skill surface, including Claude Desktop, still follow the same workflow.
 */
export const EVIDENCE_WORKFLOW_POLICY_LINES = [
  "## Prism evidence workflow",
  "During diagnosis and editing, one trustworthy correlated reproduction is enough; do not block coding on",
  "inspecting unrelated diagnostic screenshots, trace frames, or abandoned attempts.",
  "Before a completion claim, push, or release, exercise the corrected path with fresh evidence from the current",
  "build and bind stateful proof to the exact run and entity. Inspect every artifact used to support the claim.",
  "A screenshot is an observation, not absolute truth. Reject stale, wrong-run, wrong-entity, or visibly failing",
  "evidence even when its metadata says passed.",
] as const;

export const EVIDENCE_WORKFLOW_POLICY_TEXT = EVIDENCE_WORKFLOW_POLICY_LINES.join(" ");
