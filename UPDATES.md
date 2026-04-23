# 2026-04-23 - Resolve Active Merge Across CLI Expansion, Dashboard Cloud UI, SQLite Bootstrap, And Lockfile Drift

## Summary

Resolved the active merge by keeping the current branch's local-first runtime, storage, and docs behavior where it already matched the `custom` line, selectively retaining the incoming expanded CLI and Cloud dashboard UI where those additions were coherent, and regenerating `package-lock.json` from the resolved manifest instead of hand-merging generated dependency data.

## What Was Done

- Resolved the broad current-vs-incoming conflict set in favor of the existing `custom` branch versions for the established runtime, config, lifecycle, docs, tool-definition, migration, and test files so the branch keeps its current local-first behavior and provider-agnostic embedding/search messaging.
- Merged `src/cli.ts` semantically so the current branch's safe `closeStorage().catch(() => {})` cleanup pattern remains intact while the incoming expanded CLI command surface is preserved instead of truncating execution at the earlier `program.parse(process.argv)` boundary.
- Rebuilt `src/dashboard/ui.ts` from the clean incoming side after the working-tree merge produced an invalid splice of two incompatible dashboard templates; this preserves the coherent Cloud Pro tab and matching client-side handlers rather than trying to keep the broken hybrid file.
- Merged `src/storage/sqlite.ts` semantically so the current branch's embedding-retry and ledger-storage behavior stays intact while the incoming `prism_projects` and `prism_project_members` bootstrap tables are retained.
- Kept the current embedding helper imports in `src/storage/supabase.ts` to avoid regressing the persistent embedding repair flow.
- Rebuilt `package-lock.json` canonically with `npm install --package-lock-only --ignore-scripts` rather than attempting a manual merge of generated dependency metadata.

## Files Changed

- `.env.example`
- `.gitignore`
- `CHANGELOG.md`
- `README.md`
- `ROADMAP.md`
- `package-lock.json`
- `package.json`
- `src/backgroundScheduler.ts`
- `src/cli.ts`
- `src/config.ts`
- `src/dashboard/server.ts`
- `src/dashboard/ui.ts`
- `src/lifecycle.ts`
- `src/server.ts`
- `src/storage/interface.ts`
- `src/storage/reconcile.ts`
- `src/storage/sqlite.ts`
- `src/storage/supabase.ts`
- `src/storage/supabaseMigrations.ts`
- `src/tools/definitions.ts`
- `src/tools/graphHandlers.ts`
- `src/tools/ledgerHandlers.ts`
- `src/utils/supabaseApi.ts`
- `supabase/migrations/035_rpc_soft_delete_and_write_security.sql`
- `supabase/migrations/039_verification_runs.sql`
- `supabase/migrations/040_pipeline_orchestration_overrides.sql`
- `tests/residual-distribution.test.ts`
- `tests/tools/graphHandlers.test.ts`
- `tests/verification/cli-integration.test.ts`
- `training/benchmark.py`
- `training/grpo_align.py`
- `UPDATES.md`

## Verification Performed

- Confirmed the resolved repository files no longer contain merge conflict markers.
- Staged the resolved merge files and confirmed `git diff --name-only --diff-filter=U` returned no unmerged paths.
- Ran `npm run lint:dashboard` successfully.
- Ran `npm run build` successfully after fixing one merged `VALID_COLUMNS` syntax error in `src/storage/sqlite.ts`.
- Ran `npm exec vitest run tests/verification/cli-integration.test.ts tests/tools/graphHandlers.test.ts tests/lifecycle-lock.test.ts tests/backgroundScheduler.embeddingRetry.test.ts` successfully as focused regression coverage for the merged runtime areas.
- Ran `npm exec vitest run tests/residual-distribution.test.ts` as part of the wider focused suite; one pre-existing long-running case timed out at the file's 10s per-test limit.
- Re-ran the isolated `high-residualNorm vectors (>P95) maintain R@5 > 85% (d=128)` case and confirmed it still times out under the same 10s limit while printing the expected metrics first, indicating a runtime-sensitive test timeout rather than a merge-specific assertion regression.

# 2026-04-23 - Remove `.github/copilot-instructions.md` From `custom` History And Tracking

## Summary

Rewrote the `custom` branch to remove `.github/copilot-instructions.md` from all branch commits while preserving the other file changes in those commits, then restored the file locally as an untracked working copy.

## What Was Done

- Rewrote `custom` with a path-only history filter so mixed commits kept their non-instructions changes and commits that only touched `.github/copilot-instructions.md` were dropped.
- Verified the rewritten branch no longer contains any commits for `.github/copilot-instructions.md` and that the file is absent at `HEAD`.
- Restored `.github/copilot-instructions.md` into the working tree from the pre-rewrite backup branch and added it to `.git/info/exclude` so it remains local-only without changing the repository's tracked ignore rules.

## Files Changed

- `UPDATES.md`

## Verification Performed

- Confirmed `git log --oneline --decorate -- .github/copilot-instructions.md` returns no commits on `custom` after the rewrite.
- Confirmed `.github/copilot-instructions.md` is untracked after restoring the local-only copy.
- Preserved the pre-rewrite branch state on `backup/custom-before-strip-copilot-instructions-history-20260423`.

# 2026-04-22 - Resolve Active Merge Across Scholar Config, Supabase Migrations, CLI Drift Tests, And Roadmap Versioning

## Summary

Resolved the active merge conflict by keeping the current branch's richer runtime/config abstractions, restoring required compatibility exports for Web Scholar, appending the incoming research-task bridge as a new Supabase auto-migration, regenerating `package-lock.json`, and rewriting the conflicted roadmap file to match the current `v11.5.1` line.

## What Was Done

- Merged `src/config.ts` semantically so the current Google credential parser and Prism-scoped Brave Answers aliasing remain intact, `SEMANTIC_SCHOLAR_API_KEY` is exported for Web Scholar, and the legacy `GOOGLE_SEARCH_API_KEY` / `GOOGLE_SEARCH_CX` exports remain available as compatibility shims for single-credential callers.
- Kept the helper-based startup flow already present in `src/server.ts`, resolving the conflict in favor of the existing `scheduleDeferredAutoPush(server);` call instead of inlining duplicate startup orchestration.
- Merged `src/storage/supabase.ts` so the existing ledger embedding retry helpers stay imported, avoiding regression in the persistent embedding repair flow.
- Merged `src/storage/supabaseMigrations.ts` by preserving auto-migration versions `39` through `43` and appending the incoming `research_tasks_bridge` schema as version `44`, rather than reusing an occupied version number.
- Merged `tests/verification/cli-integration.test.ts` semantically so the test uses the built CLI with `node dist/cli.js`, keeps the current stronger drift assertions, and removes the broken `execOpts` / duplicated-force-case merge leftovers.
- Recreated `ROADMAP.md` with the concise current-branch roadmap content aligned to the existing `v11.x` line and regenerated `package-lock.json` from `package.json` instead of hand-merging generated dependency metadata.

## Files Changed

- `ROADMAP.md`
- `package-lock.json`
- `src/config.ts`
- `src/server.ts`
- `src/storage/supabase.ts`
- `src/storage/supabaseMigrations.ts`
- `tests/verification/cli-integration.test.ts`
- `UPDATES.md`

## Verification Performed

- Confirmed the resolved files no longer contain merge conflict markers.
- Ran `npm run build` successfully.
- Ran `npm exec vitest run tests/verification/cli-integration.test.ts tests/scholar/webScholar.test.ts tests/utils/google-search.test.ts` successfully.

# 2026-04-18 - Resolve Active Merge Across Split Provider Messaging, README Drift, And Lockfile Regeneration

