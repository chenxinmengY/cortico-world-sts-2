/**
 * 杀戮尖塔 2 的 World：她自己连着打，玩家只在忍不了时喊一句。
 * 这里管三件事：把桥的局面变成事件、把编号动作换成桥的指令、以及在她不该动的时候停住。
 * 传输在 bridge.ts，payload 形状在 protocol.ts，文本在 render.ts。
 */
import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ToolCallContext, ToolDef, ToolOutcome, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import { Sts2Bridge, BridgeError } from './bridge.ts';
import { STS2_CONFIG_GROUP, STS2_DEFAULTS, type Sts2ConfigSection } from './config.ts';
import { bool, cleanText, list, num, object, pick, selectionNeed, stateRef, type Fields, type NormAction, type NormReceipt, type NormSnapshot } from './protocol.ts';
import { pickAutoAction, looksLikeSettling, type AutoDecision } from './auto.ts';
import { pickChatter, ChatterLines } from './chatter.ts';
import { PassportTracker, type Verdict } from './passport.ts';
import { SaveReader, type SaveFacts } from './savefile.ts';
import { IntentStore } from './intent.ts';
import { SolverClient, adviceLine, matchAction, planBlock, type SolverPlan } from './solver.ts';
import { renderDeck, renderMap, renderReceipt, renderSnapshot, screenName } from './render.ts';
import { STS2_TOOL_DECLS, validateDo } from './tools.ts';

export interface Sts2WorldOptions {
  cfg: Sts2ConfigSection;
  timezone: string;
  dataDir: string;
  /** 桥若开了鉴权，用它；没开就空。 */
  token?: string;
}

/** 新版 Core 的直连发言通道；旧 Core 没有这两个方法，运行时按可选处理。 */
type SpeakHost = WorldHost & {
  speak?: (text: string, opts?: { source?: string; ttlMs?: number }) => boolean;
};

const MODE_LABEL: Record<string, string> = {
  single: '单人', 'coop-host': '多人·主机', 'coop-client': '多人·客户端', unknown: '—',
};

/** 这些屏即使没有动作也不算"卡住"：本来就该人点或本来就在等。 */
const QUIET_SCREENS = new Set(['main-menu', 'character-select', 'game-over', 'victory']);

/** 这些屏玩家自己点：不推局面、不替她开局（`quietOnMenu` 开时）。 */
const MENU_SCREENS = new Set(['main-menu', 'character-select']);

/** 她自己"两轮没动静"停手时写的原因：重连后要能自动接回来。 */
const AUTO_PAUSE_REASON = '她连着两轮没动静';

/** 接管为什么交回模型。 */
type AutoplayStop =
  | 'leave' | 'steps' | 'hp' | 'lethal' | 'settling' | 'refused' | 'stopped' | 'error'
  | 'offline' | 'no-plan' | 'no-match' | 'cards-left'
  | 'no-step' | 'search-incomplete' | 'unsupported' | 'risky' | 'low-confidence';

/** 交回时给她的一句话（她只会在摘要里看到这句）。 */
const AUTOPLAY_STOP_TEXT: Record<AutoplayStop, string> = {
  leave: '这场打完了',
  steps: '到步数上限了',
  hp: '血量到线了',
  lethal: '结束回合会死',
  settling: '界面在结算',
  refused: '桥连着拒了同一手',
  stopped: '被叫停',
  error: '提交出错',
  offline: '桥没有局面',
  'no-plan': '求解器没给计划',
  'no-match': '编号对不上',
  'cards-left': '手里还有牌没打',
  'no-step': '求解器没给第一步',
  'search-incomplete': '求解器没算完',
  unsupported: '有它不认识的牌',
  risky: '它自己说有风险',
  'low-confidence': '置信不够',
};

export class Sts2World implements World {
  readonly id = 'sts-2';
  private readonly bridge: Sts2Bridge;
  private host: WorldHost | null = null;
  private readonly stopSignal = new AbortController();
  private state: 'offline' | 'loading' | 'online' | 'error' = 'offline';
  private detail = '';
  private presented: NormSnapshot | null = null;
  private lastSeen: NormSnapshot | null = null;
  private busy = false;
  private paused = false;
  private pausedReason = '';
  private blockedRef = '';
  private eventPending = false;
  private eventTicket = 0;
  private decisionAfterTurn = false;
  private lastEventAt = 0;
  private throttleTimer: NodeJS.Timeout | null = null;
  private blockedTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private pendingBlock = '';
  /** 同一个 (状态码, 编号) 失败过就不再提交——她复读一次就够丢人了。 */
  private readonly failures = new Set<string>();
  /** 同一个状态码下连续被拒的次数。 */
  private readonly rejects = new Map<string, number>();
  /** 已经替她自动点过的状态码（每个局面最多一次）。 */
  private readonly autoUsed = new Set<string>();
  /** 已经因为连续失败喊过人的状态码。 */
  private readonly escalated = new Set<string>();
  /** 敌方回合空动作的耐心计数（按状态码）。 */
  private readonly settleRetries = new Map<string, number>();
  /** 多人地图：这次进图是什么时候开始压的（0 = 没在压）；`coopHoldDone` = 这次进图已经压过。 */
  private coopHoldSince = 0;
  private coopHoldDone = false;
  private coopTimer: NodeJS.Timeout | null = null;
  private autoCount = 0;
  /** 两次自动之间的最小间隔：防止"结束回合"在残局里被连点。 */
  private lastAutoAt = 0;
  /** 已经推了一份局面、她还在想：这期间的新局面先攒着，别把她从思考里拽出来。 */
  private awaiting = false;
  private queuedRef: string | null = null;
  /** 上一条回执已经把哪个状态码的完整局面给她了：随后那次推送就别再重复一遍。 */
  private receiptRef: string | null = null;
  private queueTimer: NodeJS.Timeout | null = null;
  /** 判成"卡住"之后还会自己回来看看：桥经常只是抖了一帧。 */
  private blockedRetry: NodeJS.Timeout | null = null;
  private blockedRetries = 0;
  /** 最近一次"桥给了动作"的时间：界面抖动时用它判断"这不是卡住"。 */
  private lastActionAt = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private lastChatterAt = 0;
  private chatterCount = 0;
  /** 上一条闲话：同一个池子里还有别的就换一句。 */
  private lastChatterText: string | null = null;
  private lastDriftAt = 0;
  private generation = 0;
  private readonly passport = new PassportTracker();
  private readonly save: SaveReader;
  private readonly solver: SolverClient;
  private readonly intent: IntentStore;
  /** 台词池（dataDir/chatter.json，可热改）。 */
  private readonly chatterLines: ChatterLines;
  /** 求解器注记：状态码 → 一行建议（null 表示这次没有可用建议）。 */
  private readonly advice = new Map<string, string | null>();
  private readonly adviceInflight = new Set<string>();
  /** 桥的体检流水（dataDir/sts2-bridge.jsonl）：卡的时候直接看这份。 */
  private readonly bridgeLogPath: string;
  private lastHealth: 'ok' | 'slow' | 'stuck' = 'ok';
  /** 玩家临时指令（"这层别打精英"）。 */
  private directive: { text: string; until: 'next' | 'floor' | 'screen' | 'manual'; floor: number | null; screen: string; refs: Set<string> } | null = null;
  /** 求解器正在接管战斗：期间不推局面、不叫醒模型。 */
  private autoplay = false;
  /** 本次接管已经执行了几步（不是累计）。 */
  private autoplaySteps = 0;
  /** 已经交回模型的那个状态码：同一帧不再重新接管（否则会和"推局面"互相点火）。 */
  private autoplayGaveUpRef = '';
  /** 上一次观察的状态码与时间，用来节流重复观察。 */
  private lastObserveRef = '';
  private lastObserveAt = 0;
  private observeCount = 0;
  private observeThrottled = 0;
  /** 最近一次真正读到局面的时间：缓存比它旧就说明这一帧不能再信了。 */
  private lastStateAt = 0;
  /** 上一次问求解器注记的时间：它一次搜索 0.7 秒满负载，得掐着问。 */
  private lastPrefetchAt = 0;
  /** 上一次接管已经交回模型的时间：接管出问题时靠它定位。 */
  private lastAutoplayAt = 0;
  /** 上次接管为什么交回。 */
  private lastAutoplayStop: AutoplayStop | null = null;
  /** SSE 说健康、却漏了帧时的兜底对账。 */
  private reconcileTimer: NodeJS.Timeout | null = null;
  /** 断开的时间与"断够久说过没有"：短暂抖动不叫她。 */
  private downAt = 0;
  private downReported = false;
  private downTimer: NodeJS.Timeout | null = null;
  private everConnected = false;

  constructor(private readonly opts: Sts2WorldOptions) {
    // 配置里的地址可能被写坏；构造期抛错会连带 Core 一起挂，所以退到默认值继续。
    const build = (baseUrl: string) => new Sts2Bridge({
      baseUrl,
      token: opts.token,
      statePath: opts.cfg.statePath,
      actionPath: opts.cfg.actionPath,
      eventPath: opts.cfg.eventPath,
      capturePath: opts.cfg.capturePath,
      pollIntervalMs: opts.cfg.pollIntervalMs,
      stateTimeoutMs: opts.cfg.stateTimeoutMs,
      actionTimeoutMs: opts.cfg.actionTimeoutMs,
    });
    try { this.bridge = build(opts.cfg.baseUrl); } catch { this.bridge = build(STS2_DEFAULTS.baseUrl); }
    this.save = new SaveReader(opts.cfg.savePath);
    this.solver = new SolverClient({
      baseUrl: opts.cfg.baseUrl,
      path: opts.cfg.solverPath,
      timeoutMs: opts.cfg.solverTimeoutMs,
    });
    this.intent = new IntentStore(opts.dataDir);
    this.bridgeLogPath = join(opts.dataDir, 'sts2-bridge.jsonl');
    const chatterPath = opts.cfg.chatterLinesFile?.trim() || join(opts.dataDir, 'chatter.json');
    this.chatterLines = new ChatterLines(chatterPath, (message) => {
      if (this.host) this.host.log.warn('sts-2.chatter', message);
      else console.warn(`[sts-2] ${message}`);
    });
    this.bridge.on('snapshot', (snapshot: NormSnapshot, cause: string) => {
      if (cause === 'action') return;
      this.noteSnapshot(snapshot, true);
    });
    this.bridge.on('disconnect', (error: Error) => {
      this.logBridge({ kind: 'disconnect', message: short(error.message), timeout: isTimeout(error) });
      if (this.state !== 'online') return;
      this.state = 'error';
      this.detail = error.message;
      this.downAt = Date.now();
      // 桥经常只是抖一下：先别急着叫她（一次事件 = 一次完整调用）。
      // 断够久才算真断了，那时再说；短抖重连回来就当她没听见。
      if (!this.downTimer) {
        this.downTimer = setTimeout(() => {
          this.downTimer = null;
          if (this.state === 'online') return;
          this.downReported = true;
          // 读超时 ≠ 断线：真机上 mod 在大局里会排队几十秒，喊"断了"只会让她乱。
          void this.event('sts-2.connection', isTimeout(error)
            ? `游戏那边回得很慢（${short(error.message)}）。我先把请求放缓，等它缓过来再接着打；这期间别重复提交动作。`
            : `和游戏的连接断了：${short(error.message)}。她已经提交但还没回执的动作结果未知；重连后会重新推一份局面。`);
        }, Math.max(0, this.opts.cfg.connectionQuietMs));
        this.downTimer.unref?.();
      }
      this.scheduleRetry();
    });
    // 桥自己报的慢/失败：落到 sts2-bridge.jsonl，真机上"卡的时候"直接看这份，不用猜。
    this.bridge.on('metric', (metric: Fields) => {
      this.logBridge({
        kind: metric['code'] ? 'fail' : 'slow',
        path: metric['path'],
        ms: metric['ms'],
        status: metric['status'],
        error: metric['code'],
        timeoutMs: metric['timeoutMs'],
      });
      this.noteHealth();
    });
  }

