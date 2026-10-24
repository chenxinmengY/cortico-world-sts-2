/**
 * 抓样本小工：一直看着桥的 /state，碰到我们还没实证的屏就落一份到 samples/。
 * 只读，不发动作。用于"你在打，我在旁边捡样本"。
 * 用法：node_modules\.bin\tsx scripts/watch-capture.ts [分钟数，默认 25]
 */
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.STS2_BRIDGE ?? 'http://127.0.0.1:18080';
const minutes = Number(process.argv[2] ?? 25);
const outDir = join(process.cwd(), 'samples');
mkdirSync(outDir, { recursive: true });
const indexPath = join(outDir, 'watch-index.log');

/** 我们已经有样本、但缺关键分支的界面。 */
const WANTED = new Set([
  'REWARD', 'CARD_SELECTION_REWARD', 'CARD_SELECTION', 'CARD_SELECTION_REMOVE',
  'SHOP', 'REST', 'CHEST', 'EVENT', 'COMBAT', 'MAP', 'BUNDLES', 'CRYSTAL_SPHERE',
]);

const stamp = () => {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

/** 同一界面的“同一屏”判定：界面名 + 动作清单 + 关键数字，变了才算新的一屏。 */
function screenKey(screen: string, data: Record<string, unknown>): string {
  const run = (data.run ?? {}) as Record<string, unknown>;
  const combat = (data.combat ?? {}) as Record<string, unknown>;
  const hand = Array.isArray(combat.hand) ? combat.hand.length : 0;
  return [
    screen,
    JSON.stringify(data.available_actions ?? []),
    run.floor, run.current_hp, run.gold, data.turn, hand,
  ].join('|');
}

async function fetchState(): Promise<{ ok: boolean; data: Record<string, unknown> & { screen?: string }; raw: unknown }> {
  const res = await fetch(`${BASE}/state`, { signal: AbortSignal.timeout(4000) });
  const raw = await res.json();
  const data = ((raw as Record<string, unknown>).data ?? raw) as Record<string, unknown>;
  return { ok: res.ok, data, raw };
}

const seen = new Set<string>();
const counts = new Map<string, number>();
const deadline = Date.now() + minutes * 60_000;

console.log(`看桥 ${BASE}，最多 ${minutes} 分钟；样本落 ${outDir}`);
while (Date.now() < deadline) {
  try {
    const { data, raw } = await fetchState();
    const screen = String(data.screen ?? 'UNKNOWN');
    if (WANTED.has(screen)) {
      const key = screenKey(screen, data);
      if (!seen.has(key)) {
        seen.add(key);
        const n = (counts.get(screen) ?? 0) + 1;
        counts.set(screen, n);
        const name = `${screen.toLowerCase()}-watch-${stamp()}-${n}.json`;
        writeFileSync(join(outDir, name), JSON.stringify(raw, null, 2));
        const actions = (data.available_actions as unknown[] | undefined) ?? [];
        const line = `${new Date().toISOString()} ${name} screen=${screen} actions=${actions.length} floor=${(data.run as any)?.floor} hp=${(data.run as any)?.current_hp}`;
        appendFileSync(indexPath, line + '\n');
        console.log(line);
      }
    }
  } catch (error) {
    console.log(`[${new Date().toISOString()}] 读不到：${(error as Error).message}`);
  }
  await new Promise((r) => setTimeout(r, 700));
}
console.log('时间到，收工。');