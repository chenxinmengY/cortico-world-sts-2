import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { STS2_DEFAULTS, type Sts2ConfigSection } from './config.ts';
import { STS2_TOOL_DECLS } from './tools.ts';
import { Sts2World } from './world.ts';

export const STS2: WorldDefinition<Sts2ConfigSection> = {
  id: 'sts-2',
  label: '杀戮尖塔 2',
  defaults: () => structuredClone(STS2_DEFAULTS),
  create: (ctx) => new Sts2World({
    cfg: ctx.cfg,
    timezone: ctx.timezone,
    dataDir: ctx.dataDir,
    token: readSecret(ctx),
  }),
  describe: {
    tools: describeTools(STS2_TOOL_DECLS, {
      sts2_observe: {
        zh: '重读当前局面和操作编号,可另含牌组与全图;默认不暴露,回执已带局面。',
        en: 'Re-reads the current situation and numbered actions, optionally with the deck and map; hidden by default because receipts already carry the state.',
      },
      sts2_inspect: {
        zh: '看牌组、地图或完整局面;只在需要长期信息时用,局面本身随回执给出。',
        en: 'Looks at the deck, the map or the full state on demand; the situation itself arrives with every receipt.',
      },
      sts2_do: {
        zh: '按编号执行一个操作(出牌、选路线、领奖励等),等结算后回报结果与变化。',
        en: 'Performs one numbered action such as playing a card or choosing a path, and reports the result once it resolves.',
      },
      sts2_play: {
        zh: '一次提交多步(整回合),按顺序执行到打不动为止,只回一份回执。',
        en: 'Submits a whole turn of steps at once and stops at the first step that no longer works.',
      },
      sts2_pause: {
        zh: '停手,不再推送局面,等你发话。',
        en: 'Stops acting and stops pushing state until told to resume.',
      },
      sts2_resume: {
        zh: '恢复自动推进,先重读一次局面。',
        en: 'Resumes autonomous play after re-reading the state.',
      },
      sts2_steer: {
        zh: '把玩家的话记成一条临时指令(下一步/本层/本界面/直到撤销),之后每份局面都会带上。',
        en: "Records the player's remark as a scoped instruction that rides along with every later snapshot.",
      },
      sts2_intent: {
        zh: '记下这一局的构筑意图;换局自动作废,传空字符串清掉。',
        en: "Stores this run's build intent; it expires with the run and an empty string clears it.",
      },
      sts2_capture: {
        zh: '截取游戏画面;桥没有截图接口时明确失败。',
        en: 'Takes a screenshot of the game; fails clearly when the bridge has no capture endpoint.',
      },
      sts2_probe: {
        zh: '排障用:原样返回桥的状态片段和归一化摘要。',
        en: 'Diagnostics: dumps the bridge payload and the normalized summary.',
      },
    }),
    events: [
      {
        type: 'sts-2.state',
        description: { zh: '局面变了,附新的局面和操作编号。', en: 'The game state changed, with the new situation and numbered actions.' },
        trigger: 'flush',
        tags: ['snapshot'],
      },
      {
        type: 'sts-2.decision',
        description: { zh: '她这一轮动过手,游戏仍在等输入。', en: 'A reminder, after a turn that acted, that the game is still waiting for input.' },
        trigger: 'flush',
      },
      {
        type: 'sts-2.connection',
        description: { zh: '与游戏内桥的连接断开,已提交动作的结果可能未确认。', en: 'The connection to the in-game bridge dropped; submitted action outcomes may be unconfirmed.' },
        trigger: 'flush',
      },
      {
        type: 'sts-2.blocked',
        description: { zh: '当前界面桥没有给出任何动作,需要人工点一下。', en: 'The bridge exposed no action on this screen; a human needs to click.' },
        trigger: 'flush',
      },
      {
        type: 'sts-2.rollback',
        description: { zh: '检测到回档或重开(快速 SL、节点回退),之前的判断作废。', en: 'A rollback or restart was detected; earlier conclusions are void.' },
        trigger: 'flush',
      },
      {
        type: 'sts-2.drift',
        description: { zh: '局面和她记的对不上,但没到回档;按现在这个来。', en: 'The situation no longer matches what she remembered, short of a rollback; use the current state.' },
        trigger: 'flush',
      },
      {
        type: 'sts-2.auto',
        description: {
          zh: '这一屏没得选,她替玩家点了一个推进动作;或者求解器接管一整场战斗之后的一句摘要。',
          en: 'The screen had no real choice, so she advanced it herself; or the one-line summary after the solver played a whole fight.',
        },
        trigger: 'flush',
      },
      {
        type: 'sts-2.murmur',
        description: {
          zh: '她偶尔的一句闲话(夸一句、喊一声疼);默认直接进桌宠气泡,不叫醒模型。',
          en: 'A passing remark from her; by default it goes straight to the pet bubble without waking the model.',
        },
        trigger: 'flush',
      },
    ],
  },
};

/** 密钥可选：桥没开鉴权时就是空串。 */
function readSecret(ctx: { secret(name: string): string }): string {
  try { return ctx.secret('CORTICO_STS_2_TOKEN') || ''; } catch { return ''; }
}