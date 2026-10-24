/** 兜底白名单：只替她点"没得选"的推进动作。规则全部来自真机样本。 */
import { describe, expect, it } from 'vitest';
import { looksLikeSettling, pickAutoAction } from '../src/auto.ts';
import { normalizeState } from '../src/protocol.ts';
import { load } from './fixtures.ts';

const norm = (name: string) => normalizeState(load(name));

describe('兜底自动', () => {
  it('战斗里永远不替她结束回合（跳过整个回合的代价太大）', () => {
    const snapshot = norm('combat-no-playable');
    expect(snapshot.actions.map((action) => action.command['action'])).toEqual(['end_turn']);
    expect(pickAutoAction(snapshot)).toBeNull();
    expect(pickAutoAction(snapshot, 'recovery')).toBeNull();
  });

  it('手牌空着（牌还没抽上来）时绝不替她结束回合', () => {
    const raw = structuredClone(load('combat-t1')) as { data: Record<string, any> };
    raw.data['combat']['hand'] = [];
    raw.data['available_actions'] = ['end_turn', 'save_and_quit'];
    const snapshot = normalizeState(raw);
    expect(snapshot.actions.map((action) => action.command['action'])).toEqual(['end_turn']);
    expect(pickAutoAction(snapshot)).toBeNull();
  });

  it('手牌还能打就绝不替她决定', () => {
    expect(pickAutoAction(norm('combat-t1'))).toBeNull();
  });

  it('结束回合会死人的时候不自动', () => {
    const raw = structuredClone(load('combat-no-playable')) as { data: Record<string, Record<string, unknown>> };
    raw.data['combat']['end_turn_will_kill_player'] = true;
    expect(pickAutoAction(normalizeState(raw))).toBeNull();
  });

  it('奖励全领完才替她点继续；还有没领的就不动', () => {
    const claimed = norm('reward-claimed');
    expect(pickAutoAction(claimed)?.action.command['action']).toBe('collect_rewards_and_proceed');
    expect(pickAutoAction(norm('reward'))).toBeNull();
  });

  it('宝箱可以开，但手上还有药水可喝时也算有取舍', () => {
    const withPotions = norm('chest-closed');
    expect(withPotions.actions.some((action) => action.command['action'] === 'use_potion')).toBe(true);
    expect(pickAutoAction(withPotions)).toBeNull(); // 喝不喝药水是玩家的选择

    const noPotions = normalizeState((() => {
      const raw = structuredClone(load('chest-closed')) as { data: Record<string, any> };
      raw.data['run']['potions'] = [];
      return raw;
    })());
    expect(pickAutoAction(noPotions)?.action.command['action']).toBe('open_chest');
  });

  it('选牌屏不替她确认', () => {
    expect(pickAutoAction(norm('card-select-two'), 'immediate')).toBeNull();
    expect(pickAutoAction(norm('card-select-two'), 'recovery')).toBeNull(); // can_confirm 不是 true
  });

  it('地图 / 事件 / 休息点永不自动', () => {
    for (const name of ['map-act0', 'event-normal', 'rest']) {
      expect(pickAutoAction(norm(name)), name).toBeNull();
    }
  });

  it('战斗里空动作算"结算中"，不是"她不会"', () => {
    const snapshot = norm('combat-empty-frame');
    expect(snapshot.actions).toHaveLength(0);
    expect(looksLikeSettling(snapshot)).toBe(true);
    expect(looksLikeSettling(norm('event-normal'))).toBe(false);
  });
});