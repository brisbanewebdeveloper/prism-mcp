/**
 * Savings-sync tests — the paid team layer.
 *
 * The two properties that matter most:
 *   1. CONSENT: with sync disabled (the default) or a free plan, NOTHING is
 *      sent — not a request, not a byte. The fetch spy proves absence.
 *   2. CONTENT: when a push does happen, the body contains COUNTERS ONLY —
 *      asserted against the exact serialized payload, including a check that
 *      no key smells like content (prompt/completion text, paths, projects).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendInferMetricBatch,
  queryDailyLocalSavings,
  _resetInferLedgerForTest,
} from '../src/storage/inferMetricsLedger.js';

// Entitlements/JWT are module-mocked: these tests must never touch the portal.
vi.mock('../src/utils/entitlements.js', () => ({
  getEntitlements: vi.fn(async () => ({ plan: 'standard' })),
}));
vi.mock('../src/utils/synaluxJwt.js', () => ({
  getSynaluxJwt: vi.fn(async () => 'test-jwt'),
}));

import { pushSavings, fetchTeamSavings, renderTeamSavings, isTeamSavings } from '../src/sync/savingsSync.js';
import { getEntitlements } from '../src/utils/entitlements.js';
import { getSynaluxJwt } from '../src/utils/synaluxJwt.js';

let dir: string;
const DAY = 86_400_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'savings-sync-'));
  process.env.PRISM_INFER_LEDGER_DB_PATH = join(dir, 'ledger.db');
  process.env.PRISM_DATA_DIR = dir; // device key sandbox — never the real one
  process.env.PRISM_SYNALUX_BASE_URL = 'https://portal.test';
  delete process.env.PRISM_SAVINGS_SYNC;
  _resetInferLedgerForTest();
  vi.mocked(getEntitlements).mockResolvedValue({ plan: 'standard' } as never);
  vi.mocked(getSynaluxJwt).mockResolvedValue('test-jwt');
});

afterEach(async () => {
  delete process.env.PRISM_INFER_LEDGER_DB_PATH;
  delete process.env.PRISM_DATA_DIR;
  delete process.env.PRISM_SYNALUX_BASE_URL;
  delete process.env.PRISM_SAVINGS_SYNC;
  _resetInferLedgerForTest();
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== 'win32' || !['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(code ?? '')) throw error;
  }
});

async function seedLedger() {
  const now = Date.now();
  await appendInferMetricBatch([
    { ts: now - 1 * DAY, backend: 'ollama-9b', model: 'prism-coder:9b', used_cloud: false, prompt_tokens: 1_000, completion_tokens: 200 },
    { ts: now - 1 * DAY, backend: 'cloud', model: 'synalux', used_cloud: true, prompt_tokens: 400, completion_tokens: 100 },
    { ts: now - 2 * DAY, backend: 'refused', model: null, used_cloud: false, prompt_tokens: 50_000, completion_tokens: 0 },
    { ts: now - 2 * DAY, backend: 'ollama-4b', model: 'prism-coder:4b', used_cloud: false, prompt_tokens: 300, completion_tokens: 50 },
  ]);
}

const okFetch = () => vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;

describe('queryDailyLocalSavings', () => {
  it('groups by UTC day with the same refusal exclusion as the meter', async () => {
    await seedLedger();
    const rows = await queryDailyLocalSavings(Date.now() - 10 * DAY);
    expect(rows).toHaveLength(2);
    const byTokens = rows!.map(r => r.local_prompt_tokens + r.local_completion_tokens).sort((a, b) => a - b);
    expect(byTokens).toEqual([350, 1_200]); // the 50k refusal contributes nothing
    expect(rows!.reduce((n, r) => n + r.cloud_calls, 0)).toBe(1);
  });
});

describe('pushSavings — consent gates', () => {
  it('sends NOTHING when sync is not enabled (the default)', async () => {
    await seedLedger();
    const spy = okFetch();
    const r = await pushSavings(spy);
    expect(r).toEqual({ pushed: false, reason: 'disabled' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('sends NOTHING on a free plan even when enabled', async () => {
    await seedLedger();
    process.env.PRISM_SAVINGS_SYNC = '1';
    vi.mocked(getEntitlements).mockResolvedValue({ plan: 'free' } as never);
    const spy = okFetch();
    const r = await pushSavings(spy);
    expect(r).toEqual({ pushed: false, reason: 'free_plan' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('sends NOTHING without portal credentials', async () => {
    await seedLedger();
    process.env.PRISM_SAVINGS_SYNC = '1';
    vi.mocked(getSynaluxJwt).mockResolvedValue(null);
    const spy = okFetch();
    const r = await pushSavings(spy);
    expect(r).toEqual({ pushed: false, reason: 'no_jwt' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('env PRISM_SAVINGS_SYNC=0 vetoes a stored opt-in', async () => {
    await seedLedger();
    process.env.PRISM_SAVINGS_SYNC = '0';
    const spy = okFetch();
    const r = await pushSavings(spy);
    expect(r.reason).toBe('disabled');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('pushSavings — payload contract', () => {
  it('pushes counters only: no content-shaped keys, correct rows, JWT auth', async () => {
    await seedLedger();
    process.env.PRISM_SAVINGS_SYNC = '1';
    const spy = okFetch();
    const r = await pushSavings(spy);
    expect(r.pushed).toBe(true);
    expect(r.days).toBe(2);

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = (spy as ReturnType<typeof vi.fn>).mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://portal.test/api/v1/prism/savings');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer test-jwt');

    const body = JSON.parse(init.body as string) as { device_id: string; days: Array<Record<string, unknown>> };
    expect(body.device_id).toMatch(/^[0-9a-f]{16}$/); // keyId — derived from a public key, no user data
    expect(body.days).toHaveLength(2);
    for (const row of body.days) {
      expect(Object.keys(row).sort()).toEqual([
        'cloud_calls', 'day', 'local_calls', 'local_completion_tokens', 'local_prompt_tokens',
      ]);
      expect(row.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    // The absence check that matters: nothing content-shaped anywhere.
    const wire = init.body as string;
    expect(wire).not.toMatch(/prompt_text|content|project|path|model/);
  });

  it('fails soft when the portal rejects — never throws into the session', async () => {
    await seedLedger();
    process.env.PRISM_SAVINGS_SYNC = '1';
    const spy = vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    const r = await pushSavings(spy);
    expect(r).toEqual({ pushed: false, reason: 'portal_rejected' });
  });
});

describe('fetchTeamSavings / renderTeamSavings', () => {
  const team = {
    workspace_id: 'ws-1', days: 30,
    members: [
      { user_id: 'u1', label: 'dev-a', devices: 2, local_calls: 40, local_tokens: 900_000 },
      { user_id: 'u2', label: 'dev-b', devices: 1, local_calls: 10, local_tokens: 100_000 },
    ],
    total_local_calls: 50, total_cloud_calls: 5, total_local_tokens: 1_000_000,
  };

  it('prints the portal-rendered block VERBATIM when present (thin client)', () => {
    const rendered = '💾 Team local serving — SERVER SAYS\n  anything the portal rendered';
    expect(renderTeamSavings({ ...team, rendered })).toBe(rendered);
  });

  it('falls back to a minimal, currency-free summary for older portals', () => {
    const text = renderTeamSavings(team); // no rendered field
    expect(text).toMatch(/~1\.0M tokens kept off cloud models across the team/);
    expect(text).toMatch(/2 member\(s\)/);
    expect(text).toMatch(/update the portal/i);
    expect(text).not.toMatch(/[$€£¥₹]/u); // no-currency contract on the fallback too
  });

  it('maps 401/402/403 to not_entitled and validates the wire shape', async () => {
    const denied = vi.fn(async () => new Response('denied', { status: 403 })) as unknown as typeof fetch;
    expect((await fetchTeamSavings('ws-1', 30, denied))).toEqual({ ok: false, reason: 'not_entitled', status: 403 });

    const malformed = vi.fn(async () => new Response('{"nope":1}', { status: 200 })) as unknown as typeof fetch;
    expect((await fetchTeamSavings('ws-1', 30, malformed))).toEqual({ ok: false, reason: 'malformed' });

    const good = vi.fn(async () => new Response(JSON.stringify(team), { status: 200 })) as unknown as typeof fetch;
    const r = await fetchTeamSavings('ws-1', 30, good);
    expect(r.ok).toBe(true);
    const [calledUrl] = (good as ReturnType<typeof vi.fn>).mock.calls[0]! as [string];
    expect(calledUrl).toContain('scope=team');
    expect(calledUrl).toContain('workspace_id=ws-1');
  });

  it('shared-machine disclosure arrives via the server render; struct field still validates', () => {
    // Review F1's disclosure moved portal-side with the rest of the
    // presentation (thin client). The client's job is to not drop it.
    const withShared = { ...team, shared_devices: 1,
      rendered: '💾 …\n  1 machine(s) reported by more than one member — each counted once' };
    expect(renderTeamSavings(withShared)).toMatch(/more than one member — each counted once/);
    expect(isTeamSavings(withShared)).toBe(true);
  });

  it('isTeamSavings rejects structural garbage', () => {
    expect(isTeamSavings(team)).toBe(true);
    expect(isTeamSavings(null)).toBe(false);
    expect(isTeamSavings({ workspace_id: 'x' })).toBe(false);
  });
});
