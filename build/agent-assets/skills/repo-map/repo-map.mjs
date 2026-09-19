#!/usr/bin/env node
/**
 * repo-map：仓库符号地图（借鉴 aider repo map 的简化版）。
 *
 * 用 ast-grep 提取各文件的顶层符号定义，按"被引用次数"排序，
 * 在预算内输出一份符号清单，帮助 agent 快速建立项目结构认知。
 *
 * 用法：
 *   node repo-map.mjs [目录] [--budget 200] [--lang ts,python]
 *
 * 输出：按文件分组的高价值符号清单（定义处 + 引用数），截断到 --budget 行。
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const args = process.argv.slice(2);
const root = resolve(args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--budget' && args[args.indexOf(a) - 1] !== '--lang') || '.');
const budgetIdx = args.indexOf('--budget');
const budget = budgetIdx >= 0 ? Number(args[budgetIdx + 1]) || 200 : 200;
const langIdx = args.indexOf('--lang');
const langArg = langIdx >= 0 ? args[langIdx + 1] : 'ts,tsx,js,jsx,python';

if (!existsSync(root)) {
  console.error(`目录不存在: ${root}`);
  process.exit(2);
}

// 各语言的"顶层定义" ast-grep 规则（kind 级匹配，不依赖具体语法文本）
const RULES = {
  ts: { lang: 'TypeScript', kinds: ['function_declaration', 'class_declaration', 'interface_declaration', 'type_alias_declaration', 'enum_declaration', 'method_definition'] },
  tsx: { lang: 'Tsx', kinds: ['function_declaration', 'class_declaration', 'interface_declaration', 'type_alias_declaration', 'enum_declaration', 'method_definition'] },
  js: { lang: 'JavaScript', kinds: ['function_declaration', 'class_declaration', 'method_definition'] },
  jsx: { lang: 'JavaScript', kinds: ['function_declaration', 'class_declaration', 'method_definition'] },
  python: { lang: 'Python', kinds: ['function_definition', 'class_definition'] },
};

function extractSymbols(langKey, cfg) {
  // 每种 kind 单独跑一条 pattern 太啰嗦；用 YAML 规则一次扫
  const rule = {
    id: `repo-map-${langKey}`,
    language: cfg.lang,
    rule: { any: cfg.kinds.map((kind) => ({ kind })) },
  };
  const ruleJson = JSON.stringify(rule);
  let out;
  try {
    out = execFileSync(
      'ast-grep',
      ['scan', '--inline-rules', ruleJson, '--json=compact', root],
      { maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] },
    ).toString('utf8');
  } catch (e) {
    // 该语言无匹配或目录无此类文件
    return [];
  }
  let matches;
  try { matches = JSON.parse(out); } catch { return []; }
  return matches
    .map((m) => {
      // 符号名：匹配节点里第一个 identifier/property_identifier/type_identifier 子节点
      const nameNode = (m.metaVariables?.NAME?.text) || findName(m);
      return nameNode ? { file: relative(root, m.file), name: nameNode, line: m.range?.start?.line ?? 0 } : null;
    })
    .filter(Boolean);
}

function findName(match) {
  // ast-grep compact JSON 不带语法树细节时，从文本里提取第一个标识符
  const text = match.text || '';
  const m = text.match(/(?:function|class|interface|type|enum|def)\s+([A-Za-z_$][\w$]*)/);
  return m?.[1];
}

function countRefs(name, files) {
  let n = 0;
  try {
    const out = execFileSync(
      'grep', ['-roh', `\\b${name}\\b`, ...files],
      { maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] },
    ).toString('utf8');
    n = out.split('\n').filter(Boolean).length;
  } catch { /* grep 无匹配时 exit 1 */ }
  return Math.max(0, n - 1); // 减去定义处自身
}

const allSymbols = [];
for (const [key, cfg] of Object.entries(RULES)) {
  if (!langArg.split(',').some((l) => l.trim() === key)) continue;
  allSymbols.push(...extractSymbols(key, cfg));
}

// 去重（同名同行）
const seen = new Set();
const symbols = allSymbols.filter((s) => {
  const k = `${s.file}:${s.line}:${s.name}`;
  return seen.has(k) ? false : (seen.add(k), true);
});

// 引用计数（按文件分组收集文件列表，减少 grep 调用）
const filesByExt = [...new Set(symbols.map((s) => s.file))].map((f) => resolve(root, f));
for (const s of symbols) s.refs = countRefs(s.name, filesByExt);

// 按引用数排序，预算内输出
symbols.sort((a, b) => b.refs - a.refs);
const byFile = new Map();
let lines = 0;
for (const s of symbols) {
  if (lines >= budget) break;
  if (!byFile.has(s.file)) byFile.set(s.file, []);
  byFile.get(s.file).push(s);
  lines++;
}

console.log(`# Repo Map: ${root}（符号数 ${symbols.length}，按引用数排序，预算 ${budget} 行）\n`);
for (const [file, syms] of byFile) {
  console.log(`${file}:`);
  for (const s of syms) console.log(`  ${s.name}  (L${s.line + 1}, ${s.refs} refs)`);
}
