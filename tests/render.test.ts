import { describe, expect, it } from 'vitest';
import { state } from './fixtures.ts';
import { normalizeReceipt, normalizeState } from '../src/protocol.ts';
import { renderReceipt, renderSnapshot } from '../src/render.ts';

const norm = (name: string) => normalizeState(state(name));

describe('回执', () => {
  it('局面没变也带编号（否则她还得再观察一次）', () => {
    const snapshot = normalizeState(state('combat-t1'));
    const text = renderReceipt({ outcome: 'executed', reason: '', code: '', snapshot }, snapshot, snapshot.actions[0]);
    expect(text).toContain('操作：');
    expect(text).toContain('结束回合');
  });
});

describe('战斗渲染', () => {
  const text = renderSnapshot(norm('combat-t1'));

  it('局面、能量、敌人意图都在', () => {
    expect(text).toContain('[StS2 ');
    expect(text).toContain('第0幕 · 第2层 · 生命 80/80 · 金币 99');
    expect(text).toContain('回合 1 · 能量 3');
    expect(text).toContain('敌0 噬尸蛞蝓 · 26/26生命 · 攻击 3×2 · 状态 饥饿 4');
    expect(text).toContain('敌1 噬尸蛞蝓 · 27/27生命 · 攻击 8×1 · 状态 饥饿 4');
  });

  it('手牌用解析后的卡面文本，并带出牌编号', () => {
    expect(text).toContain('打击（1费）：造成6点伤害。　出牌 2→敌0、3→敌1');
    expect(text).toContain('防御（1费）：获得5点格挡。　出牌 6');
    expect(text).toContain('探寻：不能被打出');
    expect(text).toContain('（打不出：不可打出）');
  });

  it('把这回合的账算好：入射、最多可挡、缺口、预计掉血', () => {
    expect(text).toContain('入射 14（敌0 3×2、敌1 8×1）');
    expect(text).toContain('最多可挡 10（2 张防御）');
    expect(text).toContain('缺口 4，预计掉 4，剩 76/80');
  });

  it('挡得住时说清楚"够用"', () => {
    const raw = structuredClone(state('combat-t1')) as Record<string, any>;
    (raw['combat']['enemies'] as any[]).forEach((enemy) => { enemy.intents = [{ intent_type: 'Attack', damage: 1, hits: 1 }]; });
    expect(renderSnapshot(normalizeState(raw))).toContain('挡得住');
  });

  it('缺口超过生命时直接说会死', () => {
    const raw = structuredClone(state('combat-t1')) as Record<string, any>;
    raw['run']['current_hp'] = 3;
    (raw['combat']['enemies'] as any[]).forEach((enemy) => { enemy.intents = [{ intent_type: 'Attack', damage: 10, hits: 1 }]; });
    expect(renderSnapshot(normalizeState(raw))).toContain('本回合会死');
  });

  it('牌堆与其余操作', () => {
    expect(text).toContain('牌堆：抽 6／弃 0／消耗 0');
    expect(text).toContain('1 结束回合');
  });

  it('结束回合会死的时候必须警告', () => {
    const lethal = structuredClone(state('combat-t1'));
    (lethal.combat as Record<string, unknown>).end_turn_will_kill_player = true;
    expect(renderSnapshot(normalizeState(lethal))).toContain('⚠ 现在结束回合会被打死。');
  });
});

