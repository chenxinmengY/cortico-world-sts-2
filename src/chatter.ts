/**
 * 偶尔一句的话：战斗结束夸一句，挨打哼一声。
 * 两套语料：watch = 她看玩家打（第二人称「你」），self = 她自己打（第一人称「我」）。
 * 台词池在 dataDir/chatter.json（可改、可热加载）；按伤情分档，避免每把都同一句。
 * 频率由概率 + 冷却共同压住。
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { NormSnapshot } from './protocol.ts';

export type ChatterKind = 'combat-win' | 'hp-loss';
export type ChatterTier = 'light' | 'heavy' | 'lethal' | 'normal' | 'lowHp';
/** watch：她在看你打；self：她自己打。 */
export type ChatterMode = 'watch' | 'self';

/** 一套台词池：伤得越重，说得越重。数组里可以写 ${loss}/${hp}/${maxHp}/${floor} 占位符。 */
export interface ChatterPools {
  hurt: { light: string[]; heavy: string[]; lethal: string[] };
  win: { normal: string[]; lowHp: string[] };
}

export interface ChatterBook {
  watch: ChatterPools;
  self: ChatterPools;
}

export const DEFAULT_CHATTER_BOOK: ChatterBook = {
  // 她看玩家打：第二人称。
  watch: {
    hurt: {
      light: [
        '【worried】嘶，${loss} 点，看着有点疼。',
        '【worried】这一下不轻。',
        '【pout】疼吗？我看着都疼。',
      ],
      heavy: [
        '【worried】这一下差点把你打飞了。',
        '【worried】${loss} 点，血条直接少一截。',
        '【sad】你这血我数着往下掉。',
      ],
      lethal: [
        '【scared】再挨一下就见底了，先防吧。',
        '【scared】血剩 ${hp} 点，别贪了。',
      ],
    },
    win: {
      normal: [
        '【happy】这波打得漂亮。',
        '【happy】又过一间。',
        '【smug】这不比我自己打稳多了。',
      ],
      lowHp: [
        '【happy】赢了，可你这血我看得心慌。',
        '【worried】过了，还剩 ${hp} 点，悠着点。',
      ],
    },
  },
  // 她自己打：第一人称。
  self: {
    hurt: {
      light: [
        '【worried】嘶，${loss} 点，疼。',
        '【pout】我去，${loss} 点，疼死我了。',
        '【sad】又挨一下，我这血。',
      ],
      heavy: [
        '【worried】我去，这一下差点把我打飞了。',
        '【scared】${loss} 点？我血条要没了。',
        '【sad】疼疼疼，别打了。',
      ],
      lethal: [
        '【scared】别别别，再一下我就没了。',
        '【scared】血剩 ${hp}，我得先防。',
      ],
    },
    win: {
      normal: [
        '【happy】这波厉害不？',
        '【smug】看到没，这波操作。',
        '【happy】过了过了，夸我。',
      ],
      lowHp: [
        '【happy】赢了……吓死我了，就剩 ${hp} 点。',
        '【worried】别夸了，我手都在抖。',
      ],
    },
  },
};

export interface Chatter {
  kind: ChatterKind;
  tier: ChatterTier;
  mode: ChatterMode;
  text: string;
}

export interface ChatterContext {
  before: NormSnapshot;
  after: NormSnapshot;
  rng: () => number;
  cooldownOk: boolean;
  winChance: number;
  hurtChance: number;
  /** 看她打还是她自己打；默认 watch。 */
  mode?: ChatterMode;
  /** 台词池；不给就用默认的。 */
  book?: ChatterBook;
  /** 上一条说过的话：池子里还有别的就换一句，别连着复读。 */
  lastText?: string | null;
}

function hpPct(snapshot: NormSnapshot): number {
  const hp = snapshot.game.hp;
  const max = snapshot.game.maxHp;
  if (hp === null || max === null || max <= 0) return 1;
  return hp / max;
}

function fill(line: string, vars: Record<string, number | string>): string {
  return line.replace(/\$\{(\w+)\}/g, (match, key: string) => (key in vars ? String(vars[key]) : match));
}

function pickLine(
  pool: readonly string[] | undefined,
  vars: Record<string, number | string>,
  rng: () => number,
  lastText?: string | null,
): string | null {
  const lines = (pool ?? []).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return null;
  let index = Math.min(lines.length - 1, Math.max(0, Math.floor(rng() * lines.length)));
  if (lines.length > 1 && fill(lines[index], vars) === lastText) index = (index + 1) % lines.length;
  return fill(lines[index], vars);
}

