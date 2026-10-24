/** 偶尔一句：夸一句、喊一声疼。频率由概率 + 冷却控制，台词按伤情分档，看她打/自己打两套。 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_CHATTER_BOOK, parseChatterBook, pickChatter, type ChatterBook } from '../src/chatter.ts';
import { normalizeState } from '../src/protocol.ts';
import { load } from './fixtures.ts';

const norm = (name: string, mutate?: (data: Record<string, any>) => void) => {
  const raw = structuredClone(load(name)) as { data: Record<string, any> };
  mutate?.(raw.data);
  return normalizeState(raw);
};

const base = { rng: () => 0, cooldownOk: true, winChance: 1, hurtChance: 1 };

const hurt = (beforeHp: number, afterHp: number, mode?: 'watch' | 'self') => pickChatter({
  ...base,
  mode,
  before: norm('combat-t1', (d) => { (d['run'] as Record<string, unknown>)['current_hp'] = beforeHp; }),
  after: norm('combat-t1', (d) => { (d['run'] as Record<string, unknown>)['current_hp'] = afterHp; }),
});

describe('偶尔说一句', () => {
  it('战斗结束会说一句', () => {
    const hit = pickChatter({ ...base, before: norm('combat-t1'), after: norm('reward') });
    expect(hit?.kind).toBe('combat-win');
    expect(hit?.mode).toBe('watch');
    expect(hit?.text.length).toBeGreaterThan(0);
  });

  it('同场战斗里掉血够多会喊疼', () => {
    const hit = hurt(70, 61);
    expect(hit?.kind).toBe('hp-loss');
    expect(hit?.tier).toBe('light');
    expect(hit?.text).toContain('9');
  });

  it('掉得少就不说', () => {
    expect(hurt(70, 68)).toBeNull();
  });

  it('一次掉得多、或者血快见底，说得更重', () => {
    expect(hurt(70, 50)?.tier).toBe('heavy');
    expect(hurt(14, 9)?.tier).toBe('lethal');
  });

  it('看她打用「你」，自己打用「我」', () => {
    const watch = hurt(70, 61, 'watch');
    const self = hurt(70, 61, 'self');
    expect(watch?.mode).toBe('watch');
    expect(self?.mode).toBe('self');
    expect(DEFAULT_CHATTER_BOOK.watch.hurt.light[0]).toContain('看着');
    expect(DEFAULT_CHATTER_BOOK.self.hurt.light[0]).toContain('疼');
    expect(self?.text).not.toBe(watch?.text);
  });

  it('冷却没到就闭嘴', () => {
    const hit = pickChatter({ ...base, cooldownOk: false, before: norm('combat-t1'), after: norm('reward') });
    expect(hit).toBeNull();
  });

  it('概率为 0 时完全不说话', () => {
    const hit = pickChatter({ ...base, winChance: 0, hurtChance: 0, before: norm('combat-t1'), after: norm('reward') });
    expect(hit).toBeNull();
  });

  it('死了不夸，也不喊疼', () => {
    const hit = pickChatter({
      ...base,
      before: norm('combat-t1', (d) => { (d['run'] as Record<string, unknown>)['current_hp'] = 9; }),
      after: norm('game-over'),
    });
    expect(hit).toBeNull();
  });

  it('旧格式只写一套时当作「看她打」，自己打用默认', () => {
    const book = parseChatterBook(JSON.stringify({ hurt: { light: ['嘶，${loss} 点。'] } }));
    expect(book?.watch.hurt.light).toEqual(['嘶，${loss} 点。']);
    expect(book?.watch.hurt.heavy).toEqual(DEFAULT_CHATTER_BOOK.watch.hurt.heavy);
    expect(book?.self).toEqual(DEFAULT_CHATTER_BOOK.self);
  });

  it('旧格式 + self 混写也能各自取到', () => {
    const book = parseChatterBook(JSON.stringify({
      hurt: { light: ['看'] },
      self: { hurt: { light: ['我'] } },
    }));
    expect(book?.watch.hurt.light).toEqual(['看']);
    expect(book?.self.hurt.light).toEqual(['我']);
  });

  it('新格式可以两套分开写', () => {
    const book = parseChatterBook(JSON.stringify({
      watch: { hurt: { light: ['看：${loss} 点'] } },
      self: { hurt: { light: ['我：${loss} 点'] } },
    }));
    expect(book?.watch.hurt.light).toEqual(['看：${loss} 点']);
    expect(book?.self.hurt.light).toEqual(['我：${loss} 点']);
    expect(book?.self.win.normal).toEqual(DEFAULT_CHATTER_BOOK.self.win.normal);
  });

  it('同一句不会连着说两遍', () => {
    const book: ChatterBook = {
      ...DEFAULT_CHATTER_BOOK,
      self: {
        ...DEFAULT_CHATTER_BOOK.self,
        hurt: { ...DEFAULT_CHATTER_BOOK.self.hurt, light: ['A', 'B'] },
      },
    };
    const first = pickChatter({
      ...base,
      mode: 'self',
      book,
      before: norm('combat-t1', (d) => { (d['run'] as Record<string, unknown>)['current_hp'] = 70; }),
      after: norm('combat-t1', (d) => { (d['run'] as Record<string, unknown>)['current_hp'] = 65; }),
    });
    const second = pickChatter({
      ...base,
      mode: 'self',
      book,
      lastText: first?.text ?? null,
      before: norm('combat-t1', (d) => { (d['run'] as Record<string, unknown>)['current_hp'] = 70; }),
      after: norm('combat-t1', (d) => { (d['run'] as Record<string, unknown>)['current_hp'] = 65; }),
    });
    expect(first?.text).toBe('A');
    expect(second?.text).toBe('B');
  });
});