/**
 * Pasted evidence must not activate skills.
 *
 * Incident 2026-08-31: the user asked "whats going on with skill loading:" and
 * pasted a Prism startup log as evidence. That log LISTS installed skill names,
 * and the literal token `fusa-bss-billing` in it satisfied that skill's own
 * trigger `\bfusa\b.{0,20}\b(billing|invoice)\b`. Two unrelated private skills
 * were loaded and injected as binding rules for a debugging question.
 *
 * The rule this pins: a skill NAME appearing in a prompt is metadata about the
 * system, not a description of work. Symptom words the user actually types must
 * still route — that is the other half, and the regression risk of the fix.
 */
import { describe, it, expect } from 'vitest';
import {
  _applyPromptRouting,
  stripQuotedEvidenceForRouting,
  resolvePromptSkillNames,
} from '../src/tools/skillRouting.js';

/** The real triggers from the two skills that misfired. */
const TRIGGERS: Record<string, string[]> = {
  '\\bfusa\\b.{0,20}\\b(billing|invoice)\\b': ['fusa-bss-billing'],
  '\\bbss\\b.{0,20}\\bbilling\\b': ['fusa-bss-billing'],
  '\\b(training|corpus|bfcl)\\b.{0,24}\\b(score|gate|promote)\\b': ['training-results-gate'],
};

const route = (prompt: string): string[] =>
  _applyPromptRouting([], stripQuotedEvidenceForRouting(prompt, TRIGGERS), TRIGGERS).map((s) => s.name);

/** Verbatim shape of the pasted startup log from the incident. */
const PASTED_LOG = `whats going on with skill loading: here is the agent log

Prism System Ready
- Subscription tier: enterprise
- Provisioned skills: 118
- Skill sync: automatic from Synalux · current · committed manifest · 1 conflict
⚠️ SKILLS NOT UPDATING (local copy has no Prism ownership marker): fusa-bss-billing.
Other tier skills provisioned: execute-method-literally, prompt-fidelity,
training-results-gate, autonomous-training-protocol, verified-shipping`;

describe('pasted evidence does not activate skills', () => {
  it('the exact incident prompt routes NOTHING', () => {
    expect(route(PASTED_LOG)).toEqual([]);
  });

  it('a bare skill name never triggers its own skill', () => {
    expect(route('why is fusa-bss-billing frozen?')).toEqual([]);
    expect(route('what does training-results-gate do?')).toEqual([]);
  });

  it('fenced output is ignored even when it contains trigger words', () => {
    const prompt = 'why did this fail?\n```\nbss billing invoice submitted\n```';
    expect(route(prompt)).toEqual([]);
  });

  it('review: stripping must not BRIDGE unrelated words into a proximity window', () => {
    // Raw prompt: 'fusa <28-char name token> invoice' — 'fusa' and 'invoice'
    // are >20 chars apart, so \bfusa\b.{0,20}\b(billing|invoice)\b does NOT
    // match the raw text. Replacing the name with a SPACE brought them within
    // the window and CREATED a match (adversarial review, reproduced). The
    // newline replacement severs the window instead: still no match.
    const LONG = 'fusa-bss-billing-extra-longer';
    const triggers = { ...TRIGGERS, ['\\bfusa\\b.{0,20}\\b(billing|invoice)\\b']: ['fusa-bss-billing'] };
    const prompt = `fusa ${LONG} invoice`;
    const withLong = { ...triggers, x: ['x'] } as Record<string, string[]>;
    withLong['zz'] = [LONG]; // make the long token itself routable → stripped
    const names = _applyPromptRouting([], stripQuotedEvidenceForRouting(prompt, withLong), withLong).map(s => s.name);
    expect(names).not.toContain('fusa-bss-billing');
  });

  it('review: two INLINE backtick-triples must not eat user-typed symptom text', () => {
    // Only line-anchored fences are pasted blocks. Inline pairs in prose used
    // to bracket-and-delete everything between them (adversarial review).
    const prompt = 'my ``` markers ``` are decoration, but my fusa billing invoice is broken';
    expect(route(prompt)).toContain('fusa-bss-billing');
  });

  it('review: hostile or overlong routable names degrade to not-stripped, never a throw', () => {
    const hostile: Record<string, string[]> = {
      ...TRIGGERS,
      aa: ['x'.repeat(500)],                 // overlong — skipped by bound
      bb: ['bad[skill-name'],                // unterminated class — raw RegExp() THROWS
    };
    expect(() => stripQuotedEvidenceForRouting('any prompt at all', hostile)).not.toThrow();
    // and routing still works for the legit triggers
    const names = _applyPromptRouting([], stripQuotedEvidenceForRouting('my fusa billing invoice', hostile), hostile).map(s => s.name);
    expect(names).toContain('fusa-bss-billing');
  });
});

describe('real symptoms still route — the regression risk of the fix', () => {
  it('user-typed symptom words match, because they are not name tokens', () => {
    expect(route('I need to submit the fusa billing invoice')).toContain('fusa-bss-billing');
    expect(route('help me with a bss billing question')).toContain('fusa-bss-billing');
    expect(route('did the training corpus score pass the gate?')).toContain('training-results-gate');
  });

  it('BY DESIGN: a typed bare name does not trigger-route — the agent reads the name directly', () => {
    // Adversarial review flagged this as a regression; it is a documented
    // trade-off instead: trigger routing exists for SYMPTOM text where no
    // name appears. When the user types the literal name, the agent sees it
    // in the raw prompt and can invoke the skill by name — no routing needed.
    // Pasted logs naming skills must not route them; that wins.
    expect(route('update fusa-bss-billing with the new invoice rate')).toEqual([]);
  });

  it('stripping removes only the NAME SPAN, leaving its words usable elsewhere', () => {
    // The name is stripped, but the same words typed separately still match.
    const prompt = 'the fusa-bss-billing skill is stale, but my fusa billing invoice is due';
    expect(route(prompt)).toContain('fusa-bss-billing');
  });

  it('ordinary hyphenated English is not mistaken for a skill name', () => {
    for (const phrase of ['end-to-end', 're-test the flow', 'well-formed input', 'up-to-date']) {
      expect(stripQuotedEvidenceForRouting(phrase, TRIGGERS)).toContain(phrase.split(' ')[0]);
    }
  });

  it('does not truncate: a symptom stated late in a long prompt still matches', () => {
    const prompt = `${'context. '.repeat(400)}now: my fusa billing invoice is wrong`;
    expect(route(prompt)).toContain('fusa-bss-billing');
  });
});

