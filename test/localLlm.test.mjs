import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import {
  ANTIGRAVITY_LLM, CLAUDE_LLM, CODEX_LLM, QUOTA_ERROR, TOOL_USE_ERROR,
  buildLocalLlmTools, createLocalLlm, extractJson, pickAgyModel, renderRequest,
} from '../bin/lib/remote/localLlm.mjs';

const dir = path.join(os.tmpdir(), 'aivin-llm-test');
const tick = () => new Promise((r) => setImmediate(r));

/** Tiến trình giả: `onInput(child, chunk)` nhận stdin, trả lời bằng child.out(obj). */
function fakeSpawn(onInput) {
  const spawned = [];
  const spawnImpl = (bin, argv, opts) => {
    const child = new EventEmitter();
    Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, killed: false, bin, argv, opts, input: '' });
    child.out = (obj) => setImmediate(() => child.stdout.write(`${JSON.stringify(obj)}\n`));
    child.kill = () => { if (child.killed) return; child.killed = true; child.exitCode = 0; setImmediate(() => child.emit('exit', 0)); };
    child.stdin.on('data', (d) => { child.input += d; onInput(child, String(d)); });
    child.stdin.on('finish', () => onInput(child, null));
    spawned.push(child);
    return child;
  };
  return { spawnImpl, spawned };
}

const adapter = (base, over = {}) => ({ ...base, find: () => ({ bin: base.id, version: '1.0.0' }), ...(base.probe ? { probe: async () => ({ disable: ['code_mode_host', 'shell_tool'] }) } : {}), ...over });
const make = (adapters, onInput) => {
  const f = fakeSpawn(onInput);
  return { ...f, llm: createLocalLlm({ adapters, spawnImpl: f.spawnImpl, dir, version: async () => '1.0.0' }) };
};

// --- Claude Code (stream-json) -----------------------------------------------------------------------------------------------------------
const ev = (event) => ({ type: 'stream_event', event });
function claudeReply(child, text, { tool = false } = {}) {
  child.out(ev({ type: 'message_start', message: { model: 'claude-sonnet-x' } }));
  if (tool) return child.out(ev({ type: 'content_block_start', content_block: { type: 'tool_use', name: 'Read' } }));
  for (const t of text.match(/.{1,3}/gs)) child.out(ev({ type: 'content_block_delta', delta: { type: 'text_delta', text: t } }));
  child.out(ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 10, output_tokens: 3 } }));
  child.out(ev({ type: 'message_stop' }));
}

test('Claude args: no tools, no project settings, no session; never a permission bypass', () => {
  const a = CLAUDE_LLM.args({ model: 'sonnet', effort: 'low' });
  assert.deepEqual(a.slice(a.indexOf('--tools'), a.indexOf('--tools') + 2), ['--tools', '']);
  assert.deepEqual(a.slice(a.indexOf('--setting-sources'), a.indexOf('--setting-sources') + 2), ['--setting-sources', '']);
  for (const f of ['--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands', '--include-partial-messages']) assert.ok(a.includes(f), f);
  assert.deepEqual(a.slice(-4), ['--model', 'sonnet', '--effort', 'low']);
  for (const x of [...a, ...CODEX_LLM.args({ cwd: dir }), ...ANTIGRAVITY_LLM.args()]) assert.doesNotMatch(x, /skip-permissions|bypass|danger/i);
});

