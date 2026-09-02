/**
 * Protected-floor digest — the context-augmented half of skill delivery.
 *
 * The native bootstrap NAMES the protected floor and never carries its rules
 * (bodies live on disk under the skills root). Measured 2026-09-01 across
 * Codex rollout logs: the model re-reads SKILL.md files to recover them —
 * median 8 reads / 36KB per session, 823 reads / 5.1MB across 498
 * compactions in the worst — each a tool round trip on a host whose
 * per-result cap is 10K tokens. On Gemini and Cursor there is no prompt hook
 * at all, so the bootstrap is the only prism channel they ever get.
 *
 * A digest is not the rule. It is enough of the rule that the model knows
 * what is in force and where the full text lives, in ~350 chars instead of
 * ~3,000. Authors pin the wording with a `digest:` frontmatter key; without
 * one it is derived from the body — the leading substantive paragraphs,
 * each new section's heading kept in front of its first unit, then the
 * section headings as a map — so it works on every skill that exists today
 * with no pipeline change.
 *
 * Pure functions, no I/O: the bootstrap and the `prism floor-digest` CLI
 * (post-compaction re-injection via the host hook) render through the same
 * code so the two channels cannot drift.
 */

/** Per-skill ceiling. 16 floor skills × 360 ≈ 5.8K chars — under the 6K
 *  block budget and far under Claude Code's 10K-char hook context cap. */
export const SKILL_DIGEST_MAX_CHARS = 360;
/** Below this a digest is a name with punctuation; render names only. */
export const SKILL_DIGEST_MIN_CHARS = 80;
/** Ceiling on the raw source a digest is derived from. Real floor bodies are
 *  1.3–5.2K chars and the digest only ever uses the head; unbounded input is
 *  regex food (a 128KB body measured 27s of bootstrap CPU before this cap). */
export const SKILL_DIGEST_SOURCE_MAX_CHARS = 64_000;

export interface SkillDigestEntry {
  name: string;
  /** Raw SKILL.md (frontmatter included); null = no body on this machine,
   *  the name still renders. */
  source: string | null;
}

/**
 * Split a SKILL.md into its frontmatter text and body — the one fence parser
 * for every inline path (the bootstrap's symptom-skill inlining strips
 * through this too). The closing fence must open a line, so a body line of
 * "---" is not a terminator.
 */
export function splitSkillFrontmatter(raw: string | null): { frontmatter: string; body: string } {
  const text = (raw ?? "").trim();
  if (!text.startsWith("---")) return { frontmatter: "", body: text };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { frontmatter: "", body: text };
  const frontmatter = text.slice(3, end).trim();
  // A closing fence on the last line has no newline after it: the body is
  // empty, not the whole document.
  const bodyStart = text.indexOf("\n", end + 1);
  const body = bodyStart === -1 ? "" : text.slice(bodyStart + 1).trim();
  return { frontmatter, body };
}

/**
 * The author-pinned digest, when present. Supports the YAML shapes a skill
 * author will actually type: `digest: text`, `digest: "quoted"`,
 * `digest: 'quoted'`, and the block scalars `digest: >` / `digest: |` with
 * indented continuation lines. Anything else (nested maps, anchors) is
 * ignored rather than misread — the derived digest takes over.
 */
export function readFrontmatterDigest(frontmatter: string): string | null {
  const lines = frontmatter.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^digest:\s*(.*)$/.exec(lines[i]!);
    if (!m) continue;
    const inline = m[1]!.trim();
    if (inline === ">" || inline === "|" || inline === ">-" || inline === "|-") {
      const parts: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const line = lines[j]!;
        if (line.trim() === "") { if (parts.length) parts.push(""); continue; }
        if (!/^\s/.test(line)) break; // dedented = next key
        parts.push(line.trim());
      }
      const joined = parts.join(" ").replace(/\s+/g, " ").trim();
      return joined || null;
    }
    let value = inline;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    value = value.replace(/\s+/g, " ").trim();
    return value || null;
  }
  return null;
}

/** slice() that never ends on a lone high surrogate. */
function sliceCodepointSafe(text: string, end: number): string {
  const cut = text.slice(0, Math.max(0, end));
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 1) return "";
  return sliceCodepointSafe(text, maxChars - 1).trimEnd() + "…";
}

