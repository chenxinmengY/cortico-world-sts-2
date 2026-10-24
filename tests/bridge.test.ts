/**
 * 事件流的连接行为：这三条对应真机上刷过一百多次的"连上就断、断了又连"。
 * 断言都盯"桥侧被打开了几次"和"有没有报假断线"，不盯实现细节。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Sts2Bridge } from '../src/bridge.ts';
import { FakeBridge } from './fake-bridge.ts';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let fake: FakeBridge | null = null;
let bridge: Sts2Bridge | null = null;
let ctrl: AbortController | null = null;

async function connect() {
  fake = new FakeBridge();
  const baseUrl = await fake.listen();
  bridge = new Sts2Bridge({ baseUrl });
  ctrl = new AbortController();
  bridge.watch(ctrl.signal);
  await fake.whenStreaming();
  await delay(60);
  return { fake, bridge };
}

afterEach(async () => {
  ctrl?.abort();
  bridge?.close();
  await fake?.close();
  fake = null;
  bridge = null;
  ctrl = null;
});

describe('Sts2Bridge 事件流', () => {
  it('重复 watch() 不会掐断已有连接，也不产生假断线', async () => {
    const { fake: server, bridge: client } = await connect();
    const disconnects: unknown[] = [];
    client.on('disconnect', (error: unknown) => disconnects.push(error));
    const opens = server.streamOpens;

    client.watch(ctrl!.signal);
    client.watch(ctrl!.signal);
    await delay(200);

    expect(server.streamOpens).toBe(opens);
    expect(disconnects).toHaveLength(0);
    expect(client.streaming).toBe(true);
  });

  it('stream_ready 这类非局面帧不会被当成局面', async () => {
    const { fake: server, bridge: client } = await connect();
    const screens: string[] = [];
    client.on('snapshot', (snapshot: { screen: string }) => screens.push(snapshot.screen));

    server.pushRaw({
      event_id: 385, type: 'stream_ready',
      data: { run_id: 'DGWPENYHLGLA', screen: 'COMBAT', in_combat: true, turn: 1, action_window_open: true },
    });
    await delay(120);
    expect(client.snapshot).toBeNull();
    expect(screens).toHaveLength(0);

    // 同一路连接上的真局面必须照常进来，别把闸门关死了。
    server.push();
    await delay(120);
    expect(client.snapshot?.screen).toBe('combat');
    expect(screens).toHaveLength(1);
  });

  it('服务端关流后按退避重连，不会零延迟刷连接', async () => {
    const { fake: server, bridge: client } = await connect();
    const disconnects: unknown[] = [];
    client.on('disconnect', (error: unknown) => disconnects.push(error));
    const opens = server.streamOpens;

    server.dropStreams();
    await delay(200);
    expect(server.streamOpens).toBe(opens);   // 500ms 退避之内不该重连
    expect(disconnects).toHaveLength(1);

    await delay(600);
    expect(server.streamOpens).toBe(opens + 1);
    expect(client.streaming).toBe(true);
    expect(disconnects).toHaveLength(1);
  });
});

describe('Sts2Bridge 读局面的压力', () => {
  it('桥卡住时不叠请求：同一时刻只发一份 /state', async () => {
    const { fake: server, bridge: client } = await connect();
    server.stateDelayMs = 80;
    const before = server.stateGets;
    // 对账定时器、观察、工具回执可能同时来要局面——不能变成三份请求压给游戏。
    await Promise.all([client.refresh(), client.refresh(), client.refresh()]);
    expect(server.stateGets - before).toBe(1);
  });

  it('连续超时把桥标成 stuck，恢复后回到 ok', async () => {
    const { fake: server, bridge: client } = await connect();
    server.stateDelayMs = 200;
    await expect(client.refresh(undefined, 50)).rejects.toThrow();
    await expect(client.refresh(undefined, 50)).rejects.toThrow();
    expect(client.health).toBe('stuck');

    server.stateDelayMs = 0;
    await client.refresh();
    expect(client.health).toBe('ok');
    expect(client.lastLatencyMs).toBeLessThan(200);
  });
});