  /** 桥的体检流水：只写"值得看一眼"的行，超过 1MB 只留最后 500 行。 */
  private logBridge(entry: Fields): void {
    const snapshot = this.bridge.snapshot;
    const line = JSON.stringify({
      ts: nowIso(this.opts.timezone),
      ...entry,
      health: this.bridge.health,
      latency: this.bridge.lastLatencyMs,
      screen: snapshot?.screen ?? null,
      act: snapshot?.game.act ?? null,
      floor: snapshot?.game.floor ?? null,
      code: snapshot ? stateRef(snapshot) : null,
    });
    try {
      appendFileSync(this.bridgeLogPath, `${line}\n`);
      if (statSync(this.bridgeLogPath).size > 1_000_000) {
        const keep = readFileSync(this.bridgeLogPath, 'utf8').split('\n').filter(Boolean).slice(-500);
        writeFileSync(this.bridgeLogPath, `${keep.join('\n')}\n`);
      }
    } catch { /* 写不进去不影响玩 */ }
  }

  /** health 升降各记一行：卡顿的起点就是 ok → slow 那一刻。 */
  private noteHealth(): void {
    const health = this.bridge.health;
    if (health === this.lastHealth) return;
    this.logBridge({ kind: 'health', from: this.lastHealth, to: health });
    this.lastHealth = health;
  }

  /* ───────────────────────── World 契约 ───────────────────────── */

  envPromptVars(): Record<string, string> { return {}; }

  /** 面板上的"接管"：求解器此刻在不在替她打。 */
  private autoplayBadge(): string {
    if (!this.opts.cfg.solverAutoplay) return '关';
    if (this.autoplay) return `求解器 ${this.autoplaySteps} 步`;
    return '待命';
  }

  tools(): ToolDef[] {
    return STS2_TOOL_DECLS
      // 观察和排障默认不暴露：每份回执已带局面，多读一次就是多一整轮调用。
      .filter((decl) => decl.name !== 'sts2_observe' || this.opts.cfg.exposeObserve)
      .filter((decl) => decl.name !== 'sts2_probe' || this.opts.cfg.devTools)
      .map((decl) => ({ ...decl, handler: (args, ctx) => this.call(decl.name, args, ctx) }));
  }

