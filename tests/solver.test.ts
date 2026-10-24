/** 求解器注记：只认能对上编号、且它自己说"看懂了这个牌组"的第一步。 */
import { describe, expect, it } from 'vitest';
import { adviceLine, matchAction, parsePlan, planBlock } from '../src/solver.ts';
import { normalizeState } from '../src/protocol.ts';
import { load } from './fixtures.ts';

const raw = load('solver-combat') as { data: Record<string, unknown> };
const plan = parsePlan(raw)!;
const combat = normalizeState(load('combat-t1'));

describe('求解器注记', () => {
  it('解析真机响应：第一步是"打击→敌0"', () => {
    expect(plan).not.toBeNull();
    expect(plan.first).toMatchObject({ kind: 'play_card', cardIndex: 1, targetIndex: 0, cardName: '打击' });
    expect(plan.confidence).toBe(0.9);
    expect(plan.searchStatus).toBe('complete');
    expect(plan.coverage.unsupported).toBe(0);
  });

  it('能把第一步对上我们的编号', () => {
    expect(matchAction(combat, plan)).toBe(2); // combat-t1 里 card_index 1 → 敌0 是 2 号
  });

  it('贴出来是一行，带编号、置信、覆盖和它的说法', () => {
    const line = adviceLine(combat, plan);
    expect(line).toContain('下一步 → 2');
    expect(line).toContain('置信 0.90');
    expect(line).toContain('覆盖 5 张');
    expect(line).toContain('打出「打击」');
  });

  it('不在战斗 / 搜索没完成 / 覆盖有缺口 / 置信太低，都不贴', () => {
    const nonCombat = normalizeState(load('map-act0'));
    expect(adviceLine(nonCombat, plan)).toBeNull();

    const unfinished = parsePlan({ ok: true, data: { ...raw.data, search_status: 'budget_exhausted' } })!;
    expect(adviceLine(combat, unfinished)).toBeNull();

    const gap = parsePlan({ ok: true, data: { ...raw.data, coverage: { exact: 3, inferred: 0, unsupported: 2, ignored: 0, potions: 0, risk: false } } })!;
    expect(adviceLine(combat, gap)).toBeNull();

    const unsure = parsePlan({ ok: true, data: { ...raw.data, confidence: 0.2 } })!;
    expect(adviceLine(combat, unsure, 0.6)).toBeNull();
  });

  it('不在战斗时解析直接返回 null', () => {
    expect(parsePlan({ ok: true, data: { in_combat: false, line: [] } })).toBeNull();
    expect(parsePlan({ ok: false, error: { code: 'not_found' } })).toBeNull();
    expect(parsePlan(null)).toBeNull();
  });

  it('门槛只有一道：注记和自动接管共用 planBlock', () => {
    expect(planBlock(plan)).toBeNull();

    const unfinished = parsePlan({ ok: true, data: { ...raw.data, search_status: 'incomplete' } })!;
    expect(planBlock(unfinished)).toBe('search-incomplete');

    const gap = parsePlan({ ok: true, data: { ...raw.data, coverage: { exact: 3, inferred: 0, unsupported: 2, ignored: 0, risk: false } } })!;
    expect(planBlock(gap)).toBe('unsupported');

    const risky = parsePlan({ ok: true, data: { ...raw.data, coverage: { exact: 4, inferred: 1, unsupported: 0, ignored: 0, risk: true } } })!;
    expect(planBlock(risky)).toBe('risky');

    const unsure = parsePlan({ ok: true, data: { ...raw.data, confidence: 0.2 } })!;
    expect(planBlock(unsure, 0.6)).toBe('low-confidence');
    expect(planBlock(unsure, 0.1)).toBeNull();
  });

  it('没有第一步也是不贴的理由', () => {
    const empty = parsePlan({ ok: true, data: { ...raw.data, line: [] } })!;
    expect(empty.first).toBeNull();
    expect(planBlock(empty)).toBe('no-step');
    expect(adviceLine(combat, empty)).toBeNull();
  });
});
describe('求解器压力闸', () => {
  it('算不动就冷 60 秒：冷却期内一次请求都不发', async () => {
    const { SolverClient } = await import('../src/solver.ts');
    let calls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((_url: unknown, init?: RequestInit) => {
      calls++;
      // 不会自己回：只有超时信号 abort 时才 reject —— 和真机 boss 战一致
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }) as unknown as typeof fetch;
    try {
      const client = new SolverClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 60 });
      expect(await client.plan()).toBeNull();
      expect(calls).toBe(1);
      expect(client.cooling).toBe(true);
      // 冷却期内再问：立刻 null，不发请求
      expect(await client.plan()).toBeNull();
      await expect(client.plan()).resolves.toBeNull();
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('同一时刻只有一份在算：并发调用拿同一个结果', async () => {
    const { SolverClient } = await import('../src/solver.ts');
    let calls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return new Response(JSON.stringify({ ok: true, data: { in_combat: true, line: [], confidence: 0.9 } }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const client = new SolverClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 2000 });
      const results = await Promise.all([client.plan(), client.plan(), client.plan()]);
      expect(results).toHaveLength(3);
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
