import type { ToolDef } from 'cortico/core/types.ts';

const binding = {
  state: { type: 'string', description: '最近快照标题里的状态码，原样复制。' },
};

export const STS2_TOOL_DECLS: Omit<ToolDef, 'handler'>[] = [
  {
    name: 'sts2_observe',
    description: '重读当前局面和操作编号。每份回执和事件已经带了局面；正常对局不需要它，只在断线恢复后确认用。',
    tags: ['read', 'snapshot'],
    parameters: {
      type: 'object',
      properties: {
        detail: {
          type: 'string', enum: ['decision', 'full'],
          description: '默认只给当前决策所需；full 另含牌组、全图和牌堆内容。',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'sts2_inspect',
    description: '看牌组、地图或完整局面。局面和编号已经随回执给出；只在需要牌组构成、全图这类长期信息时调用。',
    tags: ['read', 'snapshot'],
    parameters: {
      type: 'object',
      properties: {
        what: {
          type: 'string', enum: ['deck', 'map', 'full'],
          description: 'deck=牌组构成，map=全图，full=完整局面（也含牌组与地图）。',
        },
      },
      required: ['what'],
      additionalProperties: false,
    },
  },
  {
    name: 'sts2_do',
    description: '用最新状态码和操作编号执行一个动作，并等它结算。回执报告结果与变化；一轮只调用一次。'
      + '战斗里要打多张牌用 sts2_play，不要一张一张 do。',
    tags: ['act'],
    barrierAfter: true,
    parameters: {
      type: 'object',
      properties: {
        ...binding,
        action: { type: 'integer', minimum: 1, description: '快照里标出的操作编号。' },
      },
      required: ['state', 'action'],
      additionalProperties: false,
    },
  },
  {
    name: 'sts2_pause',
    description: '停手：不再推送局面，等你发话。她已经提交出去的那一步不会被撤回。',
    tags: ['flow'],
    parameters: {
      type: 'object',
      properties: { reason: { type: 'string', description: '为什么停，一句话就够。' } },
      additionalProperties: false,
    },
  },
  {
    name: 'sts2_resume',
    description: '恢复：重新读取当前局面并继续自己打。',
    tags: ['flow'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'sts2_play',
    description: '一次提交多步（推荐战斗里用）：按顺序执行到打不动为止，只回一份回执。牌用名字指定，编号由底下自己解析。'
      + '只有「选牌屏」（画面写着“选择 N 张牌”）才用 {select:编号}，而且要一次列全；'
      + '奖励、选角色、事件这些屏一律用 sts2_do 的编号一个个来。',
    tags: ['act'],
    barrierAfter: true,
    parameters: {
      type: 'object',
      properties: {
        ...binding,
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: 8,
          description: '按顺序执行；每步要么出牌（card + target），要么结束回合（endTurn），要么选牌（select）。',
          items: {
            type: 'object',
            properties: {
              card: { type: 'string', description: '要打出的牌名，照手牌写，例如「打击」。' },
              target: { type: 'integer', minimum: 0, description: '目标敌人编号；不需要目标的牌省略。' },
              endTurn: { type: 'boolean', description: 'true 表示结束回合；和 card 二选一。' },
              select: { type: 'integer', minimum: 1, description: '只在选牌屏用：第几个选项。要多选就一次列全，例如 [{select:1},{select:2}]。' },
            },
            additionalProperties: false,
          },
        },
      },
      required: ['state', 'steps'],
      additionalProperties: false,
    },
  },
  {
    name: 'sts2_steer',
    description: '把玩家的话记成一条临时指令（例如“这层别打精英”），之后每份局面都会带上它。传空字符串清掉。',
    tags: ['flow'],
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '玩家原话的要点，一句话；空字符串表示撤销。' },
        until: {
          type: 'string', enum: ['next', 'floor', 'screen', 'manual'],
          description: '有效范围：下一步 / 本层 / 本界面 / 直到撤销。默认 floor。',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'sts2_intent',
    description: '记下这一局的构筑意图（例如“走毒、见催化剂必拿、药水留 boss”）。换局自动作废；传空字符串清掉。',
    tags: ['flow'],
    parameters: {
      type: 'object',
      properties: {
        note: { type: 'string', description: '一句到三句，只写意图，不要写牌面数值。' },
      },
      required: ['note'],
      additionalProperties: false,
    },
  },
  {
    name: 'sts2_capture',
    description: '截取游戏画面，返回 PNG。桥没有截图接口时会明确失败，不编造画面。',
    tags: ['read'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'sts2_probe',
    description: '排障与校准：原样返回桥的 /state 片段和她读到的归一化摘要。只在状态读不懂、动作对不上时使用。',
    tags: ['read'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
];

export function validateDo(args: Record<string, unknown>): { state: string; action: number } {
  if (typeof args.state !== 'string' || !args.state) throw new Error('请复制最近快照里的状态码 state');
  if (!Number.isSafeInteger(args.action) || (args.action as number) < 1) throw new Error('action 必须是快照里的操作编号');
  return { state: args.state, action: args.action as number };
}