/**
 * 构筑意图：玩家说过"我要走毒"这类话，得活过上下文重置。
 * 只存"意图"，不存战况——牌面数值永远来自当前状态，记忆里的"事实"会过期。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface Intent {
  rev: number;
  note: string;
  updatedAt: string;
  /** 这一条属于哪一局；换局就作废。 */
  runId: string;
}

const EMPTY: Intent = { rev: 0, note: '', updatedAt: '', runId: '' };

export class IntentStore {
  private readonly file: string;
  private cached: Intent | null = null;

  constructor(dataDir: string) {
    this.file = join(dataDir || '.', 'sts2-intent.json');
  }

  load(): Intent {
    if (this.cached) return this.cached;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Intent>;
      this.cached = {
        rev: Number(raw.rev ?? 0) || 0,
        note: typeof raw.note === 'string' ? raw.note : '',
        updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
        runId: typeof raw.runId === 'string' ? raw.runId : '',
      };
    } catch {
      this.cached = { ...EMPTY };
    }
    return this.cached;
  }

  set(note: string, runId: string, now: string): Intent {
    const text = note.trim().slice(0, 200);
    const current = this.load();
    this.cached = { rev: current.rev + 1, note: text, updatedAt: now, runId };
    this.persist();
    return this.cached;
  }

  /** 换局时清空（rev 留着，方便判断有没有变过）。 */
  clear(runId: string, now: string): Intent {
    const current = this.load();
    this.cached = { rev: current.rev + 1, note: '', updatedAt: now, runId };
    this.persist();
    return this.cached;
  }

  private persist(): void {
    if (!this.cached) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.cached, null, 2));
    } catch {
      // 写不进去就只留内存里的，不影响她打牌。
    }
  }
}