/**
 * One inert display line. Markdown emphasis is dropped (it renders as noise
 * inside a list item), wiki-links keep their target name, and EVERY angle
 * bracket becomes a guillemet — a host's markdown/HTML renderer eats `<x>`
 * as an unknown tag (observed: a placeholder rendered as
 * knowledge_search("")), and this text is model context: a body could
 * otherwise carry a forged `<prism_session … />` line, which the server
 * instructions tell the model to reuse. Brackets are replaced one by one,
 * not as matched spans: a span rule let a tag split across two paragraphs,
 * list items, or headings re-form when the assembler joined them (a
 * verifier's repro), and CommonMark lets an inline tag span one line ending,
 * so even two adjacent block lines could re-form one. With no `<` or `>` in
 * any unit there is nothing to re-form; "› 60 min" still reads. The
 * wiki-link class excludes `[` so a run of unclosed brackets cannot go
 * quadratic.
 */
function inertLine(text: string): string {
  return text
    .replace(/\[\[([^\[\]]+)\]\]/g, "$1")
    .replace(/\*\*|__/g, "")
    .replace(/(^|\s)[*_](\S[^*_]*\S)[*_](?=\s|[.,;:!?]|$)/g, "$1$2")
    .replace(/</g, "‹")
    .replace(/>/g, "›")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const LIST_MARKER = /^(?:[-*+]|\d+[.)])\s+/;
const BLOCKQUOTE_MARKER = /^(?:>\s*)+/;

/**
 * Derive a digest from a body: the leading substantive units — paragraphs
 * and individual list items (headings, tables, fences and rules skipped) —
 * as many as fit, then the section headings as a map when room remains. The
 * first unit is always present, truncated if it alone exceeds the cap. List
 * items are units of their own because a floor skill's rules are usually a
 * numbered list: folded into one paragraph they never fit and the digest
 * degenerated to the one-line intro (pre-push-audit: 160 of 360 chars).
 *
 * A unit that opens a new section carries its heading (`Do NOT delegate:
 * Tasks requiring …`). Without it the join reads as one continuous
 * instruction, and a heading is where a skill's polarity flips: measured
 * on this machine, local-inference-first digested to "…your first action is
 * prism_infer. … Tasks requiring current conversation context" — the first
 * bullet of its "Do NOT delegate" section, presented as a thing to route.
 */
export function deriveSkillDigest(body: string, maxChars = SKILL_DIGEST_MAX_CHARS): string | null {
  return assembleSkillDigest(parseSkillDigestBody(body), maxChars);
}

/** One substantive unit of a body and the section (H2+) it sits under —
 *  null for the intro before any section heading. */
export interface SkillDigestUnit {
  text: string;
  section: string | null;
}

/** Digest material for one skill, parsed once: pinned wording wins, else the
 *  leading units and the section map are assembled to whatever cap the
 *  block's budget allows. */
export interface ParsedSkillDigest {
  pinned: string | null;
  units: SkillDigestUnit[];
  map: string[];
}

/** Label for a heading whose text is nothing once inert (`## **`). The
 *  boundary still has to show in the digest — dropping it would join the
 *  next unit onto the previous section. */
const UNTITLED_SECTION = "(untitled)";

