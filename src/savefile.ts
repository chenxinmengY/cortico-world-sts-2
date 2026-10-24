/**
 * 读游戏存档里的两个数字：读档次数、这一局的 seed。
 * 依据真机核对（2026-10-23）：`current_run.save` 是纯 JSON，`num_reloads` 在快速 SL、
 * 返回大厅、重开游戏之后都会 +1；`rng.seed` 换局才变。这是判断"回档"的硬证据，
 * 比"层数倒退 / 同层回血"可靠得多。
 * 铁律：读不到就返回 null，绝不抛错——存档路径、schema、权限都可能变。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface SaveFacts {
  numReloads: number;
  seed: string;
  saveTime: number;
  path: string;
}

const MAX_DEPTH = 6;
/** 这些目录里不可能有存档，跳过它们省得每次扫几千个文件。 */
const SKIP = new Set([
  'shader_cache', 'sentry', 'logs', 'mods', 'mod_configs', 'localization_override', 'mod_data',
]);
/** 找不到存档后歇一会儿再找（没开局时这个文件本来就不存在）。 */
const RELOCATE_AFTER_MS = 10_000;

export class SaveReader {
  private path: string | null;
  private mtime = 0;
  private size = -1;
  private cached: SaveFacts | null = null;
  private misses = 0;
  private nextLocateAt = 0;

  constructor(explicitPath = '') {
    this.path = explicitPath.trim() ? explicitPath.trim() : null;
  }

  /** 读一次；文件没变就复用上次结果。 */
  read(): SaveFacts | null {
    if (!this.path) {
      if (Date.now() < this.nextLocateAt) return this.cached;
      this.path = locate();
      if (!this.path) {
        this.nextLocateAt = Date.now() + RELOCATE_AFTER_MS;
        return this.cached;
      }
    }
    try {
      const stat = statSync(this.path);
      if (stat.mtimeMs === this.mtime && stat.size === this.size) return this.cached;
      const data = JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, unknown>;
      const rng = (data['rng'] ?? {}) as Record<string, unknown>;
      this.cached = {
        numReloads: Number(data['num_reloads'] ?? 0) || 0,
        seed: String(rng['seed'] ?? ''),
        saveTime: Number(data['save_time'] ?? 0) || 0,
        path: this.path,
      };
      this.mtime = stat.mtimeMs;
      this.size = stat.size;
      this.misses = 0;
      return this.cached;
    } catch {
      // 正在写、被锁、这一局结束了文件被删：沿用上一次成功的读数，没有就当读不到。
      this.misses++;
      if (this.misses > 3) {
        this.path = null;
        this.nextLocateAt = Date.now() + RELOCATE_AFTER_MS;
        this.misses = 0;
      }
      return this.cached;
    }
  }
}

/** 在 %APPDATA%\SlayTheSpire2 下找最新的 current_run.save（Steam/profile 目录都可能变）。 */
export function locate(): string | null {
  const home = process.env['APPDATA'];
  if (!home) return null;
  const root = join(home, 'SlayTheSpire2');
  let best: { path: string; mtime: number } | null = null;

  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      const full = join(dir, name);
      let stat;
      try { stat = statSync(full); } catch { continue; }
      if (stat.isDirectory()) {
        if (!SKIP.has(name.toLowerCase())) walk(full, depth + 1);
        continue;
      }
      if (name !== 'current_run.save') continue;
      if (!best || stat.mtimeMs > best.mtime) best = { path: full, mtime: stat.mtimeMs };
    }
  };

  walk(root, 0);
  return best ? (best as { path: string }).path : null;
}