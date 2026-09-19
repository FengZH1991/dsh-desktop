#!/usr/bin/env node
/**
 * PostToolUse hook：Focus Chain 防漂移（借鉴 cline 的 Focus Chain）。
 *
 * 长任务中 agent 容易偏离原始目标。本 hook 统计每个会话的工具调用次数，
 * 每 N 次向对话注入一次"焦点检查"上下文，提醒 agent 对照 todo 列表与
 * 原始目标，确认当前工作未漂移。
 *
 * 输入：PostToolUse stdin JSON（session_id, tool_name）
 * 输出：静默放行；每 N 次输出 hookSpecificOutput.additionalContext
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const N = 15; // 每 15 次工具调用注入一次焦点提醒

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

try {
  const payload = JSON.parse(await readStdin());
  const sessionId = payload?.session_id || 'unknown';

  const stateDir = join(homedir(), '.dsh', 'hooks', '.focus-state');
  mkdirSync(stateDir, { recursive: true });
  const statePath = join(stateDir, `${sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);

  let state = { count: 0 };
  if (existsSync(statePath)) {
    try { state = JSON.parse(readFileSync(statePath, 'utf8')); } catch { /* 重置 */ }
  }
  state.count += 1;
  writeFileSync(statePath, JSON.stringify(state));

  if (state.count % N === 0) {
    const reminder = [
      `[Focus Chain] 本会话已执行 ${state.count} 次工具调用。请做一次焦点检查：`,
      '1. 重新查看你的 todo_write 任务列表，确认当前正在做的事与列表一致；',
      '2. 对照用户最初的请求/目标，确认没有偏离或过度扩展范围；',
      '3. 若发现漂移，立即纠正：更新 todo 列表，回到主线任务；',
      '4. 若 todo 列表已过期（完成的未标记、新增的未记录），先更新再继续。',
    ].join('\n');
    console.log(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: reminder },
    }));
  }
  process.exit(0);
} catch {
  process.exit(0); // 失败静默放行，绝不影响工具执行
}