## Summary

Resolved the active merge conflict by preserving the split text-vs-embedding provider behavior in semantic search and ledger embedding flows, reconciling the README around offline local embeddings plus separate Google and Brave credentials, and regenerating `package-lock.json` from the current `package.json` manifest.

## What Was Done

- Merged `src/dashboard/server.ts` and `src/tools/graphHandlers.ts` semantically so semantic-search failures keep the provider-agnostic embedding guidance already covered by tests, instead of regressing to generic LLM-provider wording.
- Merged `src/tools/ledgerHandlers.ts` semantically so `session_save_ledger` and `session_save_experience` keep the guarded embedding queue via `getEmbeddingProviderOrNull()` and only advertise queued embeddings when a provider is actually available.
- Merged `src/tools/definitions.ts` semantically so `brave_web_search` and `brave_web_search_code_mode` keep the current Google-backed descriptions, `brave_answers` still documents its separate Brave Answers credential path, and the research-paper analysis comments reflect the configured-provider implementation while preserving the stable tool name.
- Reconciled `README.md` so it now documents offline semantic search via `embedding_provider=local`, keeps the separate Google web-search and Brave Answers credential paths, and uses an offline-first MCP config example that points readers to the full environment-variable reference for optional keys.
- Rebuilt `package-lock.json` with `npm install --package-lock-only` rather than attempting to hand-merge generated dependency metadata, then ran `npm install` locally so the declared `@huggingface/transformers` dependency was present for build verification.

## Files Changed

- `src/dashboard/server.ts`
- `src/tools/definitions.ts`
- `src/tools/graphHandlers.ts`
- `src/tools/ledgerHandlers.ts`
- `README.md`
- `package-lock.json`
- `UPDATES.md`

## Verification Performed

- Ran `npm install --package-lock-only` successfully.
- Ran `npm exec vitest run tests/tools/graphHandlers.test.ts tests/tools/ledgerHandlers.embedding.test.ts` successfully.
- Ran `npm run build` successfully after syncing local dependencies with `npm install` so `@huggingface/transformers` was available in `node_modules`.
- Ran `git diff --check` successfully.
- Confirmed the resolved files no longer contain merge conflict markers before staging.

# 2026-04-16 - Resolve Active Merge Across Memory Security Hardening And Ledger Embedding Guards

## Summary

Resolved the active merge conflict by keeping the stored prompt-injection sanitization added to `src/tools/ledgerHandlers.ts`, preserving the existing non-empty ledger embedding guard, and regenerating `package-lock.json` from the current `package.json` manifest instead of hand-merging generated lockfile drift.

## What Was Done

- Merged `src/tools/ledgerHandlers.ts` semantically so `sessionSaveLedgerHandler()` now sanitizes `summary`, `todos`, and `decisions` before persistence while still rejecting blank sanitized ledger content before any storage write or embedding work begins.
- Kept the rest of the handler behavior unchanged, including keyword extraction from the sanitized text, storage writes, and the fire-and-forget embedding patch flow.
- Rebuilt `package-lock.json` with `npm install --package-lock-only` rather than attempting a manual merge of generated dependency metadata.

## Files Changed

- `src/tools/ledgerHandlers.ts`
- `package-lock.json`
- `UPDATES.md`

## Verification Performed

- Ran `npm install --package-lock-only` successfully.
- Ran `npm exec vitest run tests/tools/ledgerHandlers.embedding.test.ts tests/intent-classification.test.ts` successfully.
- Ran `npm run build` successfully.
- Ran `git diff --check` successfully.

# 2026-04-15 - Resolve Active Merge Across Lifecycle Lock Handling And Lockfile Drift

## Summary

Resolved the active merge conflict by keeping the tested procfs-based lifecycle lock handling in `src/lifecycle.ts` and regenerating `package-lock.json` from the current `package.json` manifest instead of hand-merging stale dependency drift.

## What Was Done

- Merged `src/lifecycle.ts` semantically so Linux stale-PID parent inspection continues to read `/proc/<pid>/stat`, preserves the safe `unknown` parent-state fallback, and does not reintroduce the `ps`-based orphan check that previously broke slim Compose environments.
- Kept the surrounding background-task shutdown behavior already present in `src/lifecycle.ts` while removing only the conflicting `child_process` import and orphan-detection implementation.
- Planned `package-lock.json` resolution through canonical npm regeneration from `package.json` rather than attempting to reconcile the conflicting transitive dependency sections manually.

## Files Changed

- `src/lifecycle.ts`
- `package-lock.json`
- `UPDATES.md`

## Verification Performed

- Regenerated `package-lock.json` successfully with `npm install --package-lock-only`.
- Ran `npm exec vitest run tests/lifecycle-lock.test.ts` successfully.
- Ran `npm run build` successfully.
- Ran `git diff --check` successfully before staging the resolved merge files.
- Staged the resolved merge files and confirmed `git diff --name-only --diff-filter=U` returned no unmerged paths.

# 2026-04-12 - Resolve Active Merge Across TurboQuant Ranking And Lockfile Drift

## Summary

Resolved the active merge conflict by keeping the tested residual-norm tiebreaker for SQLite TurboQuant fallback ranking and regenerating `package-lock.json` from `package.json` instead of hand-merging transitive dependency drift.

## What Was Done

- Merged `src/storage/sqlite.ts` semantically so Tier-2 TurboQuant fallback ranking now matches the existing Supabase behavior by using the optional residual-norm tiebreaker when similarity scores fall within `PRISM_TURBOQUANT_TIEBREAKER_EPSILON`.
- Kept the `_residualNorm` cleanup before returning SQLite semantic-search results so the internal tiebreaker field does not leak through the public result shape.
- Rebuilt `package-lock.json` with npm rather than attempting to hand-merge the conflicting transitive dependency entries.

## Files Changed

- `src/storage/sqlite.ts`
- `package-lock.json`
- `UPDATES.md`

## Verification Performed

- Regenerated `package-lock.json` successfully with `npm install --package-lock-only`.
- Confirmed the resolved files no longer contain merge conflict markers.
- Ran `npm test -- tests/residual-tiebreaker.test.ts -t residualNorm` successfully.
- Ran `npm run build` successfully.
- Staged the resolved merge files and ran `git diff --cached --check` successfully.
- Confirmed `git diff --name-only --diff-filter=U` returned no unmerged files.

# 2026-04-09 - Resolve Active Merge Across Compose Config And Dashboard-First Supabase Runtime

## Summary

Resolved the active merge conflict by keeping the custom branch's Docker Compose environment template, preserving the upstream dashboard-first Supabase credential behavior, and regenerating `package-lock.json` instead of hand-merging dependency drift.

## What Was Done

- Resolved `.env.example` in favor of the existing Compose-oriented template so the documented defaults stay aligned with `docker-compose.yml`, including `PRISM_DASHBOARD_PORT=3001`, `PRISM_SUPABASE_URL=http://rest:3000`, empty `PRISM_SUPABASE_API_PREFIX`, and `PRISM_BRAVE_ANSWERS_API_KEY`.
- Merged `src/config.ts` semantically so Google search credential parsing and Prism-scoped Brave Answers alias support remain intact while optional `BRAVE_API_KEY` and `BRAVE_ANSWERS_API_KEY` warnings stay gated behind `PRISM_DEBUG_LOGGING`.
- Merged `src/utils/supabaseApi.ts` semantically so `SUPABASE_URL` and `SUPABASE_KEY` are read from `process.env` at request time for dashboard-injected credentials, while the API-prefix-aware URL builder remains intact for raw PostgREST and `/rest/v1` deployments.
- Resolved the comment-only conflict in `tests/verification/cli-integration.test.ts` with the more explicit local-dev environment note.
- Rebuilt `package-lock.json` from `package.json` with npm instead of attempting a manual lockfile merge.