  webUi(_language?: unknown): WorldWebUiDecl {
    return {
      lamps: [
        { label: '桥', state: this.state, hint: this.detail || undefined },
        { label: '节奏', state: this.paused ? 'offline' : 'online', hint: this.paused ? this.pausedReason || '已停手' : '自动打' },
      ],
      badges: [
        { label: '界面', value: this.bridge.snapshot ? screenName(this.bridge.snapshot) : '—' },
        { label: '模式', value: MODE_LABEL[this.bridge.snapshot?.mode ?? 'unknown'] ?? '—' },
        { label: '操作数', value: this.bridge.snapshot?.actions.length ?? 0 },
        { label: '兜底', value: this.autoCount },
        { label: '接管', value: this.autoplayBadge() },
      ],
      config: [STS2_CONFIG_GROUP],
      promptDocs: [{
        key: 'worlds.sts-2.envPrompt',
        title: '杀戮尖塔 2 · 环境提示词',
        description: '局面、编号动作与回执的含义。',
        path: fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url)),
        role: 'envPrompt',
      }],
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.state = 'loading';
    this.detail = '';
    this.passport.reset();
    this.resetRunState();
    if (this.opts.cfg.launch) {
      try { launchGame(); } catch (error) { this.detail = short(String((error as Error)?.message ?? error)); }
    }
    try {
      await this.bridge.refresh(this.stopSignal.signal, this.opts.cfg.connectAttemptMs);
      this.state = 'online';
      this.detail = '';
      this.presented = null;
      this.bridge.watch(this.stopSignal.signal);
      this.startReconcile();
      this.clearAutoPause();
      this.everConnected = true;
      this.queueState();
    } catch (error) {
      // 游戏没开是常态，不是启动失败：挂 error 灯、后台重试，绝不把 Core 带崩。
      this.state = 'error';
      this.detail = short(String((error as Error)?.message ?? error));
      void this.event('sts-2.connection', `桥还没连上（${this.detail}）。游戏没开或 mod 没加载时这是正常的，开好游戏后会自动接上。`);
      this.scheduleRetry();
    }
  }

  async stop(): Promise<void> {
    this.state = 'offline';
    this.stopSignal.abort();
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    if (this.throttleTimer) { clearTimeout(this.throttleTimer); this.throttleTimer = null; }
    if (this.blockedTimer) { clearTimeout(this.blockedTimer); this.blockedTimer = null; }
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    if (this.queueTimer) { clearTimeout(this.queueTimer); this.queueTimer = null; }
    if (this.blockedRetry) { clearTimeout(this.blockedRetry); this.blockedRetry = null; }
    if (this.reconcileTimer) { clearInterval(this.reconcileTimer); this.reconcileTimer = null; }
    if (this.downTimer) { clearTimeout(this.downTimer); this.downTimer = null; }
    this.clearCoopHold();
    this.coopHoldDone = false;
    this.downReported = false;
    this.downAt = 0;
    this.blockedRetries = 0;
    this.queuedRef = null;
    this.awaiting = false;
    this.pendingBlock = '';
    this.bridge.close();
    this.host = null;
    this.presented = null;
    this.lastSeen = null;
    this.paused = false;
    this.blockedRef = '';
    this.decisionAfterTurn = false;
    this.eventPending = false;
    this.eventTicket++;
    this.autoplay = false;
    this.autoplaySteps = 0;
    this.lastObserveRef = '';
    this.lastObserveAt = 0;
    this.resetRunState();
    this.passport.reset();
    this.lastActionAt = 0;
  }

  onHandoffEnded(): void {
    this.presented = null;
    this.blockedRef = '';
    this.queueState();
  }

  onTurnEnded(): void {
    this.awaiting = false;
    if (this.queueTimer) { clearTimeout(this.queueTimer); this.queueTimer = null; }
    if (this.queuedRef) { this.queuedRef = null; this.queueState(); }
    const pending = this.decisionAfterTurn;
    this.decisionAfterTurn = false;
    if (pending && this.opts.cfg.remindAtTurnEnd) this.queueState(true);
  }

  /* ───────────────────────── 工具 ───────────────────────── */

  private async call(name: string, args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolOutcome> {
    ctx.signal?.throwIfAborted();
    if (!this.host) throw new Error('杀戮尖塔 2 的 World 还没启动');
    await this.ensureOnline(ctx.signal);
    this.clearIdle();
    // 她开口要动作了，说明这一轮已经结束：攒着的局面不用再单独推。
    this.awaiting = false;
    this.queuedRef = null;
    if (this.queueTimer) { clearTimeout(this.queueTimer); this.queueTimer = null; }

    if (name === 'sts2_observe') {
      const previous = this.presented;
      const full = args.detail === 'full';
      // 节流看缓存里的状态码就够了：重复观察不重读、不渲染，只回一句话。
      if (!full && this.throttleObserve()) return { text: this.unchangedText() };
      const snapshot = await this.bridge.refresh(ctx.signal, this.stateDeadline());
      // 多人地图还压着：她来要也不给。给了她就会第一个点路线。
      const held = this.coopHoldNotice(snapshot);
      if (held) return { text: held };
      this.presented = snapshot;
      this.noteSnapshot(snapshot, false);
      const ref = stateRef(snapshot);
      this.observeCount++;
      this.lastObserveRef = ref;
      this.lastObserveAt = Date.now();
      // 回执刚给过、局面又没变：只回一句话，别让她把同一段文字再读一遍。
      if (!full && this.receiptRef === ref) return { text: this.unchangedText() };
      // 没要全量就只给相对上一份的增量：重复观察不再整段重发。
      return { text: this.decorate(renderSnapshot(snapshot, full, full ? undefined : previous ?? undefined), snapshot) };
    }

    if (name === 'sts2_inspect') {
      if (this.busy) return { text: '上一个动作还在结算，等回执再看。', failed: true };
      const what = args.what === 'deck' || args.what === 'map' ? args.what : 'full';
      const snapshot = await this.bridge.refresh(ctx.signal, this.stateDeadline());
      const held = this.coopHoldNotice(snapshot);
      if (held) return { text: held };
      this.presented = snapshot;
      this.noteSnapshot(snapshot, false);
      const body = what === 'deck' ? renderDeck(snapshot) : what === 'map' ? renderMap(snapshot) : renderSnapshot(snapshot, true);
      return { text: `【${what === 'deck' ? '牌组' : what === 'map' ? '地图' : '完整局面'}】\n${body}` };
    }

    // 求解器正在替她打这一场：模型可能因为一句 murmur 醒过来，但别真插手。
    if (this.autoplay && (name === 'sts2_do' || name === 'sts2_play')) {
      return { text: `求解器正在替她打这一场（已 ${this.autoplaySteps} 步），先别插手；等它把局面交回来再动。` };
    }
    // 停手是"只看不动"：被一句 murmur 叫醒时也不许顺手出牌。
    if (this.paused && (name === 'sts2_do' || name === 'sts2_play')) {
      return { text: `现在是观战模式（${this.pausedReason || '已停手'}），只看不动；要接手先 sts2_resume。` };
    }

    if (name === 'sts2_steer') {
      const text = typeof args.text === 'string' ? args.text.trim() : '';
      if (!text) {
        this.directive = null;
        return { text: '临时指令已撤销。' };
      }
      const raw = String(args.until ?? 'floor');
      const until = (['next', 'floor', 'screen', 'manual'] as const).find((value) => value === raw) ?? 'floor';
      const snapshot = this.bridge.snapshot;
      this.directive = {
        text: text.slice(0, 120),
        until,
        floor: snapshot?.game.floor ?? null,
        screen: snapshot?.screen ?? 'unknown',
        refs: new Set<string>(),
      };
      const scope = { next: '就下一步', floor: '本层结束前', screen: '本界面内', manual: '直到我撤销' }[until];
      return { text: `记下了：${this.directive.text}（${scope}）。之后每一份局面都会带上它。` };
    }

    if (name === 'sts2_intent') {
      const note = typeof args.note === 'string' ? args.note.trim() : '';
      const runId = this.bridge.snapshot?.sessionId ?? this.presented?.sessionId ?? 'sts2';
      const now = nowIso(this.opts.timezone);
      const saved = note ? this.intent.set(note, runId, now) : this.intent.clear(runId, now);
      return {
        text: saved.note
          ? `记下这一局的构筑意图（rev ${saved.rev}）：${saved.note}`
          : '这一局的构筑意图已清空。',
      };
    }

    if (name === 'sts2_capture') {
      const shot = await this.bridge.capture(ctx.signal);
      if (!shot) {
        return { text: '桥没有截图接口（或该路径不存在）。要看画面请直接看游戏窗口；这条不影响她继续打。', failed: true };
      }
      return {
        text: '杀戮尖塔 2 当前画面。',
        blobs: [{ bytes: shot.bytes, mime: shot.mime, name: 'sts2.png', fallbackText: '杀戮尖塔 2 当前画面' }],
      };
    }

    if (name === 'sts2_pause') {
      this.paused = true;
      this.pausedReason = typeof args.reason === 'string' && args.reason ? args.reason : '玩家要求停手';
      return { text: `已停手：${this.pausedReason}。不会再推送局面，也不会自己动；已经提交出去的那一步不会撤回。` };
    }

    if (name === 'sts2_resume') {
      this.paused = false;
      this.pausedReason = '';
      this.blockedRef = '';
      const snapshot = await this.bridge.refresh(ctx.signal, this.stateDeadline());
      const held = this.coopHoldNotice(snapshot);
      if (held) {
        this.presented = null;
        return { text: `已恢复。${held}` };
      }
      this.presented = null;
      this.noteSnapshot(snapshot, true);
      return { text: this.decorate(`已恢复，接着自己打。\n${renderSnapshot(snapshot)}`, snapshot) };
    }

    if (name === 'sts2_probe') {
      const raw = this.bridge.snapshot?.raw ?? await this.bridge.refresh(ctx.signal).then((s) => s.raw);
      const text = JSON.stringify(raw);
      const readable = this.bridge.snapshot ?? this.presented;
      const facts = this.saveFacts();
      const saveNote = facts ? ` · 读档 ${facts.numReloads} 次 · seed ${facts.seed || '—'}` : ' · 存档不可读';
      const summary = readable
        ? `界面 ${screenName(readable)}（原始 ${readable.screenRaw}）· 模式 ${MODE_LABEL[readable.mode] ?? readable.mode} · 动作 ${readable.actions.length} 个 · 状态码 ${stateRef(readable)} · 世代 ${this.generation}${saveNote}`
        : `还没有可用快照。${saveNote}`;
      const observeNote = ` · 观察 ${this.observeCount} 次 · 被节流 ${this.observeThrottled} 次`;
      const chatterNote = this.opts.cfg.chatter === 'off'
        ? ''
        : ` · 闲话 ${this.chatterCount} 句`
          + (this.lastChatterAt ? `（上次 ${Math.round((Date.now() - this.lastChatterAt) / 1000)} 秒前）` : '');
      const autoplayNote = this.opts.cfg.solverAutoplay
        ? ` · 求解器接管 ${this.autoplay ? '进行中' : '待命'}（本次 ${this.autoplaySteps} 步`
          + `${this.lastAutoplayStop ? ` · 上次交回：${AUTOPLAY_STOP_TEXT[this.lastAutoplayStop]}`
            + `（${Math.round((Date.now() - this.lastAutoplayAt) / 1000)} 秒前）` : ''}）`
        : '';
      return { text: `归一化摘要：${summary}${observeNote}${chatterNote}${autoplayNote}\n原始 /state（截断 ${Math.min(text.length, 6000)}/${text.length} 字符）：\n${text.slice(0, 6000)}` };
    }

    if (name === 'sts2_play') {
      const state = typeof args.state === 'string' ? args.state : '';
      const steps = Array.isArray(args.steps) ? (args.steps as Record<string, unknown>[]).slice(0, 8) : [];
      if (!state || !steps.length) throw new Error('sts2_play 需要 state 和至少一步');
      if (this.busy) return { text: '上一个动作还在结算，等它的回执。', failed: true };

      const latest = this.bridge.snapshot;
      if (!latest || stateRef(latest) !== state) {
        const snapshot = await this.bridge.refresh(ctx.signal, this.stateDeadline());
        // 真机现场：古之民结算完刚进地图，她手里的旧码失效，这里把地图 + 新编号一起给了她，
        // 下一秒她就点了路线——20 秒的等待被这一条回执绕过去。压着的时候只回话，不给局面。
        const held = this.coopHoldNotice(snapshot);
        if (held) return { text: held };
        this.presented = snapshot;
        this.noteSnapshot(snapshot, false);
        return {
          text: `未执行：状态码已过期，用下面的状态与编号。
${this.decorate(renderSnapshot(snapshot), snapshot)}`,
          failed: true,
        };
      }
      const heldNow = this.coopHoldNotice(latest);
      if (heldNow) return { text: heldNow };

      // 多选屏（"选择 N 张牌移除"）：桥一次只点一张，分开提交会互相抵消。
      // 真机上她就卡在这里：同一张牌点了四次，界面一动没动。
      // 只认真正的选牌屏：角色选择、奖励领取这些屏用 {select} 会一次并行点好几个，直接把桥点崩（500）。
      if (steps.some((step) => step['select'] !== undefined)) {
        if (latest.screen !== 'selection') {
          return {
            text: `未执行：{select} 只能用在选牌屏，这一屏是「${screenName(latest)}」。`
              + `用 sts2_do 按编号一个个来（领奖励一次领一项）。\n${renderSnapshot(latest)}`,
            failed: true,
          };
        }
        return await this.playSelects(state, steps, ctx);
      }

      const before = latest;
      const done: string[] = [];
      let failure = '';
      this.busy = true;
      try {
        for (const step of steps) {
          const snapshot = this.bridge.snapshot;
          if (!snapshot) { failure = '桥没有局面了'; break; }
          const picked = pickStep(snapshot, step);
          if (!picked) { failure = `找不到「${stepName(step)}」`; break; }
          let receipt: NormReceipt;
          try {
            receipt = await this.bridge.act(picked.command, ctx.signal, this.opts.cfg.actionTimeoutMs);
          } catch (error) {
            if (error instanceof BridgeError && error.status && error.status >= 500) {
              failure = `桥内部报错（HTTP ${error.status}，mod 异常）`;
              break;
            }
            throw error;
          }
          if (receipt.outcome !== 'executed') {
            failure = `「${picked.label}」没被接受：${receipt.reason || receipt.code || '未知原因'}`;
            break;
          }
          done.push(picked.label);
          this.decisionAfterTurn = true;
          if (picked.command['action'] === 'end_turn') break;
        }
      } finally {
        this.busy = false;
      }

      const after = this.bridge.snapshot ?? before;
      this.presented = after;
      this.noteSnapshot(after, false);
      const head = done.length ? `已执行 ${done.length} 步：${done.join('、')}。` : '一步都没执行。';
      const tail = failure ? `停在这里：${failure}。` : '这一轮打完。';
      return {
        text: this.decorate(`${head}${tail}
${renderSnapshot(after, false, before)}`, after),
        ...(done.length ? {} : { failed: true as const }),
      };
    }

    const { state, action } = validateDo(args);
    if (this.busy) return { text: '上一个动作还在结算，等它的回执，不要重复提交。', failed: true };

    const failureKey = `${state}:${action}`;
    if (this.failures.has(failureKey)) {
      const snap = this.bridge.snapshot ?? this.presented;
      return {
        text: `这一号在这个局面下已经失败过，不再重复提交。\n${snap ? renderSnapshot(snap) : '按新回执里的编号重来。'}`,
        failed: true,
      };
    }

    const before = this.presented;
    const latest = this.bridge.snapshot;
    if (!before || stateRef(before) !== state || !latest || stateRef(latest) !== state) {
      const snapshot = await this.bridge.refresh(ctx.signal, this.stateDeadline());
      const held = this.coopHoldNotice(snapshot);
      if (held) return { text: held };
      this.presented = snapshot;
      this.noteSnapshot(snapshot, false);
      return { text: `未执行：状态码已过期，用下面的状态与编号。\n${renderSnapshot(snapshot)}`, failed: true };
    }
    // 旧码还没过期、但这一屏是压着的多人地图：同样不给编号。
    const heldNow = this.coopHoldNotice(latest);
    if (heldNow) return { text: heldNow };

    const chosen = latest.actions[action - 1];
    if (!chosen) {
      return { text: `未执行：当前没有 ${action} 号操作。\n${renderSnapshot(latest)}`, failed: true };
    }

    this.busy = true;
    try {
      let receipt: NormReceipt;
      try {
        receipt = await this.bridge.act(chosen.command, ctx.signal, this.opts.cfg.actionTimeoutMs);
      } catch (error) {
        // 桥自己 500（真机：mod 对认不出的界面抛 NullReferenceException）：
        // 这不是"她断联了"，是这一步在 mod 里炸了。说清楚，别让她拿同一个编号反复试。
        if (error instanceof BridgeError && error.status && error.status >= 500) {
          this.failures.add(failureKey);
          this.trimFailures();
          return {
            text: `桥内部报错了（HTTP ${error.status}，游戏 mod 异常）：${short(String(error.message))}。`
              + '这一步没落地，别再试同一个编号；这一屏多半要你亲手点一下。',
            failed: true,
          };
        }
        throw error;
      }
      if (receipt.snapshot) {
        this.presented = receipt.snapshot;
        this.receiptRef = stateRef(receipt.snapshot);
        // 记护照、可能插一句话：走和局面推送同一条路，别两套判定。
        this.noteSnapshot(receipt.snapshot, false);
      }
      if (receipt.outcome === 'executed') {
        this.decisionAfterTurn = true;
        this.rejects.delete(state);
        if (receipt.snapshot && before) this.maybeChatter(before, receipt.snapshot);
      } else if (receipt.outcome === 'pending') {
        // 桥回了"排上队但没结算"：既不算成功也不算失败。重读一份，把真实局面给她。
        this.decisionAfterTurn = true;
        this.rejects.delete(state);
        const fresh = await this.bridge.refresh(ctx.signal, this.stateDeadline()).catch(() => null);
        if (fresh) {
          receipt = { ...receipt, snapshot: fresh };
          this.presented = fresh;
          this.noteSnapshot(fresh, false);
        }
      } else {
        // 失败的编号不再提交；被拒还要数次数，连着失败就停手喊人。
        this.failures.add(failureKey);
        this.trimFailures();
        // 被拒时局面多半已经变了（真机：桥回 409 说这一屏没这个动作）。
        // 重读一份再回，别让她对着一帧旧局面反复试。
        const fresh = await this.bridge.refresh(ctx.signal, this.stateDeadline()).catch(() => null);
        if (fresh) {
          receipt = { ...receipt, snapshot: fresh };
          this.presented = fresh;
          this.noteSnapshot(fresh, false);
        }
        if (receipt.outcome === 'rejected') {
          this.rejects.set(state, (this.rejects.get(state) ?? 0) + 1);
          this.maybeEscalate(state, receipt.snapshot ?? before);
        }
      }
      const text = this.decorate(renderReceipt(receipt, before, chosen), receipt.snapshot);
      const hint = receipt.outcome === 'executed' && this.opts.cfg.batchHint !== false ? this.batchHint(receipt.snapshot) : '';
      // 多选屏单点一下没用：告诉她怎么一次选满，别再拿同一张牌反复点。
      const pick = selectHint(latest);
      return { text: text + hint + (pick ?? ''), ...(receipt.outcome === 'rejected' ? { failed: true as const } : {}) };
    } finally {
      this.busy = false;
      this.queueState();
    }
  }

  /* ───────────────────────── 连接与事件 ───────────────────────── */

  private async ensureOnline(signal?: AbortSignal): Promise<void> {
    if (this.state === 'online' && this.bridge.connected) return;
    try {
      await this.bridge.refresh(signal, 3000);
      this.state = 'online';
      this.detail = '';
    } catch (error) {
      this.state = 'error';
      this.detail = short((error as Error)?.message ?? String(error));
      throw error instanceof BridgeError
        ? new Error(isTimeout(error)
          ? `游戏那边还没回话（${this.detail}）。它多半正在忙，缓过来就自动接上；别重复提交动作。`
          : `桥不可用：${this.detail}。确认游戏开着、mod 已加载，端口对得上。`)
        : error;
    }
  }

  /** 读局面的超时：桥慢的时候放宽，别让客户端先掐断——真机上这样会把 mod 的写回搞成断链。 */
  private stateDeadline(): number {
    const base = this.opts.cfg.stateTimeoutMs;
    return this.bridge.health === 'ok' ? base : Math.max(base, 15000);
  }

  /**
   * 兜底对账：桥的事件流"健康"却漏帧时（真机：地图 → 战斗那一帧没推过来），
   * 缓存会一直停在旧界面，她就对着过期的局面打。这里每 2.5 秒读一次 /state，
   * 只在有变化时才发事件；本地 GET，不花 token。
   */
  private startReconcile(): void {
    if (this.reconcileTimer || this.stopSignal.signal.aborted) return;
    let tick = 0;
    this.reconcileTimer = setInterval(() => {
      if (this.stopSignal.signal.aborted || !this.host) return;
      if (this.state !== 'online' || this.busy || this.autoplay) return;
      if (!this.bridge.streaming) return;   // 事件流断了有轮询兜着，不用重复读
      // 桥正卡着就别再压：真机上请求会排在它后面堆到几分钟，越压越慢。
      if (this.bridge.health === 'stuck') return;
      tick++;
      // 慢的时候降压：从每 2.5 秒一份降到每 5 秒一份。
      if (this.bridge.health === 'slow' && tick % 2 === 0) return;
      void this.bridge.refresh(this.stopSignal.signal, this.stateDeadline()).catch(() => {});
      // 兜底重推：界面有动作、她这一轮已经结束、却十几秒没有任何推送——
      // 多半是上一次 deferred 批次被宿主丢了（真机：被一句语音抢占了模型轮）。
      const current = this.bridge.snapshot;
      if (current && current.actions.length && !this.awaiting && !this.paused
        && Date.now() - this.lastEventAt > 12000) {
        this.queueState();
      }
    }, 2500);
    this.reconcileTimer.unref?.();
  }

  /**
   * 她自己因为"两轮没动静"停的手，不算是玩家叫停的：重新连上就接着打，
   * 否则游戏关一会儿再开，她会一直坐在那里不动。玩家亲口叫的停不动。
   */
  private clearAutoPause(): void {
    if (!this.paused) return;
    if (this.pausedReason !== AUTO_PAUSE_REASON) return;
    this.paused = false;
    this.pausedReason = '';
    this.clearIdle();
  }

  /** 桥没连上时的后台重试：慢慢试，连上就接管，不阻塞 Core 启动。 */
  private scheduleRetry(): void {
    if (this.retryTimer || this.stopSignal.signal.aborted || !this.host) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.retryOnce();
    }, this.opts.cfg.retryIntervalMs);
    this.retryTimer.unref?.();
  }

  private async retryOnce(): Promise<void> {
    if (this.stopSignal.signal.aborted || !this.host) return;
    try {
      await this.bridge.refresh(this.stopSignal.signal, this.opts.cfg.connectAttemptMs);
      this.state = 'online';
      this.detail = '';
      this.bridge.watch(this.stopSignal.signal);
      this.startReconcile();
      this.clearAutoPause();
      if (this.downReported) {
        this.downReported = false;
        void this.event('sts-2.connection', '和游戏的桥接回来了，接着打。');
      } else if (!this.everConnected) {
        void this.event('sts-2.connection', '和游戏的桥连上了，开始读局面。');
      }
      this.everConnected = true;
      this.queueState();
    } catch (error) {
      this.state = 'error';
      this.detail = short(isTimeout(error)
        ? '游戏那边还没回话（在读局面时超时了，通常是游戏或 mod 正忙）'
        : String((error as Error)?.message ?? error));
      this.scheduleRetry();
    }
  }

  private noteSnapshot(snapshot: NormSnapshot, notify: boolean): void {
    const before = this.lastSeen;
    this.lastStateAt = Date.now();
    const verdict = this.passport.observe(snapshot, this.saveFacts());
    this.lastSeen = snapshot;
    if (verdict) this.applyVerdict(verdict, snapshot);
    this.prefetchAdvice(snapshot);
    if (before) this.maybeChatter(before, snapshot);
    if (notify) this.queueState();
    // 观察/回执里看到战斗，也顺手把战斗交给求解器：不额外推局面。
    else if (this.canAutoplay(snapshot)) void this.runAutoplay(snapshot);
  }

  /**
   * 多人局进地图：先压 `coopRouteWaitMs`，给队友投票的时间。
   * - `> 0`：最多压这么久，到点放行；队友先投就提前放行。
   * - `= 0`：一直压到队友先投票为止（不设超时，改配置能立刻放行）。
   * 每次进图只压一次；压制期间队友投票会更新缓存，推的是最新局面。
   * 要的是"跟票"，不是"第一个点"。
   */
  private holdCoopRoute(snapshot: NormSnapshot): boolean {
    if (snapshot.screen !== 'map' || !isCoopSnapshot(snapshot)) {
      this.clearCoopHold();
      this.coopHoldDone = false;
      return false;
    }
    // 有人投了：不用等满，立刻把带投票的最新地图推给她去跟。
    if (coopOthersVoted(snapshot)) {
      this.clearCoopHold();
      this.coopHoldDone = true;
      return false;
    }
    if (this.coopHoldDone) return false;
    const wait = Math.max(0, this.opts.cfg.coopRouteWaitMs ?? 0);
    if (!this.coopHoldSince) {
      this.coopHoldSince = Date.now();
      // 真机上靠这一行确认等待到底有没有生效。
      this.host?.log.info?.('sts-2.coop', wait > 0
        ? `多人地图：先压 ${Math.round(wait / 1000)} 秒等队友投票；队友一投就提前放行`
        : '多人地图：配置是 0，一直等队友先投票（队友投了、或把配置改大才放行）');
    }
    // 0 = 一直等：没有截止时间，只有"队友投票 → 新 Revision → 再走一遍这里"能放行。
    const left = wait > 0 ? this.coopHoldSince + wait - Date.now() : Number.POSITIVE_INFINITY;
    if (left <= 0) {
      this.coopHoldDone = true;
      this.clearCoopHold();
      return false;
    }
    // 压着的时候不是"她该决定"：别让 idle 提醒把她叫醒去点地图。
    this.clearIdle();
    if (!this.coopTimer && Number.isFinite(left)) {
      this.coopTimer = setTimeout(() => {
        this.coopTimer = null;
        this.coopHoldSince = 0;
        this.coopHoldDone = true;
        this.awaiting = false;
        this.queueState(false, true);
      }, left);
      this.coopTimer.unref?.();
    }
    return true;
  }

  private clearCoopHold(): void {
    if (this.coopTimer) { clearTimeout(this.coopTimer); this.coopTimer = null; }
    this.coopHoldSince = 0;
  }

  /**
   * 压着的时候，谁也别想把地图端到她面前——包括她自己调工具来要。
   * 不给地图 = 没有编号 = 她点不了，只能等我推。
   */
  private coopHoldNotice(snapshot: NormSnapshot | null): string | null {
    if (!snapshot) return null;
    if (!this.holdCoopRoute(snapshot)) return null;
    const wait = Math.max(0, this.opts.cfg.coopRouteWaitMs ?? 0);
    const tail = wait > 0
      ? `最多再等 ${Math.max(1, Math.ceil((this.coopHoldSince + wait - Date.now()) / 1000))} 秒，队友一投我就立刻推给你`
      : '一直等队友先投票，他投了我就立刻推给你';
    return `多人局刚进地图：我在等队友先投票（${tail}）。`
      + '这一屏现在不给你编号，也别自己点——等我推局面，别重复问。';
  }

  private queueState(remind = false, force = false): void {
    const snapshot = this.bridge.snapshot;
    // 注意：这里**不能**用 eventPending 当闸门。上一批局面如果被宿主丢掉（真机上：
    // 一句语音把还没外化的模型轮抢占，deferred 批次直接作废、render 永远不跑），
    // eventPending 就永远是 true，之后一帧都推不出去——她就那么坐在战利品屏上不动。
    // 去重靠 lastEventAt 的节流和 pushDeferred 里的 ticket，不靠这个布尔量。
    if (!this.host || !snapshot || this.busy || this.state !== 'online' || this.paused) return;
    const ref = stateRef(snapshot);
    // 接管期间一帧都不推：模型每醒一次就是一次完整调用。
    if (this.autoplay) return;
    if (this.canAutoplay(snapshot)) { void this.runAutoplay(snapshot); return; }
    // 主页和选角色是她不该动的地方：玩家没说，就别推、别点。
    if (!remind && this.opts.cfg.quietOnMenu && MENU_SCREENS.has(snapshot.screen)) return;

    // 多人局进地图：先压几秒，等队友投票；到点再推最新局面。
    // 提醒（remind）也得走这条：不然"回合结束那一句"会把地图直接端给她，20 秒白设。
    if (!force && this.holdCoopRoute(snapshot)) return;

    if (this.opts.cfg.pauseOnUnknownScreen && snapshot.actions.length === 0 && !QUIET_SCREENS.has(snapshot.screen)) {
      return this.maybeBlock(snapshot, ref);
    }
    if (snapshot.actions.length) this.blockedRef = '';
    if (snapshot.actions.length) this.lastActionAt = Date.now();

    // 没得选就替她点：省一次模型往返，也让流程别停在"继续"上。
    if (this.opts.cfg.autoAdvance && !remind && !this.autoUsed.has(ref) && Date.now() - this.lastAutoAt > 900) {
      const auto = pickAutoAction(snapshot, 'immediate');
      if (auto) {
        void this.runAuto(snapshot, auto);
        return;
      }
    }

    // 她这一轮还没走完：先把最新局面攒着，等回合结束一起推。
    // 例外：多人地图上队友刚投了票——这一份就是她该立刻看见的，别攒。
    const follow = snapshot.screen === 'map' && isCoopSnapshot(snapshot) && coopOthersVoted(snapshot);
    if (this.opts.cfg.queueStateEvents && this.awaiting && !remind && !force && !follow) {
      this.queuedRef = ref;
      if (!this.queueTimer) {
        this.queueTimer = setTimeout(() => {
          this.queueTimer = null;
          if (!this.queuedRef) return;
          this.queuedRef = null;
          this.awaiting = false;
          this.queueState();
        }, 8000);
        this.queueTimer.unref?.();
      }
      return;
    }

    if (!force && !remind && this.presented && stateRef(this.presented) === ref) return;

    const wait = this.opts.cfg.stateEventThrottleMs - (Date.now() - this.lastEventAt);
    if (!force && !remind && wait > 0) {
      if (this.throttleTimer) return;
      this.throttleTimer = setTimeout(() => { this.throttleTimer = null; this.queueState(); }, wait);
      this.throttleTimer.unref?.();
      return;
    }

    this.eventPending = true;
    this.lastEventAt = Date.now();
    const ticket = ++this.eventTicket;
    this.host.pushDeferred({
      type: remind ? 'sts-2.decision' : 'sts-2.state',
      senderKey: 'sts-2',
      ...(remind ? {} : { tags: ['snapshot'] as const }),
      render: () => {
        if (ticket !== this.eventTicket) return null;
        this.eventPending = false;
        const latest = this.bridge.snapshot;
        if (!latest || this.busy || this.state !== 'online' || this.paused) return null;
        // 排队时还在事件屏、冲刷时已经进了地图：这里再拦一次。
        // 少了这一道，古之民结算完那一帧会绕过等待直接推给她（真机现场）。
        if (this.holdCoopRoute(latest)) {
          this.awaiting = false;
          return null;
        }
        if (this.presented && stateRef(this.presented) === stateRef(latest)) {
          return remind ? `[StS2] ${screenName(latest)}还在等你决定；沿用上一份状态 ${stateRef(latest)}。` : null;
        }
        this.presented = latest;
        // 回执里已经给过这份局面了：这里只给"继续"的信号，别把同样的文字再存一遍历史。
        if (this.receiptRef === stateRef(latest)) {
          return `[StS2 ${stateRef(latest)} · ${screenName(latest)}] 接着来：编号沿用上一条回执。`;
        }
        return this.decorate(renderSnapshot(latest), latest);
      },
    }, { trigger: 'flush' });
    this.awaiting = true;
    this.armIdle(1);
  }

  /**
   * 桥没有给出任何动作：不再刷状态事件，只提醒一次，然后等人。
   * 这是"认不出的屏不停手会瞎点"的反面——宁可停住。
   */
  /**
   * 空动作先不喊人：界面切换、结算动画都会短暂地没有动作。
   * 宽限期内同一个状态码仍然没有动作，才判定"这一屏她不会"，提醒一次后停住。
   */
  private maybeBlock(snapshot: NormSnapshot, ref: string): void {
    if (this.blockedRef === ref || this.pendingBlock === ref) return;
    this.pendingBlock = ref;
    if (this.blockedTimer) clearTimeout(this.blockedTimer);
    const settling = looksLikeSettling(snapshot);
    const grace = settling ? this.opts.cfg.combatGraceMs : this.opts.cfg.blockedGraceMs;
    // 刚见过动作就说明界面在抖（桥的空帧、敌方回合动画），不是"这一屏她不会"。
    const target = Math.max(Date.now() + grace, this.lastActionAt + this.opts.cfg.blockedGraceMs);
    this.blockedTimer = setTimeout(() => {
      this.blockedTimer = null;
      this.pendingBlock = '';
      const latest = this.bridge.snapshot;
      if (!latest || stateRef(latest) !== ref || latest.actions.length) return;
      if (looksLikeSettling(latest)) {
        const waits = (this.settleRetries.get(ref) ?? 0) + 1;
        this.settleRetries.set(ref, waits);
        // 敌方回合可以很久，但一直读不到动作就要说一句了。
        if (waits < 3) { this.maybeBlock(latest, ref); return; }
      } else if (Date.now() - this.lastActionAt < this.opts.cfg.blockedGraceMs) {
        this.maybeBlock(latest, ref);
        return;
      }
      void this.block(latest, ref);
    }, Math.max(0, target - Date.now()));
    this.blockedTimer.unref?.();
  }

  private async block(snapshot: NormSnapshot, ref: string): Promise<void> {
    if (this.blockedRef === ref) return;
    this.blockedRef = ref;
    // 先真读一次：缓存里可能只是桥抖了一帧，实际她已经能动了。
    try {
      const fresh = await this.bridge.refresh(this.stopSignal.signal, this.stateDeadline());
      if (fresh.actions.length) {
        this.blockedRef = '';
        this.queueState();
        return;
      }
    } catch { /* 读不到就按卡住处理 */ }

    const hint = snapshot.screen === 'unknown'
      ? '这一屏她读不懂，桥也没给动作。'
      : `${screenName(snapshot)}这一屏桥没有给任何可执行动作。`;
    void this.event('sts-2.blocked', `${hint}我先试着自己接回来；一直不行再叫你。状态码 ${ref}。`);
    this.startBlockedRetry(snapshot, ref);
  }

  /** 卡住之后每 4 秒自己回读一次，接上了就继续，别让玩家当按键。 */
  private startBlockedRetry(snapshot: NormSnapshot, ref: string): void {
    if (this.blockedRetry) return;
    this.blockedRetries = 0;
    const tick = (): void => {
      this.blockedRetry = null;
      if (this.paused || this.stopSignal.signal.aborted || this.blockedRef !== ref) return;
      this.blockedRetries++;
      void this.bridge.refresh(this.stopSignal.signal, this.stateDeadline()).then((fresh) => {
        if (fresh.actions.length) {
          this.blockedRef = '';
          void this.event('sts-2.blocked', `接回来了：${screenName(fresh)}又有动作了，我接着打。`);
          this.queueState();
          return;
        }
        if (this.blockedRetries >= 5) {
          void this.event('sts-2.blocked', `还是读不到动作（已重试 ${this.blockedRetries} 次），这一屏得你点一下。状态码 ${ref}。`);
          return;
        }
        this.startBlockedRetry(snapshot, ref);
      }).catch(() => {
        if (this.blockedRetries < 5) this.startBlockedRetry(snapshot, ref);
      });
    };
    this.blockedRetry = setTimeout(tick, this.opts.cfg.blockedRetryMs);
    this.blockedRetry.unref?.();
  }

  private saveFacts(): SaveFacts | null {
    if (!this.opts.cfg.readSave) return null;
    try { return this.save.read(); } catch { return null; }
  }

  /* ───────────────────────── 注记：意图 / 指令 / 求解器 ───────────────────────── */

  /** 在局面文本尾部补上"她要记住的东西"：构筑意图、玩家临时指令、求解器建议。 */
  private decorate(text: string, snapshot: NormSnapshot | null): string {
    const lines: string[] = [];
    const intent = this.intentLine();
    if (intent) lines.push(intent);
    const steer = this.steerLine(snapshot);
    if (steer) lines.push(steer);
    if (snapshot) {
      const advice = this.advice.get(stateRef(snapshot));
      if (advice) lines.push(advice);
    }
    return lines.length ? `${text}\n${lines.join('\n')}` : text;
  }

  private intentLine(): string | null {
    const intent = this.intent.load();
    if (!intent.note) return null;
    return `构筑意图（rev ${intent.rev}，玩家设定）：${intent.note}`;
  }

  /** 指令按范围自然过期；不靠定时器，按状态码/层数/界面判。 */
  private steerLine(snapshot: NormSnapshot | null): string | null {
    const directive = this.directive;
    if (!directive) return null;
    const scope = { next: '就下一步', floor: '本层结束前', screen: '本界面内', manual: '直到撤销' }[directive.until];

    if (snapshot) {
      if (directive.until === 'floor' && directive.floor !== null && snapshot.game.floor !== null
        && snapshot.game.floor !== directive.floor) {
        this.directive = null;
        return null;
      }
      if (directive.until === 'screen' && directive.screen !== snapshot.screen) {
        this.directive = null;
        return null;
      }
      const ref = stateRef(snapshot);
      if (directive.until === 'next' && directive.refs.size > 0 && !directive.refs.has(ref)) {
        this.directive = null;
        return null;
      }
      directive.refs.add(ref);
      if (directive.refs.size > 10) {
        this.directive = null;
        return `玩家指令（${scope}）：${directive.text}`;
      }
    }
    return `玩家指令（${scope}）：${directive.text}`;
  }

  /**
   * 提前把求解器的计划取回来，等她真正要看局面时已经有注记可贴（不阻塞）。
   * 求解器一次搜索是 0.7 秒的满负载，**绝不能每帧都问**（真机上把游戏拖卡过），
   * 所以：观战/接管期间一律不问，并且两次之间至少隔 2 秒；平时也只在真的要推局面时问。
   */
  private prefetchAdvice(snapshot: NormSnapshot): void {
    if (!this.opts.cfg.solver || snapshot.screen !== 'combat' || !snapshot.actions.length) return;
    if (this.state !== 'online') return;   // 启动时那一帧还不算数
    // 这一帧要交给求解器自己打：注记用不上，别抢在接管前面多要一份计划。
    if (this.autoplay || this.paused || this.canAutoplay(snapshot)) return;
    if (Date.now() - this.lastPrefetchAt < Math.max(0, this.opts.cfg.solverPrefetchMs ?? 2000)) return;
    const ref = stateRef(snapshot);
    if (this.advice.has(ref) || this.adviceInflight.has(ref)) return;
    this.lastPrefetchAt = Date.now();
    this.adviceInflight.add(ref);
    void this.solver.plan(this.stopSignal.signal)
      .then((plan) => {
        const line = plan ? adviceLine(snapshot, plan, this.opts.cfg.solverMinConfidence) : null;
        this.advice.set(ref, line);
        if (this.advice.size > 32) {
          const oldest = this.advice.keys().next();
          if (!oldest.done) this.advice.delete(oldest.value);
        }
      })
      .catch(() => { this.advice.set(ref, null); })
      .finally(() => { this.adviceInflight.delete(ref); });
  }

  /** 回档/换局/对不上：分三种处理，只有前三种才作废旧判断。 */
  private applyVerdict(verdict: Verdict, snapshot: NormSnapshot): void {
    if (verdict.kind === 'drift') {
      if (Date.now() - this.lastDriftAt < this.opts.cfg.driftNoticeMs) return;
      this.lastDriftAt = Date.now();
      void this.event('sts-2.drift', `局面和我记的对不上（${verdict.reason}），还没到回档；按现在这个来。`);
      return;
    }
    this.generation = verdict.generation;
    this.resetRunState();
    if (verdict.kind === 'new-run') {
      // 构筑意图和临时指令都是"这一局"的，换局就作废。
      this.intent.clear(snapshot.sessionId, nowIso(this.opts.timezone));
      this.directive = null;
      this.advice.clear();
    }
    const tail = verdict.kind === 'new-run'
      ? '之前的路线、牌序、目标全部作废。'
      : '之前的计划作废，按现在的局面重新看。';
    void this.event('sts-2.rollback', `${verdict.reason}。${tail}`);
  }

  /** 换局/读档后清掉所有跟"这一局"绑定的记忆。 */
  private resetRunState(): void {
    this.failures.clear();
    this.rejects.clear();
    this.autoUsed.clear();
    this.escalated.clear();
    this.settleRetries.clear();
    this.blockedRef = '';
    this.presented = null;
    this.blockedRetries = 0;
    this.lastObserveRef = '';
    this.receiptRef = null;
    this.autoplayGaveUpRef = '';
    this.clearCoopHold();
    this.coopHoldDone = false;
  }

  private trimFailures(): void {
    if (this.failures.size <= 256) return;
    let drop = 128;
    for (const key of this.failures) { this.failures.delete(key); if (--drop <= 0) break; }
  }

  /** 同一个局面连着被拒：能无损推进就替她推一次，否则停手说清楚。 */
  private maybeEscalate(ref: string, snapshot: NormSnapshot | null): void {
    if (this.escalated.has(ref)) return;
    const times = this.rejects.get(ref) ?? 0;
    if (times < this.opts.cfg.maxRejectsBeforeStop) return;
    this.escalated.add(ref);

    const latest = this.bridge.snapshot ?? snapshot;
    if (latest && this.opts.cfg.autoAdvance && !this.autoUsed.has(ref)) {
      const auto = pickAutoAction(latest, 'recovery');
      if (auto) { void this.runAuto(latest, auto); return; }
    }
    void this.event('sts-2.blocked',
      `同一个操作连着 ${times} 次没被接受，我停在这儿，你看一眼这一屏。状态码 ${ref}。`
      + (latest ? `\n${renderSnapshot(latest)}` : ''));
  }

  /** 替她点一次（不经过模型）：只用于"没得选"的推进。 */
  private async runAuto(snapshot: NormSnapshot, decision: AutoDecision): Promise<void> {
    const ref = stateRef(snapshot);
    if (this.busy || this.autoUsed.has(ref)) return;
    const latest = this.bridge.snapshot;
    if (!latest || stateRef(latest) !== ref) return;
    // 桥的空帧会抖：真动手之前再读一次，局面变了或这一屏其实还有选择就不动。
    const fresh = await this.bridge.refresh(this.stopSignal.signal, this.stateDeadline()).catch(() => null);
    if (fresh) {
      if (stateRef(fresh) !== ref) return;
      const stillThere = fresh.actions.some((action) => action.command['action'] === decision.action.command['action']
        && Number(action.command['card_index'] ?? -1) === Number(decision.action.command['card_index'] ?? -1)
        && Number(action.command['target_index'] ?? -1) === Number(decision.action.command['target_index'] ?? -1));
      if (!stillThere) return;
    }

    this.autoUsed.add(ref);
    this.autoCount++;
    this.lastAutoAt = Date.now();
    this.busy = true;
    try {
      const receipt = await this.bridge.act(decision.action.command, this.stopSignal.signal, this.opts.cfg.actionTimeoutMs);
      if (receipt.snapshot) {
        this.presented = receipt.snapshot;
        this.noteSnapshot(receipt.snapshot, false);
      }
      void this.event('sts-2.auto', `这一屏只剩「${decision.why}」，我替你点了。`);
      if (receipt.outcome === 'executed') {
        this.decisionAfterTurn = true;
      } else {
        this.failures.add(`${ref}:${decision.action.n}`);
        void this.block(receipt.snapshot ?? latest, ref);
      }
    } catch (error) {
      void this.event('sts-2.auto', `想替你点「${decision.why}」，没点成：${short(String((error as Error)?.message ?? error))}。`);
    } finally {
      this.busy = false;
      this.queueState();
    }
  }

  /**
   * 多选屏一次提交（"选择 N 张牌移除"这类）。
   * 桥的选牌是"一次点一张"、点同一张会反选：分两次单点会互相抵消，
   * 真机上她就这么卡住了（同一张牌点了四次，界面一动没动）。
   * 所以把要选的全部并行发出去，等它们结算完再看局面。
   */
  private async playSelects(state: string, steps: Record<string, unknown>[], ctx: ToolCallContext): Promise<ToolOutcome> {
    const latest = this.bridge.snapshot;
    if (!latest || stateRef(latest) !== state || latest.actions.length === 0) {
      const fresh = await this.bridge.refresh(ctx.signal, this.stateDeadline());
      return { text: `未执行：状态码已过期，用下面的编号。\n${renderSnapshot(fresh)}`, failed: true };
    }
    const need = selectionNeed(object(latest.blocks['selection']));
    const picked = steps
      .map((step) => latest.actions.find((action) => action.n === Number(step['select'])))
      .filter((action): action is NormAction => Boolean(action));
    if (picked.length !== steps.length) {
      return { text: `未执行：给的编号里有的这一屏没有。\n${renderSnapshot(latest)}`, failed: true };
    }
    if (picked.some((action) => String(action.command['action']) !== 'select_deck_card')) {
      return { text: '未执行：这一屏不是"选牌"，{select} 只用在选牌屏。', failed: true };
    }
    if (need > 1 && picked.length !== need) {
      return { text: `未执行：这一屏要一次选满 ${need} 张（你给了 ${picked.length} 个）。一张一张点会互相抵消。`, failed: true };
    }
    const slots = new Set(picked.map((action) => String(action.command['option_index'])));
    if (slots.size !== picked.length) {
      return { text: '未执行：同一个选项点了两次会被反选，每个选项只留一个。', failed: true };
    }

    const started = Date.now();
    let receipts: NormReceipt[] = [];
    this.busy = true;
    try {
      receipts = await Promise.all(picked.map((action) => this.bridge.act(action.command, ctx.signal, this.opts.cfg.actionTimeoutMs)));
    } catch (error) {
      if (error instanceof BridgeError && error.status && error.status >= 500) {
        return {
          text: `桥内部报错了（HTTP ${error.status}，游戏 mod 异常）：${short(String(error.message))}。`
            + '这次提交没落地，别再重复；这一屏多半要你亲手点一下。',
          failed: true,
        };
      }
      throw error;
    } finally {
      this.busy = false;
    }
    const after = await this.bridge.refresh(ctx.signal, this.stateDeadline()).catch(() => null);
    const snapshot = after ?? this.bridge.snapshot ?? latest;
    this.presented = snapshot;
    this.noteSnapshot(snapshot, false);
    this.decisionAfterTurn = true;
    const ok = receipts.filter((receipt) => receipt.outcome === 'executed').length;
    const seconds = Math.round((Date.now() - started) / 100) / 10;
    const head = `已提交 ${picked.length} 个选择（${ok} 个结算完成，用时 ${seconds} 秒）`;
    const tail = snapshot.screen === 'selection' ? '。界面还没动：按下面这份重新提交。' : '。';
    return { text: this.decorate(`${head}${tail}\n${renderSnapshot(snapshot, false, latest)}`, snapshot) };
  }

  /* ───────────────────────── 战斗接管：求解器自己打完 ───────────────────────── */

  /** 同一个局面短时间被反复观察：只回一句话，不重读、不渲染。 */
  private throttleObserve(): boolean {
    const snapshot = this.bridge.snapshot;
    if (!snapshot) return false;
    const limit = this.opts.cfg.observeThrottleMs;
    if (!limit || limit <= 0) return false;
    // 事件流不一定每帧都推：缓存太旧就老实重读一次。
    // 真机上吃过这个亏——游戏已经进战斗，她还拿着上一条地图帧回"局面没变"。
    if (Date.now() - this.lastStateAt > limit) return false;
    const ref = stateRef(snapshot);
    if (this.receiptRef === ref) return true;
    return this.lastObserveRef === ref && Date.now() - this.lastObserveAt < limit;
  }

  private unchangedText(): string {
    this.observeThrottled++;
    const snapshot = this.bridge.snapshot;
    const ref = snapshot ? stateRef(snapshot) : this.lastObserveRef || '——';
    return `局面没变（${ref}），编号沿用上一条回执。直接给动作。`;
  }

  /** 现在这一帧该不该由求解器接管。 */
  private canAutoplay(snapshot: NormSnapshot | null): boolean {
    if (!snapshot) return false;
    // 只认总开关：注记（solver）是另一回事，关掉注记也可以让它代打。
    if (!this.opts.cfg.solverAutoplay) return false;
    if (this.autoplay || this.busy || this.paused || this.awaiting) return false;
    if (!this.host || this.stopSignal.signal.aborted || this.state !== 'online') return false;
    if (snapshot.screen !== 'combat' || !snapshot.actions.length) return false;
    // 这一帧已经交回她了：同一帧别再抢回来，等局面变了再说。
    return this.autoplayGaveUpRef !== stateRef(snapshot);
  }

  /**
   * 战斗里由求解器一步步打完：期间不推局面、不产生模型轮。
   * 只在需要决策时交回——算不出、编号对不上、血太低、会死、步数到顶，或者已经离开战斗。
   */
  private async runAutoplay(seed: NormSnapshot): Promise<void> {
    if (this.autoplay || !this.canAutoplay(seed)) return;
    this.autoplay = true;
    this.autoplaySteps = 0;
    // 接管期间不该再有"没动静"的提醒：那是给模型的信号，会把模型叫醒。
    this.clearIdle();
    // 排队中的局面推送作废：接管了就不必再把她叫起来看这一帧。
    this.eventTicket++;
    this.eventPending = false;
    const startHp = seed.game.hp;
    let stop: AutoplayStop = 'leave';
    let refusedRef = '';
    let prev = seed;
    let misses = 0;

    try {
      for (;;) {
        if (this.stopSignal.signal.aborted || this.paused || !this.host) { stop = 'stopped'; break; }
        if (this.autoplaySteps >= Math.max(1, this.opts.cfg.solverAutoplayMaxSteps)) { stop = 'steps'; break; }
        // 求解器刚在 boss 上算不动（冷却中）：这一场直接交回模型，别继续钉着游戏主线程。
        if (this.solver.cooling) { stop = 'no-plan'; break; }
        const snapshot = this.bridge.snapshot;
        if (!snapshot) { stop = 'offline'; break; }
        if (snapshot.screen !== 'combat') { stop = 'leave'; break; }
        // 永远不替她结束会死的回合：这一帧整个交回模型。
        if (snapshot.combat?.endTurnWillKill) { stop = 'lethal'; break; }
        // 敌方回合/动画会短暂没有动作：在接管里等它回来，不把模型叫醒。
        if (!snapshot.actions.length) {
          if (!(await this.waitForActions(this.opts.cfg.actionTimeoutMs))) { stop = 'settling'; break; }
          continue;
        }
        if (this.hpBelowStop(snapshot)) { stop = 'hp'; break; }

        // 求解器这一帧给不出能用的第一步：先等它一次，别立刻把模型叫醒。
        // 真机上这一步被当成交回，结果每打一步就多一次完整调用。
        const plan: SolverPlan | null = await this.solver.plan(this.stopSignal.signal);
        const blocked = plan ? planBlock(plan, this.opts.cfg.solverMinConfidence) : 'no-plan';
        const n = plan && !blocked ? matchAction(snapshot, plan) : null;
        const action = n === null ? undefined : snapshot.actions.find((entry) => entry.n === n);
        if (!plan || blocked || !action) {
          const why: AutoplayStop = !plan ? 'no-plan' : blocked ?? 'no-match';
          if (misses >= (why === 'no-plan' ? 2 : 1)) { stop = why; break; }
          misses++;
          await sleep(400, undefined, { signal: this.stopSignal.signal }).catch(() => {});
          await this.bridge.refresh(this.stopSignal.signal, this.stateDeadline()).catch(() => {});
          continue;
        }
        misses = 0;
        if (action.command['action'] === 'end_turn' && snapshot.combat?.endTurnWillKill) { stop = 'lethal'; break; }
        // 手里还有能打的牌、能量也没花完，求解器却要结束回合——这一手交回模型，
        // 别替她把还能打的回合丢掉（真机现场：2 费 + 一手牌直接结束回合）。
        if (action.command['action'] === 'end_turn' && hasCardsToPlay(snapshot)) { stop = 'cards-left'; break; }

        const ref = stateRef(snapshot);
        let receipt: NormReceipt | null = null;
        this.busy = true;
        try {
          receipt = await this.bridge.act(action.command, this.stopSignal.signal, this.opts.cfg.actionTimeoutMs);
          this.lastActionAt = Date.now();
        } catch {
          receipt = null;
        } finally {
          this.busy = false;
        }
        if (receipt?.outcome !== 'executed') {
          // 被拒/出错：先读一份新局面。局面变了就接着打（多半只是我们慢了一帧）；
          // 同一帧连着两次打不出去，才算求解器和桥在互相顶着。
          const fresh = await this.bridge.refresh(this.stopSignal.signal, this.stateDeadline()).catch(() => null);
          if ((fresh ? stateRef(fresh) : ref) === ref) {
            if (refusedRef === ref) { stop = 'refused'; break; }
            refusedRef = ref;
          }
          continue;
        }
        refusedRef = '';
        this.autoplaySteps++;
        this.decisionAfterTurn = true;
        const after = receipt.snapshot ?? this.bridge.snapshot;
        if (after) {
          // 打完一间夸一句、挨了一下哼一声：概率 + 冷却压着，不会刷屏。
          this.maybeChatter(snapshot, after);
          prev = after;
        }
      }
    } finally {
      const steps = this.autoplaySteps;
      this.autoplaySteps = 0;
      this.autoplay = false;
      const latest = this.bridge.snapshot;
      // 还在战斗里就记下这一帧：别让下面的收尾动作又把它抢回来。
      this.autoplayGaveUpRef = stop === 'leave' || !latest ? '' : stateRef(latest);
      if (latest) this.noteSnapshot(latest, false);
      // 收尾这一帧才从战斗里出来时，正好夸一句（连贯的"打过一间"）。
      if (stop === 'leave' && latest) this.maybeChatter(prev, latest);
      this.lastAutoplayStop = stop;
      this.lastAutoplayAt = Date.now();
      // 交回模型：下一帧必须重新推一次，哪怕状态码和之前一样。
      this.presented = null;
      // 界面还在结算：这会儿叫醒她也没有状态码可用，等下一帧有动作再推。
      if (stop !== 'settling') {
        if (steps > 0 && this.opts.cfg.solverAutoplaySummary) {
          const body = latest && latest.actions.length
            ? `${autoplaySummary(stop, steps, startHp, latest)}\n${renderSnapshot(latest)}`
            : autoplaySummary(stop, steps, startHp, latest);
          void this.event('sts-2.auto', body);
        }
        this.queueState();
      }
    }
  }

  /** 等桥重新给出动作（敌方回合、动画期间会短暂空一片）；超时就交回模型。 */
  private async waitForActions(limitMs: number): Promise<boolean> {
    // 这里等的是"敌方回合/动画结束"，不是动作提交：用 combatGraceMs 封顶，
    // 并且主动拉 /state——这一段 SSE 本来就容易断，只等推送会干等 30 秒。
    const deadline = Date.now() + Math.max(1000, Math.min(limitMs, this.opts.cfg.combatGraceMs));
    let lastPull = 0;
    while (Date.now() < deadline) {
      if (this.stopSignal.signal.aborted || this.paused || !this.host) return false;
      await sleep(120, undefined, { signal: this.stopSignal.signal }).catch(() => {});
      const now = Date.now();
      // 桥正卡着：别再拉，等它自己回；拉也只会让它更慢。
      if (now - lastPull >= 600 && this.bridge.health !== 'stuck') {
        lastPull = now;
        await this.bridge.refresh(this.stopSignal.signal, this.stateDeadline()).catch(() => {});
      }
      const snapshot = this.bridge.snapshot;
      if (!snapshot) continue;
      if (snapshot.screen !== 'combat') return false;
      if (snapshot.actions.length) return true;
    }
    return false;
  }

  /** 生命低于配置线就不再替她打（残局交给模型）。 */
  private hpBelowStop(snapshot: NormSnapshot): boolean {
    const hp = snapshot.game.hp;
    const maxHp = snapshot.game.maxHp;
    const floor = this.opts.cfg.solverAutoplayStopHpPct;
    if (hp === null || !maxHp || maxHp <= 0 || floor <= 0) return false;
    return (hp / maxHp) * 100 < floor;
  }

  /* ───────────────────────── 没动静 ───────────────────────── */

  /** 游戏在等输入、她却没动作：先提醒一次，再一个间隔后兜底或停住。 */
  private armIdle(stage: 1 | 2): void {
    if (!this.opts.cfg.idleNudgeMs || this.paused || !this.host) return;
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.paused || this.busy || !this.host) return;
      // 求解器正在替她打：这不是"她没动静"，别叫醒模型、也别停手。
      if (this.autoplay) return;
      const snapshot = this.bridge.snapshot;
      if (!snapshot) return;
      // 多人地图还压着：这不是"她没动静"，是我们在等队友投票，别催。
      if (this.holdCoopRoute(snapshot)) { this.armIdle(stage); return; }
      const ref = stateRef(snapshot);
      if (stage === 1) {
        void this.event('sts-2.decision', `游戏在等你决定（状态码 ${ref}）。有编号就直接动手，别只观察。`);
        this.armIdle(2);
        return;
      }
      if (this.opts.cfg.autoAdvance && !this.autoUsed.has(ref)) {
        const auto = pickAutoAction(snapshot, 'recovery');
        if (auto) { void this.runAuto(snapshot, auto); return; }
      }
      this.paused = true;
      this.pausedReason = AUTO_PAUSE_REASON;
      void this.event('sts-2.blocked', `她两轮没动静，我先停住，等你发话（状态码 ${ref}）。`);
    }, this.opts.cfg.idleNudgeMs);
    this.idleTimer.unref?.();
  }

  private clearIdle(): void {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
  }

  /* ───────────────────────── 偶尔说一句 ───────────────────────── */

  /** 单步 do 之后提醒她改用批处理：一次 play 顶三四次 do。 */
  private batchHint(snapshot: NormSnapshot | null): string {
    if (!snapshot?.combat) return '';
    const cards = new Set<number>();
    for (const action of snapshot.actions) {
      if (action.kind !== 'play') continue;
      const index = Number(pick(action.command, 'card_index'));
      if (Number.isFinite(index)) cards.add(index);
    }
    if (!cards.size) return '';
    return `\n（本回合还能打 ${cards.size} 张；用 sts2_play 一次提交，能省一整轮。）`;
  }

  /** 闲话出声：优先直连气泡；没有这个通道才退回 murmur 事件。 */
  private say(text: string): void {
    if (this.opts.cfg.chatterDelivery === 'model') {
      void this.event('sts-2.murmur', text);
      return;
    }
    const host = this.host as SpeakHost | null;
    if (host && typeof host.speak === 'function') {
      const suffix = this.opts.cfg.chatterSuffix?.trim() ?? '';
      const line = suffix ? text.replace(/[。！？!?…]+$/u, '') + suffix : text;
      const ok = host.speak(line, { source: 'sts-2', ttlMs: 2500 });
      if (!ok) this.host?.log.debug?.('sts-2.chatter', '桌宠没连上，这句丢了');
      return;
    }
    // 旧 Core 没有 speak 通道：退回事件，让模型替她说。
    void this.event('sts-2.murmur', text);
  }

  private maybeChatter(before: NormSnapshot, after: NormSnapshot): void {
    if (this.opts.cfg.chatter === 'off') return;
    const scale = this.opts.cfg.chatter === 'normal' ? 1.5 : 1;
    const winChance = Math.min(1, (this.opts.cfg.chatterWinChance ?? 0.35) * scale);
    const hurtChance = Math.min(1, (this.opts.cfg.chatterHurtChance ?? 0.3) * scale);
    const cooldownOk = Date.now() - this.lastChatterAt >= this.opts.cfg.chatterCooldownMs;
    const hit = pickChatter({
      before, after, rng: Math.random, cooldownOk, winChance, hurtChance,
      mode: this.paused ? 'watch' : 'self',
      book: this.chatterLines.get(), lastText: this.lastChatterText,
    });
    if (!hit) {
      // 该说却没说（概率/冷却压掉了）也留一行：真机上要靠它分清"没触发"和"没出声"。
      if (isChatterMoment(before, after)) {
        this.host?.log.debug?.('sts-2.chatter',
          `没说（冷却${cooldownOk ? '已过' : '中'}，胜率 ${winChance.toFixed(2)} / 挨打 ${hurtChance.toFixed(2)}）`);
      }
      return;
    }
    this.lastChatterAt = Date.now();
    this.chatterCount++;
    this.lastChatterText = hit.text;
    this.host?.log.debug?.('sts-2.chatter', `说了：${hit.mode}/${hit.kind}/${hit.tier} ${hit.text}`);
    this.say(hit.text);
  }

  private async event(type: string, text: string): Promise<void> {
    try {
      await this.host?.pushEvent({
        type, source: 'sts-2', senderKey: 'sts-2', ts: nowIso(this.opts.timezone), text,
      }, { trigger: 'flush' });
    } catch (error) {
      this.host?.log.warn('sts-2.event', String(error));
    }
  }
}

