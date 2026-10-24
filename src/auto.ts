/**
 * 兜底自动：只在"没有选择"时替她点一下。
 * 原则：动作清单里只要还留着任何一个有损/有取舍的动作，就绝不动手——宁可停下喊人。
 * 白名单按真机样本校准（samples/reward-watch-*、card_selection-watch-*、combat-t1-093122）。
 */
import type { Fields, NormAction, NormSnapshot } from './protocol.ts';

/** 推进型动作：执行了只会让流程往前走，不会替玩家做取舍。 */
export const SAFE_ACTIONS: ReadonlySet<string> = new Set([
  'resolve_rewards',
  'collect_rewards_and_proceed',
  'open_chest',
  'close_shop_inventory',
  'close_cards_view',
  'confirm_selection',
]);

/** 多个推进型动作同时在场时的优先级：能一次走完的排前面。 */
const PREFERENCE = [
  'collect_rewards_and_proceed',
  'resolve_rewards',
  'open_chest',
  'close_shop_inventory',
  'close_cards_view',
  'confirm_selection',
];

export interface AutoDecision {
  action: NormAction;
  why: string;
}

function nameOf(action: NormAction): string {
  return String(action.command['action'] ?? '');
}

function fields(value: unknown): Fields {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Fields : {};
}

function rows(value: unknown): Fields[] {
  return Array.isArray(value) ? value.filter((item): item is Fields => item !== null && typeof item === 'object') : [];
}


/**
 * 给出一个可以自动执行的动作；没有就返回 null（= 停住等模型/人）。
 * 注意：这里不判断"能不能执行"，只判断"该不该替她决定"。
 *
 * mode:
 *  - `immediate`：局面一到就自动（只允许"纯推进"，不碰需要玩家取舍的确认）。
 *  - `recovery`：她连续失败/长时间没动静时的兜底，允许确认类动作。
 */
export function pickAutoAction(snapshot: NormSnapshot, mode: 'immediate' | 'recovery' = 'immediate'): AutoDecision | null {
  const actions = snapshot.actions;
  if (!actions.length) return null;

  // 只要还有一个不在白名单里的动作，说明这一屏需要取舍。
  const safe = actions.filter((action) => SAFE_ACTIONS.has(nameOf(action)));
  if (safe.length !== actions.length) return null;

  switch (snapshot.screen) {
    case 'combat':
      // 战斗里永远不替她结束回合：敌方回合的帧也会长成"只剩结束回合 + 手牌全不可打"，
      // 一旦替她点，就会把她的整个回合跳掉（真机上发生过两次）。
      return null;
    case 'reward':
    case 'card-reward': {
      const reward = fields(snapshot.blocks['reward']);
      const rewards = rows(reward['rewards']).filter((item) => item['claimable'] !== false);
      const options = rows(reward['card_options']);
      if (rewards.length || options.length) return null;
      if (reward['pending_card_choice'] === true) return null;
      break;
    }
    case 'selection': {
      // 只有桥明确说"可以确认"时才确认；选不满绝不替她提交。
      // 而且只在兜底模式下确认——玩家可能还想多选几张。
      if (mode !== 'recovery') return null;
      if (fields(snapshot.blocks['selection'])['can_confirm'] !== true) return null;
      break;
    }
    case 'chest':
    case 'shop':
    case 'deck-view':
      break;
    default:
      return null; // rest / event / map / character-select / main-menu / unknown 永不自动
  }

  for (const name of PREFERENCE) {
    const hit = safe.find((action) => nameOf(action) === name);
    if (hit) return { action: hit, why: hit.label };
  }
  return null;
}

/** 战斗里动作清单短时空掉（敌方回合/动画）时，别把这当成"她不会"。 */
export function looksLikeSettling(snapshot: NormSnapshot): boolean {
  if (snapshot.screen !== 'combat') return false;
  if (snapshot.actions.length) return false;
  return snapshot.combat !== null;
}