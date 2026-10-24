/**
 * 测试夹具：全部来自真机抓包（samples/ 里挑出来的代表样本）。
 * 这样测试盯的是"真形状"而不是我脑补的形状。
 */
import { readFileSync } from 'node:fs';
import type { Fields } from '../src/protocol.ts';

export function load(name: string): Fields {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Fields;
}

/** 只取 data 本体，模拟桥内部持有的 state。 */
export function state(name: string): Fields {
  const payload = load(name);
  return (payload.data ?? payload) as Fields;
}

export const FIXTURES = [
  'menu', 'event-neow', 'event-normal', 'combat-t1', 'combat-t1-after', 'map-act0',
  'reward', 'card-reward', 'shop-open', 'shop-closed', 'rest', 'chest-closed',
  'chest-open', 'select-upgrade', 'game-over',
  'combat-no-playable', 'reward-claimed', 'card-select-two', 'combat-empty-frame',
] as const;