/** 多人局：mode 标了 coop、run.players 里不止一个玩家，或者地图投票里有别人。 */
function isCoopSnapshot(snapshot: NormSnapshot): boolean {
  if (snapshot.mode === 'coop-host' || snapshot.mode === 'coop-client') return true;
  const players = list(pick(
    snapshot.raw,
    'run.players', 'data.run.players',
    'multiplayer.players', 'data.multiplayer.players',
    'multiplayerLobby.players', 'data.multiplayerLobby.players',
  ));
  if (players.length > 1) return true;
  // 真机上 mod 也可能把 session.mode 报成 singleplayer：地图投票里出现别的玩家，就算多人局。
  // 少了这一条，多人等待在那种局里根本不生效（她照样第一个点）。
  return list(pick(object(snapshot.blocks['map']), 'playerVotes', 'player_votes'))
    .some((vote) => !bool(pick(vote, 'isLocal', 'is_local')));
}

/** 读局面超时 ≠ 断线：大后期 mod 排队几十秒是常事。 */
function isTimeout(error: unknown): error is BridgeError {
  return error instanceof BridgeError && error.code === 'timeout';
}

/** 多选屏的固定提示：单点会互相抵消，要一次提交。 */
function selectHint(snapshot: NormSnapshot): string | null {
  if (snapshot.screen !== 'selection') return null;
  const need = selectionNeed(object(snapshot.blocks['selection']));
  if (need < 2) return null;
  const picks = Array.from({ length: need }, (_, index) => `{select:${index + 1}}`).join(',');
  return `\n（这一屏要一次选满 ${need} 张：sts2_play({state, steps:[${picks}]})；一张一张点会互相抵消。）`;
}

