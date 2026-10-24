import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolCallContext, ToolDef, WorldHost } from 'cortico/core/types.ts';
import { FakeBridge } from './fake-bridge.ts';
import { load, state as fixture } from './fixtures.ts';
import { STS2_DEFAULTS } from '../src/config.ts';
import { Sts2World } from '../src/world.ts';

/** 只记录事件的假宿主：pushDeferred 立刻消费 render，等价于一次 flush。 */
class FakeHost {
  events: Array<{ type: string; text: string }> = [];
  log = { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} };
  async pushEvent(event: any) { this.events.push({ type: event.type, text: event.text }); return event as any; }
  pushDeferred(spec: any) {
    const rendered = spec.render();
    if (rendered) this.events.push({ type: spec.type, text: typeof rendered === 'string' ? rendered : rendered.text });
  }
  of(type: string): string[] { return this.events.filter((e) => e.type === type).map((e) => e.text); }
}

const ctx = { role: 'tester', log: { warn: () => {} } } as unknown as ToolCallContext;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 会丢掉前几批 deferred 的宿主：等价于真机上"模型轮被一句语音抢占、批次作废"。 */
class DroppingHost extends FakeHost {
  drops = 1;
  override pushDeferred(spec: any) {
    if (this.drops > 0) { this.drops--; return; }
    return super.pushDeferred(spec);
  }
}

let bridge: FakeBridge | null = null;
let world: Sts2World | null = null;
let dataDir: string | null = null;

async function setup(options: Partial<typeof STS2_DEFAULTS> = {}, prepare?: (bridge: FakeBridge) => void) {
  bridge = new FakeBridge();
  prepare?.(bridge);
  const baseUrl = await bridge.listen();
  dataDir = mkdtempSync(join(tmpdir(), 'sts2-world-'));
  world = new Sts2World({
    cfg: { ...STS2_DEFAULTS, baseUrl, stateEventThrottleMs: 0, connectTimeoutMs: 3000, blockedGraceMs: 80, readSave: false, queueStateEvents: false, blockedRetryMs: 60, observeThrottleMs: 0, solverPrefetchMs: 0, exposeObserve: true, devTools: true, ...options },
    timezone: 'Asia/Shanghai',
    dataDir,
    token: '',
  });
  const host = new FakeHost();
  await world.start(host as unknown as WorldHost);
  await bridge.whenStreaming();
  return { bridge, world, host };
}

/** 求解器计划：真机形状（tests/fixtures/solver-combat.json）的最小版。 */
function solverPlan(steps: Record<string, unknown>[], override: Record<string, unknown> = {}) {
  return {
    ok: true,
    request_id: 'req_test_solver',
    data: {
      in_combat: true,
      turn: 1,
      line: [{ turn: 1, steps }],
      coverage: { exact: 4, inferred: 0, unsupported: 0, ignored: 0, potions: 0, risk: false },
      warnings: [],
      search_status: 'complete',
      confidence: 0.9,
      win_prob: 0.7,
      policy_explanation: '',
      ...override,
    },
  };
}

const playStep = (cardIndex: number, targetIndex: number | null = 0) =>
  ({ kind: 'play_card', card_index: cardIndex, card_name: '打击', target_index: targetIndex });
const endTurnStep = { kind: 'end_turn', card_index: null, card_name: '', target_index: null };

/** 多人局的地图帧：真机抓包改两个字段（mode + 第二个玩家），其余形状不动。 */
function coopMap(version = 1, vote?: { row: number; col: number }): Record<string, any> {
  const raw = structuredClone(fixture('map-act0')) as Record<string, any>;
  raw['session']['mode'] = 'coop';
  (raw['run']['players'] as any[]).push({ player_id: '2', slot_index: 1, is_local: false });
  raw['state_version'] = version;
  if (vote) {
    (raw['map']['player_votes'] as any[]).push({ player_id: '2', slot_index: 1, is_local: false, coord: vote });
    const node = (raw['map']['available_nodes'] as any[])
      .find((entry) => entry['row'] === vote.row && entry['col'] === vote.col);
    if (node) node['vote_count'] = 1;
  }
  return raw;
}

/** 等某一批动作全部落地（假桥是本地回环，通常几十毫秒）。 */
async function settled(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(20);
  }
}

