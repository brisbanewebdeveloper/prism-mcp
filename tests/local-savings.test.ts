/**
 * Local-serving meter tests.
 *
 * The SQL is where this feature can go wrong in the expensive direction — by
 * counting something that saved nothing and reporting an inflated headline — so
 * these run against a REAL temp SQLite ledger via PRISM_INFER_LEDGER_DB_PATH
 * rather than a mock. A mocked aggregate would pass while the WHERE clause was
 * wrong, which is the only bug class that actually matters here.
 *
 * Deliberately absent: any test of a dollar figure. Prism reports tokens
 * because it cannot know host rates, which model a call displaced, or whether
 * the user is on a flat plan. `rendersNoCurrency` pins that as a contract.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  appendInferMetricBatch,
  queryLocalSavings,
  _resetInferLedgerForTest,
} from '../src/storage/inferMetricsLedger.js';
import {
  renderSavings,
  caveatsFor,
  abbreviate,
  windowStart,
  sessionSavings,
  type SavingsPeriod,
} from '../src/tools/savingsHandler.js';
import {
  recordInference,
  resetInferenceMetrics,
  getInferenceSnapshot,
} from '../src/utils/inferenceMetrics.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'savings-'));
  process.env.PRISM_INFER_LEDGER_DB_PATH = join(dir, 'test.db');
  _resetInferLedgerForTest();
  resetInferenceMetrics();
});

afterEach(async () => {
  delete process.env.PRISM_INFER_LEDGER_DB_PATH;
  _resetInferLedgerForTest();
  resetInferenceMetrics();
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // libsql-js#228 — see tests/infer-metrics-ledger.test.ts.
    if (process.platform !== 'win32' || !['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(code ?? '')) {
      throw error;
    }
  }
});

const local = (over: Record<string, unknown> = {}) => ({
  backend: 'ollama-9b', model: 'prism-coder:9b', used_cloud: false,
  prompt_tokens: 1_000, completion_tokens: 500, latency_ms: 900, ...over,
});

describe('queryLocalSavings — what counts as displaced', () => {
  it('sums prompt and completion tokens for locally-served calls', async () => {
    await appendInferMetricBatch([local(), local()]);
    const s = await queryLocalSavings();
    expect(s).not.toBeNull();
    expect(s!.local_calls).toBe(2);
    expect(s!.local_prompt_tokens).toBe(2_000);
    expect(s!.local_completion_tokens).toBe(1_000);
    expect(s!.local_total_tokens).toBe(3_000);
  });

  it('never counts cloud-served calls as savings', async () => {
    // A cloud fallback served the user from the cloud. It displaced nothing;
    // counting its tokens would invert the meaning of the headline.
    await appendInferMetricBatch([
      local(),
      { backend: 'cloud', model: 'synalux', used_cloud: true, prompt_tokens: 99_999, completion_tokens: 99_999 },
    ]);
    const s = await queryLocalSavings();
    expect(s!.local_total_tokens).toBe(1_500);
    expect(s!.cloud_calls).toBe(1);
    expect(s!.local_calls).toBe(1);
  });

  it('excludes refused calls — nothing was served, so nothing was displaced', async () => {
    // recordInference() writes the ledger row BEFORE its `backend === "refused"`
    // early return, so refusals are genuinely present in the table. If the SQL
    // forgets them, every refusal inflates the call count and (when tokens are
    // recorded) the token headline.
    await appendInferMetricBatch([
      local(),
      { backend: 'refused', model: null, used_cloud: false, prompt_tokens: 50_000, completion_tokens: 0 },
      { backend: 'ollama-9b', model: 'prism-coder:9b', used_cloud: false,
        gate_outcome: 'refused', prompt_tokens: 50_000, completion_tokens: 0 },
    ]);
    const s = await queryLocalSavings();
    expect(s!.local_calls).toBe(1);
    expect(s!.local_total_tokens).toBe(1_500);
    expect(s!.excluded_refusals).toBe(2);
  });

  it('keeps degraded-but-served calls — the user did get an answer', async () => {
    await appendInferMetricBatch([local({ gate_outcome: 'gate_failed_served' })]);
    const s = await queryLocalSavings();
    expect(s!.local_calls).toBe(1);
    expect(s!.excluded_refusals).toBe(0);
  });

  it('breaks down by model, local rows only', async () => {
    await appendInferMetricBatch([
      local({ model: 'prism-coder:9b' }),
      local({ model: 'prism-coder:4b', prompt_tokens: 10, completion_tokens: 20 }),
      { backend: 'cloud', model: 'prism-coder:9b', used_cloud: true, prompt_tokens: 77_777, completion_tokens: 1 },
    ]);
    const s = await queryLocalSavings();
    expect(s!.by_model['prism-coder:9b']).toEqual({ calls: 1, prompt_tokens: 1_000, completion_tokens: 500 });
    expect(s!.by_model['prism-coder:4b']).toEqual({ calls: 1, prompt_tokens: 10, completion_tokens: 20 });
  });

  it('honours the since-timestamp window', async () => {
    const now = Date.now();
    await appendInferMetricBatch([
      local({ ts: now - 60 * 86_400_000 }),   // 60 days ago
      local({ ts: now - 2 * 86_400_000 }),    // 2 days ago
    ]);
    const all = await queryLocalSavings();
    const month = await queryLocalSavings(windowStart('month', now));
    expect(all!.local_calls).toBe(2);
    expect(month!.local_calls).toBe(1);
  });

  it('reports zero rather than throwing on an empty ledger', async () => {
    const s = await queryLocalSavings();
    expect(s!.local_calls).toBe(0);
    expect(s!.local_total_tokens).toBe(0);
    expect(s!.first_ts).toBeNull();
  });
});

describe('undercount honesty counters', () => {
  it('counts local rows carrying no token data at all', async () => {
    await appendInferMetricBatch([
      local(),
      { backend: 'ollama-9b', model: 'prism-coder:9b', used_cloud: false },
    ]);
    const s = await queryLocalSavings();
    expect(s!.local_calls).toBe(2);
    expect(s!.local_total_tokens).toBe(1_500);       // the untokened row adds nothing
    expect(s!.local_calls_without_tokens).toBe(1);   // ...and says so
    expect(caveatsFor(s!).join(' ')).toMatch(/real total is higher/i);
  });

  it('counts KV-cache hits, where Ollama reports 0 prompt tokens for real context', async () => {
    await appendInferMetricBatch([local({ prompt_tokens: 0, completion_tokens: 300 })]);
    const s = await queryLocalSavings();
    expect(s!.local_calls_with_cached_prompt).toBe(1);
    expect(caveatsFor(s!).join(' ')).toMatch(/undercounted/i);
  });

  it('emits no caveats when there is nothing to disclose', async () => {
    await appendInferMetricBatch([local()]);
    expect(caveatsFor((await queryLocalSavings())!)).toEqual([]);
  });
});

describe('rendering', () => {
  const render = async (period: SavingsPeriod = 'all') =>
    renderSavings((await queryLocalSavings())!, period).text;

  it('states the counterfactual the headline rests on', async () => {
    await appendInferMetricBatch([local()]);
    const text = await render();
    expect(text).toMatch(/assumes each locally-served call would otherwise have gone to the cloud/i);
    expect(text).toMatch(/upper bound/i);
  });

  it('reports tokens and never a currency figure', async () => {
    // The contract from the design decision: prism cannot know host rates,
    // which model a call displaced, or whether the user is on a flat plan, so
    // it must not render money. A future edit that adds "$" here is a
    // regression, not a feature.
    await appendInferMetricBatch([local({ prompt_tokens: 4_000_000, completion_tokens: 1_000_000 })]);
    const text = await render();
    expect(text).toMatch(/tokens kept off your cloud model/i);
    expect(text).not.toMatch(/[$€£]/);
    expect(text).not.toMatch(/\b(USD|saved you|per Mtok|cost)\b/i);
  });

  it('shows the local share of routed calls', async () => {
    await appendInferMetricBatch([
      local(), local(), local(),
      { backend: 'cloud', model: 'synalux', used_cloud: true, prompt_tokens: 1, completion_tokens: 1 },
    ]);
    expect(await render()).toMatch(/3 call\(s\) served locally of 4 routed \(75%\)/);
  });

  it('guides the user instead of showing a bare zero when nothing ran', async () => {
    const text = await render();
    expect(text).toMatch(/No calls served locally yet/i);
    expect(text).not.toMatch(/tokens kept off/i);
  });

  it('abbreviates large token counts without inventing precision', () => {
    expect(abbreviate(999)).toBe('999');
    expect(abbreviate(1_500)).toBe('1.5K');
    expect(abbreviate(4_200_000)).toBe('4.2M');
    expect(abbreviate(0)).toBe('0');
  });
});

describe('session view', () => {
  it('splits prompt/completion from local-only accumulators, not by subtraction', () => {
    // Regression guard. The first cut derived local prompt tokens as
    // cloudTokensSavedEst - totalCompletionTokens, but totalCompletionTokens
    // spans cloud calls too, so any cloud call corrupted the split. The cloud
    // call below has a large completion count precisely to catch that.
    recordInference({ backend: 'ollama-9b', model_picked: 'prism-coder:9b', used_cloud: false,
      latency_ms: 100, prompt_tokens: 1_000, completion_tokens: 200 });
    recordInference({ backend: 'cloud', model_picked: 'synalux', used_cloud: true,
      latency_ms: 100, prompt_tokens: 5_000, completion_tokens: 9_000 });

    const s = sessionSavings();
    expect(s.local_prompt_tokens).toBe(1_000);
    expect(s.local_completion_tokens).toBe(200);
    expect(s.local_total_tokens).toBe(1_200);
    expect(s.cloud_calls).toBe(1);
  });

  it('attributes per-model tokens to local serves only', () => {
    // Same model name on both sides is the case byModel cannot express.
    recordInference({ backend: 'ollama-9b', model_picked: 'shared-name', used_cloud: false,
      latency_ms: 10, prompt_tokens: 100, completion_tokens: 10 });
    recordInference({ backend: 'cloud', model_picked: 'shared-name', used_cloud: true,
      latency_ms: 10, prompt_tokens: 99_999, completion_tokens: 99_999 });

    const s = sessionSavings();
    expect(s.by_model['shared-name']).toEqual({ calls: 1, prompt_tokens: 100, completion_tokens: 10 });
    // The mixed map still holds both, which is why the meter does not read it.
    expect(getInferenceSnapshot().byModel['shared-name']!.calls).toBe(2);
  });

  it('excludes refusals from the session accumulators', () => {
    recordInference({ backend: 'refused', model_picked: null, used_cloud: false,
      latency_ms: 10, prompt_tokens: 50_000, completion_tokens: 0 });
    const s = sessionSavings();
    expect(s.local_calls).toBe(0);
    expect(s.local_total_tokens).toBe(0);
  });
});

describe('windowStart', () => {
  it('bounds month to a trailing 30 days and leaves all/session unbounded', () => {
    const now = 1_800_000_000_000;
    expect(windowStart('month', now)).toBe(now - 30 * 86_400_000);
    expect(windowStart('all', now)).toBeUndefined();
    expect(windowStart('session', now)).toBeUndefined();
  });
});
