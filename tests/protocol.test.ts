import { describe, expect, it } from 'vitest';
import { state } from './fixtures.ts';
import { detectRollback, normalizeReceipt, normalizeState, selectionNeed, stateRef, unwrap } from '../src/protocol.ts';

const norm = (name: string) => normalizeState(state(name));

describe('回包包装', () => {
  it('{ok, request_id, data} 会被剥开', () => {
    expect(unwrap(state('menu'))).toMatchObject({ screen: 'MAIN_MENU' });
  });
});

describe('主菜单', () => {
  const snapshot = norm('menu');
  it('动作翻成人话，save_and_quit 不给编号', () => {
    expect(snapshot.screen).toBe('main-menu');
    expect(snapshot.mode).toBe('single');
    expect(snapshot.actions.map((a) => a.label)).toEqual(['进入选角色界面', '查看时间线', '打开多人菜单', '开一局联机']);
    expect(snapshot.actions.some((a) => a.command['action'] === 'save_and_quit')).toBe(false);
  });
});

describe('事件', () => {
  it('涅奥：每个选项一个编号，option_index 从 0 起', () => {
    const snapshot = norm('event-neow');
    expect(snapshot.screen).toBe('event');
    expect(snapshot.actions).toHaveLength(3);
    expect(snapshot.actions[0]!.command).toEqual({ action: 'choose_event_option', option_index: 0 });
    expect(snapshot.actions[0]!.label).toContain('羽翼之靴');
    expect(snapshot.actions[2]!.command).toEqual({ action: 'choose_event_option', option_index: 2 });
  });

  it('普通事件：富文本清掉，药水动作带槽位编号', () => {
    const snapshot = norm('event-normal');
    const text = snapshot.actions.map((a) => a.label).join('\n');
    expect(text).toContain('这个：失去6点生命');
    expect(text).toContain('那个：将一张笨拙加入你的牌组');
    expect(text).not.toMatch(/\[(blue|gold|green)\]/);
    const potion = snapshot.actions.find((a) => a.kind === 'use-potion');
    expect(potion?.command).toEqual({ action: 'use_potion', option_index: 0 });
  });
});

describe('战斗', () => {
  it('可打出的牌按「牌 × 合法目标」编号，打不出的牌不占编号', () => {
    const snapshot = norm('combat-t1');
    expect(snapshot.actions).toHaveLength(7);
    expect(snapshot.actions[0]!.command).toEqual({ action: 'end_turn' });
    expect(snapshot.actions[1]!.command).toEqual({ action: 'play_card', card_index: 1, target_index: 0 });
    expect(snapshot.actions[2]!.command).toEqual({ action: 'play_card', card_index: 1, target_index: 1 });
    expect(snapshot.actions[6]!.command).toEqual({ action: 'play_card', card_index: 4 });
    expect(snapshot.actions.some((a) => a.label.includes('探寻'))).toBe(false);
    expect(snapshot.combat?.hand).toHaveLength(5);
    expect(snapshot.combat?.energy).toBe(3);
  });

  it('出牌后手牌下标整体前移，编号跟着换算', () => {
    const after = norm('combat-t1-after');
    expect(after.actions).toHaveLength(5);
    const indices = after.actions.filter((a) => a.kind === 'play').map((a) => a.command['card_index']);
    expect(indices).toEqual([1, 1, 2, 3]);
  });

  it('敌人意图读成攻击次数与伤害', () => {
    const [first] = norm('combat-t1').combat!.monsters;
    expect(first!.name).toBe('噬尸蛞蝓');
    expect(first!.current_hp).toBe(26);
  });
});

describe('地图', () => {
  it('每个可走节点一个编号，编号空间是 option_index', () => {
    const snapshot = norm('map-act0');
    expect(snapshot.screen).toBe('map');
    expect(snapshot.actions).toHaveLength(3);
    expect(snapshot.actions[0]!.label).toBe('战斗 (1,0)');
    expect(snapshot.actions[2]!.command).toEqual({ action: 'choose_map_node', option_index: 2 });
  });

  it('队友投票变化会生成新的状态码（否则不会推给她）', () => {
    const raw = structuredClone(state('map-act0')) as Record<string, any>;
    raw['session']['mode'] = 'coop';
    (raw['run']['players'] as any[]).push({ player_id: '2', slot_index: 1, is_local: false });
    const before = stateRef(normalizeState(raw));
    (raw['map']['player_votes'] as any[]).push({ player_id: '2', slot_index: 1, is_local: false, coord: { row: 1, col: 3 } });
    (raw['map']['available_nodes'] as any[])[1].vote_count = 1;
    const after = stateRef(normalizeState(raw));
    expect(after).not.toBe(before);
  });
});

describe('奖励与选牌', () => {
  it('战利品屏：领取按 rewards 下标编号', () => {
    const snapshot = norm('reward');
    const claim = snapshot.actions.find((a) => a.command['action'] === 'claim_reward');
    expect(claim?.command).toEqual({ action: 'claim_reward', option_index: 0 });
    expect(snapshot.actions.some((a) => a.command['action'] === 'collect_rewards_and_proceed')).toBe(true);
    expect(snapshot.actions.some((a) => a.command['action'] === 'resolve_rewards')).toBe(true);
  });

  it('选牌屏：候选牌各一个编号，且不重复出两套', () => {
    const snapshot = norm('card-reward');
    const picks = snapshot.actions.filter((a) => a.command['action'] === 'choose_reward_card');
    expect(picks).toHaveLength(3);
    expect(picks.map((a) => a.command['option_index'])).toEqual([0, 1, 2]);
    expect(picks[0]!.label).toContain('完美打击');
    expect(snapshot.actions.some((a) => a.command['action'] === 'select_deck_card')).toBe(false);
    expect(snapshot.actions.some((a) => a.command['action'] === 'skip_reward_cards')).toBe(true);
  });

  it('牌组选牌屏：select_deck_card 的编号覆盖整副可选牌', () => {
    const snapshot = norm('select-upgrade');
    const picks = snapshot.actions.filter((a) => a.command['action'] === 'select_deck_card');
    expect(picks.length).toBe(12);
    expect(picks.at(-1)!.command['option_index']).toBe(11);
  });
});