/** 多人地图：队友（非本地玩家）已经投了票没有。 */
function coopOthersVoted(snapshot: NormSnapshot): boolean {
  const map = object(snapshot.blocks['map']);
  for (const vote of list(pick(map, 'playerVotes', 'player_votes'))) {
    if (bool(pick(vote, 'isLocal', 'is_local'))) continue;
    if (pick(object(pick(vote, 'coord')), 'row') !== undefined) return true;
  }
  // 有的桥只给节点票数、不给 coord：把自己那一票扣掉再算，否则"我已经投了"会被当成队友投了。
  return list(pick(map, 'availableNodes', 'available_nodes')).some((node) => {
    const mine = bool(pick(node, 'hasLocalVote', 'has_local_vote')) ? 1 : 0;
    const voters = list(pick(node, 'votedPlayerIds', 'voted_player_ids')).length;
    return Math.max(voters, num(pick(node, 'voteCount', 'vote_count'), 0)) - mine > 0;
  });
}

/** 手里还有能打的牌、能量也还够：这时候结束回合就是把回合丢掉。 */
function hasCardsToPlay(snapshot: NormSnapshot): boolean {
  const energy = snapshot.combat?.energy ?? null;
  if (energy !== null && energy <= 0) return false;
  return snapshot.actions.some((action) => action.kind === 'play');
}

