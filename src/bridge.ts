/**
 * 与游戏内 C# mod 的 HTTP/SSE 桥。
 * 只做传输与快照缓存：不判定"能不能动"，不接受编号——那是 World 的事。
 * 所有失败都转成 BridgeError.code，让上层能区分"没连上""状态过期""动作被拒"。
 */
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { normalizeReceipt, normalizeState, stateRef, unwrap, type Fields, type NormReceipt, type NormSnapshot } from './protocol.ts';

export type BridgeErrorCode = 'offline' | 'http' | 'timeout' | 'protocol';

export class BridgeError extends Error {
  constructor(
    readonly code: BridgeErrorCode,
    message: string,
    readonly status?: number,
    /** 桥的原始回包：4xx 的 body 里通常有 code/details，被判成"被拒"时要靠它。 */
    readonly body?: string,
  ) {
    super(message);
    this.name = 'BridgeError';
  }
}

export interface BridgeOptions {
  baseUrl: string;
  /** 可选 Bearer；桥没开鉴权时留空。 */
  token?: string;
  statePath?: string;
  actionPath?: string;
  capturePath?: string;
  eventPath?: string;
  pollIntervalMs?: number;
  stateTimeoutMs?: number;
  actionTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function trimBase(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(trimmed)) throw new BridgeError('protocol', `桥地址要以 http:// 开头：${baseUrl}`);
  return trimmed;
}

function signalOf(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return { signal: timeout, dispose: () => {} };
  return { signal: AbortSignal.any([signal, timeout]), dispose: () => {} };
}

export class Sts2Bridge extends EventEmitter {
  private readonly opts: Required<Omit<BridgeOptions, 'token' | 'fetchImpl'>> & { token?: string; fetchImpl: typeof fetch };
  private watching: AbortController | null = null;
  /** 已经挂过 close() 的生命周期信号，避免每次 watch 都叠一个监听器。 */
  private boundTo: AbortSignal | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private lastRef = '';
  private sseHealthy = false;
  snapshot: NormSnapshot | null = null;
  /** 正在飞的那次 /state：桥一卡，我们就别再叠请求（真机上堆到过 190 秒）。 */
  private inflight: Promise<NormSnapshot> | null = null;
  /** 最近一次 /state 花了多久、连续超时几次。 */
  lastLatencyMs = 0;
  private slowStreak = 0;
  /** 桥卡成什么样了：'ok' | 'slow'（>stateTimeout 一半）| 'stuck'（连续超时）。 */
  get health(): 'ok' | 'slow' | 'stuck' { return this.slowStreak >= 2 ? 'stuck' : this.lastLatencyMs > 1000 ? 'slow' : 'ok'; }

  constructor(options: BridgeOptions) {
    super();
    this.opts = {
      baseUrl: trimBase(options.baseUrl),
      token: options.token || undefined,
      statePath: options.statePath || '/state',
      actionPath: options.actionPath || '/action',
      capturePath: options.capturePath || '/capture',
      eventPath: options.eventPath || '/events/stream',
      pollIntervalMs: options.pollIntervalMs ?? 1000,
      stateTimeoutMs: options.stateTimeoutMs ?? 5000,
      actionTimeoutMs: options.actionTimeoutMs ?? 30000,
      fetchImpl: options.fetchImpl ?? fetch,
    };
  }

