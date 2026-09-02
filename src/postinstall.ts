/**
 * npm postinstall — the UPGRADE path for the prism-route hook, never the
 * install path. `prism connect` is typed once per machine and is the only
 * consent that first-installs the hook; this script merely refreshes hosts
 * that carry the managed marker from that explicit install (mode "auto" is
 * marker-gated in ensurePromptRouteHook). On any machine without the marker
 * — including every Claude Code plugin install, where npx runs this
 * package's lifecycle scripts — it is a no-op that writes nothing. Silent
 * and always-exit-0: a lifecycle script must never break `npm install`.
 */
import { ensurePromptRouteHook } from "./promptRouteHostHook.js";

try {
  const results = ensurePromptRouteHook({ mode: "auto" });
  if (process.env.PRISM_DEBUG) {
    for (const r of results) console.error(`[prism postinstall] ${r.host}: script=${r.script} config=${r.config}`);
  }
  // The ONE step install cannot do for the operator, said at the only moment
  // they are certainly watching. Codex's hook-trust gate exists so software
  // cannot approve its own execution — prism will never write that trust
  // state (a compromised release would otherwise gain silent
  // execute-on-every-prompt), so the honest maximum is to make the pending
  // approval impossible to miss. Approval is per hook-version, not per
  // release: it recurs only when the hook script itself changes.
  const codex = results.find((r) => r.host === "codex");
  if (codex && codex.codexApproval === "pending-or-unknown") {
    console.error(
      "\n[prism] Codex hook installed but NOT yet trusted — Codex silently skips it until you approve it once:\n" +
      "[prism]   codex  ->  /hooks  ->  entry ending prism-route/on_prompt.py  ->  press t\n",
    );
  }
} catch {
  /* never fail an install */
}
