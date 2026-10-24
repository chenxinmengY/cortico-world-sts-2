/**
 * 把归一化快照渲染成模型读得懂的文本：一屏一段，靠 section 差异做增量。
 * 只吃 NormSnapshot；字段名与含义按真机抓包校准（见 protocol.ts 顶部注释）。
 */
import {
  pick, words, cleanText, num, bool, object, list, stateRef, selectionNeed, SCREEN_LABEL, cardLabel,
  type Fields, type NormAction, type NormReceipt, type NormSnapshot,
} from './protocol.ts';

const CARD_TYPE: Record<string, string> = {
  attack: '攻击', skill: '技能', power: '能力', status: '状态', curse: '诅咒', quest: '任务',
};

const INTENT: Record<string, string> = {
  attack: '攻击', attackdefend: '攻击并防御', attackbuff: '攻击并强化', attackdebuff: '攻击并施加负面',
  attackdebuffstrong: '攻击并施加强力负面', defend: '防御', buff: '强化', debuff: '施加负面',
  strongdebuff: '施加强力负面', escape: '逃跑', sleep: '睡眠', stun: '眩晕', magic: '特殊行动',
  unknown: '未知',
};

function relicText(relic: Fields): string {
  const name = cleanText(pick(relic, 'name', 'relicId')) || '未知';
  const description = cleanText(pick(relic, 'description'));
  const stack = pick<number>(relic, 'stack');
  return `${name}${typeof stack === 'number' && stack > 0 ? `(${stack})` : ''}${description ? '：' + description : ''}`;
}

function costText(card: Fields): string {
  if (bool(pick(card, 'costsX', 'costs_x'))) return 'X费';
  const cost = pick<number>(card, 'energyCost', 'cost');
  return cost === undefined || cost < 0 ? '' : `${cost}费`;
}

function cardLine(card: Fields): string {
  const type = CARD_TYPE[cleanText(pick(card, 'cardType', 'type')).toLowerCase()] ?? '';
  const head = `${cleanText(pick(card, 'name', 'cardId')) || '未知'}${pick(card, 'upgraded') ? '+' : ''}`;
  const tags = [type, costText(card)].filter(Boolean).join('，');
  const body = cleanText(pick(card, 'resolvedRulesText', 'resolved_rules_text', 'rulesText', 'description'));
  return `${head}${tags ? '（' + tags + '）' : ''}${body ? '：' + body : ''}`;
}