## Files Changed

- `.env.example`
- `package-lock.json`
- `src/config.ts`
- `src/utils/supabaseApi.ts`
- `tests/verification/cli-integration.test.ts`
- `UPDATES.md`

## Verification Performed

- Regenerated `package-lock.json` successfully with `npm install --package-lock-only`.
- Confirmed the resolved merge files no longer contain merge conflict markers.
- Ran `npm run build` successfully.
- Ran `npm test -- tests/verification/cli-integration.test.ts tests/utils/google-search.test.ts tests/storage/supabase-memory-links.test.ts` successfully.
- Confirmed Git no longer reports merge-conflict entries for the repository.
- Ran `git diff --cached --check` for the resolved merge files successfully. A repository-wide staged `git diff --cached --check` still reports pre-existing whitespace issues in unrelated staged files outside this merge.

# 2026-04-09 - Fallback Disabled Web Search Code Mode To Standard Search

## Summary

Changed disabled `brave_web_search_code_mode` behavior so direct calls now fall back to the standard Google-backed `brave_web_search` path instead of failing with a config error.

## What Was Done

- Updated `src/server.ts` so the `brave_web_search_code_mode` dispatch branch routes disabled requests to `webSearchHandler()` with only `query`, `count`, and `offset` forwarded.
- Added focused coverage in `tests/server-base-tools.test.ts` proving the disabled code-mode path still stays hidden from runtime discovery and that direct calls now use the standard web-search handler instead of the code-mode handler.
- Updated `README.md` to document that `PRISM_DISABLE_BRAVE_WEB_SEARCH_CODE_MODE=true` degrades direct calls to standard Google-backed web search rather than rejecting them.

## Files Changed

- `src/server.ts`
- `tests/server-base-tools.test.ts`
- `README.md`
- `UPDATES.md`

## Verification Performed

- Ran `npm test -- tests/server-base-tools.test.ts` successfully.
- Ran `npm run build` successfully.

# 2026-04-08 — Persist Embedding Retry State And Enforce Ledger Content At Storage Boundary

## Summary

Closed the two remaining embedding risks by enforcing non-empty ledger content inside both storage backends and by persisting embedding retry state so background maintenance can retry repairable missing embeddings automatically.

## What Was Done

- Extended `src/utils/ledgerEmbedding.ts` with shared validation, retry-eligibility, retry-count, and retry-state helpers so save-time embedding, manual backfill, and the scheduler all use one rule set.
- Updated `src/storage/interface.ts`, `src/storage/sqlite.ts`, and `src/storage/supabase.ts` so `saveLedger()` now rejects blank `summary`/`decisions` content even for direct internal callers, and newly saved ledger rows start with persistent embedding retry metadata.
- Added retry metadata columns and indexing to SQLite bootstrap/migrations and added the checked-in Supabase migration `supabase/migrations/043_embedding_retry_state.sql` plus auto-migration version 43 in `src/storage/supabaseMigrations.ts`.
- Updated `src/tools/hygieneHandlers.ts` so embedding backfill persists `ready`, `failed`, and `skipped` retry state, supports scheduler-only retry gating, and reports scanned rows for correct pagination.
- Updated `src/backgroundScheduler.ts` so scheduled maintenance now discovers ledger-only projects with repairable missing embeddings and retries them with backoff and retry caps.
- Updated `src/tools/ledgerHandlers.ts` and `src/utils/imageCaptioner.ts` so inline embedding attempts persist success or failure state instead of dropping failure details on the floor.
- Added focused regression coverage in `tests/storage/sqlite.test.ts`, `tests/utils/healthCheck.test.ts`, `tests/tools/hygieneHandlers.backfill.test.ts`, `tests/tools/ledgerHandlers.embedding.test.ts`, and the new `tests/backgroundScheduler.embeddingRetry.test.ts`.

## Files Changed

- `src/utils/ledgerEmbedding.ts`
- `src/storage/interface.ts`
- `src/storage/sqlite.ts`
- `src/storage/supabase.ts`
- `src/storage/supabaseMigrations.ts`
- `src/tools/hygieneHandlers.ts`
- `src/tools/ledgerHandlers.ts`
- `src/utils/imageCaptioner.ts`
- `src/backgroundScheduler.ts`
- `src/dashboard/server.ts`
- `supabase/migrations/043_embedding_retry_state.sql`
- `tests/storage/sqlite.test.ts`
- `tests/utils/healthCheck.test.ts`
- `tests/tools/hygieneHandlers.backfill.test.ts`
- `tests/tools/ledgerHandlers.embedding.test.ts`
- `tests/backgroundScheduler.embeddingRetry.test.ts`
- `UPDATES.md`

## Verification Performed

- Ran `npm test -- tests/tools/ledgerHandlers.embedding.test.ts tests/tools/hygieneHandlers.backfill.test.ts tests/utils/healthCheck.test.ts tests/storage/sqlite.test.ts tests/backgroundScheduler.embeddingRetry.test.ts` successfully.
- Ran `npm run build` successfully.
- Ran `git diff --check` successfully.

# 2026-04-07 — Fix Embedding Repair Eligibility Drift

## Summary

Fixed the Brain Health discrepancy where the dashboard counted a missing embedding as repairable, but the Fix Issues flow reported it as a failed repair because the ledger row had no embeddable text.

## What Was Done

- Added a shared ledger embedding-text helper in `src/utils/ledgerEmbedding.ts` so save-time embedding generation, backfill repair, and health classification all use the same trimmed `summary + decisions` eligibility rule.
- Updated `src/storage/sqlite.ts` and `src/storage/supabase.ts` so health stats now separate repairable missing embeddings from rows that have no embeddable text.
- Updated `src/utils/healthCheck.ts` so Brain Health reports a dedicated `unrepairable_embeddings` issue instead of implying every missing embedding can be auto-fixed.
- Updated `src/tools/hygieneHandlers.ts` and `src/dashboard/server.ts` so backfill and dashboard cleanup distinguish skipped no-text rows from true repair failures and surface the first failure reasons in the response message.
- Updated `src/tools/ledgerHandlers.ts` so `session_save_ledger` rejects blank content before it can create another ledger row with no embeddable text.
- Added focused regressions in `tests/utils/healthCheck.test.ts`, `tests/tools/hygieneHandlers.backfill.test.ts`, and `tests/tools/ledgerHandlers.embedding.test.ts`.

## Files Changed

- `src/utils/ledgerEmbedding.ts`
- `src/storage/interface.ts`
- `src/storage/sqlite.ts`
- `src/storage/supabase.ts`
- `src/utils/healthCheck.ts`
- `src/tools/hygieneHandlers.ts`
- `src/tools/ledgerHandlers.ts`
- `src/dashboard/server.ts`
- `tests/utils/healthCheck.test.ts`
- `tests/tools/hygieneHandlers.backfill.test.ts`
- `tests/tools/ledgerHandlers.embedding.test.ts`
- `tests/test_health_check.js`
- `UPDATES.md`

## Verification Performed

- Ran `npm test -- tests/tools/ledgerHandlers.embedding.test.ts tests/tools/hygieneHandlers.backfill.test.ts tests/utils/healthCheck.test.ts` successfully.
- Ran `npm run build` successfully.

# 2026-04-07 — Fix Supabase Memory Link RPC Source Id Ambiguity

## Summary