describe('round-2 review regressions', () => {
  it('\\s-glued windows are severed too — the real-table bridging repro', () => {
    // 34/58 live patterns glue words with \s* (e.g. \bui\s*test\b). \n IS \s,
    // so the round-1 newline replacement did NOT sever them: stripping a name
    // from 'ui <name> test' routed xcuitest-ios-watch. The \x1F in the
    // separator is non-space, so \s runs cannot span it.
    const t: Record<string, string[]> = {
      '\\bui\\s*test\\b': ['xcuitest-ios-watch'],
      zz: ['gh-fix-ci'],
    };
    const stripped = stripQuotedEvidenceForRouting('ui gh-fix-ci test', t);
    const names = _applyPromptRouting([], stripped, t).map((s) => s.name);
    expect(names).not.toContain('xcuitest-ios-watch');
    // and a REAL adjacent mention still matches
    const names2 = _applyPromptRouting([], stripQuotedEvidenceForRouting('run the ui test now', t), t).map((s) => s.name);
    expect(names2).toContain('xcuitest-ios-watch');
  });

  it('non-string entries in a corrupted table never throw (null lands in sort)', () => {
    const corrupt = { a: ['legit-name', null, undefined, 42, {}], b: 'not-an-array' } as never;
    expect(() => stripQuotedEvidenceForRouting('any prompt', corrupt)).not.toThrow();
  });

  it('a whitespace-only "name" does not rewrite prompt formatting', () => {
    const t = { a: ['   '] } as Record<string, string[]>;
    const input = 'line one\n   indented code line\nmore   spaced   text';
    expect(stripQuotedEvidenceForRouting(input, t)).toBe(input);
  });
});

describe('stripQuotedEvidenceForRouting mechanics', () => {
  it('removes fenced blocks and identifier-shaped tokens only', () => {
    // Updated after review: INLINE pairs are prose decoration and must NOT be
    // eaten (that deleted real symptom text); only LINE-ANCHORED fences are
    // pasted blocks.
    expect(stripQuotedEvidenceForRouting('a ```x``` b', TRIGGERS)).toContain('x');
    expect(stripQuotedEvidenceForRouting('before\n```\nBLOCK-CONTENT\n```\nafter', TRIGGERS)).not.toContain('BLOCK-CONTENT');
    expect(stripQuotedEvidenceForRouting('see fusa-bss-billing here', TRIGGERS)).not.toContain('fusa-bss-billing');
    expect(stripQuotedEvidenceForRouting('plain words stay', TRIGGERS)).toBe('plain words stay');
    // A skill name NOT in the table is left alone — we only strip what we route.
    expect(stripQuotedEvidenceForRouting('about some-other-skill', TRIGGERS)).toContain('some-other-skill');
  });
});

describe('WIRING — second production call site (toResolvedSkillsWithPrompt)', () => {
  // The review confirmed the first wiring test covered only ONE of the two
  // call sites; reverting the other went undetected. This drives the portal-
  // response path with a paid tier so _applyPromptRouting runs there too.
  it('the incident prompt adds no prompt-category skills on the portal path', async () => {
    const { _toResolvedSkillsWithPrompt: toResolvedSkillsWithPrompt, _setStorage } = await import('../src/tools/skillRouting.js');
    _setStorage(
      async () => {},
      async (key: string) => key.includes('keyword')
        ? JSON.stringify({ version: 1, prompt_keywords: TRIGGERS, universal: [], projects: {}, user_local: { enabled: false, key_prefix: 'u:' } })
        : '',
    );
    const resp = { loaded: ['prime-directive'], skipped: [], routing_version: 1, tier: 'paid' } as never;
    const resolved = await toResolvedSkillsWithPrompt(resp, PASTED_LOG, true);
    expect(resolved.names).not.toContain('fusa-bss-billing');
    expect(resolved.names).not.toContain('training-results-gate');
    const typed = await toResolvedSkillsWithPrompt(resp, 'my fusa billing invoice is broken', true);
    expect(typed.names).toContain('fusa-bss-billing');
  });
});

describe('WIRING — the real routing entry point, not just the helper', () => {
  // The helper tests above pass even if nobody CALLS the helper. This block is
  // the one that fails when the call sites regress: it goes through the public
  // resolvePromptSkillNames() path, which is what session_bootstrap uses.
  // (Mutation-verified: reverting either call site reds these.)
  it('the incident prompt resolves to NO skills through the real entry point', async () => {
    const names = await resolvePromptSkillNames(PASTED_LOG, undefined, TRIGGERS);
    expect(names).not.toContain('fusa-bss-billing');
    expect(names).not.toContain('training-results-gate');
  });

  it('a genuinely typed symptom still resolves through the real entry point', async () => {
    const names = await resolvePromptSkillNames(
      'I need to submit the fusa billing invoice', undefined, TRIGGERS);
    expect(names).toContain('fusa-bss-billing');
  });
});
