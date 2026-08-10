# Tech Debt

Known deficiencies in shipped or parked code. Distinct from `ROADMAP.md`, which
tracks planned features. Each entry states the symptom, the evidence it rests
on, why it was not fixed at the time, and what "done" means.

Add an entry when you find a real defect you are deliberately not fixing.
Delete the entry when it ships, not when it is understood.

---

## 1. Small model tiers burn their budget inside `<think>`

**Symptom.** `prism_infer` enables thinking for any non-`route` mode. On 4b/2b
tiers the model spends the whole `num_predict` budget inside `<think>` and emits
no answer a measured ~44% of the time on 4b, then retries with think disabled.

**Impact.** Wasted latency and tokens on roughly half of small-tier calls. Not a
correctness bug: `prismInferHandler.ts` already recovers via the
`reason === "think_only"` fallback, so callers still get an answer.

**Why not fixed.** The fix exists on `fix/prism-infer-think-small-tiers` but was
written before `resolveThinkingMode()` was extracted, and the branch is >100
commits behind. It needs reimplementing, not merging.

**Done looks like.** `resolveThinkingMode()` also returns `false` when the
resolved tier tag ends in `:4b` or `:2b`, with an explicit `args.think` still
overriding, plus a test asserting a small tier defaults to think-off and a large
tier does not.

---

## 2. Grounded-inference work is parked with known defects

**Symptom.** `future/grounded-infer-review-r2` carries a real improvement — PHI
redaction before cloud inference — alongside two defects found in review on
2026-07-24:

- the redaction placeholder is treated as a matchable evidence span, so a claim
  citing only redacted text can pass the grounding check
- the coding-quality gate skips its syntax check when model output is not fenced

**Impact.** None today. None of it is on `main`; `evidence span` and
`coding gate` return zero files there. The debt is that a genuinely useful PHI
fix is stranded behind two defects.

**Why not fixed.** Landing it as-is would ship a grounding check that can be
satisfied by redacted text. The correct fix is to exclude the placeholder from
span matching and to normalise unfenced output before the syntax gate — both
larger than the review that found them.

**Done looks like.** Redaction placeholders are never valid evidence spans, the
syntax gate runs on unfenced output, and the PHI redaction lands on `main`.

---

## 3. Skill bodies are not delivered to every host

**Symptom.** `resolveNativeSkillsDirs()` mirrors skill files to the canonical
root, Claude Code, and Cursor. Hosts outside that list — Codex, Gemini — receive
skill *names* with no bodies, and no MCP tool serves skill content on demand.

**Impact.** Reduced, not eliminated. Since 20.5.1 the matched skill's body is
inlined directly into the startup display, so a symptom-triggered rule reaches
every host. But only the top match is inlined and only when routing fires;
outside that path those hosts still have names without content.

**Why not fixed.** Adding a host to the mirror assumes it reads that directory.
That assumption is unverified for both Codex and Gemini, and guessing at it
produced three wrong diagnoses before the inline was built.

**Done looks like.** Either each host's skill root is confirmed by observation
and added to the mirror, or a tool returns a skill body by name so any host can
fetch one.

---

## 4. Retrieval does not weight recency

**Symptom.** Grounding evidence carries each memory's age (external review,
2026-08-02), but retrieval ranks a two-year-old note the same as yesterday's.
Nothing detects contradiction between stored notes either — but that is the
lesser problem, see below.

**Impact.** Reordered 2026-08-03 after measuring a real store: 4751 of 4758
ledger entries predated the current month. At that shape a keyword search
returning ten results returns ten OLD ones, and the fresh note that supersedes
them is never retrieved at all.

That inverts the priority. The dangerous case is not a stale note shown BESIDE
a fresh one — the model can see both dates and weigh them. It is a stale note
retrieved ALONE, with nothing to contradict, where the age label is the only
defence left. Contradiction detection cannot help a query that never surfaces
the contradicting record.

So recency weighting is the fix that matters; contradiction detection is the
refinement on top. The reverse of how this entry was originally written.

**Why not fixed.** Recency weighting changes ranking for every query and needs
its own evaluation — a naive recency boost buries durable architectural
decisions under yesterday's noise, which is a different failure and arguably
worse. Surfacing age was the cheap half and shipped first.

**Constraint worth knowing.** A memory's content date can never be older than
its row. `saveLedger` binds both `created_at` and `session_date` to now and
discards the caller's values, and `patchLedger` rejects every date column. Only
a direct SQL write can backdate a row, which is how the existing history was
migrated. Good for integrity — provenance cannot be forged — but it means the
age label is strictly ROW age, so anything imported through the public API
reads as new regardless of how old its content is. Preferring `session_date`
over `created_at` is therefore correct in principle and inert in practice:
the two are equal on all 4758 existing rows.

`tests/integration/grounding-staleness.test.ts` runs the reviewer's probe.

**Done looks like.** Time-sensitive questions surface the newest relevant
records rather than the highest keyword match, without burying decisions that
are old and still true. Contradiction flagging comes after that, not before.

---

## 5. Free tier fetches the keyword table it cannot use

**Symptom.** On the native path `resolvePromptSkillNames()` runs before
entitlement filtering, so a free-tier caller fetches the public routing table
and then discards every match.

**Impact.** One avoidable request per first turn. No privacy or correctness
issue — the table is public and the prompt is never sent.

**Done looks like.** Skip the fetch when `entitledSkillNames` cannot satisfy any
match.

---

## 6. Gemini's agent flag lives in a namespace designed to be temporary

**Symptom.** `prism connect` disables Gemini's native subagents by writing
`experimental.enableAgents = false`. That is the path Gemini defines today, but
`experimental` exists precisely so that flags graduate out of it.

**Impact.** If Gemini promotes the flag, Prism keeps writing the old path and
Gemini reads the new one. Host subagents turn back on, nothing errors, no test
fails, and the settings file still reads `false`. The failure is silent and the
config looks correct — the hardest shape to diagnose from the outside.

**Why not fixed.** There is nothing to detect against until Gemini moves it, and
guessing at a future key name would write dead config now. Documented in the
README instead, so the next person reading a `false` flag beside running agents
knows to check whether the key moved.

**Done looks like.** `connect` verifies the flag took effect — reads Gemini's
resolved config back, or asserts the key still exists where it was written —
rather than assuming the write landed somewhere Gemini reads.

---

## 7. Skill content is a distribution channel with no leak guard

**Symptom.** Skills are bundled and served to users through the manifest, so
anything written into a `SKILL.md` reaches other machines. The repository-level
private-identifier guard covers tracked source in this repo; it does not run
against skill content authored elsewhere.

**Impact.** A machine-specific path or internal identifier written into a skill
would be distributed. Caught once by review on 2026-08-02, before commit.

**Done looks like.** The same identifier-class scan runs over skill bodies as
part of bundle generation, failing the build rather than relying on review.