/** 这一帧是不是"本该说一句"的时机（用于诊断：分清没触发 vs 被概率压掉）。 */
function isChatterMoment(before: NormSnapshot, after: NormSnapshot): boolean {
  const won = before.screen === 'combat' && after.screen !== 'combat' && after.screen !== 'game-over';
  const hpBefore = before.game.hp;
  const hpAfter = after.game.hp;
  const hurt = before.screen === 'combat' && after.screen === 'combat'
    && hpBefore !== null && hpAfter !== null && hpAfter > 0 && hpBefore - hpAfter >= 5;
  return won || hurt;
}

/** 一场接管结束后的一句话：一条事件 = 一次模型调用，所以只说一次。 */
function autoplaySummary(stop: AutoplayStop, steps: number, startHp: number | null, latest: NormSnapshot | null): string {
  const hp = latest?.game.hp ?? null;
  const maxHp = latest?.game.maxHp ?? null;
  const bits: string[] = [];
  if (startHp !== null && hp !== null && startHp !== hp) {
    bits.push(startHp > hp ? `掉了 ${startHp - hp} 血` : `回了 ${hp - startHp} 血`);
  }
  if (hp !== null) bits.push(`剩 ${hp}/${maxHp ?? '?'}`);
  const tail = bits.length ? `（${bits.join('，')}）` : '';
  if (stop === 'leave') return `这场我用求解器打完了${tail}。`;
  return `求解器替我打了 ${steps} 步${tail}，剩下的交给你：${AUTOPLAY_STOP_TEXT[stop]}。`;
}

