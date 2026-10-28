import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { DeviceErrorCode, REMOTE_CONFIG_DIR, ToolGroup } from './constants.mjs';
import { DeviceToolError, assertCommandAllowed } from './sandbox.mjs';

/**
 * Lịch chạy định kỳ trên máy (28/10/2026) — một công cụ cho mọi hệ điều hành thay vì Planner tự viết `schtasks` / `crontab`: Windows Task
 * Scheduler (thư mục `\Aivin\`), macOS / Linux crontab (mục có dấu `# aivin:<tên>`). AI chỉ thấy / sửa / xoá lịch của chính nó. Lệnh nằm
 * trong tệp script ở thư mục cấu hình Aivin (không vướng giới hạn độ dài / trích dẫn của schtasks / cron). Mỗi lần đặt / xoá: kiểm lại
 * bằng cách đọc lịch của hệ điều hành, ghi vào kho hoàn tác (hoàn tác = trả lịch về như trước).
 */

const DIR = path.join(REMOTE_CONFIG_DIR, 'schedules');
const INDEX = path.join(DIR, 'index.json');
const NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;
const EVERY = ['minute', 'hour', 'day', 'week'];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const WIN_FOLDER = '\\Aivin\\';
const MARK = '# aivin:';

const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });
const schema = (properties, required = []) => ({ type: 'object', properties, required });

function run(cmd, argv, input) {
  return new Promise((resolve) => {
    const c = spawn(cmd, argv, { windowsHide: true });
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('error', (e) => resolve({ code: -1, out, err: e.message }));
    c.on('close', (code) => resolve({ code, out, err }));
    if (input !== undefined) c.stdin.end(input); else c.stdin.end();
  });
}

function readIndex() {
  try { return JSON.parse(fs.readFileSync(INDEX, 'utf8')) || {}; } catch { return {}; }
}

function writeIndex(index) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(INDEX, JSON.stringify(index, null, 2));
}

/** Kiểm + chuẩn hoá lịch. `at` "HH:MM", `weekday` mon..sun, `interval` cho minute / hour. */
export function normalizeSpec(a) {
  const name = String(a.name || '');
  if (!NAME_RE.test(name)) throw new DeviceToolError(DeviceErrorCode.INVALID_ARGS, 'name: 1-40 letters, digits, - or _');
  const every = String(a.every || '').toLowerCase();
  if (!EVERY.includes(every)) throw new DeviceToolError(DeviceErrorCode.INVALID_ARGS, `every: ${EVERY.join(' | ')}`);
  const command = String(a.command || '').trim();
  if (!command) throw new DeviceToolError(DeviceErrorCode.INVALID_ARGS, 'Missing argument: command');
  assertCommandAllowed(command);
  const interval = Math.max(1, Math.min(Number(a.interval) || 1, every === 'minute' ? 59 : 23));
  const at = String(a.at || '09:00');
  if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(at)) throw new DeviceToolError(DeviceErrorCode.INVALID_ARGS, 'at: HH:MM');
  const weekday = String(a.weekday || 'mon').toLowerCase().slice(0, 3);
  if (!WEEKDAYS.includes(weekday)) throw new DeviceToolError(DeviceErrorCode.INVALID_ARGS, `weekday: ${WEEKDAYS.join(' | ')}`);
  return { name, every, interval, at, weekday, command };
}

/** Dòng cron của lịch (macOS / Linux). */
export function cronExpression(spec) {
  const [h, m] = spec.at.split(':').map(Number);
  if (spec.every === 'minute') return `*/${spec.interval} * * * *`;
  if (spec.every === 'hour') return `0 */${spec.interval} * * *`;
  if (spec.every === 'day') return `${m} ${h} * * *`;
  return `${m} ${h} * * ${WEEKDAYS.indexOf(spec.weekday)}`;
}

function scriptPath(name) {
  return path.join(DIR, process.platform === 'win32' ? `${name}.ps1` : `${name}.sh`);
}

function writeScript(spec) {
  fs.mkdirSync(DIR, { recursive: true });
  const file = scriptPath(spec.name);
  const log = `${file}.log`;
  if (process.platform === 'win32') fs.writeFileSync(file, `& {\n${spec.command}\n} *>> "${log}"\n`);
  else { fs.writeFileSync(file, `#!/bin/sh\n${spec.command}\n`, { mode: 0o700 }); fs.chmodSync(file, 0o700); }
  return { file, log };
}

// ── Windows ─────────────────────────────────────────────────────────────────────────────────────

async function winAdd(spec) {
  const { file } = writeScript(spec);
  const tr = `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${file}"`;
  const sc = { minute: ['/SC', 'MINUTE', '/MO', String(spec.interval)], hour: ['/SC', 'HOURLY', '/MO', String(spec.interval)], day: ['/SC', 'DAILY', '/ST', spec.at], week: ['/SC', 'WEEKLY', '/D', spec.weekday.toUpperCase(), '/ST', spec.at] }[spec.every];
  const res = await run('schtasks', ['/Create', '/F', '/TN', `${WIN_FOLDER}${spec.name}`, '/TR', tr, ...sc]);
  if (res.code !== 0) throw new DeviceToolError(DeviceErrorCode.EXECUTION_FAILED, `schtasks: ${(res.err || res.out).trim()}`);
}

async function winRemove(name) {
  await run('schtasks', ['/Delete', '/F', '/TN', `${WIN_FOLDER}${name}`]);
}

