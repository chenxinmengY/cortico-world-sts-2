#!/usr/bin/env node
/**
 * 重新生成 THIRD_PARTY_NOTICES.md 里 devDependencies 那一节。
 *
 * 只写两个标记之间的内容，其余手写部分原样保留 —— 这份文件一大半是
 * 「借用了什么、怎么用的」，机器生成不了。
 *
 * 用法：pnpm notices
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const noticesPath = join(root, 'THIRD_PARTY_NOTICES.md');
const BEGIN = '<!-- deps:begin 由 scripts/gen-notices.mjs 生成，勿手改 -->';
const END = '<!-- deps:end -->';

/** @type {Record<string, unknown>} */
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const deps = Object.keys(pkg.devDependencies ?? {});

/** 已知的补充说明：许可证字段缺失或需要额外解释时用 */
const NOTES = {
  typescript: '编译器',
  vitest: '单元测试',
  tsx: '跑 TS 脚本',
  '@types/node': 'Node 类型声明',
  cortico: '宿主 SDK，只用类型与接口',
};

function readLicense(name) {
  const dir = join(root, 'node_modules', name);
  const pj = join(dir, 'package.json');
  if (!existsSync(pj)) return { version: '未安装', license: '未知' };
  const meta = JSON.parse(readFileSync(pj, 'utf8'));
  let license = meta.license;
  if (!license && meta.licenses) license = meta.licenses.map((l) => l.type).join(', ');
  return { version: meta.version ?? '?', license: license ?? '见其仓库' };
}

const rows = deps.map((name) => {
  const { version, license } = readLicense(name);
  const note = NOTES[name] ?? '';
  const url = name.startsWith('@types/')
    ? `https://github.com/DefinitelyTyped/DefinitelyTyped`
    : `https://www.npmjs.com/package/${name}`;
  return `| [${name}](${url}) ${version} | ${note} | ${license} |`;
});

const block = [BEGIN, '| 名称 | 用途 | 许可证 |', '|---|---|---|', ...rows, END].join('\n');

if (!existsSync(noticesPath)) {
  console.error('找不到 THIRD_PARTY_NOTICES.md');
  process.exit(1);
}

const text = readFileSync(noticesPath, 'utf8');
const start = text.indexOf(BEGIN);
const end = text.indexOf(END);
if (start === -1 || end === -1) {
  console.error('THIRD_PARTY_NOTICES.md 里缺少 deps:begin / deps:end 标记');
  process.exit(1);
}
const next = text.slice(0, start) + block + text.slice(end + END.length);
if (next === text) {
  console.log('依赖清单没有变化');
  process.exit(0);
}
writeFileSync(noticesPath, next, 'utf8');
console.log(`已更新 ${rows.length} 个开发依赖：`);
for (const row of rows) console.log('  ' + row);