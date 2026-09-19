#!/usr/bin/env node
/**
 * PreToolUse hook：文件级 undo 快照（借鉴 opencode 的 snapshot+revert）。
 *
 * 在 edit / write / str-replace 类工具执行前，把目标文件复制到
 * <workspace>/.dsh-undo/snapshots/<ts>__<hash>/ ，并向 .dsh-undo/index.jsonl
 * 追加一条记录。工具执行后文件被修改，快照保留了修改前的内容，
 * 可用 undo.mjs 回滚。
 *
 * 输入：Claude Code 格式的 PreToolUse stdin JSON（tool_name, tool_input.file_path）
 * 输出：退出码 0 = 放行；永不阻塞工具执行（快照失败只告警）。
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, appendFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const MAX_SNAPSHOTS = 200; // 每工作区保留的快照上限

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function prune(undoDir) {
  const snapDir = join(undoDir, 'snapshots');
  if (!existsSync(snapDir)) return;
  const entries = readdirSync(snapDir)
    .map((name) => ({ name, mtime: statSync(join(snapDir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const old of entries.slice(MAX_SNAPSHOTS)) {
    rmSync(join(snapDir, old.name), { recursive: true, force: true });
  }
}

try {
  const payload = JSON.parse(await readStdin());
  const filePath = payload?.tool_input?.file_path;
  if (!filePath || typeof filePath !== 'string') process.exit(0);

  const abs = resolve(payload.cwd || process.cwd(), filePath);
  if (!existsSync(abs)) process.exit(0); // 新文件无需快照（revert 即删除）

  const projectDir = process.env.CLAUDE_PROJECT_DIR || payload.cwd || process.cwd();
  const undoDir = join(projectDir, '.dsh-undo');
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const hash = createHash('sha1').update(abs).digest('hex').slice(0, 8);
  const snapDir = join(undoDir, 'snapshots', `${ts}__${hash}`);
  mkdirSync(snapDir, { recursive: true });

  copyFileSync(abs, join(snapDir, 'content'));

  appendFileSync(
    join(undoDir, 'index.jsonl'),
    JSON.stringify({
      ts: new Date().toISOString(),
      file: abs,
      snapshot: snapDir,
      tool: payload.tool_name,
      session: payload.session_id || null,
    }) + '\n',
  );

  prune(undoDir);
  process.exit(0);
} catch (err) {
  // 快照失败不阻塞工具：stderr 告警后放行
  process.stderr.write(`[file-undo] snapshot failed: ${err?.message ?? err}\n`);
  process.exit(0);
}