Fixed the Supabase `prism_create_link` RPC so PostgreSQL no longer hits a PL/pgSQL `source_id` ambiguity during memory-link upserts, and added a rollout migration so already-initialized databases receive the repaired function body automatically.

## What Was Done

- Updated the checked-in `prism_create_link` definition in `supabase/migrations/035_rpc_soft_delete_and_write_security.sql` to use `ON CONFLICT ON CONSTRAINT memory_links_pkey` instead of the identifier-based conflict target that can collide with `RETURNS TABLE` output variables in PL/pgSQL.
- Updated the mirrored startup auto-migration definition in `src/storage/supabaseMigrations.ts` so fresh installs ship the same corrected function body.
- Added `supabase/migrations/042_fix_prism_create_link_ambiguity.sql` and matching auto-migration version 42 so existing Compose and Supabase databases recreate the RPC on startup without requiring a manual schema reset.
- Added focused regression coverage in `tests/storage/supabase-memory-links.test.ts` for both the checked-in migration SQL and the Supabase storage create-link RPC payload path.

## Files Changed

- `supabase/migrations/035_rpc_soft_delete_and_write_security.sql`
- `supabase/migrations/042_fix_prism_create_link_ambiguity.sql`
- `src/storage/supabaseMigrations.ts`
- `tests/storage/supabase-memory-links.test.ts`
- `UPDATES.md`

## Verification Performed

- Ran `npm test -- tests/storage/supabase-memory-links.test.ts` successfully.
- Ran `npm run build` successfully.
- Confirmed the live Compose `db` logs showed the exact failing `prism_create_link` statement with `ON CONFLICT (source_id, target_id, link_type)` and the matching `column reference "source_id" is ambiguous` error before the repair.
- Applied `supabase/migrations/042_fix_prism_create_link_ambiguity.sql` directly to the running Compose PostgreSQL instance and verified `public.prism_create_link()` returned a row successfully inside a rollback transaction.
- Rebuilt and restarted the Compose `prism` service, then verified the startup auto-migration runner recorded and applied schema version 42 (`fix_prism_create_link_ambiguity`).
- Checked fresh `docker compose logs db` output after the restart and confirmed there were no new `source_id` ambiguity errors.

# 2026-04-06 — Honor Prism-Scoped Google Web Search Credentials

## Summary

Fixed Google-backed `brave_web_search` credential resolution so direct runtime startup now accepts `PRISM_GOOGLE_SEARCH_CREDENTIALS` and the matching Prism-scoped single-value aliases, instead of only working when a launcher script copied them into unscoped environment variables.

## What Was Done

- Updated `src/config.ts` so Google web search credentials resolve from `GOOGLE_SEARCH_CREDENTIALS` first, then `PRISM_GOOGLE_SEARCH_CREDENTIALS`, and similarly fall back through `GOOGLE_SEARCH_API_KEY`/`GOOGLE_SEARCH_CX` before the Prism-scoped single-value aliases.
- Kept the existing precedence order so explicitly unscoped Google search variables still win when both forms are present.
- Extended `tests/utils/google-search.test.ts` with focused coverage for Prism-scoped structured credentials, Prism-scoped single credentials, and precedence when both scoped and unscoped variables exist.

## Files Changed

- `src/config.ts`
- `tests/utils/google-search.test.ts`
- `UPDATES.md`

## Verification Performed

- Ran `npm test -- tests/utils/google-search.test.ts` successfully.
- Ran `npm run build` successfully.

# 2026-04-05 — Allow Semantic Search Via Any Embedding Provider

## Summary

Removed the stale Gemini-only gate from MCP session semantic search so the tool now works with any configured embedding provider, including OpenAI-compatible local endpoints such as Ollama.

## What Was Done

- Updated `src/tools/graphHandlers.ts` so `session_search_memory` resolves embeddings through `getLLMProvider()` instead of hard-failing when `GOOGLE_API_KEY` is absent.
- Reused the resolved provider for query embedding generation and replaced the Google-specific configuration error with a provider-agnostic message that points users to Dashboard -> AI Providers.
- Updated the empty-results guidance in `src/tools/graphHandlers.ts` so it refers to saved embeddings from the configured provider instead of `GOOGLE_API_KEY`.
- Updated the dashboard semantic-search API error text in `src/dashboard/server.ts` to match the provider-agnostic runtime behavior.
- Added focused unit coverage in `tests/tools/graphHandlers.test.ts` proving semantic search proceeds with a mocked embedding provider and returns the new configuration error when no provider is available.

## Files Changed

- `src/tools/graphHandlers.ts`
- `src/dashboard/server.ts`
- `tests/tools/graphHandlers.test.ts`
- `UPDATES.md`

## Verification Performed

- Ran `npm test -- tests/tools/graphHandlers.test.ts` successfully.
- Ran `npm run build` successfully.

# 2026-04-05 — Resolve Runtime Merge Across Transport And Tool Enumeration

## Summary

Resolved the active merge across the custom branch transport/dashboard runtime work and the incoming upstream provider and tool-enumeration changes, then regenerated the npm lockfile from `package.json`.

## What Was Done

- Merged `src/config.ts` so the custom HTTP/dashboard transport exports (`PRISM_MCP_TRANSPORT`, `PRISM_MCP_PORT`, `PRISM_MCP_PATH`, `PRISM_DASHBOARD_PORT`) remain intact alongside the upstream `VOYAGE_API_KEY` export.
- Reconciled `src/server.ts` so `getAllPossibleTools()` remains exported for dashboard/scanner enumeration, `getAvailableTools()` keeps the runtime filtering path, `ALL_BASE_TOOLS` is used for unconditional capability listing, and `createServer()` still tracks active resource subscriptions.
- Resolved the `README.md` environment-table conflict by documenting `VOYAGE_API_KEY`, `OPENAI_API_KEY`, and the clearer `BRAVE_ANSWERS_API_KEY` note explaining that Brave Answers is separate from Google-backed web search credentials.
- Chose the generated-file path for `package-lock.json` so it can be rebuilt canonically from the current `package.json` instead of hand-merging transitive dependency drift.

## Files Changed

- `src/config.ts`
- `src/server.ts`
- `README.md`
- `package-lock.json`
- `UPDATES.md`

## Verification Performed

- Pending after conflict resolution: rebuild the lockfile with `npm install`, then run `git diff --check`, `npm run build`, `npm run lint:dashboard`, and focused runtime/provider tests.

# 2026-04-05 — Repair Brain Health Embedding Backfill Failures

## Summary

Fixed the Brain Health embedding repair failure by removing a Gemini-only save-time gate, making OpenAI auto-mode reuse an embedding-shaped model when no dedicated embedding model is saved, and exposing that effective OpenAI embedding configuration in the dashboard. Then repaired the live backlog by saving the missing OpenAI embedding model setting and rerunning health cleanup.

## What Was Done

- Confirmed the live Brain Health report on `http://<host>/api/health` was global across active ledger entries, not a `BRAIN HEALTH` project, and that the affected rows contained real summaries/decisions rather than empty or corrupt text.
- Fixed `src/tools/ledgerHandlers.ts` so `session_save_ledger` and `session_save_experience` queue embeddings whenever `getLLMProvider()` is available instead of only when `GOOGLE_API_KEY` is set.
- Added `resolveOpenAIEmbeddingModel()` in `src/utils/llm/adapters/openai.ts` so OpenAI embeddings prefer `openai_embedding_model` when configured, but fall back to `openai_model` when OpenAI embeddings are effectively active and that model clearly looks like an embedding model (for example `qwen3-embedding:0.6b`).
- Updated `src/dashboard/ui.ts` so the OpenAI embedding-model field appears when embeddings effectively resolve to OpenAI through `embedding_provider=auto` with `text_provider=openai`, and preloads the effective embedding model into the field.
- Added focused regressions in `tests/llm/openai.test.ts` and `tests/tools/ledgerHandlers.embedding.test.ts` covering the OpenAI model-resolution fix and the removal of the `GOOGLE_API_KEY`-only save-time gate.
- Repaired the live stuck backlog by saving `openai_embedding_model=qwen3-embedding:0.6b` through `POST /api/settings` and then calling `POST /api/health/cleanup`, which repaired the missing embeddings successfully.

