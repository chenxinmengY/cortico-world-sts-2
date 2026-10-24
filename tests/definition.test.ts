import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { WorldContext } from 'cortico/world.ts';
import { STS2 } from '../src/definition.ts';
import type { Sts2ConfigSection } from '../src/config.ts';

function fakeContext(): WorldContext<Sts2ConfigSection> {
  return {
    id: 'sts-2',
    cfg: STS2.defaults(),
    timezone: 'Asia/Shanghai',
    botName: 'Coo',
    botDir: '/tmp/bot',
    packageDir: '/tmp/pkg',
    dataDir: '/tmp/data',
    repoRoot: '/tmp/repo',
    secret: () => '',
    storeSecret: () => {},
    persist: () => {},
    restart: async () => {},
  };
}

describe('扩展契约', () => {
  it('构造得出来，id 与契约版本对得上', () => {
    const world = STS2.create(fakeContext());
    expect(world.id).toBe('sts-2');
    expect(STS2.id).toBe('sts-2');
    expect(STS2.defaults().enabled).toBe(false);
  });

  it('实例给的工具与自描述一致', () => {
    const world = STS2.create(fakeContext());
    const live = world.tools();
    const declared = STS2.describe!.tools;
    const liveNames = live.map((tool) => tool.name);
    // 实例只返回子集：观察和排障默认不暴露，自描述里仍然列全。
    expect(declared.map((tool) => tool.name)).toEqual(expect.arrayContaining(liveNames));
    expect(liveNames).toContain('sts2_inspect');
    expect(liveNames).toContain('sts2_observe');
    expect(liveNames).not.toContain('sts2_probe');
    for (const tool of live) {
      expect(tool.parameters).toMatchObject({ type: 'object' });
      expect(typeof tool.handler).toBe('function');
      expect(tool.tags.length).toBeGreaterThan(0);
    }
  });

  it('WebUI 声明里有配置组和能打开的提示词模板', () => {
    const world = STS2.create(fakeContext());
    const ui = world.webUi?.('zh');
    expect(ui?.config?.[0]?.id).toBe('world:sts-2');
    const doc = ui?.promptDocs?.[0];
    expect(doc?.key).toBe('worlds.sts-2.envPrompt');
    expect(doc?.role).toBe('envPrompt');
    expect(doc && existsSync(doc.path)).toBe(true);
    expect(ui?.lamps?.length).toBeGreaterThan(0);
  });

  it('自描述的每个事件都有中英说明与触发方式', () => {
    for (const event of STS2.describe!.events) {
      expect(event.type).toMatch(/^sts-2\./);
      expect(event.description).toHaveProperty('zh');
      expect(event.description).toHaveProperty('en');
      expect(event.trigger).toBe('flush');
    }
  });
});