function grouped(cards: Fields[], detailed: boolean): string {
  const counts = new Map<string, number>();
  for (const card of cards) {
    const text = detailed ? cardLine(card) : cleanText(pick(card, 'name', 'cardId')) || '未知';
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  return [...counts].map(([text, count]) => `${count > 1 ? count + '×' : ''}${text}`).join('；') || '无';
}

function handLines(snapshot: NormSnapshot): string {
  const hand = snapshot.combat?.hand ?? [];
  if (!hand.length) return '手牌：无';
  const plays = snapshot.actions.filter((action) => action.kind === 'play');
  const rows = hand.map((card, position) => {
    const index = pick<number>(card, 'index') ?? position;
    const matching = plays.filter((action) => Number(pick(action.command, 'card_index') ?? -1) === index);
    const numbers = matching.map((action) => `${action.n}${action.target !== undefined ? '→敌' + action.target : ''}`);
    if (numbers.length) return `${cardLine(card)}　出牌 ${numbers.join('、')}`;
    const reason = cleanText(pick(card, 'unplayableReason', 'unplayable_reason'));
    return `${cardLine(card)}（打不出：${reason === 'unplayable' || !reason ? '不可打出' : reason}）`;
  });
  return '手牌：\n' + rows.join('\n');
}

/** 本回合会挨多少：敌人意图里的 damage × hits，死了的不算。 */
function incomingOf(snapshot: NormSnapshot): { total: number; parts: string[] } {
  const parts: string[] = [];
  let total = 0;
  for (const [position, monster] of (snapshot.combat?.monsters ?? []).entries()) {
    const hp = num(pick(monster, 'currentHp', 'current_hp', 'hp'), 1);
    if (hp <= 0) continue;
    const index = pick<number>(monster, 'index') ?? position;
    for (const intent of list(pick(monster, 'intents'))) {
      const damage = pick<number>(intent, 'damage');
      if (typeof damage !== 'number' || damage <= 0) continue;
      const hits = Math.max(1, num(pick(intent, 'hits'), 1));
      total += damage * hits;
      parts.push(`敌${index} ${damage}×${hits}`);
    }
  }
  return { total, parts };
}

/** 这回合最多能挡多少：现有格挡 + 按费用从便宜到贵买得到的防御牌。 */
function blockCapacityOf(snapshot: NormSnapshot): { current: number; cards: number; max: number } {
  const combat = snapshot.combat;
  const current = combat?.block ?? 0;
  if (!combat) return { current, cards: 0, max: current };
  let energy = combat.energy ?? 99;
  const seen = new Set<number>();
  const options: Array<{ cost: number; block: number }> = [];
  for (const action of snapshot.actions) {
    if (action.kind !== 'play') continue;
    const index = Number(action.command['card_index']);
    if (seen.has(index)) continue;
    seen.add(index);
    const card = (combat.hand ?? []).find((entry) => Number(pick(entry, 'index')) === index);
    if (!card) continue;
    const text = cleanText(pick(card, 'resolvedRulesText', 'resolved_rules_text', 'rulesText', 'rules_text', 'description'));
    const match = /获得\s*(\d+)\s*点格挡/.exec(text);
    if (!match) continue;
    const cost = num(pick(card, 'energyCost', 'cost'), 1);
    if (cost < 0) continue;
    options.push({ cost, block: Number(match[1]) });
  }
  options.sort((a, b) => a.cost - b.cost);
  let max = current;
  let cards = 0;
  for (const option of options) {
    if (option.cost > energy) continue;
    energy -= option.cost;
    max += option.block;
    cards += 1;
  }
  return { current, cards, max };
}

/**
 * 一口气把这回合的账算完：入射、最多可挡、缺口、会不会死。
 * 这些数不交给模型去加，它只负责决策。
 */
function threatLine(snapshot: NormSnapshot): string {
  const { total, parts } = incomingOf(snapshot);
  if (!total) return '';
  const capacity = blockCapacityOf(snapshot);
  const hp = snapshot.game.hp ?? 0;
  const maxHp = snapshot.game.maxHp;
  const gap = total - capacity.max;
  const head = `入射 ${total}（${parts.join('、')}）｜格挡 ${capacity.current}，最多可挡 ${capacity.max}`
    + (capacity.cards ? `（${capacity.cards} 张防御）` : '');
  if (gap <= 0) return `${head}｜挡得住：挡到够用就停，剩下的能量打输出。`;
  if (gap >= hp) return `${head}｜缺口 ${gap} ≥ 生命 ${hp}：本回合会死。`;
  return `${head}｜缺口 ${gap}，预计掉 ${gap}，剩 ${Math.max(0, hp - gap)}/${maxHp ?? '?'}。`;
}

function monsterLines(snapshot: NormSnapshot): string {
  const monsters = snapshot.combat?.monsters ?? [];
  if (!monsters.length) return '敌人：无';
  return '敌人：\n' + monsters.map((monster, position) => {
    const hp = pick(monster, 'currentHp', 'current_hp', 'hp');
    const maxHp = pick(monster, 'maxHp', 'max_hp');
    const block = num(pick(monster, 'block'), 0);
    const powers = list(pick(monster, 'powers'))
      .map((power) => `${cleanText(pick(power, 'name', 'powerId'))} ${pick(power, 'amount') ?? '?'}`)
      .join('、');
    const intents = list(pick(monster, 'intents')).map((intent) => {
      const type = cleanText(pick(intent, 'intentType', 'intent_type'));
      const label = cleanText(pick(intent, 'label'));
      const damage = pick<number>(intent, 'damage');
      const hits = num(pick(intent, 'hits'), 1);
      const kind = INTENT[type.toLowerCase()] ?? type;
      if (typeof damage === 'number') return `${kind} ${damage}×${hits}`;
      return label || kind || '意图未知';
    });
    const parts = [
      `敌${pick<number>(monster, 'index') ?? position} ${cleanText(pick(monster, 'name', 'enemyId')) || '未知'}`,
      typeof hp === 'number' ? `${hp}/${maxHp ?? '?'}生命` : '',
      block ? `${block}格挡` : '',
      intents.length ? intents.join('，') : '意图未显示',
      powers ? `状态 ${powers}` : '',
      pick(monster, 'isAlive') === false || pick(monster, 'is_alive') === false ? '（已死）' : '',
    ].filter(Boolean);
    return parts.join(' · ');
  }).join('\n');
}

function potionLine(snapshot: NormSnapshot): string {
  const potions = (snapshot.game.potions ?? []).filter((potion) => pick(potion, 'occupied') !== false);
  if (!potions.length) return '';
  const uses = snapshot.actions.filter((action) => action.kind === 'use-potion' || action.kind === 'discard-potion');
  return '药水：' + potions.map((potion, position) => {
    const index = pick<number>(potion, 'index') ?? position;
    const name = cleanText(pick(potion, 'name', 'potionId')) || `槽${index}`;
    const numbers = uses.filter((action) => Number(pick(action.command, 'option_index') ?? -1) === index)
      .map((action) => `${action.n} ${action.kind === 'use-potion' ? '使用' : '丢弃'}`);
    return `${name}${numbers.length ? '　' + numbers.join('、') : ''}`;
  }).join('；');
}

function mapBlock(snapshot: NormSnapshot): string {
  const map = object(snapshot.blocks.map);
  if (!Object.keys(map).length) return '';
  const current = object(pick(map, 'currentNode', 'current_node'));
  const at = pick(current, 'row') !== undefined ? `当前位置 (${pick(current, 'row')},${pick(current, 'col')})` : '';
  const nodes = list(pick(map, 'nodes'));
  const available = nodes.filter((node) => bool(pick(node, 'isAvailable', 'is_available')));
  const visited = nodes.filter((node) => bool(pick(node, 'visited')));
  const summary = `地图 ${num(pick(map, 'rows'))}行 × ${num(pick(map, 'cols'))}列`
    + ` · 已走 ${visited.length} 个节点 · 可走 ${available.length} 个`;
  const boss = object(pick(map, 'bossNode', 'boss_node'));
  const end = pick(boss, 'row') !== undefined ? ` · 首领 (${pick(boss, 'row')},${pick(boss, 'col')})` : '';
  const lines = [at, summary + end];
  // 多人投票：谁投了哪一格、自己投没投、现在能不能走。
  const votes = list(pick(map, 'playerVotes', 'player_votes'));
  const travel = pick(map, 'isTravelEnabled', 'is_travel_enabled');
  const coop = snapshot.mode === 'coop-host' || snapshot.mode === 'coop-client' || votes.length > 1;
  if (coop && votes.length) {
    const others = votes
      .filter((vote) => !bool(pick(vote, 'isLocal', 'is_local')))
      .map((vote) => {
        const slot = num(pick(vote, 'slotIndex', 'slot_index'), 0);
        const who = `P${slot + 1}`;
        const coord = object(pick(vote, 'coord'));
        const row = pick(coord, 'row');
        return row !== undefined ? `${who} → (${row},${pick(coord, 'col')})` : `${who} 未投`;
      });
    const localVote = object(pick(map, 'localVote', 'local_vote'));
    const mine = pick(localVote, 'row') !== undefined
      ? `你已投 (${pick(localVote, 'row')},${pick(localVote, 'col')})`
      : '你未投';
    lines.push(`投票：${[...others, mine].join('；')}${travel === false ? ' · 等队友' : ''}`);
  }
  const availableNodes = list(pick(map, 'availableNodes', 'available_nodes'));
  const nodeVotes = (availableNodes.length ? availableNodes : available)
    .map((node) => {
      const count = num(pick(node, 'voteCount', 'vote_count'), 0);
      if (count <= 0) return '';
      const row = pick(node, 'row');
      const col = pick(node, 'col');
      return row !== undefined ? `(${row},${col}) ${count}票` : `${count}票`;
    })
    .filter(Boolean);
  if (nodeVotes.length) lines.push(`节点票数：${nodeVotes.join('；')}`);
  return lines.filter(Boolean).join('\n');
}

/** 只看牌组：给 sts2_inspect 用，不把整屏局面重发一遍。 */
export function renderDeck(snapshot: NormSnapshot): string {
  const deck = snapshot.game.deck;
  return deck.length ? `牌组 ${deck.length} 张：${grouped(deck, true)}` : '牌组：空。';
}

/** 只看地图：给 sts2_inspect 用。 */
export function renderMap(snapshot: NormSnapshot): string {
  return mapBlock(snapshot) || '现在看不到地图。';
}

function selectionBlock(snapshot: NormSnapshot): string {
  const selection = object(snapshot.blocks.selection);
  if (!Object.keys(selection).length) return '';
  const kind = cleanText(pick(selection, 'kind'));
  const prompt = cleanText(pick(selection, 'prompt'));
  const min = pick<number>(selection, 'minSelect', 'min_select');
  const max = pick<number>(selection, 'maxSelect', 'max_select');
  const chosen = num(pick(selection, 'selectedCount', 'selected_count'), 0);
  const confirm = bool(pick(selection, 'requiresConfirmation', 'requires_confirmation'));
  const need = selectionNeed(selection);
  const limits = need
    ? `要选满 ${need} 张`
    : `${min !== undefined && min > 0 ? `至少 ${min}` : '可少选'}${max ? `，最多 ${max}` : ''}`;
  const lines = [
    `${kind || '选择'}${prompt ? '：' + prompt : ''}`,
    `已选 ${chosen}/${need || max || '?'}（${limits}${confirm ? '，需要确认' : ''}）`,
  ];
  // 多选屏必须一次提交：单独点会互相抵消（真机上就是这么卡死的）。
  if (need > 1) {
    const picks = Array.from({ length: need }, (_, index) => `{select:${index + 1}}`).join(',');
    lines.push(`要选 ${need} 张：一次提交 sts2_play({state, steps:[${picks}]})，别一张一张点。`);
  }
  return lines.join('\n');
}

function rewardBlock(snapshot: NormSnapshot): string {
  const reward = object(snapshot.blocks.reward);
  if (!Object.keys(reward).length) return '';
  const rewards = list(pick(reward, 'rewards'));
  const cards = list(pick(reward, 'cardOptions'));
  const lines: string[] = [];
  if (rewards.length) lines.push('战利品：' + rewards.map((item, position) => cleanText(pick(item, 'description')) || `奖励${position}`).join('；'));
  if (cards.length) lines.push('可选牌：' + cards.map((card) => cleanText(pick(card, 'name', 'cardId'))).join('、'));
  if (bool(pick(reward, 'pendingCardChoice'))) lines.push('还有选牌没处理。');
  return lines.join('\n');
}

function shopBlock(snapshot: NormSnapshot): string {
  const shop = object(snapshot.blocks.shop);
  if (!Object.keys(shop).length) return '';
  if (pick(shop, 'isOpen', 'is_open') === false) return '货架还没打开。';
  const lines: string[] = [];
  const cards = list(pick(shop, 'cards'));
  const relics = list(pick(shop, 'relics'));
  const potions = list(pick(shop, 'potions'));
  if (cards.length) lines.push('货架卡牌：' + cards.map((item) => `${cleanText(pick(item, 'name'))} ${pick(item, 'price') ?? '?'}金`).join('；'));
  if (relics.length) lines.push('货架遗物：' + relics.map((item) => `${cleanText(pick(item, 'name'))} ${pick(item, 'price') ?? '?'}金`).join('；'));
  if (potions.length) lines.push('货架药水：' + potions.map((item) => `${cleanText(pick(item, 'name'))} ${pick(item, 'price') ?? '?'}金`).join('；'));
  return lines.join('\n');
}

function restBlock(snapshot: NormSnapshot): string {
  const rest = object(snapshot.blocks.rest);
  if (!Object.keys(rest).length) return '';
  const options = list(pick(rest, 'options'));
  if (!options.length) return '';
  return '可做：' + options.map((option) => {
    const title = cleanText(pick(option, 'title', 'name')) || cleanText(pick(option, 'optionId')) || '?';
    const enabled = pick(option, 'isEnabled', 'is_enabled');
    return `${title}${enabled === false ? '（不可选）' : ''}`;
  }).join('；');
}

function chestBlock(snapshot: NormSnapshot): string {
  const chest = object(snapshot.blocks.chest);
  if (!Object.keys(chest).length) return '';
  const opened = bool(pick(chest, 'isOpened', 'is_opened'));
  const relics = list(pick(chest, 'relicOptions'));
  if (!opened) return '宝箱还没开。';
  return relics.length ? '宝箱已开，可选遗物：' + relics.map((relic) => cleanText(pick(relic, 'name'))).join('、') : '宝箱已开。';
}

function eventBlock(snapshot: NormSnapshot): string {
  const event = object(snapshot.blocks.event);
  if (!Object.keys(event).length) return '';
  const title = cleanText(pick(event, 'title', 'eventId'));
  const body = cleanText(pick(event, 'description', 'body'));
  return [title, body].filter(Boolean).join('\n');
}

function gameOverBlock(snapshot: NormSnapshot): string {
  const over = object(snapshot.blocks.gameOver);
  if (!Object.keys(over).length) return '';
  const victory = bool(pick(over, 'isVictory', 'victory'));
  const score = pick<number>(over, 'score');
  return `${victory ? '胜利' : '游戏结束'}${score !== undefined ? ` · 得分 ${score}` : ''}`;
}

function screenBlock(snapshot: NormSnapshot): string {
  switch (snapshot.screen) {
    case 'event': return eventBlock(snapshot);
    case 'reward':
    case 'card-reward': return rewardBlock(snapshot);
    case 'shop': return shopBlock(snapshot);
    case 'rest': return restBlock(snapshot);
    case 'chest': return chestBlock(snapshot);
    case 'selection': return selectionBlock(snapshot);
    case 'map': return mapBlock(snapshot);
    case 'game-over':
    case 'victory': return gameOverBlock(snapshot);
    default: return '';
  }
}

function sections(snapshot: NormSnapshot, full: boolean): Map<string, string> {
  const out = new Map<string, string>();
  const put = (key: string, text: string) => { if (text) out.set(key, text); };
  const game = snapshot.game, combat = snapshot.combat;

  put('run', [
    game.act !== null ? `第${game.act}幕` : '',
    game.floor !== null ? `第${game.floor}层` : '',
    game.hp !== null ? `生命 ${game.hp}/${game.maxHp ?? '?'}` : '',
    game.gold !== null ? `金币 ${game.gold}` : '',
  ].filter(Boolean).join(' · '));
  if (game.character) put('character', `角色 ${game.character}${game.ascension ? ` · 进阶 ${game.ascension}` : ''}${game.boss ? ` · 首领 ${game.boss}` : ''}`);
  put('relics', game.relics.length ? `遗物：${game.relics.map(relicText).join('；')}` : '');
  put('potions', potionLine(snapshot));

  if (combat) {
    const stats = [`回合 ${combat.turn}`];
    if (combat.energy !== null) stats.push(`能量 ${combat.energy}`);
    if (combat.block) stats.push(`格挡 ${combat.block}`);
    if (combat.stars) stats.push(`星 ${combat.stars}`);
    put('combat', stats.join(' · '));
    put('monsters', monsterLines(snapshot));
    put('threat', threatLine(snapshot));
    put('hand', handLines(snapshot));
    put('piles', `牌堆：抽 ${combat.drawCount}／弃 ${combat.discardCount}／消耗 ${combat.exhaustCount}`);
    if (combat.endTurnWillKill) put('lethal', '⚠ 现在结束回合会被打死。');
    if (combat.lethalRisks.length) put('risks', '⚠ ' + combat.lethalRisks.join('；'));
  }

  put('screen', screenBlock(snapshot));
  if (full) {
    put('map', mapBlock(snapshot));
    put('deck', game.deck.length ? `牌组 ${game.deck.length}张：${grouped(game.deck, true)}` : '');
  }

  const shown = new Set<number>();
  for (const action of snapshot.actions) if (action.kind === 'play') shown.add(action.n);
  const rest = snapshot.actions.filter((action) => !shown.has(action.n));
  put('actions', rest.length ? '操作：\n' + rest.map((action) => `${action.n} ${action.label}`).join('\n') : '暂无其他操作。');
  return out;
}

export function screenName(snapshot: NormSnapshot): string {
  return SCREEN_LABEL[snapshot.screen] ?? snapshot.screenRaw;
}

export interface RenderOptions {
  /** 就算和上一份完全一样，也把「操作」整段列出来：回执必须带编号，不然她还得再观察一次。 */
  forceActions?: boolean;
}

export function renderSnapshot(snapshot: NormSnapshot, full = false, previous?: NormSnapshot, options: RenderOptions = {}): string {
  const delta = !full && previous !== undefined
    && previous.sessionId === snapshot.sessionId && previous.screen === snapshot.screen
    && previous.game.floor === snapshot.game.floor;
  const current = sections(snapshot, full);
  const before = delta ? sections(previous!, false) : new Map<string, string>();
  const newTurn = delta && previous!.combat?.turn !== snapshot.combat?.turn;
  const lines = [...current]
    .filter(([key, text]) => !delta || before.get(key) !== text || (newTurn && key === 'monsters'))
    .map(([, text]) => text);
  const actions = current.get('actions');
  if (options.forceActions && actions && !lines.includes(actions)) lines.push(actions);
  for (const [key] of before) {
    if (current.has(key)) continue;
    lines.push(({
      relics: '遗物：无', potions: '药水：无', lethal: '结束回合不再致命。',
    } as Record<string, string>)[key] ?? '界面内容已更新。');
  }
  const head = `[StS2 ${stateRef(snapshot)} · ${screenName(snapshot)} · ${snapshot.ready ? '可操作' : '结算中'}${delta ? ' · 变化' : ''}]`;
  return `${head}\n${lines.join('\n') || '状态无变化，操作编号沿用上一份。'}`;
}

export function renderReceipt(receipt: NormReceipt, before: NormSnapshot, action?: NormAction): string {
  if (!receipt.snapshot) {
    return `结果未确认：${receipt.reason || '桥没有返回新状态'}。等下一份局面再决定；确实要重读用 sts2_inspect({what:"full"})。`;
  }
  if (receipt.outcome === 'executed') {
    const what = action ? action.label : '游戏内动作';
    const drawn = drawnCards(before, receipt.snapshot);
    return `已执行：${what}。${drawn ? `\n${drawn}` : ''}\n${renderSnapshot(receipt.snapshot, false, before, { forceActions: true })}`;
  }
  if (receipt.outcome === 'pending') {
    return `已排上队，但游戏还没结算完（${receipt.reason || 'state 还在变'}）。这不是"已经做了"：先看下面的局面，别拿同一步反复提交。\n${renderSnapshot(receipt.snapshot)}`;
  }
  if (receipt.outcome === 'rejected') {
    return `未执行：${receipt.reason || '桥拒绝了这次动作'}。\n${renderSnapshot(receipt.snapshot)}`;
  }
  return `结果未确认：${receipt.reason || '桥没有明确回应'}。已附当前状态，先观察再决定，不要重复提交。\n${renderSnapshot(receipt.snapshot)}`;
}

function drawnCards(before: NormSnapshot, after: NormSnapshot): string {
  const key = (card: Fields) => String(pick(card, 'index') ?? '') + ':' + String(pick(card, 'cardId', 'name'));
  const old = new Set((before.combat?.hand ?? []).map(key));
  const entered = (after.combat?.hand ?? []).filter((card) => !old.has(key(card)));
  return entered.length ? `新入手：${grouped(entered, false)}` : '';
}