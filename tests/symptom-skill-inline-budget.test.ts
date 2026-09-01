/**
 * A symptom-routed rule must arrive whole, or say plainly that it did not.
 *
 * Incident 2026-08-31: a startup display surfaced `dev-engineering-super-skill`
 * as a symptom-triggered skill, told the agent "Follow them before proposing
 * any change", and then inlined 1,800 of its 8,863 chars — cutting mid-table —
 * with only "… (rule truncated to fit the startup budget)" as notice. Every
 * super-skill is 8-15 KB, so this fired 100% of the time a super-skill routed.
 *
 * Root cause: SYMPTOM_SKILL_INLINE_MAX (1,800) was BELOW every depth's own
 * budget share, so the constant — not the budget — was the binding constraint.
 * deep allots 30_000 * 0.4 = 12_000 and was throwing 10_200 of it away.
 *
 * These tests pin the arithmetic (a regression here is silent and invisible in
 * output) and the honesty of the truncation notice when it is unavoidable.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';

/** Mirrors the production constants; a drift here means the source changed. */
const NATIVE_STARTUP_MAX_CHARS: Record<string, number> = {
  quick: 4_000, standard: 8_000, deep: 30_000,
};
const SHARE = 0.4;

/** The production cap expression, verbatim. */
const capFor = (depth: string, inlineMax: number): number =>
  Math.min(inlineMax, Math.floor(NATIVE_STARTUP_MAX_CHARS[depth]! * SHARE));

const SOURCE = readFileSync(new URL('../src/tools/ledgerHandlers.ts', import.meta.url), 'utf8');

function constantFromSource(name: string): number {
  const m = SOURCE.match(new RegExp(`const ${name} = ([0-9_]+);`));
  if (!m) throw new Error(`${name} not found in ledgerHandlers.ts`);
  return Number(m[1]!.replace(/_/g, ''));
}

describe('the budget share must govern, not the ceiling constant', () => {
  const inlineMax = constantFromSource('SYMPTOM_SKILL_INLINE_MAX');

  it('the ceiling is at or above every depth share, so it never binds', () => {
    for (const depth of ['quick', 'standard', 'deep']) {
      const share = Math.floor(NATIVE_STARTUP_MAX_CHARS[depth]! * SHARE);
      expect(
        inlineMax >= share,
        `${depth}: ceiling ${inlineMax} must not clamp the ${share}-char share`,
      ).toBe(true);
    }
  });

  it('deep depth now carries a full dev-engineering-super-skill (8,863 chars)', () => {
    expect(capFor('deep', inlineMax)).toBeGreaterThanOrEqual(8_863);
  });

  it('the old 1,800 ceiling would have failed both — the regression it replaces', () => {
    expect(capFor('deep', 1_800)).toBe(1_800);            // 10,200 chars wasted
    expect(capFor('deep', 1_800)).toBeLessThan(8_863);    // super-skill truncated
  });

  it('quick depth is unchanged: its own share is still the smaller bound', () => {
    expect(capFor('quick', inlineMax)).toBe(1_600);
  });
});

describe('when truncation is unavoidable the notice must be actionable', () => {
  // The branch is asserted against source because the alternative is booting a
  // full MCP handler with a mocked skill root — that indirection would test the
  // mock, not the shipped string. The live end-to-end proof is run separately.
  const branch = SOURCE.slice(SOURCE.indexOf('if (body.length > cap)'));

  it('states how much is missing, not just that something was cut', () => {
    expect(branch).toContain('chars of this rule are NOT shown above');
    expect(branch).toContain('showing ${cap} of ${body.length} chars');
  });

  it('names the skill so a host without filesystem access can still load it', () => {
    expect(branch).toContain('Load the full skill by name');
    expect(branch).toContain('${shown[0]}');
  });

  it('forbids treating the excerpt as the whole rule', () => {
    expect(branch).toContain('do not treat the excerpt as the whole rule');
  });

  it('the file path is an EXTRA route, never the only one (Codex/Desktop have no fs)', () => {
    // The path clause must be conditional — offload can fail, and some hosts
    // cannot read files at all.
    expect(branch).toContain('offload ?');
    expect(branch).toContain('Complete text also saved at');
  });

  it('the bare uninformative marker is gone', () => {
    expect(SOURCE).not.toContain('(rule truncated to fit the startup budget)');
  });
});

describe('routeOffload writer', () => {
  it('writes the full text and returns a readable path', async () => {
    const { writeRouteOffload } = await import('../src/utils/routeOffload.js');
    const body = 'RULE-BODY-'.repeat(500);
    const p = writeRouteOffload(`# test-skill\n\n${body}`, 'test');
    expect(p).toBeTruthy();
    expect(existsSync(p!)).toBe(true);
    const written = readFileSync(p!, 'utf8');
    expect(written).toContain(body);           // FULL text, not a clip
    expect(written.length).toBeGreaterThan(body.length);
  });

  it('never throws when the directory cannot be created', async () => {
    const { writeRouteOffload } = await import('../src/utils/routeOffload.js');
    const prev = process.env.HOME;
    process.env.HOME = '/proc/nonexistent-unwritable';
    try {
      expect(() => writeRouteOffload('x', 'test')).not.toThrow();
    } finally {
      if (prev === undefined) delete process.env.HOME; else process.env.HOME = prev;
    }
  });
});
