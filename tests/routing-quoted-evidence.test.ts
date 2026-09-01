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
});

describe('real symptoms still route — the regression risk of the fix', () => {
  it('user-typed symptom words match, because they are not name tokens', () => {
    expect(route('I need to submit the fusa billing invoice')).toContain('fusa-bss-billing');
    expect(route('help me with a bss billing question')).toContain('fusa-bss-billing');
    expect(route('did the training corpus score pass the gate?')).toContain('training-results-gate');
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

describe('stripQuotedEvidenceForRouting mechanics', () => {
  it('removes fenced blocks and identifier-shaped tokens only', () => {
    expect(stripQuotedEvidenceForRouting('a ```x``` b', TRIGGERS)).not.toContain('x');
    expect(stripQuotedEvidenceForRouting('see fusa-bss-billing here', TRIGGERS)).not.toContain('fusa-bss-billing');
    expect(stripQuotedEvidenceForRouting('plain words stay', TRIGGERS)).toBe('plain words stay');
    // A skill name NOT in the table is left alone — we only strip what we route.
    expect(stripQuotedEvidenceForRouting('about some-other-skill', TRIGGERS)).toContain('some-other-skill');
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
