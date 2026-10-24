/**
 * 桥自带的战斗求解器（GET /solver/plan，实测 2026-10-23：约 0.75s 出计划）。
 * 这里只把它当"注记"：给出下一步建议的编号，决策权仍在模型。
 * 铁律：拿不到、看不懂、覆盖不全、置信不够 → 什么都不贴，绝不猜。
 */
import type { Fields, NormSnapshot } from './protocol.ts';

export interface SolverOptions {
  baseUrl: string;
  path?: string;
  timeoutMs?: number;
  minConfidence?: number;
}

export interface SolverStep {
  kind: string;
  cardIndex: number | null;
  cardName: string;
  targetIndex: number | null;
}

export interface SolverPlan {
  turn: number | null;
  first: SolverStep | null;
  turnsPlanned: number;
  confidence: number | null;
  coverage: { exact: number; inferred: number; unsupported: number; ignored: number; risk: boolean };
  warnings: string[];
  searchStatus: string;
  winProb: number | null;
  policy: string;
  budgetMs: number | null;
}

export function parsePlan(payload: unknown): SolverPlan | null {
  const root = payload !== null && typeof payload === 'object' ? payload as Fields : {};
  if (root['ok'] === false) return null;
  const data = (root['data'] ?? root) as Fields;
  if (data['in_combat'] !== true) return null;

  const lines = Array.isArray(data['line']) ? data['line'] as Fields[] : [];
  const firstTurn = lines.length ? lines[0] : null;
  const steps = firstTurn && Array.isArray(firstTurn['steps']) ? firstTurn['steps'] as Fields[] : [];
  const raw = steps.length ? steps[0] : null;
  const first: SolverStep | null = raw ? {
    kind: String(raw['kind'] ?? ''),
    cardIndex: typeof raw['card_index'] === 'number' ? raw['card_index'] as number : null,
    cardName: String(raw['card_name'] ?? ''),
    targetIndex: typeof raw['target_index'] === 'number' ? raw['target_index'] as number : null,
  } : null;

  const coverage = (data['coverage'] ?? {}) as Fields;
  const warnings = Array.isArray(data['warnings']) ? (data['warnings'] as unknown[]).map(String) : [];

  return {
    turn: typeof data['turn'] === 'number' ? data['turn'] as number : null,
    first,
    turnsPlanned: lines.length,
    confidence: typeof data['confidence'] === 'number' ? data['confidence'] as number : null,
    coverage: {
      exact: Number(coverage['exact'] ?? 0) || 0,
      inferred: Number(coverage['inferred'] ?? 0) || 0,
      unsupported: Number(coverage['unsupported'] ?? 0) || 0,
      ignored: Number(coverage['ignored'] ?? 0) || 0,
      risk: coverage['risk'] === true,
    },
    warnings,
    searchStatus: String(data['search_status'] ?? ''),
    winProb: typeof data['win_prob'] === 'number' ? data['win_prob'] as number : null,
    policy: String(data['policy_explanation'] ?? ''),
    budgetMs: typeof data['budget_ms'] === 'number' ? data['budget_ms'] as number : null,
  };
}

/** 求解器的第一步能不能对上我们编号里的某一条。 */
export function matchAction(snapshot: NormSnapshot, plan: SolverPlan): number | null {
  const step = plan.first;
  if (!step) return null;
  if (step.kind === 'end_turn') {
    return snapshot.actions.find((action) => action.command['action'] === 'end_turn')?.n ?? null;
  }
  if (step.kind !== 'play_card' || step.cardIndex === null) return null;
  const hit = snapshot.actions.find((action) => {
    const command = action.command;
    if (command['action'] !== 'play_card') return false;
    if (command['card_index'] !== step.cardIndex) return false;
    const target = command['target_index'];
    const wanted = step.targetIndex ?? undefined;
    return target === wanted || (target === undefined && wanted === undefined);
  });
  return hit?.n ?? null;
}

/**
 * 计划为什么不能直接用。`null` = 可以用（贴注记和自动接管共用这一道门槛，
 * 免得出现"注记不贴、动作照打"这种两套判定）。
 */
export type PlanBlock = 'no-step' | 'search-incomplete' | 'unsupported' | 'risky' | 'low-confidence';

