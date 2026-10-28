import chalk from 'chalk';
import readline from 'readline/promises';

/** Dạng câu hỏi BE gửi (be `DeviceDirectQuestionKind`). */
export const QUESTION_KIND = { CHOICE: 'choice', FORM: 'form', TEXT: 'text' };

/** Kết quả `missions/answer` (be `DeviceMissionAnswerStatus`). */
export const ANSWER_STATUS = { ANSWERED: 'answered', NO_QUESTION: 'no_question', INVALID_ANSWER: 'invalid_answer', REJECTED: 'rejected' };

/** Dòng gõ "1,3" / "2" → id lựa chọn theo số thứ tự. Số lạ / rỗng → `undefined` (hỏi lại). */
export function parseChoiceInput(input, options, multiple) {
  const picks = String(input || '').split(/[\s,;]+/).filter(Boolean).map(Number);
  if (!picks.length || picks.some((n) => !Number.isInteger(n) || n < 1 || n > options.length)) return undefined;
  const ids = [...new Set(picks.map((n) => options[n - 1].id))];
  if (!multiple && ids.length > 1) return undefined;
  return ids;
}

/**
 * Hỏi câu hỏi đang chờ của nhiệm vụ ngay trong terminal. Trả thân trả lời (`option_ids` / `fields` / `text`) hoặc `undefined` khi bị huỷ
 * (`signal` — câu hỏi đã được trả lời trên web, người dùng bấm Ctrl+C → `onInterrupt`). Gõ sai số thì hỏi lại, không gửi.
 */
export async function askDirectQuestion(question, { signal, onInterrupt } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // Đang hỏi thì Ctrl+C tới readline chứ không tới `process` → chuyển cho nơi gọi (huỷ nhiệm vụ như lúc không hỏi).
  rl.on('SIGINT', () => onInterrupt?.());
  const ask = (q) => rl.question(q, { signal });
  try {
    console.log(`\n${chalk.yellow('❓')} ${question.question || 'Cần bạn trả lời để làm tiếp:'}`);
    if (question.kind === QUESTION_KIND.CHOICE && question.options?.length) {
      question.options.forEach((o, i) => console.log(`   ${chalk.cyan(`${i + 1})`)} ${o.text}`));
      const hint = question.multiple ? 'Chọn số (nhiều số cách nhau dấu phẩy): ' : 'Chọn số: ';
      for (;;) {
        const ids = parseChoiceInput(await ask(chalk.gray(`   ${hint}`)), question.options, question.multiple);
        if (ids) return { option_ids: ids };
        console.log(chalk.red(`   Chọn một số từ 1 tới ${question.options.length}.`));
      }
    }
    if (question.kind === QUESTION_KIND.FORM && question.fields?.length) {
      const fields = {};
      for (const f of question.fields) {
        const choices = f.options?.length ? ` (${f.options.map((o) => o.text).join(' / ')})` : '';
        for (;;) {
          const value = (await ask(chalk.gray(`   ${f.label}${choices}${f.required ? '' : ' (bỏ trống được)'}: `))).trim();
          if (value || !f.required) {
            if (value) fields[f.name] = value;
            break;
          }
        }
      }
      return { fields };
    }
    for (;;) {
      const text = (await ask(chalk.gray('   Trả lời: '))).trim();
      if (text) return { text };
    }
  } catch (e) {
    if (e?.name === 'AbortError' || e?.code === 'ABORT_ERR') return undefined;
    throw e;
  } finally {
    rl.close();
  }
}