function parseSkillDigestBody(body: string): ParsedSkillDigest {
  const units: SkillDigestUnit[] = [];
  const headings: string[] = [];
  let current: string[] = [];
  let currentIsList = false;
  let section: string | null = null;
  let headingSeen = false;
  let inFence = false;
  const flush = () => {
    if (current.length) {
      const text = inertLine(current.join(" "));
      if (text) units.push({ text, section });
    }
    current = [];
    currentIsList = false;
  };
  const openSection = (level: number, rawText: string) => {
    // The first heading of the document, when it is an H1 that precedes
    // every unit, is the title (the name says it) and owns nothing. Any
    // other heading — including a LATER H1 — owns the units that follow
    // it: an H1 or H4 "Never" flips polarity as surely as an H2 does, so a
    // level is never a reason to reset the section to the intro. H2 is the
    // map; H3 only when a skill has no H2 at all
    // (absence-of-evidence-protocol is all H3); a mid-document H1 maps as
    // an H2.
    const text = inertLine(rawText);
    const isTitle = level === 1 && !headingSeen && units.length === 0;
    headingSeen = true;
    if (isTitle) { section = null; return; }
    section = text || UNTITLED_SECTION;
    if (level <= 3) headings.push(`${Math.max(level, 2)}:${text}`);
  };
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim().replace(BLOCKQUOTE_MARKER, "");
    if (line.startsWith("```") || line.startsWith("~~~")) { inFence = !inFence; flush(); continue; }
    if (inFence) continue;
    if (line === "") { flush(); continue; }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      openSection(heading[1]!.length, heading[2]!);
      continue;
    }
    // Setext: a lone paragraph line underlined with `===` (H1) or `---`
    // (H2) is a heading, not a paragraph followed by a rule.
    if (current.length === 1 && !currentIsList && /^(?:=+|-+)$/.test(line)) {
      const text = current[0]!;
      current = [];
      openSection(line.startsWith("=") ? 1 : 2, text);
      continue;
    }
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(line) || line.startsWith("|")) { flush(); continue; }
    if (LIST_MARKER.test(line)) { flush(); currentIsList = true; }
    current.push(line.replace(LIST_MARKER, ""));
  }
  flush();

  const h2 = headings.filter((h) => h.startsWith("2:")).map((h) => h.slice(2));
  const map = (h2.length ? h2 : headings.map((h) => h.slice(2))).filter(Boolean);
  return { pinned: null, units, map };
}

/** Fit parsed material to a cap. Null when there is nothing to say — which
 *  does not depend on the cap, so a block can count digestible entries
 *  before it knows each one's share. */
export function assembleSkillDigest(parsed: ParsedSkillDigest | null, maxChars = SKILL_DIGEST_MAX_CHARS): string | null {
  if (!parsed) return null;
  if (parsed.pinned) return truncate(parsed.pinned, maxChars);
  const { units, map } = parsed;
  if (units.length === 0 && map.length === 0) return null;

  let out = "";
  let section: string | null = null;
  for (const unit of units) {
    // The heading is spent only where the section changes, so a run of
    // bullets under one heading pays for it once.
    const text = unit.section && unit.section !== section ? `${unit.section}: ${unit.text}` : unit.text;
    if (!out) { out = truncate(text, maxChars); section = unit.section; continue; }
    if (out.length + 1 + text.length > maxChars) break;
    out = `${out} ${text}`;
    section = unit.section;
  }
  if (map.length) {
    const sections = `Sections: ${map.join(" · ")}.`;
    if (!out) out = truncate(sections, maxChars);
    else if (out.length + 1 + sections.length <= maxChars) out = `${out} ${sections}`;
    else if (maxChars - out.length - 1 >= 40) out = `${out} ${truncate(sections, maxChars - out.length - 1)}`;
  }
  // Units were made inert one by one; the joins above are a new string, so
  // it is made inert as a whole too (a `*` closing across a join, say).
  // Every rule in inertLine shortens or preserves length, so this cannot
  // push the digest back over maxChars.
  return inertLine(out) || null;
}

/** A document that opens a frontmatter fence and never closes it — a
 *  materialization cut off mid-header. `splitSkillFrontmatter` hands the
 *  whole document back as the body in that case (right for the inline
 *  path, which shows the file as it is); for a one-line digest that would
 *  present the YAML — name, description, the on-device `prompt_triggers`
 *  patterns — as the rule in force. It is not a body. */
export function hasUnclosedFrontmatter(raw: string | null): boolean {
  const text = (raw ?? "").trim();
  // The opener must be followed by a `key:`-shaped line — the first
  // non-whitespace text after it decides, blank lines are skipped: a body
  // that opens with a horizontal rule and then a heading or `Rule one.` is
  // still a body. A body whose first text after the rule happens to be
  // key-shaped (`Note: …`, with or without a blank line between) reads as an
  // unclosed header — a deliberate false positive that fails toward "no
  // digest", never toward presenting YAML as a rule (round-11/12 review).
  return /^---\r?\n\s*[A-Za-z_][\w-]*\s*:/.test(text) && text.indexOf("\n---", 3) === -1;
}

/** Parse a raw SKILL.md once: frontmatter `digest:` when pinned, else the
 *  body's material. Null for no source, or for a truncated one. */
