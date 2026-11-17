import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentMode, CODEX_ADAPTER, agentArgs } from '../bin/lib/remote/codingAgents.mjs';

// Sự kiện thật của `codex exec --json` (bản 0.169, Windows, 17/11/2026).
const EVENTS = [
  { type: 'thread.started', thread_id: '01a1e9a4-d027-7e21-88d0-754c95f13211' },
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'I’ll create `hello.txt` with `hi`, then check Git status.\n' } },
  { type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'powershell.exe -Command \'Set-Content -LiteralPath hello.txt -Value hi\'', exit_code: null, status: 'in_progress' } },
  { type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'powershell.exe -Command \'Set-Content -LiteralPath hello.txt -Value hi\'', exit_code: 0, status: 'completed' } },
  { type: 'item.completed', item: { id: 'item_3', type: 'agent_message', text: 'DONE' } },
  { type: 'turn.completed', usage: { input_tokens: 46606, cached_input_tokens: 43008, output_tokens: 119 } },
];

test('Codex: sửa tệp = --approve-for-me (sandbox workspace-write + tự duyệt), chỉ đọc = -s read-only; đề bài qua stdin; không nạp cấu hình / luật của người dùng', () => {
  const edit = agentArgs(CODEX_ADAPTER, { mode: AgentMode.ACCEPT_EDITS, addDirs: ['C:\\jobs\\codex-1'], model: 'gpt-5.5', effort: 'max' });
  assert.deepEqual(edit, ['exec', '--json', '--ignore-user-config', '--ignore-rules', '--approve-for-me', '--add-dir', 'C:\\jobs\\codex-1', '-m', 'gpt-5.5', '-c', 'model_reasoning_effort="high"', '-']);
  assert.ok(!edit.includes('-s'), '--approve-for-me không đi cùng --sandbox (codex từ chối)');
  assert.deepEqual(agentArgs(CODEX_ADAPTER, { mode: AgentMode.PLAN }).slice(4), ['-s', 'read-only', '-']);
  assert.deepEqual(agentArgs(CODEX_ADAPTER, { mode: AgentMode.MANUAL }).slice(4), ['-s', 'read-only', '-']);
  // Cờ phải có trong `codex exec --help` của bản đã cài.
  assert.throws(() => agentArgs(CODEX_ADAPTER, { mode: AgentMode.ACCEPT_EDITS }, new Set(['--json'])), /too old/);
  assert.equal(CODEX_ADAPTER.selfWorktree, false);
  assert.equal(CODEX_ADAPTER.resumable, false);
});

test('Codex: đọc sự kiện thật — mã phiên, chữ, lệnh đã chạy, kết quả', () => {
  const job = { texts: [], tools: [], result: null };
  const shown = EVENTS.map((m) => CODEX_ADAPTER.parse(job, m)).filter(Boolean);
  assert.equal(job.session_id, '01a1e9a4-d027-7e21-88d0-754c95f13211');
  assert.deepEqual(job.texts.at(-1), 'DONE');
  assert.equal(job.tools.length, 1);
  assert.match(job.tools[0], /^🔧 command_execution powershell/);
  assert.equal(shown.length, 3);
  assert.deepEqual(job.result, { ok: true, answer: 'DONE', usage: { input_tokens: 46606, output_tokens: 119 } });
  const failed = { texts: [], tools: [], result: null };
  CODEX_ADAPTER.parse(failed, { type: 'turn.failed', error: { message: 'You have hit your usage limit' } });
  assert.deepEqual(failed.result, { ok: false, answer: 'You have hit your usage limit', stop_reason: 'error' });
});