async function winQuery(name) {
  const res = await run('schtasks', ['/Query', '/TN', `${WIN_FOLDER}${name}`, '/FO', 'LIST', '/V']);
  if (res.code !== 0) return null;
  const field = (label) => res.out.split(/\r?\n/).find((l) => l.toLowerCase().startsWith(label))?.split(':').slice(1).join(':').trim();
  return { installed: true, next_run: field('next run time'), status: field('status'), last_result: field('last result') };
}

// ── macOS / Linux (crontab) ───────────────────────────────────────────────────────────────────────

async function readCrontab() {
  const res = await run('crontab', ['-l']);
  return res.code === 0 ? res.out : '';
}

/** Bỏ mục của `name` (dòng dấu + dòng lệnh ngay sau) khỏi crontab. */
export function withoutCronEntry(text, name) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === `${MARK}${name}`) { i++; continue; }
    out.push(lines[i]);
  }
  return out.join('\n').replace(/\n*$/, '\n');
}

async function writeCrontab(text) {
  const res = await run('crontab', ['-'], text);
  if (res.code !== 0) throw new DeviceToolError(DeviceErrorCode.EXECUTION_FAILED, `crontab: ${(res.err || res.out).trim()}`);
}

async function cronAdd(spec) {
  const { file, log } = writeScript(spec);
  const current = withoutCronEntry(await readCrontab(), spec.name);
  await writeCrontab(`${current.trim() ? `${current.trimEnd()}\n` : ''}${MARK}${spec.name}\n${cronExpression(spec)} /bin/sh "${file}" >> "${log}" 2>&1\n`);
}

async function cronRemove(name) {
  const current = await readCrontab();
  if (current.includes(`${MARK}${name}`)) await writeCrontab(withoutCronEntry(current, name));
}

async function cronQuery(name) {
  const lines = (await readCrontab()).split('\n');
  const i = lines.findIndex((l) => l.trim() === `${MARK}${name}`);
  return i >= 0 && lines[i + 1] ? { installed: true, cron: lines[i + 1].trim() } : null;
}

const os = {
  add: (spec) => (process.platform === 'win32' ? winAdd(spec) : cronAdd(spec)),
  remove: (name) => (process.platform === 'win32' ? winRemove(name) : cronRemove(name)),
  query: (name) => (process.platform === 'win32' ? winQuery(name) : cronQuery(name)),
};

/** Đặt / xoá lịch + cập nhật danh mục; trả lịch trước đó (để hoàn tác). */
async function apply(spec, name) {
  const index = readIndex();
  const previous = index[name] || null;
  if (spec) {
    await os.add(spec);
    index[name] = spec;
  } else {
    await os.remove(name);
    delete index[name];
    fs.rmSync(scriptPath(name), { force: true });
  }
  writeIndex(index);
  return previous;
}

export function createScheduleManager({ undo } = {}) {
  // Hoàn tác: trả lịch về như trước lần đặt / xoá.
  undo?.registerHandler('schedule', async (item) => {
    await apply(item.previous || null, item.name);
    return { schedule_restored: item.name };
  });

  async function set(args) {
    const action = String(args.action || 'add');
    const name = String(args.name || '');
    if (action === 'remove') {
      if (!NAME_RE.test(name)) throw new DeviceToolError(DeviceErrorCode.INVALID_ARGS, 'name required');
      const previous = await apply(null, name);
      undo?.begin(args.undo_group, 'schedule').custom('schedule', { name, previous });
      const still = await os.query(name);
      return { removed: name, existed: !!previous, verified: !still };
    }
    const spec = normalizeSpec(args);
    const previous = await apply(spec, spec.name);
    undo?.begin(args.undo_group, 'schedule').custom('schedule', { name: spec.name, previous });
    // Kiểm lại: đọc lịch thật của hệ điều hành, không tin lệnh đặt đã chạy.
    const installed = await os.query(spec.name);
    return { name: spec.name, schedule: spec.every === 'week' ? `${spec.weekday} ${spec.at}` : spec.every === 'day' ? `daily ${spec.at}` : `every ${spec.interval} ${spec.every}(s)`, verified: !!installed, ...(installed || {}), replaced: !!previous };
  }

  async function list() {
    const index = readIndex();
    const items = await Promise.all(Object.values(index).map(async (s) => ({ ...s, ...(await os.query(s.name) || { installed: false }) })));
    return { schedules: items };
  }

  return { set, list };
}

export function buildScheduleTools(sm) {
  return [
    { name: 'sys.schedule', group: ToolGroup.SYSTEM, handler: (a) => sm.set(a),
      description: `Create, replace or remove a recurring job on this computer (${process.platform === 'win32' ? 'Windows Task Scheduler' : 'crontab'}), managed by Aivin: action add | remove; every minute | hour (with interval) | day (at HH:MM) | week (weekday + at). The command runs in ${process.platform === 'win32' ? 'PowerShell' : 'sh'}; its output goes to a log. Verifies the job is installed and can be undone.`,
      input_schema: schema({ action: str('add | remove'), name: str('job name: letters, digits, - _'), command: str('command to run'), every: str('minute | hour | day | week'), interval: num('for minute / hour, default 1'), at: str('HH:MM for day / week'), weekday: str('mon..sun for week') }, ['action', 'name']) },
    { name: 'sys.schedules', group: ToolGroup.SYSTEM, read_only: true, handler: () => sm.list(),
      description: 'Recurring jobs Aivin set up on this computer, with whether each is installed and its next run.',
      input_schema: schema({}) },
  ];
}