  get connected(): boolean { return this.snapshot !== null; }
  get streaming(): boolean { return this.sseHealthy; }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { accept: 'application/json', ...(this.opts.token ? { authorization: `Bearer ${this.opts.token}` } : {}), ...extra };
  }

  private url(path: string): string { return `${this.opts.baseUrl}${path}`; }

  private async request(path: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
    const started = Date.now();
    const { signal: composed } = signalOf(signal, timeoutMs);
    let response: Response;
    try {
      response = await this.opts.fetchImpl(this.url(path), { ...init, signal: composed });
    } catch (error) {
      const name = (error as Error)?.name;
      const code = name === 'AbortError' || name === 'TimeoutError' ? 'timeout' : 'offline';
      this.emitMetric({ path, ms: Date.now() - started, code, timeoutMs });
      if (code === 'timeout') throw new BridgeError('timeout', `桥在 ${timeoutMs}ms 内没有回应（${path}）`);
      throw new BridgeError('offline', `连不上游戏桥 ${this.opts.baseUrl}：${(error as Error)?.message ?? error}`);
    }
    const ms = Date.now() - started;
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      this.emitMetric({ path, ms, status: response.status });
      throw new BridgeError(
        'http',
        `桥返回 ${response.status}（${path}）${body ? '：' + body.slice(0, 400) : ''}`,
        response.status,
        body,
      );
    }
    // 只记"值得看一眼"的：读局面超过 0.5 秒、动作超过 2 秒。给真机卡顿留证据，别写垃圾。
    if (ms >= (path === this.opts.statePath ? 500 : 2000)) this.emitMetric({ path, ms, status: response.status });
    return response;
  }

  /** 桥自己的体检记录：World 会把它落到 sts2-bridge.jsonl，卡的时候直接看这份。 */
  private emitMetric(metric: { path: string; ms: number; status?: number; code?: string; timeoutMs?: number }): void {
    try { this.emit('metric', metric); } catch { /* 没人听就算了 */ }
  }

  /** 读取并缓存最新局面。同一时刻只允许一次在飞：桥忙的时候重复压请求只会更慢。 */
  async refresh(signal?: AbortSignal, timeoutMs = this.opts.stateTimeoutMs): Promise<NormSnapshot> {
    if (this.inflight) return this.inflight;
    const started = Date.now();
    const task = this.fetchState(signal, timeoutMs);
    this.inflight = task;
    try {
      const snapshot = await task;
      this.slowStreak = 0;
      this.lastLatencyMs = Date.now() - started;
      return snapshot;
    } catch (error) {
      if (error instanceof BridgeError && error.code === 'timeout') this.slowStreak++;
      throw error;
    } finally {
      if (this.inflight === task) this.inflight = null;
    }
  }

  private async fetchState(signal: AbortSignal | undefined, timeoutMs: number): Promise<NormSnapshot> {
    const response = await this.request(this.opts.statePath, { method: 'GET', headers: this.headers() }, timeoutMs, signal);
    const payload: unknown = await response.json().catch(() => {
      throw new BridgeError('protocol', '桥的 /state 不是合法 JSON');
    });
    const snapshot = normalizeState(payload);
    this.commit(snapshot, 'refresh');
    return snapshot;
  }

  /** 提交一个动作；指令体原样交给桥。 */
  async act(command: Fields, signal?: AbortSignal, timeoutMs = this.opts.actionTimeoutMs): Promise<NormReceipt> {
    let response: Response;
    try {
      response = await this.request(this.opts.actionPath, {
        method: 'POST', headers: this.headers({ 'content-type': 'application/json' }), body: JSON.stringify(command),
      }, timeoutMs, signal);
    } catch (error) {
      // 桥用 4xx 回"这个动作现在不可用"（真机实测 409 invalid_action）：
      // 那不是传输故障，是一张被拒的回执，得让 World 按"未执行"处理。
      if (error instanceof BridgeError && error.status && error.body && error.status < 500) {
        const receipt = this.receiptOf(error.body);
        if (receipt) return receipt;
      }
      throw error;
    }
    const payload: unknown = await response.json().catch(() => ({}));
    const receipt = normalizeReceipt(payload, this.snapshot);
    if (receipt.snapshot) this.commit(receipt.snapshot, 'action');
    return receipt;
  }

  /** 4xx 的 body 若是桥的错误信封，就当回执用；否则返回 null 继续抛错。 */
  private receiptOf(body: string): NormReceipt | null {
    let payload: unknown;
    try { payload = JSON.parse(body); } catch { return null; }
    const node = payload !== null && typeof payload === 'object' ? payload as Fields : {};
    if (!('ok' in node) && !('error' in node)) return null;
    const receipt = normalizeReceipt(payload, this.snapshot);
    return receipt.outcome === 'unknown' && !receipt.code ? null : receipt;
  }

  /** 截图；桥不支持时返回 null（由上层给出说明，不编造画面）。 */
  async capture(signal?: AbortSignal, timeoutMs = 10000): Promise<{ bytes: Buffer; mime: string } | null> {
    let response: Response;
    try {
      response = await this.request(this.opts.capturePath, { method: 'GET', headers: this.headers() }, timeoutMs, signal);
    } catch (error) {
      if (error instanceof BridgeError && error.status === 404) return null;
      throw error;
    }
    const mime = response.headers.get('content-type') ?? 'image/png';
    if (mime.includes('json')) {
      const payload = await response.json().catch(() => ({})) as Fields;
      const base64 = typeof payload.base64 === 'string' ? payload.base64
        : typeof payload.image === 'string' ? payload.image : null;
      return base64 ? { bytes: Buffer.from(base64, 'base64'), mime: 'image/png' } : null;
    }
    return { bytes: Buffer.from(await response.arrayBuffer()), mime };
  }

  /**
   * 订阅局面变化：优先 SSE，退化为轮询。
   * 断线不抛错，只发 'disconnect'，由 World 决定要不要提示。
   */
  watch(signal: AbortSignal): void {
    // 已经有一条活的订阅就别再建：掐断旧循环会被判成"断线"，上层随即重连，
    // 重连又掐断……真机上这么来回刷过一百多次，两个事件灯一直闪。
    if (this.watching && !this.watching.signal.aborted) return;
    // 只停旧的订阅，不清缓存：调用方通常刚 refresh 过，清掉会把首帧吞掉。
    this.watching?.abort();
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    this.sseHealthy = false;
    this.watching = new AbortController();
    const stop = this.watching.signal;
    if (this.boundTo !== signal) {
      this.boundTo = signal;
      signal.addEventListener('abort', () => this.close(), { once: true });
    }
    void this.streamLoop(stop).catch(() => {});
  }

  close(): void {
    this.watching?.abort();
    this.watching = null;
    this.sseHealthy = false;
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    this.lastRef = '';
    this.snapshot = null;
  }

  private commit(snapshot: NormSnapshot, cause: 'refresh' | 'action' | 'stream' | 'poll'): void {
    const ref = stateRef(snapshot);
    const changed = ref !== this.lastRef;
    this.snapshot = snapshot;
    if (changed) { this.lastRef = ref; this.emit('snapshot', snapshot, cause); }
  }

  private async streamLoop(signal: AbortSignal): Promise<void> {
    let backoff = 500;
    while (!signal.aborted) {
      try {
        await this.streamOnce(signal);
        backoff = 500;
      } catch (error) {
        // 主动停掉的连接（换订阅、停 World）不是断线：不报事件、不再重连。
        if (signal.aborted) break;
        this.sseHealthy = false;
        this.emit('disconnect', error instanceof Error ? error : new Error(String(error)));
        this.startPolling(signal);
        await delay(backoff, undefined, { signal }).catch(() => {});
        if (signal.aborted) break;
        backoff = Math.min(backoff * 2, 5000);
      }
    }
  }

  private startPolling(signal: AbortSignal): void {
    if (this.pollTimer || signal.aborted) return;
    this.pollTimer = setInterval(() => {
      void this.refresh(signal).catch(() => {});
    }, this.opts.pollIntervalMs);
    this.pollTimer.unref?.();
  }

  /** 一条 SSE 连接，直到断开。 */
  private async streamOnce(signal: AbortSignal): Promise<void> {
    const response = await this.opts.fetchImpl(this.url(this.opts.eventPath), {
      method: 'GET', headers: this.headers({ accept: 'text/event-stream' }), signal,
    });
    if (!response.ok || !response.body) throw new BridgeError('http', `事件流不可用（${response.status}）`, response.status);
    this.sseHealthy = true;
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        // 服务端主动关流：按"断线"处理，走退避。直接 return 会在外层 while 里
        // 立刻重连，桥一关流就成了零延迟的死循环。
        if (done) throw new BridgeError('offline', '桥关掉了事件流');
        buffer += decoder.decode(value, { stream: true });
        let split: number;
        while ((split = buffer.indexOf('\n\n')) >= 0) {
          const chunk = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          this.ingestEvent(chunk);
        }
        if (buffer.length > 4 * 1024 * 1024) throw new BridgeError('protocol', '事件流单帧过大');
      }
    } finally {
      reader.releaseLock();
    }
  }

  private ingestEvent(chunk: string): void {
    const data = chunk.split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) return;
    let payload: unknown;
    try { payload = JSON.parse(data); } catch { return; }
    const node = payload as Fields;
    const kind = typeof node?.type === 'string' ? node.type : '';
    if (kind && /danmaku|ping|heartbeat|config/i.test(kind) && !('screen' in node) && !('game' in node)) return;
    // 连接时桥会先发一帧 stream_ready（只有 run_id/screen/turn，没有动作）。
    // 把它当局面会让 World 看到"战斗界面 0 个操作"，误报"这一屏她不会"。
    // 真局面一定带 available_actions，用它当闸门。
    if (!('available_actions' in unwrap(payload))) return;
    try {
      const snapshot = normalizeState(payload);
      this.commit(snapshot, 'stream');
    } catch (error) {
      this.emit('malformed', error);
    }
  }
}