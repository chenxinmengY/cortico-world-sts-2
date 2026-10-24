/**
 * 生成 describe.json：从定义的 describe 与提示词模板文件拼出扩展自描述。
 * 与框架 `pnpm describe:extension` 的产物同形（tools / events / prompts），
 * 这样不依赖框架 CLI 也能保持一致。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { STS2 } from '../src/definition.ts';

const promptPath = fileURLToPath(new URL('../src/ENV_PROMPT.md', import.meta.url));
const file = {
  tools: STS2.describe.tools.map((tool) => ({ ...tool })),
  events: STS2.describe.events.map((event) => ({ ...event })),
  prompts: [{
    key: 'worlds.sts-2.envPrompt',
    title: '杀戮尖塔 2 · 环境提示词',
    role: 'envPrompt',
    content: readFileSync(promptPath, 'utf8'),
  }],
};

// 经一次 JSON 往返，与框架读回文件后的比较口径一致。
const normalized = JSON.parse(JSON.stringify(file));
writeFileSync(new URL('../describe.json', import.meta.url), JSON.stringify(normalized, null, 2) + '\n');
console.log(`describe.json: ${normalized.tools.length} tools, ${normalized.events.length} events, ${normalized.prompts.length} prompt`);