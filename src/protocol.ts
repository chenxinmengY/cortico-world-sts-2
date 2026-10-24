/**
 * STS2 桥的真实契约（NekoSpire `protocolVersion: 2026-03-11-v1`，对照其 GameActionService.cs）：
 *
 *   GET  /state             → { ok, request_id, data }
 *   GET  /actions/available → { ok, data: { screen, actions: [{name, requires_target, requires_index}] } }
 *   POST /action            → { action, card_index?, target_index?, option_index? } → { ok, data } | { ok:false, error:{code,message} }
 *
 * 参数名不是统一的：出牌用 card_index + target_index，其余带编号的动作一律 option_index。
 * 编号空间也不是同一个数组，所以这里按动作名逐条映射（见 INDEX_ACTIONS）。
 * 校准依据：samples/ 下的真机抓包。
 */
import { createHash } from 'node:crypto';

export type Fields = Record<string, unknown>;

export const object = (value: unknown): Fields =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Fields) : {};

export const list = (value: unknown): Fields[] =>
  Array.isArray(value) ? value.filter((item) => item !== null && typeof item === 'object').map(object) : [];

function variants(key: string): string[] {
  return [key, key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`), key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())];
}

/** 多路径取值，每段自动 snake/camel；命中第一个非 null/undefined。 */
export function pick<T = unknown>(src: Fields, ...paths: string[]): T | undefined {
  for (const path of paths) {
    let cursor: unknown = src;
    for (const segment of path.split('.')) {
      const node = object(cursor);
      let hit: unknown;
      for (const name of variants(segment)) {
        if (node[name] !== undefined && node[name] !== null) { hit = node[name]; break; }
      }
      if (hit === undefined) { cursor = undefined; break; }
      cursor = hit;
    }
    if (cursor !== undefined && cursor !== null) return cursor as T;
  }
  return undefined;
}

export function num(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return fallback;
}

export function bool(value: unknown): boolean {
  return value === true || value === 'true' || value === 1;
}

const energyIcons: Record<string, string> = { R: '1能量', G: '1能量', B: '1能量', W: '1能量', E: '1能量', P: '1能量' };

/** 游戏文本：能量标记、富文本标签、换行、未解析的模板与图标路径。 */
export function words(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\[(R|G|B|W|E|P)\]/g, (_, key: string) => energyIcons[key] ?? '能量')
    .replace(/\[\/?[a-zA-Z][a-zA-Z0-9_]*(?:=[^\]]*)?\]/g, '')
    .replace(/res:\/\/\S+/g, '')
    .replace(/\{[^}]*\}/g, '?')
    .replace(/\s*NL\s*|\s*\n\s*/g, '；')
    .replace(/#[rgbypwocv]|[@~]/gi, '')
    .replace(/\s+([，。；！？、])/g, '$1')
    .replace(/；{2,}/g, '；')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** 本地化键（`NEOW.pages.INITIAL.description`）不是给人看的文本。 */
const LOCALE_KEY = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)+$/;

export function cleanText(value: unknown): string {
  const text = words(value);
  return !text || LOCALE_KEY.test(text) ? '' : text;
}

/* ───────────────────────────── 屏幕 ───────────────────────────── */

export type Screen =
  | 'main-menu' | 'character-select' | 'combat' | 'map' | 'reward' | 'card-reward'
  | 'shop' | 'rest' | 'chest' | 'event' | 'selection' | 'deck-view'
  | 'game-over' | 'victory' | 'unknown';

export const SCREEN_LABEL: Record<Screen, string> = {
  'main-menu': '主菜单', 'character-select': '选角色', combat: '战斗', map: '地图',
  reward: '战利品', 'card-reward': '选牌', shop: '商店', rest: '休息点', chest: '宝箱',
  event: '事件', selection: '选择', 'deck-view': '查看牌组', 'game-over': '游戏结束',
  victory: '胜利', unknown: '未知界面',
};

const SCREENS: Record<string, Screen> = {
  MAIN_MENU: 'main-menu',
  CHARACTER_SELECT: 'character-select',
  COMBAT: 'combat',
  MAP: 'map',
  REWARD: 'reward',
  CARD_SELECTION_REWARD: 'card-reward',
  CARD_REWARD: 'card-reward',
  CARD_SELECTION: 'selection',
  CARD_SELECTION_REMOVE: 'selection',
  SHOP: 'shop',
  REST: 'rest',
  CHEST: 'chest',
  EVENT: 'event',
  TIMELINE: 'deck-view',
  GAME_OVER: 'game-over',
  VICTORY: 'victory',
  TERMINAL: 'game-over',
};

const SCREEN_RULES: Array<[RegExp, Screen]> = [
  [/main.?menu/i, 'main-menu'],
  [/character.?select|embark/i, 'character-select'],
  [/combat|battle/i, 'combat'],
  [/card.?selection.?reward/i, 'card-reward'],
  [/card.?selection/i, 'selection'],
  [/reward/i, 'reward'],
  [/shop|merchant|store/i, 'shop'],
  [/rest|campfire|smith|forge/i, 'rest'],
  [/chest|treasure/i, 'chest'],
  [/event/i, 'event'],
  [/bundle|capstone|select|choose|pick|grid/i, 'selection'],
  [/map|route/i, 'map'],
  [/deck|pile|timeline|view/i, 'deck-view'],
  [/victory/i, 'victory'],
  [/game.?over|death|defeat|terminal/i, 'game-over'],
];

export function classifyScreen(rawName: string): Screen {
  const exact = SCREENS[rawName.toUpperCase()];
  if (exact) return exact;
  for (const [pattern, screen] of SCREEN_RULES) if (pattern.test(rawName)) return screen;
  return 'unknown';
}

/* ───────────────────────────── 动作 ───────────────────────────── */

export type ActionKind =
  | 'play' | 'end-turn' | 'use-potion' | 'discard-potion' | 'map' | 'choose'
  | 'confirm' | 'cancel' | 'proceed' | 'buy' | 'rest' | 'open' | 'other';

export interface NormAction {
  n: number;
  kind: ActionKind;
  label: string;
  target?: number;
  /** 回传给桥的指令体：{ action, card_index? | option_index? , target_index? } */
  command: Fields;
}

const KIND_RULES: Array<[RegExp, ActionKind]> = [
  [/end.?turn/i, 'end-turn'],
  [/play.?card/i, 'play'],
  [/use.?potion/i, 'use-potion'],
  [/discard.?potion/i, 'discard-potion'],
  [/map.?node|travel/i, 'map'],
  [/^buy|purchase/i, 'buy'],
  [/rest.?option|smith|rest/i, 'rest'],
  [/open.?chest|chest/i, 'open'],
  [/proceed|collect|resolve|continue/i, 'proceed'],
  [/confirm|embark|ready/i, 'confirm'],
  [/skip|cancel|back/i, 'cancel'],
  [/choose|select|pick|claim|reward|bundle|capstone|divine/i, 'choose'],
];

export function classifyAction(raw: string): ActionKind {
  for (const [pattern, kind] of KIND_RULES) if (pattern.test(raw)) return kind;
  return 'other';
}

/** 动作名的中文兜底；认不出的就把下划线换成空格。 */
const ACTION_LABEL: Record<string, string> = {
  end_turn: '结束回合',
  play_card: '出牌',
  use_potion: '使用药水',
  discard_potion: '丢弃药水',
  choose_map_node: '走这个节点',
  claim_reward: '领取这项奖励',
  choose_reward_card: '选这张牌',
  skip_reward_cards: '跳过选牌',
  resolve_rewards: '结算奖励',
  collect_rewards_and_proceed: '领完继续',
  select_deck_card: '选这张牌',
  confirm_selection: '确认选择',
  close_cards_view: '关闭牌组浏览',
  open_chest: '打开宝箱',
  choose_treasure_relic: '拿这件遗物',
  choose_event_option: '选这个选项',
  choose_rest_option: '选这项',
  open_shop_inventory: '打开货架',
  close_shop_inventory: '离开商店',
  buy_card: '买这张牌',
  buy_relic: '买这件遗物',
  buy_potion: '买这瓶药水',
  remove_card_at_shop: '移除一张牌',
  choose_bundle: '选这一组',
  confirm_bundle: '确认这一组',
  choose_capstone_option: '选这个',
  divine_crystal_sphere: '探明水晶球',
  select_character: '选这个角色',
  embark: '出发',
  proceed: '继续',
  open_character_select: '进入选角色界面',
  open_timeline: '查看时间线',
  open_multiplayer_menu: '打开多人菜单',
  start_coop_session: '开一局联机',
  continue_run: '继续上次的局',
  close_main_menu_submenu: '关闭子菜单',
  choose_timeline_epoch: '选这个时间线节点',
  confirm_timeline_overlay: '确认',
};

/** 这些不给编号：会毁局，或只是别人的流程。 */
const EXCLUDED = new Set(['save_and_quit', 'abandon_run']);

/** 不需要编号的动作。 */
const NO_INDEX = new Set([
  'end_turn', 'resolve_rewards', 'collect_rewards_and_proceed', 'skip_reward_cards',
  'confirm_selection', 'close_cards_view', 'open_chest', 'remove_card_at_shop',
  'open_shop_inventory', 'close_shop_inventory', 'proceed', 'open_character_select',
  'open_timeline', 'embark', 'confirm_bundle', 'close_main_menu_submenu',
  'confirm_timeline_overlay', 'continue_run',
]);

/* 编号空间：每个动作对应状态里的哪一个数组。所有编号字段都叫 option_index。 */
const INDEX_ACTIONS: Record<string, (state: Fields) => Fields[]> = {
  choose_event_option: (state) => list(pick(state, 'event.options')),
  claim_reward: (state) => list(pick(state, 'reward.rewards')),
  choose_reward_card: (state) => list(pick(state, 'reward.cardOptions')),
  select_deck_card: (state) => list(pick(state, 'selection.cards')),
  choose_treasure_relic: (state) => list(pick(state, 'chest.relicOptions')),
  choose_rest_option: (state) => list(pick(state, 'rest.options')),
  choose_bundle: (state) => list(pick(state, 'bundles.bundles', 'bundles.options', 'bundles.choices')),
  choose_capstone_option: (state) => list(pick(state, 'bundles.capstones', 'bundles.buttons', 'bundles.options')),
  divine_crystal_sphere: (state) => list(pick(state, 'crystalSphere.options', 'crystal_sphere.options', 'crystalSphere.cells')),
  select_character: (state) => list(pick(state, 'characterSelect.characters', 'characterSelect.options')),
  choose_timeline_epoch: (state) => list(pick(state, 'timeline.epochs', 'timeline.options')),
  buy_card: (state) => list(pick(state, 'shop.cards')),
  buy_relic: (state) => list(pick(state, 'shop.relics')),
  buy_potion: (state) => list(pick(state, 'shop.potions')),
  choose_map_node: (state) => mapOptions(state),
};

const NODE_LABEL: Record<string, string> = {
  monster: '战斗', elite: '精英', restsiteroom: '休息', rest: '休息', shop: '商店',
  treasure: '宝箱', unknown: '未知', event: '事件', ancient: '先古', boss: '首领',
};

function nodeLabel(node: Fields): string {
  const type = cleanText(pick(node, 'nodeType', 'type', 'symbol')) || '';
  const zh = NODE_LABEL[type.toLowerCase()] ?? (type || '?');
  const row = pick<number>(node, 'row');
  const col = pick<number>(node, 'col');
  return row !== undefined && col !== undefined ? `${zh} (${row},${col})` : zh;
}

/**
 * 地图可走节点：优先用桥自带的 agent_view.map.options（i 就是 option_index），
 * 因为它的顺序就是 UI/动作的顺序；没有就退化成 map.nodes 里 is_available 的节点。
 */
export function mapOptions(state: Fields): Fields[] {
  const view = list(pick(state, 'agentView.map.options', 'agent_view.map.options'));
  if (view.length) {
    return view.map((option, position) => {
      const line = cleanText(pick(option, 'line', 'text'));
      const translated = line.replace(/^([A-Za-z]+)/, (matched) => NODE_LABEL[matched.toLowerCase()] ?? matched);
      return { index: pick<number>(option, 'i', 'index') ?? position, label: translated || `节点${position}` };
    });
  }
  const nodes = list(pick(state, 'map.nodes')).filter((node) => bool(pick(node, 'isAvailable', 'is_available')));
  return nodes.map((node, position) => ({ index: position, label: nodeLabel(node) }));
}

function cardName(card: Fields): string {
  return cleanText(pick(card, 'name', 'cardId', 'id')) || '未知';
}

function cardCost(card: Fields): string {
  if (bool(pick(card, 'costsX', 'costs_x'))) return 'X费';
  const cost = pick<number>(card, 'energyCost', 'cost');
  return cost === undefined ? '' : `${cost}费`;
}

function cardBody(card: Fields): string {
  return cleanText(pick(card, 'resolvedRulesText', 'resolved_rules_text', 'rulesText', 'rules_text', 'description'));
}

export function cardLabel(card: Fields): string {
  const parts = [cardName(card) + (pick(card, 'upgraded') ? '+' : ''), cardCost(card)].filter(Boolean);
  const body = cardBody(card);
  return `${parts.join(' ')}${body ? '：' + body : ''}`;
}

function optionLabel(action: string, option: Fields, position: number): string {
  switch (action) {
    case 'choose_event_option': {
      const title = cleanText(pick(option, 'title', 'name')) || `选项${position}`;
      const description = cleanText(pick(option, 'description'));
      const locked = bool(pick(option, 'isLocked', 'is_locked'));
      return `${title}${locked ? '（不可选）' : ''}${description ? '：' + description : ''}`;
    }
    case 'claim_reward': {
      const description = cleanText(pick(option, 'description')) || cleanText(pick(option, 'rewardType', 'reward_type')) || `奖励${position}`;
      const claimable = pick(option, 'claimable');
      return `${description}${claimable === false ? '（已领）' : ''}`;
    }
    case 'choose_reward_card':
    case 'select_deck_card':
      return cardLabel(option);
    case 'choose_treasure_relic': {
      const name = cleanText(pick(option, 'name', 'relicId', 'relic_id')) || `遗物${position}`;
      return name;
    }
    case 'choose_rest_option': {
      const title = cleanText(pick(option, 'title', 'name')) || cleanText(pick(option, 'optionId', 'option_id')) || `选项${position}`;
      const description = cleanText(pick(option, 'description'));
      const enabled = pick(option, 'isEnabled', 'is_enabled');
      return `${title}${enabled === false ? '（不可选）' : ''}${description ? '：' + description : ''}`;
    }
    case 'buy_card':
    case 'buy_relic':
    case 'buy_potion': {
      const name = action === 'buy_card' ? cardLabel(option) : cleanText(pick(option, 'name', 'id')) || '商品';
      const price = pick<number>(option, 'price');
      const affordable = pick(option, 'enoughGold', 'enough_gold');
      return `${name}${price !== undefined ? ` · ${price}金币` : ''}${affordable === false ? '（金币不足）' : ''}`;
    }
    default:
      return cleanText(pick(option, 'label', 'line', 'title', 'name', 'description')) || `选项${position}`;
  }
}

function playCardActions(hand: Fields[], command: (extra: Fields) => Fields): NormAction[] {
  const actions: NormAction[] = [];
  for (const card of hand) {
    const index = pick<number>(card, 'index');
    if (index === undefined) continue;
    if (pick(card, 'playable') === false) continue;
    let targets: Array<number | undefined> = [undefined];
    if (bool(pick(card, 'requiresTarget', 'requires_target'))) {
      const valid = pick<number[]>(card, 'validTargetIndices', 'valid_target_indices');
      targets = Array.isArray(valid) && valid.length ? valid : [];
    }
    for (const target of targets) {
      actions.push({
        n: 0,
        kind: 'play',
        label: `${cardName(card)}${pick(card, 'upgraded') ? '+' : ''}${target !== undefined ? `→敌${target}` : ''}`,
        ...(target !== undefined ? { target } : {}),
        command: command({ card_index: index, ...(target !== undefined ? { target_index: target } : {}) }),
      });
    }
  }
  return actions;
}

interface RawAction { name: string; requiresIndex: boolean; requiresTarget: boolean }

function rawActions(source: unknown): RawAction[] {
  const entries: RawAction[] = [];
  const push = (value: unknown): void => {
    if (typeof value === 'string') {
      const name = value.trim().toLowerCase();
      if (name) entries.push({ name, requiresIndex: false, requiresTarget: false });
      return;
    }
    const node = object(value);
    const name = String(pick(node, 'name', 'action') ?? '').trim().toLowerCase();
    if (!name) return;
    entries.push({
      name,
      requiresIndex: bool(pick(node, 'requiresIndex', 'requires_index')),
      requiresTarget: bool(pick(node, 'requiresTarget', 'requires_target')),
    });
  };
  if (Array.isArray(source)) source.forEach(push);
  else {
    const wrapped = pick(object(source), 'actions', 'available');
    if (Array.isArray(wrapped)) wrapped.forEach(push);
  }
  return entries;
}

export interface ActionContext {
  state: Fields;
  hand: Fields[];
  monsters: Fields[];
}

const POTION_ACTIONS = new Set(['use_potion', 'discard_potion']);

/** 药水动作的编号空间是 run.potions[].index，只列当前真的能用的槽位。 */
function potionOptions(action: string, state: Fields): Fields[] {
  const used = action === 'use_potion' ? 'canUse' : 'canDiscard';
  return list(pick(state, 'run.potions'))
    .filter((potion) => pick(potion, 'occupied') !== false && bool(pick(potion, used)))
    .map((potion) => ({ index: pick<number>(potion, 'index'), name: cleanText(pick(potion, 'name', 'potionId')) }));
}

export function normalizeActions(source: unknown, ctx: ActionContext): NormAction[] {
  const actions: NormAction[] = [];
  const seen = new Set<string>();
  const declared = rawActions(source);
  const names = new Set(declared.map((action) => action.name));

  for (const raw of declared) {
    if (EXCLUDED.has(raw.name) || seen.has(raw.name)) continue;
    // 奖励选牌界面上两个动作指向同一批牌，只留官方那个，避免编号翻倍。
    if (raw.name === 'select_deck_card' && names.has('choose_reward_card')) continue;
    seen.add(raw.name);
    const base: Omit<NormAction, 'n' | 'label' | 'command'> = { kind: classifyAction(raw.name) };
    const command = (extra: Fields): Fields => ({ action: raw.name, ...extra });

    if (raw.name === 'play_card') {
      actions.push(...playCardActions(ctx.hand, command));
      continue;
    }

    if (POTION_ACTIONS.has(raw.name)) {
      for (const potion of potionOptions(raw.name, ctx.state)) {
        const index = potion.index as number | undefined;
        if (index === undefined) continue;
        actions.push({
          ...base,
          n: 0,
          label: `${ACTION_LABEL[raw.name] ?? raw.name}${potion.name ? `「${potion.name}」` : `（槽${index}）`}`,
          command: command({ option_index: index }),
        });
      }
      continue;
    }

    if (raw.requiresTarget && !INDEX_ACTIONS[raw.name] && ctx.monsters.length) {
      ctx.monsters.forEach((monster, position) => {
        const index = pick<number>(monster, 'index') ?? position;
        actions.push({
          ...base,
          n: 0,
          label: `${ACTION_LABEL[raw.name] ?? raw.name}→敌${index}`,
          target: index,
          command: command({ target_index: index }),
        });
      });
      continue;
    }

    const options = INDEX_ACTIONS[raw.name]?.(ctx.state) ?? [];
    if (options.length) {
      options.forEach((option, position) => {
        actions.push({
          ...base,
          n: 0,
          label: optionLabel(raw.name, option, position),
          command: command({ option_index: pick<number>(option, 'index') ?? position }),
        });
      });
      continue;
    }

    if (raw.requiresIndex || INDEX_ACTIONS[raw.name]) continue; // 有编号空间但当前没有选项：不编造
    actions.push({ ...base, n: 0, label: ACTION_LABEL[raw.name] ?? raw.name.replace(/_/g, ' '), command: command({}) });
  }

  return actions.map((action, position) => ({ ...action, n: position + 1 }));
}

/* ───────────────────────────── 状态 ───────────────────────────── */

export type GameMode = 'single' | 'coop-host' | 'coop-client' | 'unknown';

export interface NormCombat {
  turn: number;
  energy: number | null;
  block: number;
  stars: number;
  hand: Fields[];
  monsters: Fields[];
  drawCount: number;
  discardCount: number;
  exhaustCount: number;
  endTurnWillKill: boolean;
  lethalRisks: string[];
}

export interface NormGame {
  act: number | null;
  floor: number | null;
  hp: number | null;
  maxHp: number | null;
  gold: number | null;
  character: string;
  ascension: number | null;
  relics: Fields[];
  potions: Fields[];
  deck: Fields[];
  boss: string;
  score: number | null;
  victory: boolean | null;
}

export interface NormSnapshot {
  sessionId: string;
  revision: number;
  ready: boolean;
  screen: Screen;
  screenRaw: string;
  mode: GameMode;
  game: NormGame;
  combat: NormCombat | null;
  /** 当前界面的原始块（event / reward / shop / rest / chest / map / selection / bundles …），只放非空的。 */
  blocks: Record<string, Fields>;
  actions: NormAction[];
  raw: Fields;
}

/** 桥的响应外面包了一层 { ok, request_id, data }。 */
export function unwrap(payload: unknown): Fields {
  const root = object(payload);
  const data = pick(root, 'data');
  return data && typeof data === 'object' && !Array.isArray(data) ? object(data) : root;
}

const BLOCK_KEYS = [
  'event', 'reward', 'shop', 'rest', 'chest', 'map', 'selection', 'bundles',
  'modal', 'gameOver', 'characterSelect', 'timeline', 'crystalSphere',
];

function blocksOf(state: Fields): Record<string, Fields> {
  const blocks: Record<string, Fields> = {};
  for (const key of BLOCK_KEYS) {
    const block = object(pick(state, key));
    if (Object.keys(block).length) blocks[key] = block;
  }
  return blocks;
}

/** 界面主块：渲染时以它为准，其余块只是附属信息。 */
function primaryBlock(screen: Screen, blocks: Record<string, Fields>): Fields {
  const byScreen: Partial<Record<Screen, string>> = {
    event: 'event', reward: 'reward', 'card-reward': 'reward', shop: 'shop',
    rest: 'rest', chest: 'chest', map: 'map', selection: 'selection',
    'character-select': 'characterSelect', 'deck-view': 'timeline',
  };
  const key = byScreen[screen];
  return (key && blocks[key]) || {};
}

function modeOf(state: Fields): GameMode {
  const mode = String(pick(state, 'session.mode', 'sessionMode') ?? '');
  const host = bool(pick(state, 'multiplayer.isHost', 'multiplayerLobby.isHost'));
  if (/single/i.test(mode)) return 'single';
  if (host || /host/i.test(mode)) return 'coop-host';
  if (/client|join/i.test(mode)) return 'coop-client';
  if (/coop|multiplayer/i.test(mode)) return 'coop-host';
  return 'unknown';
}

function normalizeCombat(state: Fields): NormCombat | null {
  const combat = pick<Fields>(state, 'combat');
  if (!combat || !Object.keys(combat).length) return null;
  const player = object(pick(combat, 'player'));
  const piles = object(pick(state, 'agentView.run.piles'));
  return {
    turn: num(pick(state, 'turn') ?? pick(combat, 'turn'), 0),
    energy: pick(player, 'energy') !== undefined ? num(pick(player, 'energy')) : null,
    block: num(pick(player, 'block'), 0),
    stars: num(pick(player, 'stars'), 0),
    hand: list(pick(combat, 'hand')),
    monsters: list(pick(combat, 'enemies', 'monsters')),
    drawCount: list(pick(piles, 'drawCards')).length || num(pick(combat, 'drawPileCount', 'draw_pile_count'), 0),
    discardCount: list(pick(piles, 'discardCards')).length || num(pick(combat, 'discardPileCount'), 0),
    exhaustCount: list(pick(piles, 'exhaustCards')).length || num(pick(combat, 'exhaustPileCount'), 0),
    endTurnWillKill: bool(pick(combat, 'endTurnWillKillPlayer', 'end_turn_will_kill_player')),
    lethalRisks: list(pick(combat, 'lethalRisks', 'lethal_risks')).map((risk) => cleanText(pick(risk, 'text', 'label', 'description'))).filter(Boolean),
  };
}

function semanticRevision(snapshot: Omit<NormSnapshot, 'revision'>, declared?: number): number {
  const map = object(snapshot.blocks.map);
  const parts = [
    declared ?? '',
    snapshot.screenRaw,
    snapshot.mode,
    snapshot.game.floor, snapshot.game.hp, snapshot.game.gold,
    snapshot.combat?.turn, snapshot.combat?.hand.map((c) => String(pick(c, 'index', 'cardId'))).join(','),
    snapshot.combat?.monsters.map((m) => `${pick(m, 'enemyId', 'name')}:${pick(m, 'currentHp', 'hp')}`).join(','),
    snapshot.actions.map((a) => `${a.command['action']}:${a.label}`).join('|'),
    Object.entries(snapshot.blocks).map(([key, block]) => `${key}:${JSON.stringify(block).length}`).join(','),
    // 多人地图的投票变化也要算新 Revision，否则队友投了哪一格不会推给她。
    JSON.stringify([
      pick(map, 'localVote', 'local_vote'),
      pick(map, 'playerVotes', 'player_votes'),
      pick(map, 'isTravelEnabled', 'is_travel_enabled'),
      pick(snapshot.raw, 'multiplayer', 'multiplayerLobby'),
    ]),
  ].join('§');
  return Number.parseInt(createHash('sha1').update(parts).digest('hex').slice(0, 8), 16);
}

export function stateRef(snapshot: Pick<NormSnapshot, 'sessionId' | 'revision'>): string {
  return createHash('sha256').update(`${snapshot.sessionId}:${snapshot.revision}`).digest('hex').slice(0, 12);
}

export function normalizeState(payload: unknown): NormSnapshot {
  const root = object(payload);
  const state = unwrap(payload);
  const run = object(pick(state, 'run', 'game'));
  const combat = normalizeCombat(state);
  const screenRaw = String(pick(state, 'screen', 'screenName') ?? 'unknown');
  const screen = classifyScreen(screenRaw);
  const blocks = blocksOf(state);
  const view = object(pick(state, 'agentView'));

  const draft: Omit<NormSnapshot, 'revision'> = {
    sessionId: String(pick(state, 'runId', 'run_id', 'sessionId') ?? 'sts2'),
    ready: true, // 桥只在轮到玩家决策时才列出动作；null 状态一律当可操作
    screen,
    screenRaw,
    mode: modeOf(state),
    game: {
      act: pick(run, 'actId', 'act_id', 'act') !== undefined ? num(pick(run, 'actId', 'act_id', 'act')) : null,
      floor: pick(run, 'floor') !== undefined ? num(pick(run, 'floor')) : null,
      hp: pick(run, 'currentHp', 'current_hp') !== undefined ? num(pick(run, 'currentHp', 'current_hp')) : null,
      maxHp: pick(run, 'maxHp', 'max_hp') !== undefined ? num(pick(run, 'maxHp', 'max_hp')) : null,
      gold: pick(run, 'gold') !== undefined ? num(pick(run, 'gold')) : null,
      character: cleanText(pick(run, 'characterName', 'character_name', 'characterId')),
      ascension: pick(run, 'ascension') !== undefined ? num(pick(run, 'ascension')) : null,
      relics: list(pick(run, 'relics')),
      potions: list(pick(run, 'potions')),
      deck: list(pick(run, 'deck')),
      boss: cleanText(pick(run, 'bossId', 'boss_id', 'boss')) || '',
      score: pick(run, 'score') !== undefined ? num(pick(run, 'score')) : null,
      victory: pick(state, 'victory') !== undefined ? bool(pick(state, 'victory')) : null,
    },
    combat,
    blocks,
    actions: [],
    raw: root,
  };

  // 桥在某些帧里只给 agent_view（带 i/line），没有原始 hand：补成同一形状再展开。
  const hand = combat?.hand?.length
    ? combat.hand
    : list(pick(view, 'combat.hand')).map((entry, position) => ({
      index: pick<number>(entry, 'i') ?? position,
      name: cleanText(pick(entry, 'line')).split(' [')[0] ?? '',
      playable: pick(entry, 'playable'),
      requiresTarget: list(pick(entry, 'targets')).length > 0 || Array.isArray(pick(entry, 'targets')),
      validTargetIndices: pick<number[]>(entry, 'targets') ?? [],
    }));

  draft.actions = normalizeActions(
    pick(state, 'availableActions', 'available_actions', 'actions'),
    { state, hand, monsters: combat?.monsters ?? [] },
  );

  const declared = pick<number>(state, 'stateVersion', 'state_version');
  return { ...draft, revision: semanticRevision(draft, typeof declared === 'number' ? declared : undefined) };
}

/* ───────────────────────────── 回档与回执 ───────────────────────────── */

/**
 * 只看"只增不减"的量：换局、层数倒退。
 * 以前还有一条"同层血从 <80% 补到满"——篝火休息就能凑出来，是确定的误报源，
 * 已移除。真正的读档交给 passport.ts（存档里的读档次数 + seed）。
 */
export function detectRollback(previous: NormSnapshot, next: NormSnapshot): string | null {
  if (previous.sessionId !== next.sessionId && previous.sessionId !== 'sts2' && next.sessionId !== 'sts2') return '已开始新的一局';
  const before = previous.game, after = next.game;
  if (before.floor !== null && after.floor !== null && after.floor < before.floor) {
    return `层级从 ${before.floor} 退回 ${after.floor}`;
  }
  return null;
}

export type Outcome = 'executed' | 'rejected' | 'pending' | 'unknown';

export interface NormReceipt {
  outcome: Outcome;
  reason: string;
  code: string;
  snapshot: NormSnapshot | null;
}

const RECEIPT_CODES: Record<string, string> = {
  invalid_request: '请求参数不对',
  invalid_action: '当前界面不支持这个动作',
  invalid_target: '目标或编号已失效',
  stale: '局面已经变了',
  not_ready: '游戏还在结算',
  busy: '上一个动作还没结束',
  screen_changed: '界面已经切换',
};

export function normalizeReceipt(payload: unknown, fallback: NormSnapshot | null): NormReceipt {
  const root = object(payload);
  const okRaw = pick(root, 'ok', 'success');
  const error = object(pick(root, 'error'));
  const code = String(pick(error, 'code') ?? '');
  const message = cleanText(pick(error, 'message')) || String(pick(error, 'message') ?? '');
  const data = object(pick(root, 'data'));
  // 真机的 /action 把局面套在 data.state 里（外面还有 status/stable/message）。
  const inside = object(pick(data, 'state'));
  const body = Object.keys(inside).length ? inside : data;

  const snapshot = Object.keys(body).length && pick(body, 'screen', 'combat', 'run') !== undefined
    ? normalizeState(body)
    : fallback;

  let outcome: Outcome = 'unknown';
  if (okRaw !== undefined) outcome = bool(okRaw) ? 'executed' : 'rejected';
  else if (code) outcome = 'rejected';
  // 桥回了 200，但动作只是"排上队"（status:pending / stable:false）：
  // 它不是执行成功。当成成功会让她以为选了牌，然后拿着同一帧反复点（真机上卡死在选牌屏）。
  const status = String(pick(data, 'status') ?? '').toLowerCase();
  if (/pending|queued|transition/.test(status) || pick(data, 'stable') === false) outcome = 'pending';
  else if (/fail|reject|error|cancel/.test(status)) outcome = 'rejected';

  return {
    outcome,
    reason: outcome === 'pending'
      ? (cleanText(pick(data, 'message')) || '游戏还在结算，动作没落地')
      : (code ? RECEIPT_CODES[code] ?? (message || code) : message),
    code,
    snapshot,
  };
}

/**
 * 这一屏要选几张牌。
 * 桥的 max_select / min_select 经常是 0（= 未设置），所以再从题面里抠一个数字：
 * 「选择[blue]2[/blue]张牌来移除」→ 2。
 */
export function selectionNeed(selection: Fields): number {
  const declared = Math.max(num(pick(selection, 'maxSelect', 'max_select'), 0), num(pick(selection, 'minSelect', 'min_select'), 0));
  const prompt = cleanText(pick(selection, 'prompt')).replace(/\[[^\]]*\]/g, '');
  const asked = Number(/(\d+)\s*张/.exec(prompt)?.[1] ?? 0);
  return Math.max(declared, Number.isFinite(asked) ? asked : 0);
}