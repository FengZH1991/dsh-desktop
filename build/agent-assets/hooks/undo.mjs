#!/usr/bin/env node
/**
 * 文件级 undo 回滚工具（配合 pre-edit-snapshot.mjs）。
 *
 * 用法：
 *   node undo.mjs list [workspace]              # 列出最近快照
 *   node undo.mjs revert <file> [workspace]     # 把 file 回滚到最近一次快照
 *   node undo.mjs revert-last [workspace]       # 回滚最近一次快照对应的文件
 *
 * 若文件在快照时并不存在（首次创建），revert 会删除该文件。
 */
import { existsSync, readFileSync, copyFileSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const [cmd, arg1, arg2] = process.argv.slice(2);

function loadIndex(workspace) {
  const indexPath = join(workspace, '.dsh-undo', 'index.jsonl');
  if (!existsSync(indexPath)) return [];
  return readFileSync(indexPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function usage() {
  console.error('usage: undo.mjs list [workspace] | revert <file> [workspace] | revert-last [workspace]');
  process.exit(2);
}

if (!cmd) usage();
const workspace = resolve(cmd === 'revert' ? arg2 || '.' : arg1 || '.');
const entries = loadIndex(workspace);

if (cmd === 'list') {
  const recent = entries.slice(-20).reverse();
  if (!recent.length) {
    console.log('(无快照记录)');
    process.exit(0);
  }
  for (const e of recent) console.log(`${e.ts}  ${e.tool ?? '?'}  ${e.file}`);
  process.exit(0);
}

let target;
if (cmd === 'revert') {
  if (!arg1) usage();
  const abs = resolve(workspace, arg1);
  target = [...entries].reverse().find((e) => e.file === abs);
  if (!target) {
    console.error(`未找到该文件的快照: ${abs}`);
    process.exit(1);
  }
} else if (cmd === 'revert-last') {
  target = entries[entries.length - 1];
  if (!target) {
    console.error('无快照记录');
    process.exit(1);
  }
} else {
  usage();
}

const snapContent = join(target.snapshot, 'content');
if (existsSync(snapContent)) {
  mkdirSync(dirname(target.file), { recursive: true });
  copyFileSync(snapContent, target.file);
  console.log(`已回滚 ${target.file} 到 ${target.ts} 的快照`);
} else {
  // 快照记录存在但内容缺失，或文件当时不存在 → 删除
  rmSync(target.file, { force: true });
  console.log(`已删除 ${target.file}（快照前该文件不存在）`);
}
