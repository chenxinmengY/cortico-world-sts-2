/** 回档判定：只认"只增不减"的量，加上存档里的读档次数。 */
import { describe, expect, it } from 'vitest';
import { PassportTracker } from '../src/passport.ts';
import { normalizeState } from '../src/protocol.ts';
import type { SaveFacts } from '../src/savefile.ts';
import { load } from './fixtures.ts';

type Envelope = { data: Record<string, unknown> };

const snap = (name: string, mutate?: (data: Record<string, any>) => void) => {
  const raw = structuredClone(load(name)) as Envelope;
  mutate?.(raw.data as Record<string, any>);
  return normalizeState(raw);
};

const save = (numReloads: number, seed = 'SEED-A'): SaveFacts => ({ numReloads, seed, saveTime: 0, path: 'x' });

const combat = (hp: number, floor: number) => snap('combat-t1', (data) => {
  (data['run'] as Record<string, unknown>)['current_hp'] = hp;
  (data['run'] as Record<string, unknown>)['floor'] = floor;
});

const withMap = (act: number, visited: number) => snap('map-act0', (data) => {
  (data['run'] as Record<string, unknown>)['act_id'] = act;
  data['map'] = { nodes: Array.from({ length: 5 }, (_, i) => ({ visited: i < visited, is_available: false })) };
});

describe('回档判定', () => {
  it('篝火把血补满不算回档（旧版的误报源）', () => {
    const tracker = new PassportTracker();
    tracker.observe(combat(38, 7), null);
    expect(tracker.observe(combat(88, 7), null)).toBeNull();
  });

  it('层数倒退算回档', () => {
    const tracker = new PassportTracker();
    tracker.observe(combat(70, 7), null);
    const verdict = tracker.observe(combat(70, 5), null);
    expect(verdict?.kind).toBe('rollback');
    expect(verdict?.reason).toContain('退回');
  });

  it('换幕导致地图重建不算回档', () => {
    const tracker = new PassportTracker();
    tracker.observe(withMap(1, 4), null);
    expect(tracker.observe(withMap(2, 0), null)).toBeNull();
  });

  it('从地图切到战斗帧（没有地图块）不算回档', () => {
    const tracker = new PassportTracker();
    tracker.observe(withMap(0, 4), null);
    // 战斗帧里 blocks.map 不存在，visited 会被读成 0；这不是回档。
    const combatFrame = snap('combat-t1', (data) => { delete data['map']; });
    expect(tracker.observe(combatFrame, null)).toBeNull();
  });

  it('同一幕里走过的节点变少算回档', () => {
    const tracker = new PassportTracker();
    tracker.observe(withMap(1, 4), null);
    expect(tracker.observe(withMap(1, 2), null)?.kind).toBe('rollback');
  });

  it('读档次数增加、局面也退了 → 读档', () => {
    const tracker = new PassportTracker();
    tracker.observe(combat(70, 7), save(0));
    const verdict = tracker.observe(combat(40, 6), save(1));
    expect(verdict?.kind).toBe('reload');
    expect(verdict?.reason).toContain('读档次数 0→1');
  });

  it('读档次数增加但局面没变（去大厅转一圈）→ 不打扰', () => {
    const tracker = new PassportTracker();
    tracker.observe(combat(70, 7), save(0));
    expect(tracker.observe(combat(70, 7), save(1))).toBeNull();
  });

  it('seed 变了就是换局', () => {
    const tracker = new PassportTracker();
    tracker.observe(combat(70, 7), save(0, 'SEED-A'));
    expect(tracker.observe(combat(70, 7), save(0, 'SEED-B'))?.kind).toBe('new-run');
  });

  it('金币和牌组同时变少只说"对不上"，不作废计划', () => {
    const tracker = new PassportTracker();
    tracker.observe(snap('shop-open'), null);
    const next = snap('shop-open', (data) => {
      (data['run'] as Record<string, unknown>)['gold'] = 20;
      (data['run'] as Record<string, unknown>)['deck'] = ((data['run'] as Record<string, unknown>)['deck'] as unknown[]).slice(0, 4);
    });
    expect(tracker.observe(next, null)?.kind).toBe('drift');
  });
});