export function parseSkillDigest(raw: string | null): ParsedSkillDigest | null {
  if (!raw) return null;
  // The cap is applied first so a fence that closes beyond it reads as
  // unclosed — the same slice is what gets split.
  const source = raw.slice(0, SKILL_DIGEST_SOURCE_MAX_CHARS);
  if (hasUnclosedFrontmatter(source)) return null;
  const { frontmatter, body } = splitSkillFrontmatter(source);
  const pinned = readFrontmatterDigest(frontmatter);
  if (pinned) return { pinned: inertLine(pinned), units: [], map: [] };
  return parseSkillDigestBody(body);
}

/** Frontmatter `digest:` when pinned, else derived from the body. */
export function skillDigestFromSource(raw: string | null, maxChars = SKILL_DIGEST_MAX_CHARS): string | null {
  return assembleSkillDigest(parseSkillDigest(raw), maxChars);
}

export interface FloorDigestBlockOptions {
  /** Hard ceiling for the whole rendered block (chars). */
  maxChars: number;
  /** Where the full bodies live, rendered into the header so the model can
   *  read the rule when the digest is not enough. */
  skillsRoot?: string;
  /** Rendered line prefix — `"> "` inside the System Ready blockquote, `""`
   *  for the hook payload. */
  linePrefix?: string;
}

const HEADER_LEAD = "📖 Protected floor — rules in force this session";
/** Line tail for a name whose body says nothing digestible (not on this
 *  machine, or all fences and tables). The rule is still in force — the
 *  server named it — so the line says why it is bare instead of looking like
 *  a skill with nothing to say. */
export const SKILL_DIGEST_UNAVAILABLE = "digest unavailable; read the full skill";

/**
 * Render the block, or null when the budget cannot carry a useful digest for
 * every digestible name — a floor whose lines were squeezed below
 * SKILL_DIGEST_MIN_CHARS would be names with punctuation, so the caller keeps
 * its name-only line instead. A name whose body cannot be digested at any
 * budget still renders, marked SKILL_DIGEST_UNAVAILABLE, so an absent rule is
 * never mistaken for a silent one. The per-skill cap is derived from the
 * budget BEFORE digesting, so the derivation fits its rules and section map
 * to the room it actually has instead of being cut a second time; one long
 * body cannot starve the rest; the result never exceeds maxChars.
 */
export function renderFloorDigestBlock(
  entries: SkillDigestEntry[],
  options: FloorDigestBlockOptions,
): string | null {
  if (entries.length === 0 || options.maxChars <= 0) return null;
  const prefix = options.linePrefix ?? "";
  const root = options.skillsRoot ? ` (full text: ${options.skillsRoot}/‹name›/SKILL.md)` : "";
  const header = `${prefix}- ${HEADER_LEAD}${root}:`;
  // Parse each body exactly once; the share is derived from how many can say
  // anything at all, which the assembler decides independently of the cap.
  const parsed = entries.map((e) => parseSkillDigest(e.source));
  const digestible = parsed.map((p) => assembleSkillDigest(p) !== null);
  const withBody = digestible.filter(Boolean).length;
  if (withBody === 0) return null;
  // Every char that is not digest: the per-line chrome, the newline, and the
  // full marker line for a name that gets no digest at all.
  const chrome = entries.reduce(
    (sum, e, i) => sum + `${prefix}  - ${e.name} — `.length + (digestible[i] ? 0 : SKILL_DIGEST_UNAVAILABLE.length) + 1,
    0,
  );
  const perSkill = Math.min(
    SKILL_DIGEST_MAX_CHARS,
    Math.floor((options.maxChars - header.length - 1 - chrome) / withBody),
  );
  if (perSkill < SKILL_DIGEST_MIN_CHARS) return null;
  const lines = [header];
  entries.forEach((entry, index) => {
    const digest = digestible[index] ? assembleSkillDigest(parsed[index]!, perSkill) : null;
    lines.push(`${prefix}  - ${entry.name} — ${digest ?? SKILL_DIGEST_UNAVAILABLE}`);
  });
  // The bound is the arithmetic above: header + chrome + withBody × perSkill
  // ≤ maxChars, and a digest never exceeds its cap. There is deliberately no
  // post-hoc `length <= maxChars ? block : null` guard — one turned a
  // budgeting slip into a silently missing floor that the budget sweep could
  // not see (the mutant survived); the sweep asserts the bound directly.
  return lines.join("\n");
}
