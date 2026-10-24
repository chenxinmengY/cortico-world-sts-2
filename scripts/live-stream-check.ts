/**
 * 真机自检（只读）：验证三件事
 *   1) 同一条桥只建一条事件流，重复 watch() 不会报假断线；
 *   2) stream_ready 帧不会被当成局面（不该出现"战斗界面 0 个操作"）；
 *   3) 连上之后局面能读到，且状态码稳定。
 * 用法：node_modules\.bin\tsx scripts/live-stream-check.ts [秒数]
 */
import { Sts2Bridge } from '../src/bridge.ts';
import { stateRef, SCREEN_LABEL } from '../src/protocol.ts';

const seconds = Number(process.argv[2] ?? 8);
const bridge = new Sts2Bridge({ baseUrl: 'http://127.0.0.1:18080' });
const ctrl = new AbortController();

let disconnects = 0;
let snapshots = 0;
const screens: string[] = [];
bridge.on('disconnect', (error: Error) => {
  disconnects++;
  console.log(`[断线 ${disconnects}] ${error.message}`);
});
bridge.on('snapshot', (snapshot: { screen: string }) => {
  snapshots++;
  screens.push(snapshot.screen);
  console.log(`[局面 ${snapshots}] ${SCREEN_LABEL[snapshot.screen] ?? snapshot.screen} · ${stateRef(snapshot)}`);
});

void (async () => {
  await bridge.refresh(ctrl.signal, 3000);
  console.log(`初始：${bridge.snapshot ? SCREEN_LABEL[bridge.snapshot.screen] : '无'} · ${bridge.snapshot ? stateRef(bridge.snapshot) : '-'}`);
  bridge.watch(ctrl.signal);
  await new Promise((r) => setTimeout(r, 400));
  console.log(`“重连”一次（模拟 retryOnce）：streaming=${bridge.streaming}`);
  bridge.watch(ctrl.signal);
  bridge.watch(ctrl.signal);

  await new Promise((r) => setTimeout(r, seconds * 1000));
  console.log(`\n${seconds} 秒结果：断线 ${disconnects} 次 · 局面推送 ${snapshots} 次 · streaming=${bridge.streaming}`);
  console.log(`桥侧连接数应稳定为 1；若断线次数 >0 且 streaming=false，说明还在自激。`);
  ctrl.abort();
  bridge.close();
  process.exit(0);
})();