describe('商店', () => {
  it('买卡按 cards 下标，买不起的标出来', () => {
    const snapshot = norm('shop-open');
    const buys = snapshot.actions.filter((a) => a.command['action'] === 'buy_card');
    expect(buys).toHaveLength(7);
    expect(buys[0]!.label).toContain('暴走');
    expect(buys[0]!.label).toContain('72金币');
    expect(buys.at(-1)!.label).toContain('金币不足');
    const relics = snapshot.actions.filter((a) => a.command['action'] === 'buy_relic');
    expect(relics.map((a) => a.command['option_index'])).toEqual([0, 1, 2]);
    expect(snapshot.actions.some((a) => a.command['action'] === 'remove_card_at_shop')).toBe(true);
  });

  it('没开货架时只有打开和离开', () => {
    const snapshot = norm('shop-closed');
    expect(snapshot.actions.map((a) => a.command['action'])).toEqual(['proceed', 'open_shop_inventory']);
  });
});

describe('篝火与宝箱', () => {
  it('篝火：遗物带来的额外选项也在列表里', () => {
    const snapshot = norm('rest');
    const options = snapshot.actions.filter((a) => a.command['action'] === 'choose_rest_option');
    expect(options.map((a) => a.label.split('：')[0])).toEqual(['休息', '锻造', '挖掘']);
    expect(options[1]!.command).toEqual({ action: 'choose_rest_option', option_index: 1 });
  });

  it('宝箱开前是 open_chest，开后是 choose_treasure_relic', () => {
    expect(norm('chest-closed').actions[0]!.command).toEqual({ action: 'open_chest' });
    const open = norm('chest-open');
    expect(open.actions[0]!.label).toBe('摆动球');
    expect(open.actions[0]!.command).toEqual({ action: 'choose_treasure_relic', option_index: 0 });
  });
});

describe('状态码与回档', () => {
  it('同一局面稳定，血变了就变', () => {
    const a = norm('combat-t1');
    expect(stateRef(norm('combat-t1'))).toBe(stateRef(a));
    const changed = structuredClone(state('combat-t1'));
    (changed.run as Record<string, unknown>).current_hp = 40;
    expect(stateRef(normalizeState(changed))).not.toBe(stateRef(a));
  });

  it('层数倒退算回档', () => {
    const previous = norm('combat-t1');
    const rolled = structuredClone(state('combat-t1'));
    (rolled.run as Record<string, unknown>).floor = 1;
    expect(detectRollback(previous, normalizeState(rolled))).toContain('退回');
  });

  it('正常往前不算回档', () => {
    const previous = norm('combat-t1');
    const next = structuredClone(state('combat-t1'));
    (next.run as Record<string, unknown>).floor = 3;
    expect(detectRollback(previous, normalizeState(next))).toBeNull();
  });
});

describe('回执', () => {
  it('ok=false + error.code 是未执行，并给中文原因', () => {
    const receipt = normalizeReceipt({
      ok: false, error: { code: 'invalid_action', message: 'Action is not supported yet.' },
    }, norm('combat-t1'));
    expect(receipt.outcome).toBe('rejected');
    expect(receipt.reason).toBe('当前界面不支持这个动作');
  });

  it('ok=true 带新状态就是已执行', () => {
    const receipt = normalizeReceipt({ ok: true, data: state('map-act0') }, null);
    expect(receipt.outcome).toBe('executed');
    expect(receipt.snapshot?.screen).toBe('map');
  });

  it('没有 ok 也没有 error 时算未确认', () => {
    expect(normalizeReceipt({}, norm('combat-t1')).outcome).toBe('unknown');
  });

  it('ok=true 但 status:pending 只是"排上队"，不算执行成功', () => {
    // 真机：选牌屏点一张，桥等 10 秒回这个。当成成功她会以为选完了，接着反复点同一张。
    const receipt = normalizeReceipt({
      ok: true,
      data: {
        action: 'select_deck_card', status: 'pending', stable: false,
        message: 'Action queued but state is still transitioning.',
        state: state('selection-remove'),
      },
    }, null);
    expect(receipt.outcome).toBe('pending');
    expect(receipt.snapshot?.screen).toBe('selection');
  });

  it('status:completed 才是真的执行了', () => {
    const receipt = normalizeReceipt({
      ok: true,
      data: { action: 'select_deck_card', status: 'completed', stable: true, state: state('selection-remove') },
    }, null);
    expect(receipt.outcome).toBe('executed');
  });
});

describe('多选屏', () => {
  it('从题面里读出要选几张（桥给的 max_select 是 0）', () => {
    const block = (state('selection-remove') as Record<string, any>)['selection'];
    expect(block['max_select']).toBe(0);
    expect(selectionNeed(block)).toBe(2);
  });
});