/** 存档读取：读不到必须安静地返回 null，绝不能把 World 带崩。 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SaveReader } from '../src/savefile.ts';

let dir: string | null = null;

function tempSave(content: string): string {
  dir = mkdtempSync(join(tmpdir(), 'sts2-save-'));
  const path = join(dir, 'current_run.save');
  writeFileSync(path, content);
  return path;
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe('存档读取', () => {
  it('读出读档次数与 seed', () => {
    const path = tempSave(JSON.stringify({ num_reloads: 2, rng: { seed: 'SEED-X' }, save_time: 123 }));
    const facts = new SaveReader(path).read();
    expect(facts).toMatchObject({ numReloads: 2, seed: 'SEED-X', saveTime: 123 });
  });

  it('文件不存在时返回 null，不抛错', () => {
    dir = mkdtempSync(join(tmpdir(), 'sts2-save-'));
    expect(new SaveReader(join(dir, 'current_run.save')).read()).toBeNull();
  });

  it('半截 JSON（正在写）不会抛错', () => {
    const path = tempSave('{"num_reloads": 1, "rng": {"seed"');
    expect(new SaveReader(path).read()).toBeNull();
  });

  it('文件更新后能读到新值', () => {
    const path = tempSave(JSON.stringify({ num_reloads: 0, rng: { seed: 'A' } }));
    const reader = new SaveReader(path);
    expect(reader.read()?.numReloads).toBe(0);
    writeFileSync(path, JSON.stringify({ num_reloads: 1, rng: { seed: 'A' } }));
    expect(reader.read()?.numReloads).toBe(1);
  });
});