## Files Changed

- `src/tools/ledgerHandlers.ts`
- `src/utils/llm/adapters/openai.ts`
- `src/dashboard/ui.ts`
- `tests/llm/openai.test.ts`
- `tests/tools/ledgerHandlers.embedding.test.ts`
- `UPDATES.md`

## Verification Performed

- Ran `npm test -- tests/llm/openai.test.ts tests/llm/factory.test.ts tests/tools/ledgerHandlers.embedding.test.ts` successfully.
- Ran `npm run lint:dashboard` successfully.
- Ran `npm run build` successfully.
- Called `POST /api/settings` on the live dashboard to save `openai_embedding_model=qwen3-embedding:0.6b` and confirmed via `curl` that `/api/settings` now returns that value.
- Called `POST /api/health/cleanup` on the live dashboard and received a successful repair response with repaired embeddings.
- Verified via direct `curl` with cache-busting query params that the live `/api/health` endpoint now reports `healthy` with no remaining issues.

# 2026-04-04 — Restore Verification Schema In Compose

## Summary

Fixed the missing `public.verification_runs` relation in the local Docker Compose PostgreSQL flow by bringing the verification schema under the runtime auto-migration path and adding the missing tenant-parity columns required by the Supabase storage layer.

## What Was Done

- Confirmed the live Compose database had `prism_schema_versions` through 38, but neither `verification_harnesses` nor `verification_runs` existed because versions 39 and 40 were never being applied automatically.
- Applied the existing checked-in verification SQL migrations (`039_verification_runs.sql` and `040_pipeline_orchestration_overrides.sql`) to the running Compose database to restore the missing tables immediately.
- Added versions 39 and 40 to `src/storage/supabaseMigrations.ts` with idempotent SQL so existing Supabase/PostgREST deployments auto-apply the verification schema on startup instead of depending on a separate manual replay of `supabase/migrations/*.sql`.
- Added `supabase/migrations/041_verification_user_id_parity.sql` and matching auto-migration version 41 so PostgreSQL verification tables gain the `user_id` columns and `idx_verification_runs_user` index already expected by `src/storage/supabase.ts` and already present in SQLite.
- Added `NOTIFY pgrst, 'reload schema'` to the verification migrations so PostgREST refreshes its schema cache after the tables or columns are created, avoiding stale-cache `column ... does not exist` errors immediately after migration application.

## Files Changed

- `src/storage/supabaseMigrations.ts`
- `supabase/migrations/041_verification_user_id_parity.sql`
- `UPDATES.md`

## Verification Performed

- Queried the live Compose database before the fix and confirmed `to_regclass('public.verification_runs')` and `to_regclass('public.verification_harnesses')` were empty.
- Confirmed the live migration tracker contained versions through 38 but not the verification schema.
- Applied the missing verification SQL migrations to the Compose database and verified both verification tables were created.
- Confirmed after creation that PostgreSQL verification tables still lacked `user_id`, justifying the new parity migration.
- Ran `npm run build` successfully.
- Ran `npm test -- tests/verification/supabase-verification.test.ts` successfully.
- Rebuilt and restarted the Compose `prism` service, then verified the runtime auto-migration tracker recorded versions 39, 40, and 41.
- Verified the live PostgreSQL schema now includes `verification_harnesses.user_id`, `verification_runs.user_id`, `verification_runs.gate_override`, and `verification_runs.override_reason`.
- Sent `NOTIFY pgrst, 'reload schema'` to refresh PostgREST after the DDL changes, then verified an authenticated `SupabaseStorage.listVerificationRuns()` call inside the running `prism` container returned `[]` successfully.
- Checked fresh `docker compose logs db` output after the authenticated verification query and confirmed there were no new `verification_runs` relation, missing-column, or permission errors.

# 2026-04-04 — Resolve Active Merge Conflict

## Summary

Resolved the active dashboard merge cleanup by restoring the template to the hand-authored source form and merging the upstream safety and intent-health deltas without keeping the transient transpiled artifact.

## What Was Done

- Replaced the bad merged `src/dashboard/ui.ts` worktree state that had TypeScript-transpiled helper output embedded inside the dashboard template script with the committed source version.
- Reapplied the intended merge behaviors in `src/dashboard/ui.ts`: `abortPipeline(this.dataset.id)` button wiring, last-project restore via `localStorage`, project-tab visibility repair via `projectLoaded`, and the intent-health card fetch/render flow.
- Pulled in the upstream escaping fixes for pipeline status content, project selectors, decision badges, and the shared `escapeHtml()` helper so the merged dashboard does not reintroduce raw HTML injection paths.
- Kept the rest of the dashboard logic on the readable source form already tracked in the repository instead of preserving the transient transpiled merge artifact.

## Files Changed

- `src/dashboard/ui.ts`
- `UPDATES.md`

## Verification Performed

- Ran `git diff --check` successfully after resolving the dashboard merge.
- Ran `npm run lint:dashboard` successfully.
- Ran `npm run build` successfully.
- Verified the edited files report no diagnostics in the workspace.

# 2026-04-03 — Add Env Gate For Web Search Code Mode

## Summary

Added an opt-out runtime flag for `brave_web_search_code_mode` so operators can remove that tool from normal runtime discovery and reject direct calls without changing the static sandbox capability export.

## What Was Done

- Added `PRISM_DISABLE_BRAVE_WEB_SEARCH_CODE_MODE` in `src/config.ts`.
- Updated `src/server.ts` so `buildRuntimeBaseTools()` hides `brave_web_search_code_mode` from the normal runtime tool list when the flag is enabled.
- Added a direct-call guard in `src/server.ts` so explicit invocations of `brave_web_search_code_mode` fail with a clear disabled-by-config error when the flag is enabled.
- Left the sandbox/scanner export path unchanged so static capability enumeration still exposes the full catalog.
- Updated `.env.example`, `docker-compose.yml`, `README.md`, and `docs/permissions-when-google-search-api.md` to surface the new flag and clarify its runtime behavior.
- Extended `tests/server-base-tools.test.ts` so the focused runtime discovery test covers the new disable flag alongside the existing Brave Answers gating.

## Files Changed

- `src/config.ts`
- `src/server.ts`
- `tests/server-base-tools.test.ts`
- `.env.example`
- `docker-compose.yml`
- `README.md`
- `docs/permissions-when-google-search-api.md`
- `UPDATES.md`

## Verification Performed

- Ran `npm run build` successfully.
- Ran `npm test -- tests/server-base-tools.test.ts` successfully.

# 2026-04-03 — Resolve Custom Branch Merge With Upstream Runtime Work

## Summary

Resolved the active merge across the custom branch transport and Docker work and the incoming upstream runtime features, keeping the custom HTTP/Docker/search-credential behavior while integrating the newer scheduler, scholar, watchdog, task-router, HDC, and Dark Factory runtime paths.

## What Was Done