test('Codex args: exec read-only, ephemeral, no user config, tool features disabled, model + effort', () => {
  const a = CODEX_LLM.args({ model: 'gpt-6.1-sol', effort: 'high', cwd: dir, probe: { disable: ['code_mode_host', 'shell_tool'] } });
  assert.equal(a[0], 'exec');
  for (const f of ['--json', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check']) assert.ok(a.includes(f), f);
  assert.deepEqual(a.slice(a.indexOf('-s'), a.indexOf('-s') + 2), ['-s', 'read-only']);
  assert.deepEqual(a.slice(a.indexOf('-C'), a.indexOf('-C') + 2), ['-C', dir]);
  assert.ok(a.join(' ').includes('--disable code_mode_host --disable shell_tool'));
  assert.ok(a.join(' ').includes('-m gpt-6.1-sol'));
  assert.ok(a.includes('model_reasoning_effort="high"'));
  assert.equal(a.at(-1), '-', 'prompt from stdin');
});

test('pickAgyModel: exact id, family + effort, nearest effort, unknown', () => {
  const ids = ['gemini-3.8-flash-low', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-high', 'gemini-4-hydrogen-xhigh', 'gemini-4-hydrogen-low'].map((modelId) => ({ modelId }));
  assert.equal(pickAgyModel(ids, 'gemini-3.8-flash-high', 'low'), 'gemini-3.8-flash-high');
  assert.equal(pickAgyModel(ids, 'gemini-3.8-flash', 'medium'), 'gemini-3.8-flash-medium');
  assert.equal(pickAgyModel(ids, 'gemini-3.8-flash', 'max'), 'gemini-3.8-flash-high');
  assert.equal(pickAgyModel(ids, 'gemini-4-hydrogen', 'high'), 'gemini-4-hydrogen-xhigh');
  assert.equal(pickAgyModel(ids, 'gemini-9', 'low'), null);
  assert.equal(pickAgyModel(ids, '', 'low'), 'gemini-3.8-flash-low');
  assert.equal(pickAgyModel([], 'x', 'low'), null);
});

test('renderRequest: instructions, history, last user turn, schema; base rules for agents without a system flag', () => {
  const text = renderRequest({
    system: 'Be brief.',
    messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }, { role: 'user', content: 'sum 2+2' }],
    json_schema: { type: 'object' },
  });
  assert.match(text, /<instructions>\nBe brief\.\n<\/instructions>/);
  assert.match(text, /<conversation>\n<user>\nhi\n<\/user>\n<assistant>\nhello\n<\/assistant>\n<\/conversation>/);
  assert.match(text, /<request>\nsum 2\+2\n<\/request>/);
  assert.match(text, /JSON Schema/);
  assert.equal(renderRequest({ prompt: 'just this' }), 'just this');
  assert.match(renderRequest({ prompt: 'x' }, { withBase: true }), /^<rules>\n.*must not call any/s);
  assert.throws(() => renderRequest({ messages: [{ role: 'assistant', content: 'x' }] }), /prompt/);
});

test('extractJson: plain, fenced, with prose, broken', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":[1,2]}\n```'), { a: [1, 2] });
  assert.deepEqual(extractJson('Here: {"a":2} done'), { a: 2 });
  assert.equal(extractJson('nope'), null);
});

test('Claude: streams deltas, answers at message_stop, one process per call, the next call is warm', async () => {
  const { llm, spawned } = make([adapter(CLAUDE_LLM)], (child, d) => { if (d) claudeReply(child, 'pong pong'); });
  const chunks = [];
  const out = await llm.complete({ prompt: 'ping', model: 'sonnet', effort: 'low' }, { onOutput: (s, c) => chunks.push([s, c]) });
  assert.equal(out.text, 'pong pong');
  assert.equal(chunks.map((c) => c[1]).join(''), 'pong pong');
  assert.ok(chunks.every((c) => c[0] === 'stdout'));
  assert.deepEqual([out.agent, out.model, out.stop_reason, out.warm_start], ['claude', 'claude-sonnet-x', 'end_turn', false]);
  assert.deepEqual(out.usage, { input_tokens: 10, output_tokens: 3 });
  await tick(); await tick();
  assert.equal(spawned.length, 2, 'a replacement is kept warm');
  assert.equal(spawned[0].killed, true);
  assert.equal(JSON.parse(spawned[0].input).message.content, 'ping');
  assert.equal(spawned[0].opts.cwd, dir);
  const out2 = await llm.complete({ prompt: 'again', model: 'sonnet', effort: 'low' });
  assert.equal(out2.warm_start, true);
  assert.equal(JSON.parse(spawned[1].input).message.content, 'again');
  llm.stopAll();
});

test('Claude: a tool_use block discards the answer (LOCAL_LLM_TOOL_USE)', async () => {
  const { llm, spawned } = make([adapter(CLAUDE_LLM)], (child, d) => { if (d) claudeReply(child, '', { tool: true }); });
  await assert.rejects(llm.complete({ prompt: 'read my files' }), { code: TOOL_USE_ERROR });
  assert.equal(spawned[0].killed, true);
  llm.stopAll();
});

// --- Codex (exec --json) -----------------------------------------------------------------------------------------------------------------
test('Codex: prompt on stdin then EOF; the LAST agent_message is the answer; usage from turn.completed', async () => {
  const { llm, spawned } = make([adapter(CODEX_LLM)], (child, d) => {
    if (d !== null) return;
    child.out({ type: 'thread.started' });
    child.out({ type: 'item.completed', item: { type: 'error', message: 'Code Mode is unavailable' } });
    child.out({ type: 'item.completed', item: { type: 'agent_message', text: 'Working on it…' } });
    child.out({ type: 'item.completed', item: { type: 'agent_message', text: '{"ok":true}' } });
    child.out({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 5 } });
  });
  const chunks = [];
  const out = await llm.complete({ agent: 'codex', system: 'S', prompt: 'x', model: 'gpt-6.1-sol', effort: 'medium', json_schema: { type: 'object' } }, { onOutput: (_s, c) => chunks.push(c) });
  assert.equal(out.text, '{"ok":true}');
  assert.deepEqual(out.json, { ok: true });
  assert.deepEqual(chunks, ['{"ok":true}']);
  assert.deepEqual(out.usage, { input_tokens: 100, output_tokens: 5 });
  assert.match(spawned[0].input, /^<rules>[\s\S]*<instructions>\nS\n<\/instructions>[\s\S]*<request>\nx\n<\/request>/);
  assert.ok(spawned[0].argv.includes('--disable'));
  llm.stopAll();
});