export function pickChatter(ctx: ChatterContext): Chatter | null {
  if (!ctx.cooldownOk) return null;
  const { before, after } = ctx;
  const mode: ChatterMode = ctx.mode ?? 'watch';
  const book = ctx.book ?? DEFAULT_CHATTER_BOOK;
  const pools = book[mode] ?? book.watch;
  const vars = {
    hp: after.game.hp ?? 0,
    maxHp: after.game.maxHp ?? 0,
    floor: after.game.floor ?? 0,
  };

  // 战斗结束（赢了）：离开战斗界面、人还活着、不是死亡结算。
  const won = before.screen === 'combat'
    && after.screen !== 'combat'
    && after.screen !== 'game-over'
    && (after.game.hp === null || after.game.hp > 0);
  if (won && ctx.rng() < ctx.winChance) {
    const tier: ChatterTier = hpPct(after) < 0.3 ? 'lowHp' : 'normal';
    const text = pickLine(pools.win[tier], vars, ctx.rng, ctx.lastText)
      ?? pickLine(pools.win.normal, vars, ctx.rng, ctx.lastText);
    if (text) return { kind: 'combat-win', tier, mode, text };
  }

  // 挨打：同一场战斗里掉血，且掉得够明显才值得说一句。
  const inCombat = before.screen === 'combat' && after.screen === 'combat';
  const hpBefore = before.game.hp;
  const hpAfter = after.game.hp;
  if (inCombat && hpBefore !== null && hpAfter !== null && hpAfter > 0) {
    const loss = hpBefore - hpAfter;
    if (loss >= 5 && ctx.rng() < ctx.hurtChance) {
      const pct = hpPct(after);
      const tier: ChatterTier = pct <= 0.15 ? 'lethal' : loss >= 12 || pct < 0.35 ? 'heavy' : 'light';
      const text = pickLine(pools.hurt[tier], { ...vars, loss }, ctx.rng, ctx.lastText)
        ?? pickLine(pools.hurt.light, { ...vars, loss }, ctx.rng, ctx.lastText);
      if (text) return { kind: 'hp-loss', tier, mode, text };
    }
  }

  return null;
}

function pools(raw: unknown, fallback: ChatterPools): ChatterPools {
  const object = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const list = (node: unknown, key: string, fallbackLines: string[]): string[] => {
    const section = node !== null && typeof node === 'object' ? node as Record<string, unknown> : {};
    const values = Array.isArray(section[key]) ? section[key] : null;
    if (!values) return fallbackLines;
    const lines = values
      .filter((line): line is string => typeof line === 'string' && line.trim() !== '')
      .map((line) => line.trim());
    return lines.length ? lines : fallbackLines;
  };
  return {
    hurt: {
      light: list(object['hurt'], 'light', fallback.hurt.light),
      heavy: list(object['hurt'], 'heavy', fallback.hurt.heavy),
      lethal: list(object['hurt'], 'lethal', fallback.hurt.lethal),
    },
    win: {
      normal: list(object['win'], 'normal', fallback.win.normal),
      lowHp: list(object['win'], 'lowHp', fallback.win.lowHp),
    },
  };
}

/**
 * 把外部 JSON 合并成完整的台词池：
 * - 新格式 `{ watch: {...}, self: {...} }`：两套各取各的；
 * - 旧格式 `{ hurt: {...}, win: {...} }`：当作 watch，self 用默认（不破坏已有文件）；
 * - 缺的档位一律用默认补。
 */
export function parseChatterBook(raw: string): ChatterBook | null {
  let value: unknown;
  try { value = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch { return null; }
  const root = value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;
  if (!root) return null;
  // watch 可以写在 `watch` 下，也可以沿用旧格式直接写在根上；self 只在 `self` 下。
  const legacy = root['hurt'] !== undefined || root['win'] !== undefined;
  const watchNode = root['watch'] ?? (legacy ? root : undefined);
  return {
    watch: pools(watchNode, DEFAULT_CHATTER_BOOK.watch),
    self: pools(root['self'], DEFAULT_CHATTER_BOOK.self),
  };
}

/**
 * 台词文件的读取器：文件不存在就写一份默认的；改完保存即生效（最多 2 秒延迟）。
 * 解析失败保留上一份，不把错别字变成她的嘴。
 */
export class ChatterLines {
  private book: ChatterBook = DEFAULT_CHATTER_BOOK;
  private mtime = -1;
  private checkedAt = 0;

  constructor(
    private readonly path: string,
    private readonly warn: (message: string) => void = () => {},
  ) {}

  get(): ChatterBook {
    if (!this.path) return this.book;
    const now = Date.now();
    if (now - this.checkedAt < 2000) return this.book;
    this.checkedAt = now;
    try {
      const stat = statSync(this.path);
      if (stat.mtimeMs === this.mtime) return this.book;
      const parsed = parseChatterBook(readFileSync(this.path, 'utf8'));
      if (parsed) {
        this.book = parsed;
        this.mtime = stat.mtimeMs;
      } else {
        this.warn(`台词文件解析失败，继续用上一份：${this.path}`);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') this.writeDefault();
      else this.warn(`读不到台词文件：${this.path}（${String((error as Error)?.message ?? error)}）`);
    }
    return this.book;
  }

  /** 首次启动写一份默认台词，玩家照着改就行。 */
  private writeDefault(): void {
    try {
      if (!existsSync(dirname(this.path))) mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(DEFAULT_CHATTER_BOOK, null, 2) + '\n', 'utf8');
      this.mtime = statSync(this.path).mtimeMs;
    } catch (error) {
      this.warn(`写不了默认台词文件：${this.path}（${String((error as Error)?.message ?? error)}）`);
    }
  }
}