export function planBlock(plan: SolverPlan, minConfidence = 0.6): PlanBlock | null {
  if (!plan.first) return 'no-step';
  if (plan.searchStatus !== 'complete') return 'search-incomplete';
  if (plan.coverage.unsupported > 0) return 'unsupported';
  if (plan.coverage.risk) return 'risky';
  if (plan.confidence !== null && plan.confidence < minConfidence) return 'low-confidence';
  return null;
}

/**
 * 把求解器计划变成快照尾部的一行；不值得贴就返回 null。
 * 门槛：搜索完成、没有不支持/有风险的牌、置信够、第一步能对上编号。
 */
export function adviceLine(snapshot: NormSnapshot, plan: SolverPlan, minConfidence = 0.6): string | null {
  if (snapshot.screen !== 'combat') return null;
  if (planBlock(plan, minConfidence)) return null;

  const n = matchAction(snapshot, plan);
  if (n === null) return null;

  const action = snapshot.actions.find((entry) => entry.n === n);
  const label = action ? action.label : plan.first?.cardName ?? '';
  const bits = [`求解器：下一步 → ${n}${label ? `（${label}）` : ''}`];
  const stats: string[] = [];
  if (plan.confidence !== null) stats.push(`置信 ${plan.confidence.toFixed(2)}`);
  const covered = plan.coverage.exact + plan.coverage.inferred;
  if (covered) stats.push(`覆盖 ${covered} 张${plan.coverage.inferred ? `（${plan.coverage.inferred} 张推断）` : ''}`);
  if (stats.length) bits.push(`（${stats.join(' · ')}）`);
  if (plan.policy && plan.policy.length <= 60) bits.push(`；它的说法：${plan.policy}`);
  if (plan.winProb !== null && plan.winProb > 0.02 && plan.winProb < 0.98) bits.push(`；估计胜率 ${Math.round(plan.winProb * 100)}%`);
  return bits.join('');
}

/** 只读客户端：超时/出错都返回 null，绝不阻塞。 */
export class SolverClient {
  private readonly url: string;
  private readonly timeoutMs: number;
  /** 冷却到什么时候（超时之后冷一段时间，别把游戏主线程钉死）。 */
  private cooldownUntil = 0;
  private inflight: Promise<SolverPlan | null> | null = null;
  /** 连续超时次数 & 最近一次耗时：给"这一场改我自己打"的判断用。 */
  timeouts = 0;
  lastMs = 0;

  constructor(options: SolverOptions) {
    this.url = `${options.baseUrl.replace(/\/+$/, '')}${options.path && options.path.trim() ? options.path.trim() : '/solver/plan'}`;
    this.timeoutMs = options.timeoutMs ?? 6000;
  }

  /** 冷却中（求解器刚算不动）：调用方可以据此直接改走模型。 */
  get cooling(): boolean { return Date.now() < this.cooldownUntil; }

  async plan(signal?: AbortSignal): Promise<SolverPlan | null> {
    if (Date.now() < this.cooldownUntil) return null;
    if (this.inflight) return this.inflight;
    const started = Date.now();
    const task = this.fetchPlan(signal).then((plan) => {
      this.lastMs = Date.now() - started;
      if (plan) this.timeouts = 0;
      return plan;
    });
    this.inflight = task;
    try {
      const plan = await task;
      // 超时 = 搜索在游戏主线程上跑不完：冷却一段时间，别每步都去钉它。
      // 越算不动冷得越久（60s → 2min → 4min …，封顶 10 分钟），别在同一个 boss 上反复送死。
      if (!plan && this.lastMs >= this.timeoutMs - 50) {
        this.timeouts++;
        this.cooldownUntil = Date.now() + Math.min(60_000 * 2 ** Math.min(this.timeouts - 1, 4), 600_000);
      }
      return plan;
    } finally {
      if (this.inflight === task) this.inflight = null;
    }
  }

  private async fetchPlan(signal?: AbortSignal): Promise<SolverPlan | null> {
    try {
      const composed = signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs);
      const response = await fetch(this.url, { method: 'GET', headers: { accept: 'application/json' }, signal: composed });
      if (!response.ok) return null;
      return parsePlan(await response.json());
    } catch {
      return null;
    }
  }
}