test('Codex: any tool item (started or completed) → LOCAL_LLM_TOOL_USE; turn.failed with a limit → QUOTA', async () => {
  let { llm } = make([adapter(CODEX_LLM)], (child, d) => { if (d === null) child.out({ type: 'item.started', item: { type: 'command_execution', command: 'type secret.txt' } }); });
  await assert.rejects(llm.complete({ agent: 'codex', prompt: 'x' }), { code: TOOL_USE_ERROR });
  llm.stopAll();
  ({ llm } = make([adapter(CODEX_LLM)], (child, d) => { if (d === null) child.out({ type: 'item.completed', item: { type: 'web_search', query: 'q' } }); }));
  await assert.rejects(llm.complete({ agent: 'codex', prompt: 'x' }), { code: TOOL_USE_ERROR });
  llm.stopAll();
  ({ llm } = make([adapter(CODEX_LLM)], (child, d) => { if (d === null) child.out({ type: 'turn.failed', error: { message: 'You hit your usage limit' } }); }));
  await assert.rejects(llm.complete({ agent: 'codex', prompt: 'x' }), { code: QUOTA_ERROR });
  llm.stopAll();
});

// --- Antigravity (ACP) -------------------------------------------------------------------------------------------------------------------
/** Máy chủ ACP giả. `behave(child, prompt, reply)` chạy khi nhận session/prompt. */
function acpServer(behave, { models = ['gemini-3.8-flash-low', 'gemini-3.8-flash-medium'] } = {}) {
  const calls = [];
  const onInput = (child, d) => {
    if (!d) return;
    for (const line of d.split('\n').filter(Boolean)) {
      const m = JSON.parse(line);
      calls.push({ ...m, child });
      const reply = (result) => child.out({ jsonrpc: '2.0', id: m.id, result });
      if (m.method === 'initialize') reply({ protocolVersion: 1 });
      if (m.method === 'session/new') reply({ sessionId: 'S1', models: { currentModelId: models[0], availableModels: models.map((modelId) => ({ modelId })) } });
      if (m.method === 'session/set_model') reply({});
      if (m.method === 'session/prompt') behave(child, m, reply);
    }
  };
  return { onInput, calls };
}
const chunk = (child, text) => child.out({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'S1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });

test('Antigravity: ACP session opened ahead, model picked by effort, chunks streamed, usage from the prompt result', async () => {
  const srv = acpServer((child, m, reply) => { chunk(child, 'po'); chunk(child, 'ng\n'); setImmediate(() => setImmediate(() => reply({ stopReason: 'end_turn', usage: { inputTokens: 50, outputTokens: 2 } }))); });
  const { llm, spawned } = make([adapter(ANTIGRAVITY_LLM)], srv.onInput);
  const chunks = [];
  const out = await llm.complete({ agent: 'antigravity', prompt: 'ping', model: 'gemini-3.8-flash', effort: 'medium' }, { onOutput: (_s, c) => chunks.push(c) });
  assert.equal(out.text, 'pong');
  assert.equal(chunks.join(''), 'pong\n');
  assert.equal(out.model, 'gemini-3.8-flash-medium');
  assert.deepEqual(out.usage, { input_tokens: 50, output_tokens: 2 });
  assert.deepEqual(spawned[0].argv, ['acp', '--disable-telemetry']);
  const first = srv.calls.filter((c) => c.child === spawned[0]);
  assert.deepEqual(first.map((c) => c.method), ['initialize', 'session/new', 'session/set_model', 'session/prompt']);
  assert.deepEqual(first[0].params.clientCapabilities, { fs: { readTextFile: false, writeTextFile: false }, terminal: false });
  assert.deepEqual(first[1].params.mcpServers, []);
  assert.equal(first[2].params.modelId, 'gemini-3.8-flash-medium');
  assert.match(first[3].params.prompt[0].text, /^<rules>/);
  llm.stopAll();
});

test('Antigravity: permission request is rejected and the answer discarded; tool_call notification too; quota text → QUOTA', async () => {
  let srv = acpServer((child) => child.out({ jsonrpc: '2.0', id: 99, method: 'session/request_permission', params: { toolCall: { name: 'run_command' }, options: [{ optionId: 'allow', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }] } }));
  let made = make([adapter(ANTIGRAVITY_LLM)], srv.onInput);
  await assert.rejects(made.llm.complete({ agent: 'antigravity', prompt: 'x' }), { code: TOOL_USE_ERROR });
  await tick();
  const answer = made.spawned[0].input.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.id === 99);
  assert.deepEqual(answer.result, { outcome: { outcome: 'selected', optionId: 'no' } });
  made.llm.stopAll();

  srv = acpServer((child) => child.out({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'tool_call', name: 'read_file' } } }));
  made = make([adapter(ANTIGRAVITY_LLM)], srv.onInput);
  await assert.rejects(made.llm.complete({ agent: 'antigravity', prompt: 'x' }), { code: TOOL_USE_ERROR });
  made.llm.stopAll();

  srv = acpServer((child, m, reply) => { chunk(child, '\n⚠ Individual quota reached. Resets in 147h.\n'); setImmediate(() => setImmediate(() => reply({ stopReason: 'end_turn' }))); });
  made = make([adapter(ANTIGRAVITY_LLM)], srv.onInput);
  await assert.rejects(made.llm.complete({ agent: 'antigravity', prompt: 'x' }), { code: QUOTA_ERROR });
  made.llm.stopAll();
});