- Merged the runtime conflicts in `src/config.ts`, `src/dashboard/server.ts`, `src/lifecycle.ts`, `src/server.ts`, and `src/tools/ledgerHandlers.ts` without dropping either branch's valid behavior.
- Kept the custom branch HTTP transport and dashboard configuration (`PRISM_MCP_TRANSPORT`, `PRISM_MCP_PORT`, `PRISM_MCP_PATH`, `PRISM_DASHBOARD_PORT`) while preserving the newer storage/runtime feature flags from upstream.
- Restored the dashboard stale-port cleanup path and combined the newer background-task shutdown flow with the custom shutdown hooks and parent-process handling.
- Unified server startup so background services are scheduled once from shared runtime initialization, and re-added the compatibility `notifyResourceUpdate(project, server)` export required by existing handlers.
- Resolved the docs and env-template conflicts in `.env.example` and `README.md`, then updated `docker-compose.yml` so the documented runtime flags and API key pass-throughs are actually wired into the Prism container.
- Preserved the callback-based handoff notification path in `src/tools/ledgerHandlers.ts` so per-server resource update behavior continues to work.
- Installed already-declared npm dependencies that were missing locally so the merged tree could be validated successfully.

## Files Changed

- `.env.example`
- `README.md`
- `docker-compose.yml`
- `src/config.ts`
- `src/dashboard/server.ts`
- `src/lifecycle.ts`
- `src/server.ts`
- `src/tools/ledgerHandlers.ts`
- `UPDATES.md`

## Verification Performed

- Checked the resolved merge files for leftover conflict markers.
- Ran `npm install` to restore missing declared dependencies in the local workspace.
- Ran `npm run build` successfully.
- Ran `vitest run tests/server-base-tools.test.ts tests/utils/google-search.test.ts tests/http-mcp.test.ts tests/lifecycle-lock.test.ts` successfully.

# 2026-03-30 — Clarify Brave Answers Credential Wiring

## Summary

Clarified that Brave Answers has a separate credential path from Google-backed web search, added a Prism-scoped alias for the Brave Answers key, and stopped advertising `brave_answers` at runtime when that credential is absent.

## What Was Done

- Added `PRISM_BRAVE_ANSWERS_API_KEY` support in `src/config.ts` as a Prism-scoped alias for `BRAVE_ANSWERS_API_KEY`.
- Updated `docker-compose.yml` and `docker-start-prism.sh` so the checked-in Docker launcher path can pass the Prism-scoped Brave Answers credential through to the runtime.
- Changed `src/server.ts` so `brave_answers` is listed in normal runtime tool discovery only when a Brave Answers key is configured, while sandbox/scanner enumeration still exposes the full static capability set.
- Updated the `brave_answers` tool description in `src/tools/definitions.ts` to explicitly state that it does not use Google search credentials.
- Updated `.env.example`, `README.md`, and `docs/permissions-when-google-search-api.md` to distinguish `PRISM_GOOGLE_SEARCH_CREDENTIALS` from the separate Brave Answers credential.
- Added focused tests covering the Prism-scoped alias and runtime tool gating for `brave_answers`.

## Files Changed

- `src/config.ts`
- `src/server.ts`
- `src/tools/definitions.ts`
- `docker-compose.yml`
- `docker-start-prism.sh`
- `.env.example`
- `README.md`
- `docs/permissions-when-google-search-api.md`
- `tests/utils/google-search.test.ts`
- `tests/server-base-tools.test.ts`
- `UPDATES.md`

## Verification Performed

- Added targeted tests for the new alias and runtime tool gating.
- Ran `npm test -- tests/utils/google-search.test.ts tests/server-base-tools.test.ts` successfully.
- Ran `npm run build` successfully.

# 2026-03-30 — Document Env-Gated Permissions For Ask And Plan

## Summary

Added a focused permissions note explaining that `brave_web_search` now runs on Google Programmable Search when Google search credentials are set, and documented the read-only Prism permission set appropriate for `Ask` and `Plan` modes.

## What Was Done

- Added `docs/permissions-when-google-search-api.md`.
- Documented that the public tool names and permission names remain unchanged even though the `brave_web_search` backend now uses Google when Google search credentials are configured.
- Grouped the relevant read-only permissions by environment variable requirements:
	- Google web search credentials
	- `BRAVE_API_KEY`
	- `BRAVE_ANSWERS_API_KEY`
	- `GOOGLE_API_KEY`
	- `SUPABASE_URL` + `SUPABASE_KEY`
	- `PRISM_ENABLE_HIVEMIND=true`
- Included a practical allow-list example for `Ask` and `Plan` modes, then corrected the recommended section for GitHub Copilot custom agents to use a `tools:` list with raw MCP tool names instead of Claude-style permission IDs.

## Files Changed

- `docs/permissions-when-google-search-api.md`
- `UPDATES.md`

## Verification Performed

- Verified the permission/tool names and runtime gating against `src/tools/definitions.ts`, `src/tools/index.ts`, `src/server.ts`, and `src/config.ts`.

# 2026-03-30 — Migrate Web Search to Google + Multi-Key Channel Pairs

## Summary

Replaced Brave web-search calls with Google Programmable Search while keeping existing MCP tool names stable, and added support for multiple Google credential pairs (`apiKey` + associated `cx` channel) with either ordered failover or random single-request selection.

## What Was Done

- Added Google web-search credential parsing in `src/config.ts` with three configuration paths:
	- `GOOGLE_SEARCH_CREDENTIALS` JSON array of `{apiKey, cx}` pairs for ordered failover, or object form with `{strategy, credentials}` for failover or random selection (also accepts `channel` as alias for `cx`)
	- Indexed pairs (`GOOGLE_SEARCH_API_KEY_1` + `GOOGLE_SEARCH_CX_1`, etc.)
	- Single pair fallback (`GOOGLE_SEARCH_API_KEY` + `GOOGLE_SEARCH_CX`)
- Updated web search execution in `src/utils/braveApi.ts` to call Google Programmable Search (`customsearch/v1`) and normalize responses into the existing `web.results` shape expected by handlers and code-mode scripts.
- Implemented ordered credential failover for web search in `src/utils/braveApi.ts` on credential/quota-related failures (401/403/429 and credential-related 400 reasons), plus optional random selection of one configured pair per request when `GOOGLE_SEARCH_CREDENTIALS` uses `{"strategy":"random","credentials":[...]}`.
- Kept public MCP tool names unchanged (`brave_web_search`, `brave_web_search_code_mode`) while updating tool descriptions in `src/tools/definitions.ts` to reflect Google as the backend.
- Updated runtime/startup wiring for credentials:
	- `run_server.sh` now validates Google web-search credentials instead of requiring `BRAVE_API_KEY`
	- `docker-compose.yml` now passes Prism-scoped Google search env vars
	- `docker-start-prism.sh` maps Prism-scoped Google vars to runtime `GOOGLE_SEARCH_*` vars
- Updated configuration docs and metadata in `README.md`, `.env.example`, `server.json`, and `examples/langgraph-agent/README.md` to describe Google web-search setup and multi-key options.
- Added targeted tests in `tests/utils/google-search.test.ts` covering credential parsing precedence, incomplete credential rejection, normalized response mapping, failover behavior, and random single-request selection.

## Files Changed

- `src/config.ts`
- `src/utils/braveApi.ts`
- `src/tools/definitions.ts`
- `src/tools/handlers.ts`
- `run_server.sh`
- `docker-compose.yml`
- `docker-start-prism.sh`
- `.env.example`
- `README.md`
- `server.json`
- `examples/langgraph-agent/README.md`
- `tests/utils/google-search.test.ts` (new)
- `UPDATES.md`

## Verification Performed

- Ran `npm run build` successfully.
- Ran `npm test -- tests/utils/google-search.test.ts` successfully.

## Notes for Future Work

