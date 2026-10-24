/**
 * 对着真桥跑一遍：打印启动事件和一份渲染后的局面。
 * 用法：  pnpm live            （默认 http://127.0.0.1:18080）
 *         $env:STS2_BASE_URL='http://127.0.0.1:38080'; pnpm live
 * 只读：只发 GET /state，不会下任何动作。
 */
import type { WorldHost } from 'cortico/core/types.ts';
import { STS2_DEFAULTS } from '../src/config.ts';
import { Sts2World } from '../src/world.ts';

const baseUrl = process.env.STS2_BASE_URL ?? 'http://127.0.0.1:18080';

const host = {
  log: { warn: (_: string, message: unknown) => console.warn('[warn]', message), info: () => {} },
  async pushEvent(event: { type: string; text: string }) {
    console.log(`\n=== 事件 ${event.type} ===\n${event.text}`);
    return event as never;
  },
  pushDeferred(spec: { type: string; render: () => unknown }) {
    const rendered = spec.render();
    if (rendered) {
      const text = typeof rendered === 'string' ? rendered : (rendered as { text: string }).text;
      console.log(`\n=== 推送 ${spec.type} ===\n${text}`);
    }
  },
} as unknown as WorldHost;

const world = new Sts2World({
  cfg: { ...STS2_DEFAULTS, baseUrl, connectTimeoutMs: 5000 },
  timezone: process.env.TZ ?? 'Asia/Shanghai',
  dataDir: process.env.TEMP ?? '/tmp',
  token: process.env.CORTICO_STS_2_TOKEN ?? '',
});

console.log(`连 ${baseUrl} …`);
await world.start(host);
const observe = world.tools().find((tool) => tool.name === 'sts2_observe')!;
const outcome = await observe.handler({ detail: 'full' as string }, { role: 'probe', log: host.log as never });
console.log('\n=== sts2_observe ===\n' + (typeof outcome === 'string' ? outcome : outcome.text));
await world.stop();