test('Antigravity: unknown model → NOT_FOUND', async () => {
  const srv = acpServer(() => {});
  const { llm } = make([adapter(ANTIGRAVITY_LLM)], srv.onInput);
  await assert.rejects(llm.complete({ agent: 'antigravity', prompt: 'x', model: 'gemini-99' }), { code: 'NOT_FOUND' });
  llm.stopAll();
});

// --- Chung -------------------------------------------------------------------------------------------------------------------------------
test('agent selection: default is the first installed; unknown / not installed → NOT_FOUND; bad args → INVALID_ARGS', async () => {
  const { llm } = make([adapter(CODEX_LLM), adapter(CLAUDE_LLM)], (child, d) => {
    if (child.argv[0] === 'exec' && d === null) { child.out({ type: 'item.completed', item: { type: 'agent_message', text: 'from codex' } }); child.out({ type: 'turn.completed' }); }
  });
  assert.deepEqual(llm.agents().map((a) => a.id), ['codex', 'claude']);
  assert.equal((await llm.complete({ prompt: 'x' })).agent, 'codex');
  await assert.rejects(llm.complete({ agent: 'antigravity', prompt: 'x' }), { code: 'NOT_FOUND' });
  await assert.rejects(llm.complete({ prompt: 'x', model: 'bad model;rm' }), { code: 'INVALID_ARGS' });
  await assert.rejects(llm.complete({ prompt: 'x', effort: 'turbo' }), { code: 'INVALID_ARGS' });
  llm.stopAll();
  const none = createLocalLlm({ adapters: [{ ...CLAUDE_LLM, find: () => null }] });
  assert.equal(none.available(), false);
  await assert.rejects(none.complete({ prompt: 'x' }), { code: 'NOT_FOUND' });
});

test('cancel, timeout, early exit', async () => {
  let { llm } = make([adapter(CLAUDE_LLM)], () => {});
  const ac = new AbortController();
  const p = llm.complete({ prompt: 'x' }, { signal: ac.signal });
  setTimeout(() => ac.abort(), 20);
  await assert.rejects(p, { code: 'CANCELLED' });
  await assert.rejects(llm.complete({ prompt: 'x', timeout_ms: 30 }), { code: 'CALL_TIMEOUT' });
  llm.stopAll();
  ({ llm } = make([adapter(CLAUDE_LLM)], (child, d) => { if (d) child.kill(); }));
  await assert.rejects(llm.complete({ prompt: 'x' }), /exited/);
  llm.stopAll();
});

test('tools are internal + read-only and list installed agents; prewarm keeps at most 4 processes', async () => {
  const { llm, spawned } = make([adapter(CLAUDE_LLM), adapter(CODEX_LLM)], () => {});
  await tick();
  const tools = buildLocalLlmTools(llm);
  assert.deepEqual(tools.map((t) => t.name), ['llm.complete', 'llm.prewarm']);
  assert.ok(tools.every((t) => t.internal && t.read_only));
  assert.match(tools[0].description, /claude 1\.0\.0, codex 1\.0\.0/);
  for (const model of ['opus', 'sonnet', 'haiku', 'fable', 'x']) llm.prewarm({ model });
  await tick(); await tick();
  assert.equal(llm.info().warm.length, 4);
  assert.equal(spawned.filter((c) => c.killed).length, 1);
  assert.throws(() => llm.prewarm({ model: 'x y' }), /Bad model/);
  llm.stopAll();
  await tick();
  assert.equal(llm.info().warm.length, 0);
});