- `brave_local_search`, `brave_local_search_code_mode`, and `brave_answers` remain Brave-backed and still depend on Brave credentials.

# 2026-03-29 — Add Opt-In HTTP MCP Transport

## Summary

Added an opt-in Streamable HTTP transport for Prism MCP while keeping stdio as the default runtime and package behavior.

## What Was Done

- Refactored server startup in `src/server.ts` so runtime initialization is shared across stdio and HTTP transports.
- Updated the package/module entrypoint in `index.ts` to dispatch through the configured transport so HTTP mode works consistently outside the direct `src/server.ts` execution path.
- Moved MCP resource subscription state to each server instance instead of a process-global set, preventing cross-session leakage when multiple HTTP clients connect.
- Added `src/http/server.ts` with a dedicated Streamable HTTP `/mcp` endpoint backed by the MCP SDK's `StreamableHTTPServerTransport`.
- Added transport configuration in `src/config.ts` for `PRISM_MCP_TRANSPORT`, `PRISM_MCP_PORT`, and `PRISM_MCP_PATH`.
- Extended lifecycle shutdown handling so HTTP mode can close its listener and active sessions without relying on stdin-close semantics.
- Updated `docker-compose.yml`, `.env.example`, and `tests/setup.ts` for the new opt-in HTTP transport settings.
- Documented the HTTP mode in `README.md` and clarified in `GITHUB_COPILOT.md` that Copilot should still prefer stdio.

## Files Changed

- `src/config.ts`
- `src/dashboard/server.ts`
- `src/http/server.ts`
- `index.ts`
- `src/lifecycle.ts`
- `src/server.ts`
- `src/tools/sessionMemoryHandlers.ts`
- `tests/http-mcp.test.ts`
- `tests/setup.ts`
- `docker-compose.yml`
- `.env.example`
- `README.md`
- `GITHUB_COPILOT.md`
- `UPDATES.md`

## Verification Performed

- Ran `npm run build` successfully.
- Added and ran `npm test -- tests/http-mcp.test.ts` to verify HTTP initialize, session reuse, invalid-session rejection, and DELETE teardown.

## Notes for Future Work

- The HTTP implementation currently targets modern Streamable HTTP only; deprecated SSE compatibility was intentionally left out.
- If HTTP mode needs to be exposed outside localhost or a trusted network, add TLS and stronger authentication via a reverse proxy rather than bolting it into the MCP runtime.

# 2026-03-29 — Complete GitHub Copilot Setup Guide

## Summary

Replaced the placeholder `GITHUB_COPILOT.md` with a repo-accurate setup guide for GitHub Copilot in VS Code and GitHub Copilot CLI when Docker Compose runs on a remote server and the Copilot client runs on a laptop.

## What Was Done

- Rewrote the guide around the repository's `docker-compose.yml` as the only supported path in the document, with Docker running on a remote server.
- Added the server-side bootstrap steps: copy `.env.example`, start `db` and `rest`, and apply the SQL migrations through `docker compose exec`.
- Added a concrete migration-verification section showing how to confirm the required tables, RPCs, and version rows exist after applying SQL on the server.
- Corrected the documented `psql` examples to use `POSTGRES_USER` and `POSTGRES_DB` inside the `db` container, avoiding the `role "root" does not exist` failure caused by missing `PRISM_DB_*` variables in that container.
- Documented GitHub Copilot in VS Code using `.vscode/mcp.json` with an `ssh` command that runs `docker compose run --rm -T prism` on the remote server.
- Documented GitHub Copilot CLI using the same remote-SSH pattern via `/mcp add` or `~/.copilot/mcp-config.json`.
- Added the optional SSH tunnel plus `--service-ports` flow for reaching the dashboard from the laptop.
- Explained why Copilot should spawn a one-off remote `prism` container instead of attaching to a separately started long-running `prism` service.

## Files Changed

- `GITHUB_COPILOT.md`
- `UPDATES.md`

## Verification Performed

- Verified the documentation against the current code in `docker-compose.yml`, `docker-start-prism.sh`, and `.env.example`, plus the stdio launch model exposed by the Node entrypoint.
- Cross-checked current GitHub documentation for GitHub Copilot MCP support in VS Code, GitHub Copilot CLI MCP configuration, and Copilot coding-agent MCP JSON semantics.

## Notes for Future Work

- If the remote-launch flow is later changed to use a checked-in wrapper script instead of raw `ssh ... docker compose run`, update this guide and keep the VS Code and CLI examples aligned.

# 2026-03-27 — Configure Service Ports via .env

## Summary

Implemented centralized, .env-driven port configuration for local services and startup env loading.

## What Was Done

- Updated `docker-compose.yml` to remove hardcoded service ports and use environment variable interpolation with safe defaults.
- Parameterized PostgreSQL service values:
	- Host/container ports (`PRISM_DB_HOST_PORT`, `PRISM_DB_PORT`)
	- DB credentials and name (`PRISM_DB_USER`, `PRISM_DB_PASSWORD`, `PRISM_DB_NAME`)
	- Healthcheck port usage (`pg_isready -p ${PRISM_DB_PORT}`)
- Parameterized PostgREST service values:
	- Host/container ports (`PRISM_REST_HOST_PORT`, `PRISM_REST_PORT`)
	- DB URI composition from DB env vars
	- Schema/role/JWT settings (`PRISM_REST_DB_SCHEMAS`, `PRISM_REST_DB_ANON_ROLE`, `PRISM_REST_JWT_SECRET`)
	- Explicit `PGRST_SERVER_PORT` from `PRISM_REST_PORT`
- Updated application startup config in `src/config.ts` to load `.env` at process start using `dotenv/config`.
- Added `.env.example` as the central template for local port and related service settings.
- Updated `README.md` to document env-driven dashboard/local stack ports and added new variables to the environment table.

## Files Changed

- `docker-compose.yml`
- `src/config.ts`
- `.env.example` (new)
- `README.md`

## Verification Performed

- Ran `docker compose config` successfully to confirm variable interpolation and defaults resolve correctly.
- Confirmed compose output shows expected published/target ports and generated service env values.

## Notes for Future Work

- The repo currently has no committed `.env`; use `.env.example` as the source of truth when onboarding or changing service ports.
- If changing host ports, ensure downstream MCP config values (for example `SUPABASE_URL`) match the chosen PostgREST host port.
- Local TypeScript build verification was not fully runnable in this environment because `tsc` was unavailable (`sh: 1: tsc: not found`).

# 2026-03-28 — Set DB Timezone to Australia/Brisbane

## Summary

Configured the PostgreSQL container to use the `Australia/Brisbane` timezone.

## What Was Done

- Updated `docker-compose.yml` `db` service environment with `TZ: Australia/Brisbane`.

## Files Changed

- `docker-compose.yml`

## Notes for Future Work

- Recreate or restart the `db` container for timezone changes to take effect in the running container.

# 2026-03-28 — Add Local PostgreSQL Auth Override

## Summary

Added a repo-owned `pg_hba.conf` and mounted it into the local PostgreSQL container to bypass the upstream `supabase_map` peer-auth mismatch for custom database roles.

## What Was Done

- Added `pg_hba.conf` at the repository root.
- Mounted the file directly over the image's default `/etc/postgresql/pg_hba.conf` path so the packaged PostgreSQL config remains intact.
- Added a one-shot `db-bootstrap` service plus `docker-bootstrap-db.sh` to create or update the configured app role and database when an existing volume predates the current `.env` values.
- Made the bootstrap script discover a usable local superuser role instead of assuming a `postgres` role exists in the cluster.
- Extended the bootstrap script to create the Supabase compatibility roles required by the image and migration set (`supabase_admin`, `anon`, `authenticated`, `service_role`) in addition to the configured local anon role.
- Changed the `db` healthcheck to probe TCP readiness directly instead of depending on any role or database that may not exist yet on older volumes.
- Made `027_auto_migration_infra.sql` safely rerunnable by dropping and recreating its policies if a previous partial run already created them.
- Kept TCP connections password-authenticated with `scram-sha-256` while allowing local socket startup/auth flows to avoid the failing peer map.

