/** 构筑意图：写盘、跨重启存活、换局清空。 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { IntentStore } from '../src/intent.ts';

let dir: string | null = null;
const temp = () => {
  dir = mkdtempSync(join(tmpdir(), 'sts2-intent-'));
  return dir;
};

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe('构筑意图', () => {
  it('记下来能写盘，重新打开还在', () => {
    const dataDir = temp();
    const saved = new IntentStore(dataDir).set('走毒', 'RUN-1', 'now');
    expect(saved.rev).toBe(1);
    expect(existsSync(join(dataDir, 'sts2-intent.json'))).toBe(true);

    const reopened = new IntentStore(dataDir).load();
    expect(reopened.note).toBe('走毒');
    expect(reopened.runId).toBe('RUN-1');
  });

  it('清空只清内容，rev 继续往前走', () => {
    const store = new IntentStore(temp());
    store.set('走毒', 'RUN-1', 'now');
    const cleared = store.clear('RUN-2', 'later');
    expect(cleared.note).toBe('');
    expect(cleared.rev).toBe(2);
  });

  it('写盘失败也不抛错（只留内存）', () => {
    const store = new IntentStore(join(temp(), 'nope', 'deeper'));
    expect(() => store.set('走毒', 'RUN-1', 'now')).not.toThrow();
    expect(store.load().note).toBe('走毒');
  });
});