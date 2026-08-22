import chalk from 'chalk';
import readline from 'readline';
import inquirer from 'inquirer';

// ✅ FIX: several axios calls across the CLI (store.mjs, connectors.mjs, deploy.mjs's main deploy
// POST) had no `timeout` at all - a network glitch/overloaded backend left the spinner spinning
// forever with no way out short of Ctrl+C, which is especially costly for a call like `connector
// register` where the whole interactive form (including a typed-in OAuth client_secret) would have
// to be re-entered from scratch afterwards. A generous but finite default so a genuinely slow-but-
// alive backend still succeeds, while a truly hung connection eventually surfaces as a normal error.
export const DEFAULT_API_TIMEOUT_MS = 30000;

// Same spinner deployPlugin has always had, factored out so other long-running network calls
// (AI codegen, connector register) get the same "still working, not hung" feedback instead of a
// static line that just sits there for however many seconds the request takes.
export async function withSpinner(label, fn) {
  if (!process.stdout.isTTY) {
    console.log(chalk.blue(`${label}...`));
    return fn();
  }
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const timer = setInterval(() => {
    process.stdout.write(`\r${chalk.cyan(frames[i])} ${label}...`);
    i = (i + 1) % frames.length;
  }, 100);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
  }
}

// Same as withSpinner but also renders a stage/percent readout that changes over time — for calls
// where the backend publishes realtime progress (e.g. `plugin trigger`'s cold-start Docker install,
// which can take 60-150s+ with zero feedback otherwise). `getCurrent()` is polled every tick and
// should return the latest `{ stage, percent, message }` received (or null before anything arrives).
export async function withProgressSpinner(label, getCurrent, fn) {
  if (!process.stdout.isTTY) {
    console.log(chalk.blue(`${label}...`));
    return fn();
  }
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const timer = setInterval(() => {
    const current = getCurrent?.();
    const suffix = current?.percent != null ? ` ${current.message || current.stage} ${current.percent}%` : '...';
    process.stdout.write(`\r${chalk.cyan(frames[i])} ${label}${suffix}`);
    i = (i + 1) % frames.length;
  }, 100);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
  }
}

// Positional CLI args are declared optional ([arg]) everywhere, not required (<arg>), so Commander
// never hard-fails before the action() runs - every command instead calls this to fill a missing
// value interactively. Falls back to throwing `usage` when there's no TTY to prompt on (scripts/
// CI) or the user leaves the prompt blank, so non-interactive callers still fail fast and loud
// instead of hanging on a prompt nothing will ever answer.
export async function requireArg(value, { prompt, usage }) {
  if (value) return value;
  if (process.stdin.isTTY && process.stdout.isTTY) {
    const { answer } = await inquirer.prompt([{ type: 'input', name: 'answer', message: prompt }]);
    if (answer) return answer;
  }
  throw new Error(usage);
}