## Files Changed

- `pg_hba.conf` (new)
- `docker-bootstrap-db.sh` (new)
- `docker-compose.yml`
- `UPDATES.md`

## Verification Performed

- Ran `docker compose config` successfully to confirm the auth override file mount, bootstrap service, and dependency graph render correctly.

## Notes for Future Work

- Recreate the `db` container after auth-file changes so PostgreSQL reloads the mounted `pg_hba.conf`.
- If local startup still fails after the HBA override, inspect whether the upstream image also relies on a custom `pg_ident.conf` mapping and bring that file into the repo as well.

# 2026-03-28 — Add Compose-Managed Prism App Service

## Summary

Added a `prism` service to the local Docker Compose stack so the Prism Node process and Mind Palace dashboard can run inside Compose alongside PostgREST.

## What Was Done

- Added a new `prism` service in `docker-compose.yml` that builds from the existing repository Dockerfile.
- Configured the service to run `npm run build && npm start` via `/bin/sh -lc` so the chained command executes correctly in the container.
- Published the dashboard port from `PRISM_DASHBOARD_PORT` and kept the service dependent on `rest`.
- Introduced `PRISM_SUPABASE_URL` and `PRISM_SUPABASE_KEY` in `.env.example` so the container can receive explicit `SUPABASE_URL` and `SUPABASE_KEY` values without forcing host-side `.env` users onto the internal `rest` hostname.
- Left `PRISM_SUPABASE_KEY` blank by default so the service does not send an invalid bearer token to PostgREST when no local JWT is configured.
- Updated `README.md` to note that `docker compose up -d` now starts the `prism` app container as part of the local stack.

## Files Changed

- `docker-compose.yml`
- `.env.example`
- `README.md`
- `UPDATES.md`

## Notes for Future Work

- The Prism MCP server is stdio-based, so verify your MCP client can use a Compose-managed Prism process before treating the `prism` service as the primary MCP launch path.
- If you need health-gated startup for `prism`, add a healthcheck to `rest` first so `depends_on` can wait for API readiness rather than simple process start.

# 2026-03-28 — Refresh npm Lockfile for Docker Builds

## Summary

Regenerated `package-lock.json` so Docker builds using `npm ci` no longer fail on an out-of-sync dependency graph.

## What Was Done

- Reproduced the install failure locally with `env -u NODE_OPTIONS npm ci --ignore-scripts`.
- Confirmed the lockfile was missing the `esbuild@0.27.4` entry expected by the current Vitest/Vite dependency graph.
- Ran `npm install --package-lock-only` to refresh `package-lock.json` without changing `package.json` dependencies.

## Files Changed

- `package-lock.json`
- `UPDATES.md`

## Verification Performed

- `env -u NODE_OPTIONS npm install --package-lock-only`

## Notes for Future Work

- Keep `package-lock.json` updated whenever dev tooling changes, because the Dockerfile intentionally uses `npm ci` for reproducible installs.

# 2026-03-28 — Fix Prism Compose PostgREST Path + JWT Wiring

## Summary

Fixed the Compose-managed Prism app so it can authenticate to the local PostgREST container and call the raw PostgREST root-path RPCs instead of assuming hosted Supabase's `/rest/v1` prefix.

## What Was Done

- Switched the `prism` service back to the existing `docker-start-prism.sh` entrypoint so startup can prepare auth and readiness checks before launching the app.
- Extended `docker-start-prism.sh` to export `SUPABASE_API_PREFIX` from `PRISM_SUPABASE_API_PREFIX`, alongside a generated local JWT fallback that uses `PRISM_DB_USER` as its role claim.
- Added `SUPABASE_API_PREFIX` support in `src/config.ts` and `src/utils/supabaseApi.ts`, defaulting to `/rest/v1` for hosted Supabase while allowing an empty prefix for raw PostgREST.
- Updated local `.env`, `.env.example`, and `README.md` to set `PRISM_SUPABASE_URL=http://rest:3000` and `PRISM_SUPABASE_API_PREFIX=` for the Compose stack.

## Files Changed

- `docker-compose.yml`
- `docker-start-prism.sh`
- `src/config.ts`
- `src/utils/supabaseApi.ts`
- `.env`
- `.env.example`
- `README.md`
- `UPDATES.md`

## Verification Performed

- Pending runtime verification after recreating the `prism` container with the restored entrypoint and raw-PostgREST prefix settings.

## Notes for Future Work

- If a reverse proxy is later added in front of PostgREST, set `PRISM_SUPABASE_API_PREFIX=/rest/v1` for the local stack and keep the docs aligned.

# 2026-03-28 — Persist Prism Compose State Across Restarts

## Summary

Persisted the Compose-managed Prism app's local state directory so dashboard settings survive container recreation.

## What Was Done

- Added a named `prism_state` volume to the `prism` service in `docker-compose.yml` and mounted it at `/root/.prism-mcp`.
- Kept the existing config-storage path unchanged, so `prism-config.db`, local SQLite data, and related Prism state now survive `./restart.sh` and `docker compose down`.
- Updated `README.md` to document that normal Compose restarts preserve dashboard settings, while `docker compose down -v` intentionally resets them.

## Files Changed

- `docker-compose.yml`
- `README.md`
- `UPDATES.md`

## Verification Performed

- Ran `docker compose config` and confirmed the resolved `prism` service mounts the named `prism_state` volume at `/root/.prism-mcp`.
- Recreated the `prism` container with `docker compose up -d --build prism` and confirmed `/root/.prism-mcp` exists inside the container.
- Wrote a sentinel file into `/root/.prism-mcp`, force-recreated the `prism` container, and confirmed the file persisted across recreation.

## Notes for Future Work

- If the Compose image or runtime user changes away from root, update the mount target to match the new home directory so `~/.prism-mcp` remains persistent.

# 2026-03-28 — Fix Prism Compose Lifecycle PID Inspection

## Summary

Removed the Prism lifecycle lock check's runtime dependency on `ps` so the Compose-managed Prism service no longer misclassifies live processes as zombies in the slim Docker image.

## What Was Done

- Replaced the Linux orphan-process check in `src/lifecycle.ts` with direct `/proc/<pid>/stat` parent inspection instead of shelling out to `ps`.
- Hardened the stale-PID logic so an inconclusive parent inspection preserves the existing lock instead of blindly killing a live process.
- Added a focused `tests/lifecycle-lock.test.ts` regression suite covering both the safe fallback path and the Linux procfs zombie-detection path.

## Files Changed

- `src/lifecycle.ts`
- `tests/lifecycle-lock.test.ts` (new)
- `UPDATES.md`

## Verification Performed

- Ran `npm exec vitest run tests/lifecycle-lock.test.ts` and confirmed both lifecycle stale-PID regression cases pass.
- Rebuilt and started the Compose-managed Prism service with `docker compose up -d --build prism`.
- Checked `docker compose logs prism --tail=120` and confirmed the service starts without `/bin/sh: 1: ps: not found` or the false zombie-process termination path.

## Notes for Future Work

- If non-Linux orphan detection needs to be as strict as the Linux path, add an explicit platform-specific parent-inspection implementation rather than reintroducing shell-command dependencies.
