/**
 * 回档判定：把"层数/幕数/已走节点"这类只增不减的量做成护照，再叠上存档里的读档次数。
 * 相比旧版（层数 + 同层回满血），这里去掉了一个确定的误报源：
 * 篝火休息把血补满不是回档。真的补满血只可能是读档，而读档有更硬的证据（num_reloads）。
 */
import { bool, list, pick, type Fields, type NormSnapshot } from './protocol.ts';
import type { SaveFacts } from './savefile.ts';

export type VerdictKind = 'new-run' | 'reload' | 'rollback' | 'drift';

export interface Verdict {
  kind: VerdictKind;
  reason: string;
  generation: number;
}

interface Mark {
  runId: string;
  act: number | null;
  floor: number | null;
  visited: number;
  /** 这一帧里地图块有多少节点；战斗/奖励帧没有地图块，visited 不可比。 */
  mapNodes: number;
  relics: string;
  gold: number | null;
  maxHp: number | null;
  deck: number;
  seed: string;
  reloads: number;
}

function relicSet(snapshot: NormSnapshot): string {
  const names = (snapshot.game.relics ?? [])
    .map((relic) => String(pick(relic, 'name', 'relicId') ?? ''))
    .filter(Boolean)
    .sort();
  return names.join(',');
}

/** 这一幕已走过的节点数（跨幕会重建地图，所以只在同幕内比）。 */
function mapStats(snapshot: NormSnapshot): { visited: number; nodes: number } {
  const map = snapshot.blocks['map'] as Fields | undefined;
  if (!map) return { visited: 0, nodes: 0 };
  const nodes = list(pick(map, 'nodes'));
  return { visited: nodes.filter((node) => bool(pick(node, 'visited'))).length, nodes: nodes.length };
}

function mark(snapshot: NormSnapshot, save: SaveFacts | null): Mark {
  const map = mapStats(snapshot);
  return {
    runId: snapshot.sessionId,
    act: snapshot.game.act,
    floor: snapshot.game.floor,
    visited: map.visited,
    mapNodes: map.nodes,
    relics: relicSet(snapshot),
    gold: snapshot.game.gold,
    maxHp: snapshot.game.maxHp,
    deck: snapshot.game.deck.length,
    seed: save?.seed ?? '',
    reloads: save ? save.numReloads : -1,
  };
}

const REAL_RUN = (id: string): boolean => Boolean(id) && id !== 'sts2' && id !== 'run_unknown';

export class PassportTracker {
  private last: Mark | null = null;
  private gen = 0;

  get generation(): number {
    return this.gen;
  }

  reset(): void {
    this.last = null;
  }

  observe(snapshot: NormSnapshot, save: SaveFacts | null): Verdict | null {
    const next = mark(snapshot, save);
    const prev = this.last;
    this.last = next;
    if (!prev) return null;

    if (prev.runId !== next.runId && (REAL_RUN(prev.runId) || REAL_RUN(next.runId))) {
      return this.verdict('new-run', `已开始新的一局（${next.runId}）`);
    }

    // 存档里的 seed 是这局的身份证：它变了就是换局，不是回档。
    if (prev.seed && next.seed && prev.seed !== next.seed) {
      return this.verdict('new-run', `seed 从 ${prev.seed} 换成 ${next.seed}`);
    }

    if (next.reloads >= 0 && prev.reloads >= 0 && next.reloads > prev.reloads) {
      // 返回大厅、重开游戏也会 +1，但局面没变的话不值得作废任何东西。
      const same = sameProgress(prev, next);
      return same ? null : this.verdict('reload', `检测到读档（读档次数 ${prev.reloads}→${next.reloads}）`);
    }

    if (prev.act !== null && next.act !== null && next.act < prev.act) {
      return this.verdict('rollback', `幕数从 ${prev.act} 退回 ${next.act}`);
    }
    if (prev.floor !== null && next.floor !== null && next.floor < prev.floor) {
      return this.verdict('rollback', `层级从 ${prev.floor} 退回 ${next.floor}`);
    }
    // 只有两边都带地图块时才比：战斗/奖励帧没有 map 块，把它当"退回 0"会误报。
    if (prev.act === next.act && prev.mapNodes > 0 && next.mapNodes > 0
      && prev.visited > 0 && next.visited < prev.visited) {
      return this.verdict('rollback', `这一幕走过的节点从 ${prev.visited} 退回 ${next.visited}`);
    }

    // 下面这些都有合法解释（买东西、删牌、事件），单独一条不打断，凑够两条才算"对不上"。
    const drift: string[] = [];
    if (prev.relics && next.relics.length < prev.relics.length) drift.push('遗物变少');
    if (prev.gold !== null && next.gold !== null && next.gold < prev.gold) drift.push(`金币 ${prev.gold}→${next.gold}`);
    if (next.deck < prev.deck) drift.push(`牌组 ${prev.deck}→${next.deck}`);
    if (prev.maxHp !== null && next.maxHp !== null && next.maxHp < prev.maxHp) drift.push(`生命上限 ${prev.maxHp}→${next.maxHp}`);
    if (drift.length >= 2) return this.verdict('drift', drift.join('，'));
    return null;
  }

  private verdict(kind: VerdictKind, reason: string): Verdict {
    if (kind !== 'drift') this.gen++;
    return { kind, reason, generation: this.gen };
  }
}

/** 读档后如果位置、金币、牌组都没变，就当"去大厅转了一圈"。 */
function sameProgress(prev: Mark, next: Mark): boolean {
  const sameVisited = prev.mapNodes > 0 && next.mapNodes > 0 ? prev.visited === next.visited : true;
  return prev.act === next.act
    && prev.floor === next.floor
    && sameVisited
    && prev.gold === next.gold
    && prev.deck === next.deck
    && prev.relics === next.relics;
}