describe('其他界面', () => {
  it('地图：位置、规模、可走节点', () => {
    const text = renderSnapshot(norm('map-act0'));
    expect(text).toContain('当前位置 (0,3)');
    expect(text).toContain('地图 16行 × 7列 · 已走 1 个节点 · 可走 3 个 · 首领 (16,3)');
    expect(text).toContain('1 战斗 (1,0)');
  });

  it('多人地图：把队友投票写进局面', () => {
    const raw = structuredClone(state('map-act0')) as Record<string, any>;
    raw['session']['mode'] = 'coop';
    (raw['run']['players'] as any[]).push({ player_id: '2', slot_index: 1, is_local: false, is_connected: true });
    (raw['map']['player_votes'] as any[]).push({ player_id: '2', slot_index: 1, is_local: false, coord: { row: 1, col: 3 } });
    (raw['map']['available_nodes'] as any[])[1].vote_count = 1;
    (raw['map']['available_nodes'] as any[])[1].voted_player_ids = ['2'];
    const text = renderSnapshot(normalizeState(raw));
    expect(text).toContain('投票：');
    expect(text).toContain('P2 → (1,3)');
    expect(text).toContain('你未投');
    expect(text).toContain('(1,3) 1票');
  });

  it('多选选牌屏：说清要选几张，并给出一次提交的写法', () => {
    const text = renderSnapshot(norm('selection-remove'));
    expect(text).toContain('选择2张牌来移除');
    expect(text).toContain('已选 0/2（要选满 2 张）');
    expect(text).toContain('sts2_play({state, steps:[{select:1},{select:2}]})');
    expect(text).toContain('1 打击');
    expect(text).toContain('10 痛击');
  });

  it('事件：标题在，本地化键与富文本都不露出', () => {
    const text = renderSnapshot(norm('event-neow'));
    expect(text).toContain('涅奥');
    expect(text).not.toContain('NEOW.pages');
    expect(text).not.toMatch(/\[(blue|gold|green)\]/);
  });

  it('篝火：可做清单', () => {
    expect(renderSnapshot(norm('rest'))).toContain('可做：休息；锻造；挖掘');
  });

  it('商店：货架与价格分开列，不跟自己的遗物混淆', () => {
    const text = renderSnapshot(norm('shop-open'));
    expect(text).toContain('货架卡牌：暴走 72金');
    expect(text).toContain('货架遗物：梨子 206金');
    expect(text).toContain('货架药水：攻击药水 51金');
  });

  it('宝箱：开箱状态说清楚', () => {
    expect(renderSnapshot(norm('chest-closed'))).toContain('宝箱还没开。');
    expect(renderSnapshot(norm('chest-open'))).toContain('宝箱已开，可选遗物：摆动球');
  });

  it('战利品：列出可领的东西', () => {
    expect(renderSnapshot(norm('reward'))).toContain('战利品：将一张牌添加到你的牌组。');
  });

  it('牌组只在 full 里出现', () => {
    expect(renderSnapshot(norm('combat-t1'))).not.toContain('牌组 11张');
    expect(renderSnapshot(norm('combat-t1'), true)).toContain('牌组 11张');
  });
});

describe('同屏增量', () => {
  it('只有能量变了，就只报战斗那一行', () => {
    const before = norm('combat-t1');
    const raw = structuredClone(state('combat-t1'));
    (raw.combat as Record<string, unknown>).player = { ...(raw.combat as Record<string, unknown>).player as object, energy: 1 };
    (raw as Record<string, unknown>).state_version = 11;
    const after = normalizeState(raw);
    const text = renderSnapshot(after, false, before);
    expect(text).toContain('变化');
    expect(text).toContain('回合 1 · 能量 1');
    expect(text).not.toContain('第0幕');
  });
});

describe('回执渲染', () => {
  it('已执行说清做了什么', () => {
    const before = norm('combat-t1');
    const receipt = normalizeReceipt({ ok: true, data: state('combat-t1-after') }, before);
    const text = renderReceipt(receipt, before, before.actions[1]);
    expect(text).toContain('已执行：打击→敌0。');
  });

  it('被拒说清原因', () => {
    const before = norm('combat-t1');
    const receipt = normalizeReceipt({ ok: false, error: { code: 'invalid_target', message: 'x' } }, before);
    expect(renderReceipt(receipt, before, before.actions[1])).toContain('未执行：目标或编号已失效');
  });

  it('没有新状态时要求先观察', () => {
    expect(renderReceipt(normalizeReceipt({}, null), norm('combat-t1'))).toContain('结果未确认');
  });
});