/** 「打击→敌0」这类给人看的步骤名。 */
function stepName(step: Record<string, unknown>): string {
  if (step['endTurn'] === true) return '结束回合';
  const card = typeof step['card'] === 'string' ? step['card'].trim() : '';
  const target = typeof step['target'] === 'number' ? `→敌${step['target']}` : '';
  return `${card || '?'}${target}`;
}

/**
 * 把「牌名 + 目标」解析成当前局面里的一个编号动作。
 * 用牌名而不是编号：打出一张牌之后手牌会重排，编号全作废。
 */
function pickStep(snapshot: NormSnapshot, step: Record<string, unknown>): NormAction | null {
  if (step['endTurn'] === true) {
    return snapshot.actions.find((action) => action.command['action'] === 'end_turn') ?? null;
  }
  const name = typeof step['card'] === 'string' ? step['card'].trim() : '';
  if (!name) return null;
  const target = typeof step['target'] === 'number' ? step['target'] as number : undefined;
  const hand = snapshot.combat?.hand ?? [];
  for (const action of snapshot.actions) {
    if (action.kind !== 'play') continue;
    const cardIndex = Number(action.command['card_index']);
    const card = hand.find((entry) => Number(pick(entry, 'index')) === cardIndex);
    if (!card) continue;
    const cardName = cleanText(pick(card, 'name', 'cardId'));
    if (cardName !== name && `${cardName}+` !== name) continue;
    if (target === undefined ? action.target !== undefined : action.target !== target) continue;
    return action;
  }
  return null;
}

/** 用 Steam 拉起游戏；非 Windows 直接说明。 */
function launchGame(): void {
  if (process.platform !== 'win32') throw new Error('自动启动只在 Windows 上实现了；请手动开游戏。');
  const child = spawn('cmd', ['/c', 'start', '', 'steam://rungameid/2868840'], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

function short(text: string): string {
  return text.replace(/\s+/g, ' ').slice(0, 160);
}