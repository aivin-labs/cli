import chalk from 'chalk';
import readline from 'readline/promises';
import { ConfirmMode, REMOTE_POLICY_FILE, loadLocalPolicy, saveLocalPolicy } from './localPolicy.mjs';

/**
 * `aivin remote policy [hành động] [giá trị]` — chủ máy đặt sàn luật tại máy (localPolicy.mjs). Siết luật chạy ngay; NỚI luật (bớt xác
 * nhận, bật lại công cụ, bỏ chặn lệnh) phải gõ trong terminal thật và trả lời "có": lệnh shell do agent chạy không có terminal, nên agent
 * không tự nới được luật của máy.
 */

const CONFIRM_RANK = { [ConfirmMode.NEVER]: 0, [ConfirmMode.RISKY]: 1, [ConfirmMode.ALWAYS]: 2 };

const CONFIRM_TEXT = {
  [ConfirmMode.RISKY]: 'việc rủi ro (lệnh đổi hệ thống / bảo mật, xoá hẳn, gửi thư, đặt lịch) phải bấm "Cho phép" trên máy',
  [ConfirmMode.ALWAYS]: 'MỌI việc có tác dụng phải bấm "Cho phép" trên máy',
  [ConfirmMode.NEVER]: 'không hỏi trên máy — chỉ theo luật phía Aivin',
};

function show(policy) {
  console.log(chalk.blue('🛡️  Luật tại máy này') + chalk.gray(` (${REMOTE_POLICY_FILE})`));
  console.log(`   Xác nhận trên máy: ${chalk.cyan(policy.confirm)} — ${CONFIRM_TEXT[policy.confirm]} (chờ tối đa ${policy.confirm_timeout_sec} s)`);
  console.log(`   Công cụ tắt:       ${policy.deny_tools.length ? policy.deny_tools.join(', ') : chalk.gray('không')}`);
  console.log(`   Lệnh chặn thêm:    ${policy.blocked_commands.length ? policy.blocked_commands.map((r) => `/${r}/`).join('  ') : chalk.gray('không')}`);
  console.log(chalk.gray('   Đổi: aivin remote policy confirm <never|risky|always> · deny|allow <công cụ> · block|unblock "<regex>" · timeout <giây>'));
}

/** Nới luật: chỉ người gõ trong terminal thật, và phải trả lời "có". */
async function assertHumanLoosening(what) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(`Nới luật tại máy (${what}) chỉ làm được khi gõ lệnh trong cửa sổ terminal — lệnh do agent chạy không được nới luật.`);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(chalk.yellow(`⚠️  ${what}. Gõ "co" để đồng ý: `));
    if (!/^\s*(co|có|yes|y)\s*$/i.test(answer)) throw new Error('Đã huỷ — luật giữ nguyên.');
  } finally {
    rl.close();
  }
}

export async function runPolicyCommand(action, value) {
  const policy = loadLocalPolicy();
  if (!action) return show(policy);
  const v = String(value ?? '').trim();
  const next = { ...policy, deny_tools: [...policy.deny_tools], blocked_commands: [...policy.blocked_commands] };
  switch (action) {
    case 'confirm': {
      if (!(v in CONFIRM_RANK)) throw new Error('Dùng: aivin remote policy confirm <never|risky|always>');
      if (CONFIRM_RANK[v] < CONFIRM_RANK[policy.confirm]) await assertHumanLoosening(`Giảm xác nhận trên máy từ "${policy.confirm}" xuống "${v}"`);
      next.confirm = v;
      break;
    }
    case 'deny':
      if (!v) throw new Error('Dùng: aivin remote policy deny <tên công cụ> (vd shell.exec, office.outlook.send, gui.act)');
      if (!next.deny_tools.includes(v)) next.deny_tools.push(v);
      break;
    case 'allow':
      if (!next.deny_tools.includes(v)) throw new Error(`Công cụ ${v || '?'} đang không bị tắt.`);
      await assertHumanLoosening(`Bật lại công cụ ${v} cho agent trên máy này`);
      next.deny_tools = next.deny_tools.filter((t) => t !== v);
      break;
    case 'block':
      try { new RegExp(v, 'i'); } catch { throw new Error(`Regex không hợp lệ: ${v}`); }
      if (!v) throw new Error('Dùng: aivin remote policy block "<regex>" (vd "\\bgit\\s+push\\b")');
      if (!next.blocked_commands.includes(v)) next.blocked_commands.push(v);
      break;
    case 'unblock':
      if (!next.blocked_commands.includes(v)) throw new Error(`Không có luật chặn /${v}/.`);
      await assertHumanLoosening(`Bỏ luật chặn lệnh /${v}/`);
      next.blocked_commands = next.blocked_commands.filter((r) => r !== v);
      break;
    case 'timeout': {
      const sec = Number(v);
      if (!Number.isFinite(sec) || sec < 15 || sec > 900) throw new Error('Dùng: aivin remote policy timeout <15–900 giây>');
      next.confirm_timeout_sec = Math.round(sec);
      break;
    }
    default:
      throw new Error(`Không hiểu "${action}". Dùng: confirm | deny | allow | block | unblock | timeout`);
  }
  const saved = saveLocalPolicy(next);
  console.log(chalk.green('✅ Đã lưu — có hiệu lực ngay (công cụ tắt / bật lại vào danh mục ở lần khởi động daemon kế tiếp).'));
  show(saved);
}