function tool(world: Sts2World, name: string): ToolDef {
  const found = world.tools().find((entry) => entry.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

async function stateCode(world: Sts2World): Promise<string> {
  const observed = await tool(world, 'sts2_observe').handler({}, ctx);
  const text = typeof observed === 'string' ? observed : observed.text;
  const code = /\[StS2 ([0-9a-f]{12})/.exec(text)?.[1];
  if (!code) throw new Error('no state code in observation');
  return code;
}

afterEach(async () => {
  await world?.stop();
  await bridge?.close();
  world = null;
  bridge = null;
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  dataDir = null;
});

describe('Sts2World', () => {
  it('桥不可达时 start 也不抛错，之后自动接上（否则整个 Core 起不来）', async () => {
    const probe = new FakeBridge();
    const url = await probe.listen();
    const port = Number(new URL(url).port);
    await probe.close();

    const w = new Sts2World({
      cfg: { ...STS2_DEFAULTS, baseUrl: url, connectAttemptMs: 400, retryIntervalMs: 100, stateEventThrottleMs: 0 },
      timezone: 'Asia/Shanghai', dataDir: mkdtempSync(join(tmpdir(), 'sts2-world-')), token: '',
    });
    const host = new FakeHost();
    await expect(w.start(host as unknown as WorldHost)).resolves.toBeUndefined();
    expect(w.webUi?.('zh')?.lamps?.[0]?.state).toBe('error');

    bridge = new FakeBridge();
    await bridge.listen(port);
    world = w;
    await delay(500);
    expect(host.of('sts-2.state').length).toBeGreaterThan(0);
  });

  it('启动就推一份真局面', async () => {
    const { host } = await setup();
    const text = host.of('sts-2.state').at(-1);
    expect(text).toContain('出牌 2→敌0');
  });

  it('观察给的编号能直接出牌，参数名与桥一致', async () => {
    const { world: w, bridge: b } = await setup();
    const code = await stateCode(w);
    const result = await tool(w, 'sts2_do').handler({ state: code, action: 2 }, ctx);
    expect((result as { text: string }).text).toContain('已执行');
    expect(b.requests.at(-1)?.body).toEqual({ action: 'play_card', card_index: 1, target_index: 0 });
  });

  it('事件选项按 option_index 提交', async () => {
    const { world: w, bridge: b } = await setup();
    b.state = structuredClone(fixture('event-neow'));
    const code = await stateCode(w);
    const result = await tool(w, 'sts2_do').handler({ state: code, action: 1 }, ctx);
    expect((result as { text: string }).text).toContain('已执行');
    expect(b.requests.at(-1)?.body).toEqual({ action: 'choose_event_option', option_index: 0 });
  });

  it('过期状态码被拒，并附新状态', async () => {
    const { world: w } = await setup();
    const result = await tool(w, 'sts2_do').handler({ state: 'deadbeef0000', action: 1 }, ctx);
    expect((result as { text: string }).text).toContain('未执行：状态码已过期');
    expect((result as { failed?: boolean }).failed).toBe(true);
  });

  it('编号不存在时不瞎猜', async () => {
    const { world: w } = await setup();
    const code = await stateCode(w);
    const result = await tool(w, 'sts2_do').handler({ state: code, action: 99 }, ctx);
    expect((result as { text: string }).text).toContain('未执行：当前没有 99 号操作');
  });

  it('桥拒绝时给中文原因', async () => {
    const { world: w, bridge: b } = await setup();
    b.rejectAction = true;
    const code = await stateCode(w);
    const result = await tool(w, 'sts2_do').handler({ state: code, action: 2 }, ctx);
    expect((result as { text: string }).text).toContain('未执行：目标或编号已失效');
  });

  it('停手后不再推局面，恢复后接着推', async () => {
    const { world: w, host, bridge: b } = await setup();
    await tool(w, 'sts2_pause').handler({ reason: '玩家离开' }, ctx);
    const before = host.of('sts-2.state').length;
    const next = structuredClone(b.state);
    (next.run as Record<string, unknown>).current_hp = 55;
    next.state_version = 77;
    b.state = next;
    b.push(next);
    await delay(80);
    expect(host.of('sts-2.state').length).toBe(before);

    await tool(w, 'sts2_resume').handler({}, ctx);
    expect(host.of('sts-2.state').length).toBeGreaterThan(before);
  });

  it('空动作只在宽限期后算卡住，且只提醒一次', async () => {
    const { world: w, host, bridge: b } = await setup();
    const stuck = structuredClone(fixture('combat-t1'));
    stuck.screen = 'MYSTERY_SCREEN';
    stuck.available_actions = [];
    b.state = stuck;
    b.push(stuck);
    await delay(30);
    expect(host.of('sts-2.blocked')).toHaveLength(0);
    await delay(160);
    expect(host.of('sts-2.blocked')).toHaveLength(1);
    expect(host.of('sts-2.blocked')[0]).toContain('先试着自己接回来');
    b.push(stuck);
    await delay(160);
    expect(host.of('sts-2.blocked')).toHaveLength(1);
  });

  it('回档会作废旧判断', async () => {
    const { host, bridge: b } = await setup();
    const rolled = structuredClone(b.state);
    (rolled.run as Record<string, unknown>).floor = 1;
    rolled.state_version = 90;
    b.state = rolled;
    b.push(rolled);
    await delay(80);
    expect(host.of('sts-2.rollback').at(-1)).toContain('层级从 2 退回 1');
  });

  it('桥没有截图接口时明确失败', async () => {
    const { world: w, bridge: b } = await setup();
    b.capture = null;
    const result = await tool(w, 'sts2_capture').handler({}, ctx);
    expect((result as { failed?: boolean }).failed).toBe(true);
    expect((result as { text: string }).text).toContain('桥没有截图接口');
  });

  it('有截图时返回 PNG', async () => {
    const { world: w } = await setup();
    const result = await tool(w, 'sts2_capture').handler({}, ctx) as { blobs?: unknown[] };
    expect(result.blobs).toHaveLength(1);
  });

  it('排障工具给摘要和原始 payload', async () => {
    const { world: w } = await setup();
    const text = (await tool(w, 'sts2_probe').handler({}, ctx) as { text: string }).text;
    expect(text).toContain('归一化摘要');
    expect(text).toContain('原始 /state');
  });

  it('断流抖一下不吵人：短于 connectionQuietMs 的重连一个字都不发', async () => {
    const { world: w, host, bridge: b } = await setup({ retryIntervalMs: 100, connectionQuietMs: 3000 });
    b.dropStreams();
    await delay(1200);

    // 桥一两秒就接回来了：不发"断了"也不发"接上了"（每条都是一次模型调用）。
    expect(host.of('sts-2.connection')).toHaveLength(0);

    const observed = await tool(w, 'sts2_observe').handler({}, ctx) as { text: string };
    expect(observed.text).toContain('StS2');
  });

  it('真断久了说一句，接回来说一句，不刷屏', async () => {
    const probe = new FakeBridge();
    const url = await probe.listen();
    const port = Number(new URL(url).port);
    const w = new Sts2World({
      cfg: { ...STS2_DEFAULTS, baseUrl: url, stateEventThrottleMs: 0, connectTimeoutMs: 3000, readSave: false, queueStateEvents: false, connectionQuietMs: 300, retryIntervalMs: 200 },
      timezone: 'Asia/Shanghai', dataDir: mkdtempSync(join(tmpdir(), 'sts2-world-')), token: '',
    });
    const host = new FakeHost();
    world = w;
    await w.start(host as unknown as WorldHost);
    await probe.whenStreaming();
    expect(host.of('sts-2.connection')).toHaveLength(0);

    await probe.close();                       // 桥彻底没了
    await delay(900);
    expect(host.of('sts-2.connection').some((text) => text.includes('连接断了'))).toBe(true);

    bridge = new FakeBridge();
    await bridge.listen(port);                 // 桥回来了
    await delay(1200);
    expect(host.of('sts-2.connection').some((text) => text.includes('接回来了'))).toBe(true);
    expect(host.of('sts-2.connection').length).toBeLessThanOrEqual(2);
  });

  it('战斗里不替她结束回合', async () => {
    const { host, bridge: b } = await setup();
    const stuck = structuredClone(fixture('combat-no-playable'));
    b.state = stuck;
    b.push(stuck);
    await delay(350);

    expect(b.requests.filter((request) => request.body['action'] === 'end_turn')).toHaveLength(0);
    expect(host.of('sts-2.auto')).toHaveLength(0);
  });

  it('同一个编号失败过就不再重复提交', async () => {
    const { world: w, bridge: b } = await setup();
    b.rejectAction = true;
    const code = await stateCode(w);

    const first = await tool(w, 'sts2_do').handler({ state: code, action: 2 }, ctx) as { text: string };
    expect(first.text).toContain('未执行');
    const second = await tool(w, 'sts2_do').handler({ state: code, action: 2 }, ctx) as { text: string };
    expect(second.text).toContain('已经失败过');
    expect(b.requests).toHaveLength(1);
  });

  it('判成卡住之后会自己回读，接上了就继续（不需要玩家喊）', async () => {
    const { host, bridge: b } = await setup();
    const stuck = structuredClone(fixture('combat-t1'));
    stuck.screen = 'MYSTERY_SCREEN';
    stuck.available_actions = [];
    b.state = stuck;
    b.push(stuck);
    await delay(200);
    expect(host.of('sts-2.blocked').length).toBeGreaterThanOrEqual(1);

    // 桥自己恢复了：不推事件，只让 /state 能读到动作。
    b.state = structuredClone(fixture('combat-t1'));
    await delay(300);
    expect(host.of('sts-2.blocked').some((text) => text.includes('接回来了'))).toBe(true);
  });

  it('敌方回合的空动作不会被当成"她不会"', async () => {
    const { host, bridge: b } = await setup({ blockedGraceMs: 60, combatGraceMs: 80 });
    const empty = structuredClone(fixture('combat-empty-frame'));
    b.state = empty;
    b.push(empty);
    await delay(150);
    expect(host.of('sts-2.blocked')).toHaveLength(0);
    await delay(400);
    expect(host.of('sts-2.blocked').length).toBeGreaterThanOrEqual(1);
  });

  it('回执刚给过局面时，re-observe 只回一句话', async () => {
    const { world: w } = await setup();
    const code = await stateCode(w);
    await tool(w, 'sts2_do').handler({ state: code, action: 2 }, ctx);
    const again = await tool(w, 'sts2_observe').handler({}, ctx) as { text: string };
    expect(again.text).toContain('局面没变');
  });

  it('一次提交多步：两张牌加结束回合只占一轮', async () => {
    const { world: w, bridge: b } = await setup();
    const code = await stateCode(w);
    const result = await tool(w, 'sts2_play').handler({
      state: code,
      steps: [{ card: '打击', target: 0 }, { card: '打击', target: 1 }, { endTurn: true }],
    }, ctx) as { text: string };
    expect(result.text).toContain('已执行 3 步');
    expect(b.requests.map((request) => request.body['action'])).toEqual(['play_card', 'play_card', 'end_turn']);
  });

  it('多步里打不动的牌就停在那儿，不猜', async () => {
    const { world: w, bridge: b } = await setup();
    const code = await stateCode(w);
    const result = await tool(w, 'sts2_play').handler({
      state: code,
      steps: [{ card: '痛击', target: 0 }],
    }, ctx) as { text: string; failed?: boolean };
    expect(result.text).toContain('找不到');
    expect(result.failed).toBe(true);
    expect(b.requests).toHaveLength(0);
  });

  it('多人地图先压一会儿，等队友投票再推', async () => {
    const { host, bridge: b } = await setup({ coopRouteWaitMs: 300, solverAutoplay: false, chatter: 'off', queueStateEvents: false });
    await delay(120);
    const before = host.of('sts-2.state').length;
    const raw = structuredClone(fixture('map-act0')) as Record<string, any>;
    raw['session']['mode'] = 'coop';
    (raw['run']['players'] as any[]).push({ player_id: '2', slot_index: 1, is_local: false });
    b.state = raw;
    b.push(raw);
    await delay(120);
    expect(host.of('sts-2.state').length).toBe(before);   // 压着，让队友先投
    await settled(() => host.of('sts-2.state').length > before, 2000);
    expect(host.of('sts-2.state').length).toBeGreaterThan(before);
  });

  it('古之民结算完进地图：回合结束那句提醒也不许把地图抢推给她', async () => {
    const { host, bridge: b, world: w } = await setup({ coopRouteWaitMs: 600, solverAutoplay: false, chatter: 'off', queueStateEvents: false });
    // 她刚做完一个决定（真机上就是古之民选项）：回合结束时 World 会补一句提醒。
    const code = await stateCode(w);
    await tool(w, 'sts2_do').handler({ state: code, action: 2 }, ctx);

    b.state = coopMap(11);
    b.push(b.state);
    await delay(100);
    const texts = () => [...host.of('sts-2.state'), ...host.of('sts-2.decision')].join('\n');
    expect(texts()).not.toContain('地图 16行');   // 进图先压着

    w.onTurnEnded();                               // 提醒到了：之前它会带着整张地图把她叫醒
    await delay(150);
    expect(texts()).not.toContain('地图 16行');

    await settled(() => texts().includes('地图 16行'), 2000);
    expect(texts()).toContain('地图 16行');        // 压完了照样推
  });

  it('队友一投票就立刻推给她跟票，不用等满整个等待期', async () => {
    const { host, bridge: b } = await setup({ coopRouteWaitMs: 8000, solverAutoplay: false, chatter: 'off', queueStateEvents: false });
    b.state = coopMap(21);
    b.push(b.state);
    await delay(120);
    const texts = () => [...host.of('sts-2.state'), ...host.of('sts-2.decision')].join('\n');
    expect(texts()).not.toContain('地图 16行');

    b.state = coopMap(22, { row: 1, col: 3 });
    b.push(b.state);
    await settled(() => texts().includes('投票：P2 → (1,3)'), 2000);
    expect(texts()).toContain('投票：P2 → (1,3)');
  });

  it('压着等队友投票的时候，不催她"游戏在等你决定"', async () => {
    const { host, bridge: b } = await setup({ coopRouteWaitMs: 3000, idleNudgeMs: 200, solverAutoplay: false, chatter: 'off' });
    b.state = coopMap(31);
    b.push(b.state);
    await delay(800);   // 足够让 idle 提醒响好几轮
    expect(host.of('sts-2.decision').join('\n')).not.toContain('游戏在等你决定');
  });

  it('压着的时候她自己拿旧状态码试动作，也只回"等队友"，不给地图', async () => {
    const { world: w, host, bridge: b } = await setup({ coopRouteWaitMs: 500, solverAutoplay: false, chatter: 'off', stateEventThrottleMs: 0 });
    // 真机现场：古之民那一下刚点完，她手里还是上一屏的状态码
    const staleCode = await stateCode(w);
    b.state = coopMap(51);
    b.push(b.state);
    await delay(100);

    const stale = await tool(w, 'sts2_do').handler({ state: staleCode, action: 1 }, ctx) as { text: string };
    expect(stale.text).toContain('等队友先投票');
    expect(stale.text).not.toContain('地图 16行');
    expect(stale.text).not.toContain('战斗 (1,6)');   // 连编号都没给

    const observed = await tool(w, 'sts2_observe').handler({}, ctx) as { text: string };
    expect(observed.text).toContain('等队友先投票');
    expect(observed.text).not.toContain('地图 16行');

    // 压完了照样推：不是把她忘了
    const texts = () => [...host.of('sts-2.state'), ...host.of('sts-2.decision')].join('\n');
    await settled(() => texts().includes('地图 16行'), 2500);
    expect(texts()).toContain('地图 16行');
  });

  it('配置成 0 = 一直等队友先投：不投就一帧都不推，投了立刻推', async () => {
    const { world: w, host, bridge: b } = await setup({ coopRouteWaitMs: 0, solverAutoplay: false, chatter: 'off' });
    b.state = coopMap(61);
    b.push(b.state);
    await delay(600);   // 0 没有截止时间：等多久都不会自己放行
    const texts = () => [...host.of('sts-2.state'), ...host.of('sts-2.decision')].join('\n');
    expect(texts()).not.toContain('地图 16行');

    const observed = await tool(w, 'sts2_observe').handler({}, ctx) as { text: string };
    expect(observed.text).toContain('一直等队友先投票');
    expect(observed.text).not.toContain('地图 16行');

    // 队友投了：立刻放行，把带投票的地图推上来
    b.state = coopMap(62, { row: 1, col: 3 });
    b.push(b.state);
    await settled(() => texts().includes('投票：P2 → (1,3)'), 2000);
    expect(texts()).toContain('投票：P2 → (1,3)');
  });

  it('自己先投了一票不算"队友投了"：仍要按住等队友', async () => {
    const { host, bridge: b } = await setup({ coopRouteWaitMs: 400, solverAutoplay: false, chatter: 'off' });
    const raw = coopMap(71);   // 注意：不带队友投票
    (raw['map'] as any)['local_vote'] = { row: 1, col: 3 };
    const node = (raw['map']['available_nodes'] as any[]).find((n) => n['row'] === 1 && n['col'] === 3);
    node['vote_count'] = 1;
    node['has_local_vote'] = true;
    node['voted_player_ids'] = ['1'];
    // 玩家自己在地图上点了一格：这一票不能当成"队友投了"
    b.state = raw;
    b.push(raw);
    await delay(150);
    const texts = () => [...host.of('sts-2.state'), ...host.of('sts-2.decision')].join('\n');
    expect(texts()).not.toContain('地图 16行');
    await settled(() => texts().includes('地图 16行'), 2000);
  });

  it('桥把多人局报成 singleplayer 时，靠投票里的别人也认得出是多人局', async () => {
    const { host, bridge: b } = await setup({ coopRouteWaitMs: 400, solverAutoplay: false, chatter: 'off' });
    // 真机可能给出 session.mode=singleplayer、run.players 只有自己；但地图投票里还有 P2。
    const raw = structuredClone(fixture('map-act0')) as Record<string, any>;
    (raw['map']['player_votes'] as any[]).push({ player_id: '2', slot_index: 1, is_local: false, coord: null });
    raw['state_version'] = 41;
    b.state = raw;
    b.push(raw);
    await delay(120);
    const texts = () => [...host.of('sts-2.state'), ...host.of('sts-2.decision')].join('\n');
    expect(texts()).not.toContain('地图 16行');   // 也压着
    await settled(() => texts().includes('地图 16行'), 2000);
    expect(texts()).toContain('地图 16行');
  });

  it('多选选牌屏：单点一下只是"排上队"，回执不谎报已执行，并教她一次选满', async () => {
    const { world: w } = await setup({ solverAutoplay: false, chatter: 'off' }, (br) => {
      br.state = structuredClone(fixture('selection-remove'));
    });
    await delay(120);
    const code = await stateCode(w);
    const result = await tool(w, 'sts2_do').handler({ state: code, action: 1 }, ctx) as { text: string };
    expect(result.text).toContain('已排上队');
    expect(result.text).not.toContain('已执行');
    expect(result.text).toContain('要一次选满 2 张');
  });

  it('多选选牌屏：sts2_play 一次提交两张，界面才会动', async () => {
    const { world: w, bridge: b } = await setup({ solverAutoplay: false, chatter: 'off' }, (br) => {
      br.state = structuredClone(fixture('selection-remove'));
    });
    await delay(120);
    const code = await stateCode(w);
    const result = await tool(w, 'sts2_play').handler({ state: code, steps: [{ select: 1 }, { select: 5 }] }, ctx) as { text: string };
    expect(b.requests.filter((entry) => entry.body['action'] === 'select_deck_card')).toHaveLength(2);
    expect(result.text).toContain('已提交 2 个选择');
    expect(b.state['screen']).toBe('EVENT');
  });

  it('多选选牌屏：数量不对就直接说清楚，不瞎点', async () => {
    const { world: w, bridge: b } = await setup({ solverAutoplay: false, chatter: 'off' }, (br) => {
      br.state = structuredClone(fixture('selection-remove'));
    });
    await delay(120);
    const code = await stateCode(w);
    const result = await tool(w, 'sts2_play').handler({ state: code, steps: [{ select: 1 }] }, ctx) as { text: string; failed?: boolean };
    expect(result.text).toContain('要一次选满 2 张');
    expect(result.failed).toBe(true);
    expect(b.requests).toHaveLength(0);
  });

  it('{select} 只能用在选牌屏：奖励屏用了会被挡回来，一个请求都不发', async () => {
    const { world: w, bridge: b } = await setup({ chatter: 'off' }, (br) => {
      br.state = structuredClone(fixture('event-normal'));
    });
    await delay(120);
    const code = await stateCode(w);
    const result = await tool(w, 'sts2_play').handler({ state: code, steps: [{ select: 1 }, { select: 2 }] }, ctx) as { text: string; failed?: boolean };
    expect(result.text).toContain('只能用在选牌屏');
    expect(result.failed).toBe(true);
    expect(b.requests).toHaveLength(0);
  });

  it('桥回 500（mod 内部异常）时说清是桥报错，不冒充断联，也不让她重试同一编号', async () => {
    const { world: w, host, bridge: b } = await setup({ chatter: 'off' }, (br) => { br.crashAction = true; });
    await delay(120);
    const code = await stateCode(w);
    const result = await tool(w, 'sts2_do').handler({ state: code, action: 2 }, ctx) as { text: string; failed?: boolean };
    expect(result.text).toContain('桥内部报错');
    expect(result.text).toContain('500');
    expect(result.failed).toBe(true);
    expect(host.of('sts-2.connection')).toHaveLength(0);   // 不是"断联"

    const again = await tool(w, 'sts2_do').handler({ state: code, action: 2 }, ctx) as { text: string };
    expect(again.text).toContain('已经失败过');
    expect(b.requests).toHaveLength(1);
  });

  it('桥慢的时候把体检流水写进 sts2-bridge.jsonl（卡了直接看这份）', async () => {
    const { world: w, bridge: b } = await setup({ chatter: 'off' });
    b.stateDelayMs = 600;
    await tool(w, 'sts2_observe').handler({}, ctx);
    const path = join(dataDir as string, 'sts2-bridge.jsonl');
    const lines = readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    const slow = lines.find((entry) => entry['kind'] === 'slow' && Number(entry['ms']) >= 500);
    expect(slow).toBeTruthy();
    expect(slow?.['path']).toBe('/state');
    expect(slow?.['screen']).toBe('combat');
  });

  it('宿主丢了一批局面（模型轮被抢占）之后，她还能被叫醒，不会就此坐着不动', async () => {
    bridge = new FakeBridge();
    const baseUrl = await bridge.listen();
    dataDir = mkdtempSync(join(tmpdir(), 'sts2-world-'));
    world = new Sts2World({
      cfg: { ...STS2_DEFAULTS, baseUrl, stateEventThrottleMs: 0, connectTimeoutMs: 3000, readSave: false, queueStateEvents: false, observeThrottleMs: 0, solverPrefetchMs: 0 },
      timezone: 'Asia/Shanghai', dataDir, token: '',
    });
    const host = new DroppingHost();
    await world.start(host as unknown as WorldHost);
    await bridge.whenStreaming();
    await delay(100);
    expect(host.of('sts-2.state')).toHaveLength(0);   // 第一份被宿主丢了

    const next = structuredClone(bridge.state) as Record<string, any>;
    next['state_version'] = 991;
    (next['run'] as Record<string, unknown>)['gold'] = 123;
    bridge.state = next;
    bridge.push(next);
    await settled(() => host.of('sts-2.state').length > 0, 2000);
    expect(host.of('sts-2.state').length).toBeGreaterThan(0);
  });

  it('她还在想的时候，新局面先攒着，等这一轮结束再给', async () => {
    const { world: w, host, bridge: b } = await setup({ queueStateEvents: true });
    const before = host.of('sts-2.state').length;   // 初始局面推过，正处于"等她想"
    const next = structuredClone(b.state);
    next.state_version = 88;
    (next.run as Record<string, unknown>).gold = 77;
    b.state = next;
    b.push(next);
    await delay(150);
    expect(host.of('sts-2.state').length).toBe(before);   // 攒着，没把她拽出来

    w.onTurnEnded();
    await delay(150);
    expect(host.of('sts-2.state').length).toBeGreaterThan(before);
  });

  it('玩家的一句"别打精英"会挂在之后每一份局面上', async () => {
    const { world: w } = await setup();
    const steered = await tool(w, 'sts2_steer').handler({ text: '这层别打精英', until: 'floor' }, ctx) as { text: string };
    expect(steered.text).toContain('这层别打精英');

    const observed = await tool(w, 'sts2_observe').handler({}, ctx) as { text: string };
    expect(observed.text).toContain('玩家指令（本层结束前）：这层别打精英');

    await tool(w, 'sts2_steer').handler({ text: '' }, ctx);
    const cleared = await tool(w, 'sts2_observe').handler({}, ctx) as { text: string };
    expect(cleared.text).not.toContain('玩家指令');
  });

  it('构筑意图记下来会挂在局面上，换局才作废', async () => {
    const { world: w } = await setup();
    const saved = await tool(w, 'sts2_intent').handler({ note: '走毒；见催化剂必拿' }, ctx) as { text: string };
    expect(saved.text).toContain('走毒');

    const observed = await tool(w, 'sts2_observe').handler({}, ctx) as { text: string };
    expect(observed.text).toContain('构筑意图');
    expect(observed.text).toContain('走毒');
  });

  it('求解器有建议就贴在局面尾部（只注记，不执行）', async () => {
    const { world: w, bridge: b } = await setup();
    b.solverPlan = load('solver-combat');
    // 换一个局面（金币变了），让预取在新状态码上重新跑一次。
    const next = structuredClone(b.state);
    next.state_version = 77;
    (next.run as Record<string, unknown>).gold = 99;
    b.state = next;
    b.push(next);
    // 预取是异步的：等它落地，最多 1.5 秒。
    let text = '';
    for (let i = 0; i < 20; i += 1) {
      await delay(100);
      text = ((await tool(w, 'sts2_observe').handler({}, ctx)) as { text: string }).text;
      if (text.includes('求解器')) break;
    }
    const code = await stateCode(w);
    expect(text).toContain('求解器：下一步 → 2');
    expect(b.requests.filter((request) => request.body['action']).length).toBe(0); // 只贴建议，不发动作
    expect(code).toMatch(/^[0-9a-f]{12}$/);
  });

  it('战斗结束会偶尔说一句', async () => {
    const { host, bridge: b } = await setup({
      chatter: 'normal', chatterWinChance: 1, chatterHurtChance: 1, chatterCooldownMs: 0,
    });
    const reward = structuredClone(fixture('reward'));
    b.state = reward;
    b.push(reward);
    await delay(350);
    expect(host.of('sts-2.murmur').length).toBeGreaterThanOrEqual(1);
  });

  it('求解器接管整场战斗：零模型事件，只留一条摘要', async () => {
    const { host, bridge: b } = await setup(
      { solverAutoplay: true, chatter: 'off' },
      (fake) => {
        // 真机就是每步重新求解：手里的牌打完再结束回合。
        fake.solverPlans = [
          solverPlan([playStep(1)]),
          solverPlan([playStep(2)]),
          solverPlan([playStep(3, null)]),
          solverPlan([playStep(4, null)]),
          solverPlan([endTurnStep]),
        ];
        fake.endTurnTo = 'reward';
      },
    );
    await settled(() => host.of('sts-2.auto').length > 0);

    expect(b.requests.map((request) => request.body['action']))
      .toEqual(['play_card', 'play_card', 'play_card', 'play_card', 'end_turn']);
    const summary = host.of('sts-2.auto');
    expect(summary).toHaveLength(1);                      // 一场一条，不每步发
    expect(summary[0]).toContain('这场我用求解器打完了');

    // 接管期间一帧都没推给她：唯一的状态事件是战斗结束后那份。
    const states = host.of('sts-2.state');
    expect(states).toHaveLength(1);
    expect(states[0]).not.toContain('出牌');
  });

  for (const [why, override] of [
    ['求解器没算完', { search_status: 'budget_exhausted' }],
    ['有它不认识的牌', { coverage: { exact: 3, inferred: 0, unsupported: 2, ignored: 0, potions: 0, risk: false } }],
  ] as Array<[string, Record<string, unknown>]>) {
    it(`求解器门槛不满足时一步都不动，直接把局面交回（${why}）`, async () => {
      const { host, bridge: b } = await setup(
        { solverAutoplay: true, chatter: 'off' },
        (fake) => { fake.solverPlans = [solverPlan([playStep(1)], override)]; },
      );
      await settled(() => host.of('sts-2.state').length > 0);

      expect(b.requests).toHaveLength(0);
      expect(host.of('sts-2.auto')).toHaveLength(0);        // 一步没动就不发摘要
      expect(host.of('sts-2.state')).toHaveLength(1);       // 交回模型
    });
  }

  it('结束回合会死的局面绝不替她结束', async () => {
    const { host, bridge: b } = await setup(
      { solverAutoplay: true, chatter: 'off' },
      (fake) => {
        fake.state = structuredClone(fixture('combat-t1'));
        (fake.state.combat as Record<string, unknown>).end_turn_will_kill_player = true;
        fake.solverPlans = [solverPlan([playStep(1), endTurnStep])];
      },
    );
    await settled(() => host.of('sts-2.state').length > 0);

    expect(b.requests.filter((request) => request.body['action'] === 'end_turn')).toHaveLength(0);
    expect(b.requests).toHaveLength(0);
  });

  it('接管步数到上限就交回，不会无限打下去', async () => {
    const { host, bridge: b } = await setup(
      { solverAutoplay: true, solverAutoplayMaxSteps: 2, chatter: 'off' },
      (fake) => { fake.solverPlans = [solverPlan([playStep(1)]), solverPlan([playStep(2)])]; },
    );
    await settled(() => host.of('sts-2.auto').length > 0);

    expect(b.requests.map((request) => request.body['action'])).toEqual(['play_card', 'play_card']);
    const summary = host.of('sts-2.auto');
    expect(summary).toHaveLength(1);
    expect(summary[0]).toContain('2 步');
    expect(summary[0]).toContain('剩下的交给你');
    // 交回时直接把当前局面和状态码附上：模型不用再 observe 一次。
    expect(summary[0]).toMatch(/\[StS2 [0-9a-f]{12}/);
  });

  it('手里还有牌、能量也没花完时，求解器要结束回合也不听', async () => {
    const { host, bridge: b } = await setup(
      { solverAutoplay: true, chatter: 'off' },
      (fake) => { fake.solverPlans = [solverPlan([endTurnStep])]; },
    );
    await settled(() => host.of('sts-2.state').length > 0);

    expect(b.requests).toHaveLength(0);                    // 一张牌都没替她打，也没结束回合
    expect(host.of('sts-2.auto')).toHaveLength(0);
    expect(host.of('sts-2.state')).toHaveLength(1);        // 交回模型自己决定
  });

  it('生命低于门槛就不再替她打，残局交给模型', async () => {
    const { host, bridge: b } = await setup(
      { solverAutoplay: true, chatter: 'off' },
      (fake) => {
        fake.state = structuredClone(fixture('combat-t1'));
        (fake.state.run as Record<string, unknown>).current_hp = 20;   // 20/80 = 25% < 30%
        fake.solverPlans = [solverPlan([playStep(1)])];
      },
    );
    await settled(() => host.of('sts-2.state').length > 0);

    expect(b.requests).toHaveLength(0);
    expect(host.of('sts-2.state')).toHaveLength(1);
  });

  it('关掉摘要就一条事件都不发', async () => {
    const { host, bridge: b } = await setup(
      { solverAutoplay: true, solverAutoplaySummary: false, chatter: 'off' },
      (fake) => {
        fake.solverPlans = [
          solverPlan([playStep(1)]), solverPlan([playStep(2)]), solverPlan([playStep(3, null)]),
          solverPlan([playStep(4, null)]), solverPlan([endTurnStep]),
        ];
        fake.endTurnTo = 'reward';
      },
    );
    await settled(() => host.of('sts-2.state').length > 0);

    expect(b.requests).toHaveLength(5);
    expect(host.of('sts-2.auto')).toHaveLength(0);
  });

  it('敌方回合的空动作在接管里等它回来，不叫醒模型', async () => {
    const { host, bridge: b } = await setup(
      { solverAutoplay: true, chatter: 'off' },
      (fake) => {
        fake.solverPlans = [
          solverPlan([playStep(1)]), solverPlan([playStep(2)]), solverPlan([playStep(3, null)]),
          solverPlan([playStep(4, null)]), solverPlan([endTurnStep]),
        ];
        fake.endTurnTo = 'reward';
      },
    );
    await settled(() => b.requests.length >= 1);

    // 敌方回合：桥这一帧只给 save_and_quit，等于没有动作。
    const withActions = b.state;
    const version = Number(withActions.state_version ?? 0);
    b.state = { ...structuredClone(withActions), available_actions: [], state_version: version + 1 };
    b.push(b.state);
    await delay(300);

    expect(host.of('sts-2.state')).toHaveLength(0);   // 空帧不推给模型
    expect(host.of('sts-2.auto')).toHaveLength(0);    // 也没交回

    // 回到她的回合：接管自己接着打。
    b.state = { ...structuredClone(withActions), state_version: version + 2 };
    b.push(b.state);
    await settled(() => host.of('sts-2.auto').length > 0);
    // 回到她的回合之后接管自己接着打（至少继续出牌，不会把整场丢掉）。
    const after = b.requests.slice(1).map((request) => request.body['action']);
    expect(after.length).toBeGreaterThanOrEqual(2);
    expect(after.every((action) => action === 'play_card' || action === 'end_turn')).toBe(true);
  });

  it('主页不替她开局：主菜单一帧都不推', async () => {
    const { host, bridge: b } = await setup(
      {},
      (fake) => { fake.state = structuredClone(fixture('menu')); },
    );
    await delay(150);
    expect(host.of('sts-2.state')).toHaveLength(0);
    expect(b.requests).toHaveLength(0);

    // 玩家自己开局、进了战斗：局面推送恢复。
    const combat = structuredClone(fixture('combat-t1'));
    b.state = combat;
    b.push(combat);
    await delay(150);
    expect(host.of('sts-2.state')).toHaveLength(1);
  });

  it('求解器偶尔来不及给计划：先等它一次，不立刻把她叫醒', async () => {
    const { host, bridge: b } = await setup(
      { solverAutoplay: true, chatter: 'off' },
      (fake) => {
        fake.solverPlans = [solverPlan([playStep(1)])];
        fake.solverFailures = 2;          // 头两次 404，跟真机"没算完"一样
        fake.endTurnTo = 'reward';
      },
    );
    await settled(() => host.of('sts-2.auto').length > 0);

    // 两次 404 之后还能自己打出一张牌（旧行为是直接交回、一步不动）。
    expect(b.requests.map((request) => request.body['action'])).toEqual(['play_card']);
    expect(host.of('sts-2.auto')).toHaveLength(1);      // 一场只有一条摘要
    expect(host.of('sts-2.state')).toHaveLength(1);     // 战斗里一帧都没推
  });

  it('接管里挨了一下会说一句疼', async () => {
    const { host, bridge: b } = await setup(
      { solverAutoplay: true, chatter: 'normal', chatterHurtChance: 1, chatterWinChance: 0, chatterCooldownMs: 0 },
      (fake) => {
        fake.solverPlans = [solverPlan([playStep(1)]), solverPlan([endTurnStep])];
        fake.hpAfterPlay = 69;            // 80 → 69，够她说一句
        fake.endTurnTo = 'reward';
      },
    );
    await settled(() => host.of('sts-2.murmur').length > 0);

    const lines = host.of('sts-2.murmur');
    expect(lines.length).toBeGreaterThan(0);
  });

  it('有直连通道时闲话直接进气泡，不发 murmur 事件', async () => {
    const { world: w, host } = await setup(
      { chatter: 'normal', chatterHurtChance: 1, chatterWinChance: 0, chatterCooldownMs: 0, solverAutoplay: false, solver: false },
      (fake) => { fake.hpAfterPlay = 69; },
    );
    const said: string[] = [];
    (host as unknown as { speak: (text: string) => boolean }).speak = (text: string) => { said.push(text); return true; };
    const code = await stateCode(w);
    await tool(w, 'sts2_do').handler({ state: code, action: 2 }, ctx);
    await settled(() => said.length > 0);
    expect(said.length).toBeGreaterThan(0);
    expect(host.of('sts-2.murmur')).toHaveLength(0);
  });

  it('inspect 只给牌组，不把整屏局面再发一遍', async () => {
    const { world: w } = await setup();
    const result = await tool(w, 'sts2_inspect').handler({ what: 'deck' }, ctx) as { text: string };
    expect(result.text).toContain('牌组');
    expect(result.text).not.toContain('操作：');
  });

  it('接管期间一次都不向求解器要注记（它一次搜索 0.7 秒，会把游戏拖卡）', async () => {
    const { host, bridge: b } = await setup(
      { solverAutoplay: true, chatter: 'off' },
      (fake) => {
        fake.solverPlans = [solverPlan([playStep(1)]), solverPlan([endTurnStep])];
        fake.endTurnTo = 'reward';
      },
    );
    await settled(() => host.of('sts-2.auto').length > 0);
    // 接管自己按步要的计划 + 交回时给模型补的那一条注记；绝不会是"每帧一问"。
    expect(b.solverPlanRequests).toBeLessThanOrEqual(3);
    expect(b.solverPlanRequests).toBeGreaterThanOrEqual(2);
  });

  it('观战时也不问求解器（玩家自己打，别去抢 CPU）', async () => {
    const { world: w, bridge: b } = await setup(
      { solverAutoplay: false },
      (fake) => { fake.solverPlans = [solverPlan([playStep(1)])]; },
    );
    await tool(w, 'sts2_pause').handler({ reason: '看我打' }, ctx);
    const before = b.solverPlanRequests;
    // 换几帧战斗局面，观战期间不应再多要计划。
    for (let i = 0; i < 3; i += 1) {
      const next = structuredClone(fixture('combat-t1'));
      next.state_version = 200 + i;
      b.state = next;
      b.push(next);
      await delay(60);
    }
    expect(b.solverPlanRequests).toBe(before);
  });

  it('同一局面连着观察两次只回一句话', async () => {
    const { world: w } = await setup({ observeThrottleMs: 3000 });
    const first = await tool(w, 'sts2_observe').handler({}, ctx) as { text: string };
    expect(first.text).toContain('[StS2');

    const second = await tool(w, 'sts2_observe').handler({}, ctx) as { text: string };
    expect(second.text).toContain('局面没变');
    expect(second.text).not.toContain('手牌');

    const probe = await tool(w, 'sts2_probe').handler({}, ctx) as { text: string };
    expect(probe.text).toMatch(/观察 \d+ 次/);
    expect(probe.text).toMatch(/被节流 1 次/);
  });

  it('事件流漏了一帧时，观察不能拿旧帧糊她', async () => {
    // 真机现场：游戏已经从地图进了战斗，但桥没把那一帧推过来，
    // 而节流照旧回"局面没变"，她就一直卡在旧的地图编号上。
    const { world: w, bridge: b } = await setup(
      { observeThrottleMs: 200 },
      (fake) => { fake.state = structuredClone(fixture('map-act0')); },
    );
    const first = await tool(w, 'sts2_observe').handler({}, ctx) as { text: string };
    expect(first.text).toContain('地图');

    b.state = structuredClone(fixture('combat-t1'));   // 只换桥的状态，不推帧
    await delay(300);

    const second = await tool(w, 'sts2_observe').handler({}, ctx) as { text: string };
    expect(second.text).not.toContain('局面没变');
    expect(second.text).toContain('手牌');
  });

  it('桥用 409 回"这个动作不可用"时算被拒，并附上新局面', async () => {
    const { world: w, bridge: b } = await setup(
      { observeThrottleMs: 0 },
      (fake) => { fake.state = structuredClone(fixture('map-act0')); },
    );
    const code = await stateCode(w);
    b.rejectStatus = 409;
    b.state = structuredClone(fixture('combat-t1'));

    const result = await tool(w, 'sts2_do').handler({ state: code, action: 1 }, ctx) as { text: string; failed?: boolean };
    expect(result.failed).toBe(true);
    expect(result.text).toContain('未执行');
    expect(result.text).toContain('当前界面不支持这个动作');
    expect(result.text).toContain('手牌');            // 重读后的战斗局面

    // 同一号被拒过就不再重复提交（免得她复读）。
    b.rejectStatus = null;
    const again = await tool(w, 'sts2_do').handler({ state: code, action: 1 }, ctx) as { text: string };
    expect(again.text).toContain('已经失败过');
  });

  it('要全量时不受节流影响', async () => {
    const { world: w } = await setup({ observeThrottleMs: 5000 });
    await tool(w, 'sts2_observe').handler({}, ctx);
    await tool(w, 'sts2_observe').handler({}, ctx);

    const full = await tool(w, 'sts2_observe').handler({ detail: 'full' }, ctx) as { text: string };
    expect(full.text).toContain('[StS2');
    expect(full.text).toContain('牌组');
    expect(full.text).not.toContain('局面没变');
  });
});