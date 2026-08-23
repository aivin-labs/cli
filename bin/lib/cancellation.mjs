import axios from 'axios';
import chalk from 'chalk';

// Ctrl+C used to just kill the local CLI process while whatever HTTP request was in flight (MCP
// scan, plugin trigger, deploy, login, ...) kept running server-side with nothing telling it the
// caller gave up - most commands had zero SIGINT handling at all. Rather than threading an
// AbortController through every individual axios call site across the CLI, this hooks the ONE
// shared `axios` module instance every lib file already imports: a single request interceptor
// attaches the currently-live controller's signal to every request that doesn't already set its
// own, so aborting that one controller cancels every in-flight request CLI-wide.
//
// A handful of commands (browser missions, log watchers) already have their own more specific
// SIGINT handler that does real cooperative cancellation (e.g. POST /plugins/ai-browser/cancel)
// before letting the process wind down naturally - this module doesn't touch those. It only adds a
// baseline "abort in-flight requests, then force an exit if nothing else already caused one" for
// everything else, which is the vast majority of commands.
let controller = new AbortController();

axios.interceptors.request.use((config) => {
  if (config.signal === undefined) config.signal = controller.signal;
  return config;
});

// Rewritten so a command's own `` `X failed: ${error.message}` `` reads as a clean "Cancelled"
// instead of axios' raw "canceled" - every command already has this wrapping, so fixing the message
// here (once) covers all of them instead of editing each catch block individually.
axios.interceptors.response.use(
  (response) => response,
  (error) => {
    if (axios.isCancel(error) || error.code === 'ERR_CANCELED') {
      error.message = 'Cancelled';
    }
    return Promise.reject(error);
  },
);

const FORCE_EXIT_GRACE_MS = 4000;
let sigintCount = 0;

process.on('SIGINT', () => {
  sigintCount++;
  if (sigintCount > 1) {
    // Second Ctrl+C - stop waiting on whatever cooperative cleanup another handler is mid-way
    // through and just leave now.
    process.exit(130);
  }
  console.log(chalk.yellow('\n⏹  Cancelling (Ctrl+C again to force quit)...'));

  // Abort every in-flight request, then swap in a fresh controller immediately - a *different*
  // SIGINT handler elsewhere (e.g. the browser-mission cooperative cancel) may still need to send
  // its own request right after this (a "please stop" POST) and shouldn't have it born
  // already-aborted just because it shares the same axios instance.
  controller.abort();
  controller = new AbortController();

  // Safety net, not the primary exit path: a command whose own request just got aborted rejects
  // almost immediately and exits on its own via its normal catch block. This only matters for the
  // cases nothing else handles - stuck on a prompt, a socket still reconnecting, etc.
  const forceExit = setTimeout(() => process.exit(130), FORCE_EXIT_GRACE_MS);
  forceExit.unref?.();
});
