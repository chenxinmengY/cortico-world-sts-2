/**
 * 假桥：回包形状与真机一致（NekoSpire protocolVersion 2026-03-11-v1）。
 * 初始状态直接取真机抓包（tests/fixtures/combat-t1.json），动作语义按 mod 的参数名实现：
 *   play_card{card_index,target_index} / end_turn / choose_event_option{option_index} / choose_map_node{option_index}
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Fields } from '../src/protocol.ts';
import { state as fixture } from './fixtures.ts';

export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

export class FakeBridge {
  /** 只存 data 本体；回包时再包一层 { ok, request_id, data }。 */
  state: Fields = structuredClone(fixture('combat-t1'));
  requests: Array<{ path: string; body: Fields }> = [];
  rejectAction = false;
  /** 用这个 HTTP 状态码回错误信封（真机实测 409 invalid_action）。 */
  rejectStatus: number | null = null;
  capture: Buffer | null = PNG;
  /** 求解器回包：null 表示这个桥没有 /solver/plan。 */
  solverPlan: unknown = null;
  /** 预先排好的计划：第 n 份对应"已经交了 n 个动作"的局面，同一局面反复问拿到同一份（像真机）。 */
  solverPlans: unknown[] = [];
  /** 前几次 /solver/plan 直接 404（真机上求解器偶尔来不及给计划）。 */
  solverFailures = 0;
  /** /action 直接回 500：真机上 mod 对认不出的界面抛 NullReferenceException。 */
  crashAction = false;
  /** /state 延迟多久再回（模拟大后期 mod 排队）。 */
  stateDelayMs = 0;
  /** /state 被请求过几次（断言"别叠请求"）。 */
  stateGets = 0;
  /** 一共被问过几次 /solver/plan（判断有没有乱问）。 */
  solverPlanRequests = 0;
  /** 出牌之后把生命改成这个值（模拟挨打）。 */
  hpAfterPlay: number | null = null;
  /** 结束回合后切到这份夹具（模拟一场战斗打赢）。null = 照原样停在战斗里。 */
  endTurnTo: string | null = null;
  /** 选牌屏要选几张、凑够之后切到哪一屏。 */
  selectionNeed = 2;
  selectionDoneTo = 'event-normal';
  /** 这一轮选牌屏上已经点过的选项（点同一张会反选，和真机一致）。 */
  selectionPicks = new Set<number>();
  /** 事件流被打开过几次：用来断言重连没有失控。 */
  streamOpens = 0;
  private server: Server | null = null;
  private streams: ServerResponse[] = [];
  private seq = 0;

  async listen(port = 0): Promise<string> {
    this.server = createServer((req, res) => { void this.handle(req, res); });
    await new Promise<void>((resolve) => this.server!.listen(port, '127.0.0.1', resolve));
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('fake bridge failed to bind');
    return `http://127.0.0.1:${address.port}`;
  }

  async close(): Promise<void> {
    for (const stream of this.streams) stream.destroy();
    this.streams = [];
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
    this.server = null;
  }

  async whenStreaming(timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.streams.length) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('事件流一直没连上');
  }

  push(state: Fields = this.state): void {
    const envelope = { ok: true, request_id: this.id(), data: state };
    for (const stream of this.streams) stream.write(`data: ${JSON.stringify(envelope)}\n\n`);
  }

  /** 发任意一帧，用来覆盖 stream_ready / 心跳这类非局面帧。 */
  pushRaw(payload: unknown): void {
    for (const stream of this.streams) stream.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  /** 模拟服务端主动关流。 */
  dropStreams(): void {
    for (const stream of this.streams) stream.destroy();
    this.streams = [];
  }

  private id(): string { return `req_test_${++this.seq}`; }

  /** 按"已经交了几个动作"给计划：队尾那份会被反复回放（同一局面重新求解，结果一样）。 */
  private nextPlan(): unknown {
    if (!this.solverPlans.length) return this.solverPlan;
    const index = Math.min(this.requests.length, this.solverPlans.length - 1);
    return this.solverPlans[index];
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && path === '/state') {
      this.stateGets++;
      if (this.stateDelayMs) await new Promise((resolve) => setTimeout(resolve, this.stateDelayMs));
      return this.json(res, 200, { ok: true, request_id: this.id(), data: this.state });
    }
    if (req.method === 'GET' && path === '/health') {
      return this.json(res, 200, {
        ok: true, request_id: this.id(),
        data: { service: 'nekospire', modVersion: '0.1.0', protocolVersion: '2026-03-11-v1', game_version: '0.111.0', status: 'ready' },
      });
    }
    if (req.method === 'GET' && path === '/actions/available') {
      return this.json(res, 200, { ok: true, request_id: this.id(), data: { screen: this.state.screen, actions: this.state.available_actions } });
    }
    if (req.method === 'GET' && path === '/solver/plan') {
      this.solverPlanRequests++;
      if (this.solverFailures > 0) {
        this.solverFailures--;
        return this.json(res, 404, { ok: false, error: { code: 'not_found', message: 'Route not found.' } });
      }
      const plan = this.nextPlan();
      if (!plan) return this.json(res, 404, { ok: false, error: { code: 'not_found', message: 'Route not found.' } });
      return this.json(res, 200, plan);
    }
    if (req.method === 'GET' && path === '/capture') {
      if (!this.capture) return this.json(res, 404, { ok: false, error: { code: 'not_found', message: 'no capture endpoint' } });
      res.writeHead(200, { 'content-type': 'image/png' });
      return void res.end(this.capture);
    }
    if (req.method === 'GET' && path === '/events/stream') {
      this.streamOpens++;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(': ok\n\n');
      this.streams.push(res);
      req.on('close', () => { this.streams = this.streams.filter((s) => s !== res); });
      return;
    }
    if (req.method === 'POST' && path === '/action') {
      const body = await this.body(req);
      this.requests.push({ path, body });
      if (this.crashAction) {
        return this.json(res, 500, {
          ok: false, request_id: this.id(),
          error: { code: 'internal_error', message: 'Unhandled server error.', details: null, retryable: false },
        });
      }
      if (this.rejectStatus) {
        return this.json(res, this.rejectStatus, {
          ok: false, request_id: this.id(),
          error: {
            code: 'invalid_action',
            message: 'Action is not available in the current state.',
            details: { action: body.action },
            retryable: false,
          },
        });
      }
      if (this.rejectAction) {
        return this.json(res, 200, { ok: false, request_id: this.id(), error: { code: 'invalid_target', message: 'Target or index is no longer valid.', details: null, retryable: false } });
      }
      const name = body.action;
      if (typeof name !== 'string' || !name) {
        return this.json(res, 200, { ok: false, request_id: this.id(), error: { code: 'invalid_request', message: 'Request body must contain an action field.', details: null, retryable: false } });
      }
      const available = (this.state.available_actions as unknown[]) ?? [];
      const known = available.some((entry) => (typeof entry === 'string' ? entry : (entry as Fields).name) === name);
      if (!known) {
        return this.json(res, 200, { ok: false, request_id: this.id(), error: { code: 'invalid_action', message: 'Action is not supported yet.', details: { action: name }, retryable: false } });
      }
      return this.json(res, 200, { ok: true, request_id: this.id(), data: this.apply(body) });
    }
    this.json(res, 404, { ok: false, error: { code: 'not_found', message: `unknown path ${path}` } });
  }

  /**
   * 回包形状对齐真机：`data = { action, status, stable, message, state }`。
   * 选牌屏（select_deck_card）一次只点一张，点同一张会反选；没凑够张数时
   * 真机回 `status: pending`，整张牌面的 state_version 都不变。
   */
  private apply(body: Fields): Fields {
    const name = String(body.action);
    if (name === 'select_deck_card') {
      const index = Number(body.option_index ?? -1);
      if (this.selectionPicks.has(index)) this.selectionPicks.delete(index);
      else this.selectionPicks.add(index);
      if (this.selectionPicks.size < this.selectionNeed) {
        return {
          action: name, status: 'pending', stable: false,
          message: 'Action queued but state is still transitioning.',
          state: structuredClone(this.state),
        };
      }
      this.selectionPicks.clear();
      const done = structuredClone(this.state);
      this.switchTo(this.selectionDoneTo, done);
      this.state = done;
      return { action: name, status: 'completed', stable: true, message: 'Action completed.', state: done };
    }
    const next = structuredClone(this.state);
    next.state_version = Number(next.state_version ?? 0) + 1;
    if (name === 'play_card') {
      const combat = (next.combat ?? {}) as Fields;
      const hand = (combat.hand ?? []) as Fields[];
      combat.hand = hand.filter((card) => card.index !== body.card_index);
      if (!(combat.hand as Fields[]).length) next.available_actions = ['end_turn'];
      if (this.hpAfterPlay !== null) {
        const run = (next.run ?? {}) as Fields;
        run.current_hp = this.hpAfterPlay;
        next.run = run;
        const player = (combat.player ?? {}) as Fields;
        player.current_hp = this.hpAfterPlay;
        combat.player = player;
      }
    } else if (name === 'end_turn') {
      const combat = (next.combat ?? {}) as Fields;
      next.turn = Number(next.turn ?? 0) + 1;
      combat.hand = [];
      next.available_actions = ['end_turn'];
      if (this.endTurnTo) this.switchTo(this.endTurnTo, next);
    } else if (name === 'choose_event_option' || name === 'choose_map_node') {
      this.switchTo('map-act0', next);
    }
    this.state = next;
    return { action: name, status: 'completed', stable: true, message: 'Action completed.', state: next };
  }

  /** 切到另一份真机抓包，保留 run_id 之外的旧字段由夹具决定。 */
  private switchTo(fixtureName: string, next: Fields): void {
    const target = structuredClone(fixture(fixtureName));
    for (const key of Object.keys(next)) if (!(key in target)) delete next[key];
    Object.assign(next, target);
    next.state_version = Number(next.state_version ?? 0) + 1;
  }

  private body(req: IncomingMessage): Promise<Fields> {
    return new Promise((resolve) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        try { resolve(JSON.parse(raw || '{}') as Fields); } catch { resolve({}); }
      });
    });
  }

  private json(res: ServerResponse, status: number, payload: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  }
}