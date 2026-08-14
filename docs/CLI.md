# 🖥️ CLI Reference

`aivin` is built on [Commander](https://github.com/tj/commander.js), so help is always available
without needing this doc:

```bash
aivin --help            # or: aivin help
aivin <command> --help  # or: aivin help <command>
```

Every command below is real - this is the exact output of `aivin --help` as of this CLI version.

```
Usage: aivin [options] [command]

aivin CLI - scaffold, run, and deploy Aivin plugins

Options:
  -V, --version                           output the version number
  -h, --help                              display help for command

Commands:
  create [options] [name]                 Create new plugin
  init [options] [name]                   Set up a new plugin step by step: asks what it should do, then generates real working code from that description
  validate [options]                      Validate manifest.json in the current directory (or --json/--stdin for scripted use)
  start [options]                         Start plugin server
  deploy                                  Deploy plugin to your org on the Aivin server
  test [options]                          Deploy to a non-production test instance, then smoke-test it with generated input and save a report to .test/
  plugin                                  AI-assisted plugin authoring
  connector                               Register and discover reusable connectors (OAuth apps / credential-form namespaces)
  pluginstore                             Self-hosted aivin-service worker (Docker) - attach it to your org as a plugin store
  mcp [options] [url]                     MCP proxy plugins - wrap an external MCP server tool/resource/prompt, no code required
  login [options] [baseUrl]               Log in and save an API key for plugin deployment (opens your browser by default)
  whoami                                  Show which account is currently logged in on this machine (reads ~/.aivin/credentials - no server call)
  key                                     Manage named API keys for your account
  browser [options] [mission]             Run an AI Browser mission - by default opens/reuses a local browser window dedicated to AI Browser (own profile, own cookies - log in once, watch missions run live from then on); --remote uses a server-side browser instead
  do [options] [agentNickname] [mission]  Have <agentNickname> work toward a goal in the background - not a specific deployed plugin
  task [options] [description]            Create a new task from a plain-language description
  workspace [options]                     Browse your workspaces and projects, and pick one to use with --workspace/--project
  agent                                   Search, install, create, and publish AI Staff agents
  project                                 Create, update, and delete projects within a workspace
  help [command]                          display help for command
```

## `aivin init [name]`

The simplest way to start: asks what the plugin should do, then scaffolds the project **and**
generates real working code from that description in one step - no separate `aivin create` +
`aivin plugin make` needed.

```bash
aivin init my-plugin
# ? Plugin name: my-plugin
# ? What should this plugin do? (be specific - this is what generates your code)
#   > Summarize a support ticket and tag its urgency low/medium/high
```

Options:

```
Options:
  --name <name>          Plugin name (if not specified, will prompt)
  --model <model>        LLM model to use for generation
  --provider <provider>  LLM provider to use for generation
```

Writes two source files instead of one, unlike `aivin create`:

- **`src/service.ts`** - the actual business logic, AI-generated from your description. A single
  exported `execute(input, ctx)` that returns plain result data (or throws a plain `Error`) - no
  `PluginResponse`/`PluginStatus` boilerplate to think about.
- **`src/main.ts`** - a thin, static wrapper (not AI-generated, doesn't change between runs). Calls
  `execute()` and packages the result into the `PluginResponse` the platform expects. This filename
  is fixed - the runtime always loads exactly `src/main.ts`, so it's never regenerated or renamed.

If code generation fails (network issue, `API_KEY` not set, etc.), `aivin init` still leaves you
with a working, deployable scaffold - it falls back to the same plain placeholder `aivin create`
writes, so nothing is left half-broken.

Regenerating later: `aivin plugin make "<new description>"` detects `src/service.ts` and targets it
instead of `src/main.ts`, so the split is preserved (see below).

Prefer no AI step at all? `aivin create` scaffolds the same project structure minus the generation -
one `src/main.ts` you write by hand.

## `aivin create`

Scaffold a new plugin project (`manifest.json`, `src/main.ts`, `package.json`, `tsconfig.json`,
`.env`, `.gitignore`).

```
Usage: aivin create [options] [name]

Options:
  --json <config>  JSON config (AI mode)
  --stdin          Read from stdin
  --name <name>    Plugin name (if not specified, will prompt)
  --silent         Silent mode
  --json-output    JSON output
```

- `aivin create <name>` (or `--name <name>`) → creates a new `<name>/` subdirectory and scaffolds
  into it, no name prompt (description still prompted).
- No name at all → interactive prompts for both name and description, scaffolding into the
  **current** directory - `mkdir`/`cd` into your target folder yourself first.
- `--json '<config>'` / `--stdin` → non-interactive/scripted mode for AI tooling, also creates a
  `<config.name>/` subdirectory. `config` needs at least `name` and `description`; anything else
  (`input`, `output`, `trigger_type`, ...) is merged straight into the generated `manifest.json`.
  `config` may also be a path to a JSON file.
- `--json-output` → prints a machine-readable `{ success, pluginDir, name, description, timestamp }`
  result instead of the usual colored console output.

```bash
aivin create my-plugin
aivin create --json '{"name":"my-plugin","description":"Summarize tickets"}'
```

## `aivin validate`

Validates a plugin config against the same rules `aivin create` enforces (name format, required
`description`, and - if present - `proxy_config` completeness for MCP proxy plugins). Doesn't touch
the network.

With no flags, validates `manifest.json` in the current directory - the common case:

```bash
cd my-plugin
aivin validate
```

```
Options:
  --json <config>  JSON config, instead of reading manifest.json from the current directory
  --stdin          Read JSON config from stdin, instead of reading manifest.json
  --json-output    JSON output
```

`--json`/`--stdin` remain for scripted/CI use where the config isn't a file on disk yet:

```bash
aivin validate --json '{"name":"my-plugin","description":"x"}'
```

## `aivin start`

Runs the current plugin directory (must contain `manifest.json` and `src/main.ts`) against a real
local server - specifically, this project's own installed `@aivin-labs/sdk`'s `bin/server.mjs`
(resolved from *this project's* `node_modules`, not the CLI's own install location - if you see
"Could not find @aivin-labs/sdk installed", run `npm install` first). Starts:

1. A real gRPC server (bind `0.0.0.0:50051`) - the same protocol the production host uses to
   trigger your handler(s). You don't call this directly.
2. In development (anything but `NODE_ENV=production`), an HTTP test shim on `:4001` (override with
   `LOCAL_TEST_PORT`) for manual `curl` testing.

```bash
aivin start
curl -X POST http://localhost:4001/invoke -H 'content-type: application/json' \
  -d '{"input":{"text":"hello"}}'
```

With more than one `plugins: []` entry, pass `mission` to pick which entry's `func` runs - it's
matched against each entry's `id`, falling back to `func` (a single-entry manifest, the scaffold
default, always resolves to its one entry - no `mission` needed):

```bash
curl -X POST http://localhost:4001/invoke -H 'content-type: application/json' \
  -d '{"mission":"summarize-ticket","input":{"text":"hello"}}'
```

SDK calls made while running default to the **production** backend (`api.aivin.cloud`) if
`SDK_ENDPOINT` isn't set in `.env` - point it at a local/dev backend instead if you don't want
that (see [Environment variables](#environment-variables) below).

### Hot-reload

Saving `src/**` or `manifest.json` re-imports the plugin in place - no more Ctrl+C + `aivin start`
again after every edit. Both the real gRPC server and the `:4001` HTTP test shim pick up the change
together. A broken save (syntax error, missing export) is reported and the *previous* working
version keeps serving until you fix it - a typo mid-edit doesn't kill the running server.

```
♻️  Reloaded (src/main.ts): my-plugin (My Plugin) v0.1.0
```

On by default in development; disabled automatically inside a real deployed container (detected via
`SDK_SECRET_FILE`, which only a real deploy sets - `NODE_ENV=production` alone doesn't reliably mean
"deployed", the platform's own container build never sets it). This same file is also the
container's entrypoint in production, where the plugin source is also bind-mounted read-only, so
there'd be nothing for the watcher to see even without this check. Turn it off by hand with
`--no-watch` or `AIVIN_START_WATCH=false`.

### Live per-call debugging: `--debug` / `--debug-json`

By default you only see a trace summary once the whole invocation finishes (`AIVIN_TRACE`, on by
default - see [Environment variables](#environment-variables)). To watch each `sdk.*` call as it
happens instead:

```bash
aivin start --debug        # human-readable: one line per call, live
aivin start --debug-json   # same events, one JSON object per line - for a script/coding agent
                            # to parse instead of pattern-matching free text
```

Both are `SDK_DEBUG=true`/`SDK_DEBUG=json` under the hood (settable directly if you're not going
through `aivin start`, e.g. inside `aivin test`'s smoke-test run). Each line/event covers exactly
one `sdk.*` call: `namespace`, `duration_ms`, `attempts`, `success`, `error` (if any).

## `aivin deploy`

Deploys the plugin in the current directory (`manifest.json` + every project file except
`node_modules/`, `.git/`, `.tmp/`, `dist/`, `build/`, `.test/`, `.gitignore`, `yarn.lock`, and
`.env`) to `POST /plugins/deploy`. Always private to your org - there's no CLI-reachable "submit to
the public store" path for regular code/Docker plugins today (that only exists through the browser
CodeEditor's publish flow, a different runtime). **MCP proxy plugins are the one exception** -
`aivin mcp <url> --publish` (below) can submit those to the community store directly from the CLI.

- `manifest.json` is normally the default `{ ...commonFields, plugins: [...] }` shape (see
  [MANIFEST.md#default-shape](https://github.com/aivin-labs/AIVIN-SDK/blob/main/docs/MANIFEST.md#default-shape)) - common fields are copied onto each
  entry in `plugins` before upload, and all entries deploy together, sharing one running
  container. The legacy flat single-object shape is still accepted.
- If every entry's `manifest.proxy_config` is set (MCP proxy plugins - see `aivin mcp create`
  below), no files are read or sent at all - just the manifest.
- `package-lock.json` is auto-generated (`npm install --package-lock-only`) before upload if missing
  - the backend's build runs `npm ci`, which requires one.
- On success, auto-increments `manifest.json`'s patch version(s) and writes back the plugin id(s)
  the server assigned.

```bash
aivin deploy
```

## `aivin test`

Same payload/logic as `aivin deploy`, but against `POST /plugins/test/deploy` - a non-production
instance for verifying the plugin runs end-to-end on real infra (real container, real gRPC, real
the SDK) before anyone else can see it. This endpoint is blocked by the backend in production.

After a successful deploy, it also **smoke-tests** every non-proxy plugin entry: generates sample
input from `manifest.json`'s `input` schema (`POST /code/generate-sample-data`), invokes the plugin
for real (`POST /plugins/execute`) against a workspace, and writes a pass/fail report to
`.test/<timestamp>.json` in the project directory (also excluded from future deploy uploads).

**MCP proxy entries are skipped by default** - there's no generic "sample input" that makes sense
for a tool schema an external MCP server defines itself, so `aivin test` deploys them but runs no
automated invoke/report unless you opt in with `--verify-proxy`. Use
`aivin plugin trigger --id <pluginId> -a "<prompt>"` (or the interactive "Test now?" step
`aivin mcp <url>` offers right after deploy) to test one by hand instead.

```
Options:
  --workspace <id>  Workspace id to run the smoke test against (default: auto-picks your first one)
  --no-smoke-test   Only deploy - skip the generated-input invoke test and report
  --verify-proxy    Also invoke MCP proxy entries for real (empty input) instead of skipping
                    them - only use if you know the underlying tool(s) have no meaningful side
                    effects
```

```bash
aivin test                        # deploy + smoke-test + report
aivin test --workspace <id>        # smoke-test against a specific workspace
aivin test --no-smoke-test         # deploy only, same as before this flag existed
aivin test --verify-proxy          # also invoke proxy entries with empty input, for real
```

`--verify-proxy` sends `arguments: {}` (not AI-generated - proxy's `input` schema is the generic
`{ data: object }` passthrough, so there's nothing meaningful to infer a "realistic" sample from)
straight to `/plugins/execute`. This really calls the external MCP server - only use it if the
tool(s) involved are safe to invoke automatically (idempotent/read-only), since a repeated `aivin
test` run means a repeated real call every time.

## `aivin plugin make <description>`

AI-generates a plugin from a natural-language description, via `POST /code/generate-project` -
**complexity-adaptive**: the backend classifies the requirement first, and only escalates beyond a
single `src/main.ts` when it's genuinely complex.

```
Options:
  --model <model>        LLM model to use for generation
  --provider <provider>  LLM provider to use for generation
```

```bash
aivin plugin make "Summarize a support ticket and tag its urgency"
```

- **Simple/moderate** requirement (the common case): exactly one `src/main.ts`, one generation call
  - unchanged from before. Same conventions as always (`main(mission, input, ctx)`,
  `import { ai } from '@aivin-labs/sdk'`, `PluginResponse`).
- **Complex** requirement (several genuinely independent capabilities, or logic too large for one
  flat function): the backend plans a small multi-file project first, generates each file, and - if
  the plan calls for it - returns a [multi-function manifest](https://github.com/aivin-labs/AIVIN-SDK/blob/main/docs/MANIFEST.md#multi-function-plugins)
  fragment that replaces `manifest.json`'s `plugins[]` with one entry per capability.

Requires `manifest.json` to already exist (`aivin create` first).

### Self-correction loop

Generation isn't one-shot, and for a multi-file plan it isn't one-file-at-a-time either: files with
no dependency on each other generate in parallel (only a file that genuinely needs to see another
one's content, per the plan's own `depends_on`, waits for it first). After writing every returned
file, if the project's own `typescript` devDependency is installed (`npm install` already run), the
whole project is type-checked with `tsc --noEmit`. Real compiler errors (exact
`file(line,col): error TSxxxx: ...` lines) are attributed back to whichever file they were reported
against and sent to the AI for a surgical fix - up to 2 rounds, across as many files as had errors:

```
🤖 Generating plugin
✅ 2 file(s) generated (src/main.ts, src/lib/search.ts)
⚠️  2 compiler error(s) across 1 file(s) - asking the AI to fix...
✅ Fixed - clean type-check after 1 attempt(s)
```

If `node_modules` isn't installed yet, type-checking (and the self-correction it enables) is skipped
silently - run `npm install` first if you want it. If errors remain after both rounds, every file is
still written, with every remaining error printed for you to fix by hand.

Review generated code before relying on it either way - self-correction only catches what `tsc`
catches (type errors), not wrong business logic.

## `aivin plugin convert [hint]`

Hands the existing project in the current directory to the backend's agentic project-conversion
pipeline instead of generating locally. Unlike `plugin make`/`plugin init` (a single AI call per
file, run entirely from what you pass it), this command:

1. Uploads only the **directory tree** - paths and byte sizes, never file content - so the request
   stays cheap no matter how large the project is.
2. The backend scans it: it decides which files are actually worth reading (entry points,
   `package.json`, anything name-suggestive of routes/tools/skills) and asks the CLI to read them
   back one at a time, over the same socket connection `aivin plugin logs` uses.
3. It plans a conversion - single `main()` vs. a [multi-function manifest](https://github.com/aivin-labs/AIVIN-SDK/blob/main/docs/MANIFEST.md#multi-function-plugins)
   (one `plugins[]` entry per independent capability), and which files to create vs. adapt in
   place - detecting the project's shape (a plain script, an MCP server, an API backend with
   routes, a Claude-style skill) from what it actually read, not a fixed regex. If the project isn't
   TypeScript/JavaScript (Python, Go, ...), every file becomes a **port** (translated, not edited) -
   the plan always uses `create` in that case, never `update`, since there's no existing `.ts` file
   to adapt in place.
4. It generates/updates each planned file, then **verifies with a real `tsc --noEmit` run** on your
   machine (via the same tool-call channel) and self-corrects on real compiler errors, up to twice.

Every step prints live as it happens - this loop can take a while on a real project, so it's never
silent:

```bash
cd your-existing-project
aivin plugin convert
# 📂 Scanning project tree...
#    142 file(s) in tree (content read on demand by the server, never uploaded up front)
# 🤖 Converting - this loops (scan → plan → generate → verify), watch for progress below...
#
# [10:32:01] Scanning project tree (142 entries)...
# [10:32:03] Reading 3 file(s): package.json, src/index.ts, src/tools/search.ts
# [10:32:07] Plan ready: mcp_server, 2 file(s) - Two independent MCP tools found (search, fetch);
#            splitting into a multi-function manifest so each is separately callable.
# [10:32:15] Generating 2 file(s) in parallel: src/main.ts, src/lib/search.ts
# [10:32:22] Type-checking (attempt 1)...
# [10:32:23] Type-check clean
# [10:32:23] All required exports present
# [10:32:24] Running a smoke test with generated sample input (may make real SDK/AI calls using your credentials)...
# [10:32:31] Smoke test passed
# ✅ Conversion done (mcp_server, 2 file(s))
```

The smoke test only runs if the type-check passed first (no point executing code that doesn't even
compile) and `@aivin-labs/sdk` is already installed locally (`npm install`) - skipped, not failed,
otherwise. It spawns the real plugin runtime on your machine on off-default ports (won't collide with
a real `aivin start`) with AI-generated sample input, so a plugin whose logic calls `ai.prompt()` or
other SDK methods will make a real call using your credentials during this step.

```
Options:
  --model <model>        LLM model to use for generation
  --provider <provider>  LLM provider to use for generation
  --force                 Re-run conversion even if src/main.ts already exists (e.g. redo a
                          previous bad/stale result)
```

- No `manifest.json` needed first - if one doesn't exist, it's created from `package.json` (name,
  description) or the directory name.
- Fails if `src/main.ts` already exists, unless `--force` is given - the plain (no-flag) case is
  for a project that isn't a plugin yet; `--force` re-runs the whole scan/plan/generate/verify loop
  against a project this command already converted before (the earlier plan turned out wrong, the
  project changed since, whatever the reason) - `src/main.ts` isn't excluded from what gets scanned,
  so the new plan is free to mark it `update`, and the usual per-file overwrite confirmation still
  applies to it like any other existing file.
- `[hint]` is optional extra guidance, e.g. which function to focus on - passed straight to the
  backend's planning step.
- If the plan is multi-function, `manifest.json`'s `plugins[]` is replaced with one entry per
  planned capability (fresh local ids - `aivin deploy` still assigns the real ones).
- Requires a live connection to the Aivin server for the whole duration (it's not a local batch
  job) - the socket is what lets the backend read files on demand and stream progress back.
- Only one conversion can run at a time per project - starting a second one against the same
  project while the first is still running fails fast instead of racing both against the same
  files. If the previous run's process died without cleanly finishing, this frees up on its own
  within moments, not stuck for the full run duration.
- The whole run gives up after ~15 minutes regardless of how far it got, so a stuck step can't hold
  the connection open forever.

### Overwrite safety

Unlike `plugin make`, this command can touch files that **already exist** in your project - the
backend's plan may mark some as `update` (adapt in place) rather than `create` (new file):

- Before scanning starts, if the directory is a git repo with uncommitted changes, you're warned
  and (in an interactive terminal) asked to confirm before continuing at all.
- Before any individual existing file is actually overwritten, you're prompted per-file (with a
  quick `git status` hint - untracked vs. has uncommitted changes - when available) - declining
  skips just that file, the rest of the conversion continues.
- Non-interactive runs (CI/scripts) can't prompt, so they proceed automatically - the decision is
  still printed to the log either way, it's just not blocking.

Review the generated code before relying on it - self-correction only catches what `tsc` catches
(type errors), not wrong business logic, and the file/project-kind detection is a best effort, not
a guarantee.

## `aivin plugin search <query>`

Searches the platform's plugin ecosystem before you write new logic - the same relevance-ranked
lookup the platform's own agent uses to auto-select a plugin for a mission (`GET /plugins/search`).
Doesn't need to be run from inside a plugin project.

```bash
aivin plugin search "send a slack message"
```

Options:

```
Options:
  --workspace <id>   Restrict to plugins visible in this workspace (default: your whole org)
  --mcp <server_id>  List every tool/resource/prompt plugin generated from one MCP server, instead of a text search
  --store <store_id> Restrict to plugins hosted on one self-hosted plugin store (id from `aivin pluginstore ls`) - combines with the text query/--mcp
  --limit <n>        Max results to show
  --plain            Print a flat list instead of the interactive browser (for scripts/CI)
```

In a real terminal, results open in an interactive browser: `↑`/`↓` to move between matches,
`→`/`space`/`enter` to open a plugin's detail view (full description, version, input/output
schema), `←`/`esc`/`backspace` to go back to the list, `q` to quit. Non-TTY contexts (scripts, CI,
piped output) or `--plain` fall back to a flat printed list.

Call one from your own plugin with `import { call } from '@aivin-labs/sdk'` then
`await call('<plugin_id>', params)`.

## `aivin plugin info <id>`

Detail view for **one already-known plugin id**, without going through `plugin search`'s free-text
ranking first - useful when debugging a specific plugin you already have the id for (copied from
`plugin search --mcp <server_id>`'s listing, from the platform, etc.).

```bash
aivin plugin info modelcontextprotocol-servers-src-everything-read_file
```

Options:

```
Options:
  --workspace <id>  Restrict to plugins visible in this workspace (default: your whole org)
  --plain           Print flat instead of the interactive browser, if falling back to
                     closest-match results
```

There's no dedicated `GET /plugins/:id` on the backend, so this reuses `/plugins/search` with the
id itself as the query and picks the exact `id` match out of the ranked results. If nothing matches
exactly (typo'd id, or a plugin not visible to you), it prints "no exact match" and falls back to
the same interactive browser over the closest results instead of failing outright.

## `aivin plugin ask [mission]`

One-shot "just simulate the agent" mode: give it a plain-language mission and it does what a
running agent actually does at execution time - searches the plugin ecosystem the same
relevance-ranked way (`plugin search`'s lookup), picks the **top match**, and immediately triggers
it with that same mission auto-mapped onto the input schema (`plugin trigger -a` under the hood).
Where `plugin search` + `plugin trigger --id <id> -a "..."` is a manual two-step "pick, then run"
flow, `ask` collapses both into a single command - no copying an id between them.

```bash
aivin plugin ask "send a slack message to #eng saying the deploy is done"
```

```
🤖 Auto-selected: Slack Notify (87% match)  (slack-notify-abc123)
   runner-up(s): Slack Post Message, Discord Notify

🚀 Triggering Slack Notify...
...
```

Options:

```
Options:
  --top <n>          How many candidates to consider/print as runner-up context
                      (default 5) - only the top match is ever run
  -i, --input <json> Force specific fields (as JSON) alongside the auto-mapped
                      ones - explicit fields win
  --workspace <id>    Workspace id to search/run against (default: auto-picks
                      your first one)
  --agent <id>        Agent id to run as, if the plugin needs one for
                      HIL/confirm behavior to be accurate
  --watch-logs        Also stream the chosen plugin's own live console output inline
  --save              Write this run's result to .test/trigger/<ts>.json
  --compare <file>    Diff this run against a previously --save'd file
```

If the auto-pick looks wrong, check the printed runner-up(s) and fall back to the manual flow -
`aivin plugin search "<mission>"` to browse candidates yourself, then
`aivin plugin trigger --id <chosen-id> -a "<mission>"` to run that specific one instead. `ask`
throws (no plugin executed) if the search comes back empty, rather than guessing.

## `aivin plugin trigger [mission] [input]`

Invokes an **already-deployed** plugin for real and prints the result - the same
`POST /plugins/execute` the platform's own Playground ("Thử nghiệm" tab) uses, so it exercises the
exact same code path a running agent would hit. Run it from the plugin's project directory -
`manifest.json` supplies the plugin id (`--func <name>` picks the entry for a multi-function
plugin) - or pass `--id` directly for a plugin with no local project directory (e.g. one built by
`aivin mcp <url>`, which deploys straight from a scan and never writes a `manifest.json` anywhere).

```
Options:
  -a, --auto <prompt>  Natural-language prompt - the platform auto-maps it onto
                       the input schema for you
  --id <pluginId>      Plugin id to trigger directly - skips the local
                       manifest.json lookup entirely
  --func <name>        Which function to trigger, for a multi-function plugin
                       (matches name/func/id) - ignored when --id is given
  --workspace <id>     Workspace id to run against (default: auto-picks your
                       first one)
  --agent <id>         Agent id to run as, if the plugin needs one for
                       HIL/confirm behavior to be accurate
  --watch-logs         Also stream the plugin's own live console output inline
                       (same feed as `aivin plugin logs`) - no second terminal
                       needed. Requires permission to view that plugin's logs;
                       most store plugins from other orgs just fall back to
                       the REST result only.
  --save               Write this run's result to .test/trigger/<ts>.json
  --compare <file>     Diff this run against a previously --save'd file
```

```bash
# no local project directory - e.g. an MCP proxy plugin from `aivin mcp <url>`
aivin plugin trigger --id my-mcp-plugin-id -a "search for open issues about login"
```

**Direct mode** - `<mission>` (becomes `main()`'s `mission` argument) and `<input>` (a JSON string,
becomes `main()`'s `input` argument) both required:

```bash
aivin plugin trigger "summarize this" '{"text":"Aivin plugins are easy to write."}'
```

**Auto mode** (`-a`/`--auto <prompt>`) - give it free text instead of structured JSON; the backend's
own input-mapping (`mapDataToSchema`, the same mechanism the Playground's chat-style tester uses)
maps it onto `manifest.json`'s `input` schema for you:

```bash
aivin plugin trigger -a "Summarize this ticket: customer can't log in after the last update"
```

`<input>` can still be given alongside `-a` for fields you want to force rather than let the AI
infer - explicit values win over auto-mapped ones per field.

What gets printed:
- `--- Log ---` - the backend's own mapping/execution stage messages (`processing_log`), if any.
  This is **not** your plugin's own `console.log()` output from inside `main.ts` - it's everything
  the HTTP response itself carries, printed after the call completes.
- `--- Auto-mapped input ---` - what `-a`'s prompt actually got mapped to (`mapped_arguments`),
  only present in auto mode.
- `--- Result: <status> ---` - the plugin's real `status`/`message`/`error_code`/`data`.
- `--- Compare ---` (only with `--compare <file>`) - status + data diffed against the saved run.

Both the workspace lookup and the execute call have a client-side timeout (15s and 3 minutes) - a
hung backend fails with a clear error instead of `trigger` sitting there forever. Override the
execute one with `AIVIN_TRIGGER_TIMEOUT_MS` if you have a legitimately slow plugin.

### Watching your plugin's own console output inline: `--watch-logs`

By default `trigger` only shows what's above - not the plugin's own `console.log()`/`sdk.log()`
calls from inside `main.ts`. Pass `--watch-logs` to subscribe to that live, over the same channel
`aivin plugin logs` uses, right before firing the call - one terminal instead of two:

```bash
aivin plugin trigger --watch-logs "summarize this" '{"text":"..."}'
```

This is permission-scoped server-side to plugins you can see the container logs for (your own or
your org's deployments). Triggering a plugin from the public store that some other org owns will
print `(--watch-logs: no live console output - ...)` and fall back to the REST result only - there's
no way around that from the CLI, raw container stdout isn't something the platform exposes across
org boundaries.

### Turning ad-hoc tries into a regression check: `--save` / `--compare`

```bash
aivin plugin trigger "summarize this" '{"text":"..."}' --save
# Saved: .test/trigger/2026-01-15T10-30-00-000Z.json

# ...later, after changing the plugin (or re-testing the same store plugin)...
aivin plugin trigger "summarize this" '{"text":"..."}' \
  --compare .test/trigger/2026-01-15T10-30-00-000Z.json
```

Lighter-weight than `aivin test`'s full deploy+smoke-test+report flow - useful for a quick "did this
still behave the same way" check on any plugin you can trigger, including ones you don't own.

## `aivin plugin logs [pluginId]`

Tails an **already-deployed** plugin's own container stdout/stderr live - the same real-time feed
the platform's own Playground log panel uses. `pluginId` defaults to the current directory's
`manifest.json` id (`--func <name>` picks the entry for a multi-function plugin), so plain
`aivin plugin logs` works from inside the plugin's own project directory; pass an explicit id to
watch a plugin you're not standing inside.

```
Options:
  --func <name>   Which function's id to resolve, for a multi-function plugin
                  (only used when pluginId is omitted)
```

```bash
aivin plugin logs
aivin plugin logs my-plugin-id
```

Prints each line as it's written (`console.log` → gray, `console.error` → red), with a local
timestamp. Runs until you press Ctrl+C. If the container restarts (redeploy/crash) mid-stream,
the connection ends - re-run the command to resume watching.

## `aivin connector`

Connectors are reusable OAuth apps / credential-form namespaces, referenced from `manifest.json`'s
`connection_id` field so multiple plugins can share one set of user-connected credentials instead
of each prompting for the same login separately. Check for an existing one before registering a
new namespace:

```bash
aivin connector search "slack"
aivin connector list
```

```
Commands:
  register                  Register a new connector namespace, interactively
  search [options] [query]  Search connectors for something to reuse instead of registering a new one
  list [options]            List connectors visible to your org
  deprecate [id]            Hide a connector you own from search/list without breaking plugins already using it
  undeprecate [id]          Make a previously-deprecated connector you own discoverable again

Options for search/list:
  --limit <n>            Max results to show (search)
  --page <n>             Page number (list)
  --include-deprecated   Also show your org's deprecated connectors, hidden by default (list)
  --plain                Print a flat list instead of the interactive browser - for scripts/CI (both)
```

`aivin connector register` walks you through naming the namespace and picking the auth shape
(OAuth vs. a plain credential form) interactively - there's no non-interactive/scripted form, since
registering real OAuth app credentials isn't something to automate blindly. Once registered, put
the connector's id in your plugin's `manifest.json` as `connection_id` - see
[MANIFEST.md](https://github.com/aivin-labs/AIVIN-SDK/blob/main/docs/MANIFEST.md#fields) (sdk
repo).

`aivin connector deprecate`/`undeprecate` only affect discoverability (search/list) - they never
break a plugin that's already using the connector's `connection_id`, so it's safe to deprecate one
you've replaced without migrating existing plugins first.

## `aivin pluginstore`

Manages a **self-hosted `aivin-service` worker** (a Docker container you run yourself) attached to
your org as a *plugin store* - a piece of infrastructure your org's plugins can run against,
independent from Aivin's own hosted infra. A store can have multiple *nodes* (multiple machines
each running their own `aivin-service`, all attached to the same store) for redundancy/scale. This
is unrelated to the **Plugin Marketplace** (`aivin mcp <url> --publish` and the browser
CodeEditor's publish flow) - a plugin store is infrastructure you attach, not a place plugins get
published to.

```
Commands:
  create [options] [store_id]  Create a new plugin store + attach this machine as its first node
  attach [options] [store_id]  Attach this machine as another node of an existing plugin store
  ls                            List plugin stores visible to your org, with online/offline status per node
  enable [store_id]             Enable a store for your org (org admin only)
  disable [store_id]            Disable a store for your org without deleting it (org admin only)
  rm [options] [store_id]       Delete a store - revokes EVERY node attached to it, not just this machine (org admin only)
  detach [options]              Remove THIS machine's pairing only (local file only, no BE call)
```

```bash
aivin pluginstore create my-store --label "Production store"
aivin pluginstore ls
```

`create`/`attach` both end by writing `worker-identity.json` into a data directory (default
`~/.aivin/service-data`, override with `--data-dir`) - the machine's actually-running
`aivin-service` process watches that directory (`fs.watch`) and pairs itself automatically the
moment the file appears. Neither command needs `aivin-service` to already be running, and neither
restarts any container - the CLI's job ends at writing the file; pairing itself is the worker's own
responsibility.

```
Options (create):
  --label <label>       Display label for the store (defaults to store_id)
  --node-label <label>  Display label for this node/instance
  --data-dir <path>     Where to write worker-identity.json (default: ~/.aivin/service-data)

Options (attach):
  --node-label <label>  Display label for this node/instance
  --data-dir <path>     Where worker-identity.json is written (default: ~/.aivin/service-data)
```

`aivin pluginstore detach` is the local-only inverse of `attach`/`create`: it deletes
`worker-identity.json` from this machine (`--data-dir` to point at a non-default location) without
calling the backend at all - the running `aivin-service` notices the file is gone and un-pairs on
its own. To actually revoke a node/store server-side (so it can't reattach with an old token), use
`aivin pluginstore rm` instead - **org admin only**, and destructive: it revokes every node attached
to the store, not just this machine, hence the `-y`/`--yes` flag to skip the confirmation prompt in
scripts.

`enable`/`disable` don't delete anything - they just toggle whether your org's plugins are allowed
to route to the store right now, so you can pull a store out of rotation (e.g. for maintenance)
without losing its configuration or having to re-attach nodes afterward.

## `aivin mcp <url> [--publish|--private|--org]`

The one-shot path from "here's an [MCP](https://modelcontextprotocol.io) server" to deployed
plugin(s) - unlike `aivin mcp create` below (which scaffolds exactly 1 tool/resource/prompt you
already know the transport/command/name for), this scans a whole server and converts everything it
finds, interactively:

1. **Scan** (`POST /plugins/scan-mcp`) - `<url>` can be a GitHub/GitLab repo, an npm/Smithery
   package, or a live MCP server URL. Reads the repo/README or handshakes the live server directly.
   Only scan URLs you actually trust - this step connects to (and, for a live handshake, effectively
   runs) whatever's at that address to introspect it, same trust model as installing a dependency
   from source. Bounded to 60s (scanning a live server can legitimately take longer than the other
   steps, which is why this one gets more headroom) so an unresponsive server fails with a clear
   error instead of hanging the CLI indefinitely. Right after a successful scan, this also runs the
   URL itself as a free-text `plugin search` and prints anything that comes back as an FYI ("might
   already be from this server, double-check before converting again") - a soft heuristic, not a
   real duplicate check (there's no reliable way to match "same MCP server" client-side), so it
   never blocks the flow either way.
2. **Select** - checkbox prompt lists every tool/resource/prompt found (all checked by default);
   space to toggle, enter to continue with only what you actually want as plugins.
3. **Build manifests** (`POST /plugins/build-mcp-manifests`, 30s timeout) - one `PluginManifest` per
   selected item, generated server-side (not typed by hand like `aivin mcp create` requires).
4. **Edit** (optional) - confirm prompt offers to rename/redescribe any of the generated plugins
   before anything is deployed. A second, separate optional prompt offers to attach one connector
   (existing or newly registered) as every generated manifest's `connection_id` in one go - see
   [`aivin mcp create`](#aivin-mcp-create-name)'s connector section above for what that buys you.
5. **Confirm** - since the checkbox in step 2 defaults to everything checked, and there's no
   `plugin delete`/`undeploy` command anywhere in this CLI to walk a deploy back, this step asks for
   an explicit yes ("Deploy N plugin(s) to your org? This can't be undone from the CLI.", default
   **No**) before anything actually goes out. In a non-TTY context (scripts/CI) this step is skipped
   entirely - the same as everywhere else in the CLI, only a real terminal gets a confirmation prompt.
6. **Deploy** (`POST /plugins/deploy`, 60s timeout) - always org-scoped first, regardless of the
   visibility flag below (there's no narrower per-workspace scope for plugins today). This is the
   point of no return: deployed plugins are visible to your whole org from here on.
7. **Publish** (only with `--publish`, 30s timeout per submission) - submits each deployed plugin for
   community review (`POST /plugins/store/submit`) - the backend re-verifies each one LIVE against
   the real MCP server before it reaches the review queue, not just whatever got deployed (see the
   backend's own `marketplace-catalog.md` docs, §"Tự submit plugin MCP lên store", for the full
   gate). A submission can't be withdrawn from this CLI either once sent.

   **Blocked, not just warned**: a manifest whose `proxy_config.auth_secret_key` is set is skipped
   entirely at this step (never submitted) instead of being sent as-is. `auth_secret_key` is an
   admin-level credential meant to be shared by everyone *within the org that deployed it* -
   publishing means other orgs can call this same plugin, and there is no confirmed backend step
   that strips or reissues that credential per installing org, so submitting it unchanged would let
   another org's calls silently resolve to (and spend/exhaust/expose) your org's credential. Rebuild
   the plugin with a connector-bound environment variable instead (`aivin mcp create`'s interactive
   auth setup, "one or more environment variables" → bind to a connector) - that path resolves
   credentials per the *calling* org/user, not off the shared manifest, and is safe to publish.
8. Prints ready-to-run `aivin plugin trigger --id <id> -a "..."` / `aivin plugin logs <id>` for
   every plugin deployed, and offers to run one right now, interactively - see
   [`aivin test`](#aivin-test) above for why this exists (its automated smoke test skips proxy
   plugins entirely, so this interactive step is currently the *only* built-in way to verify a
   freshly-converted MCP plugin actually works before walking away from the terminal).

```
Options:
  --publish   Deploy to your org, then submit for community store review
              (needs admin approval)
  --private   Deploy to your org only - default
  --org       Alias of --private - there is no narrower per-workspace scope today
```

```bash
aivin mcp https://github.com/example-org/example-mcp-server
aivin mcp https://github.com/example-org/example-mcp-server --publish
```

## `aivin mcp create <name>`

Scaffolds a **manifest-only** plugin (`proxy_config.type: "mcp"`) that proxies straight to an
external [MCP](https://modelcontextprotocol.io) server's tool/resource/prompt - no `src/main.ts`,
no `package.json`, nothing to run. `aivin deploy`/`aivin test` detect this automatically.

```
Options:
  --transport <transport>      stdio | sse
  --command <command>          Command to launch the MCP server (stdio transport)
  --args <args>                Space-separated args for --command (stdio transport)
  --url <url>                  Remote MCP server URL (sse transport)
  --kind <kind>                tool | resource | prompt (default: tool)
  --tool-name <name>           MCP tool name (kind=tool)
  --resource-uri <uri>         MCP resource URI (kind=resource)
  --resource-mime-type <mime>  MIME type of the resource (kind=resource)
  --prompt-name <name>         MCP prompt name (kind=prompt)
  --description <description>  Plugin description
  --auth-secret-key <key>      Name of the workspace secret to use as the
                               token/credential, if the MCP server needs auth
  --auth-type <type>           auth_type value to send (default: "bearer" when
                               --auth-secret-key is set) - check your backend
                               for which values it supports
  --connector <id>             Existing connector id for this plugin's connection_id
                               (readiness/"needs login" display only - see below)
```

- Fully interactive → run with no flags at all: prompts for everything, in order.
- Fully flagged → fully non-interactive/scriptable, no prompts. `--transport` and `--kind` are
  inferred from whichever flags you pass (`--command` implies stdio, `--url` implies sse;
  `--tool-name`/`--resource-uri`/`--prompt-name` each imply their own `--kind`) - spell them out
  explicitly only if you're scripting this without any of those (unusual).
- **Partially flagged, real terminal** → prompts for exactly what's still missing, not everything -
  e.g. `aivin mcp create foo --transport stdio` alone still prompts for `--command` instead of
  failing with a generic validation error.
- Passing more than one kind-identifying flag at once (e.g. both `--tool-name` and
  `--resource-uri`) without an explicit `--kind` prints a warning and picks one by priority
  (tool → resource → prompt) rather than silently dropping the other with no explanation.
- Whatever's still missing once prompting is done (or immediately, outside a real terminal) fails
  fast with the exact flag(s) needed, e.g. `Missing required field(s): --command <command>,
  --tool-name <name>`.

```bash
# stdio (local command)
aivin mcp create fs-tools --command npx --args "-y @modelcontextprotocol/server-filesystem /data" \
  --tool-name read_file --description "Read files via MCP"

# sse (remote server)
aivin mcp create doc-search --url https://example.com/mcp \
  --tool-name search_docs --description "Search external docs via MCP"
```

See [MANIFEST.md#mcp-proxy-plugins](https://github.com/aivin-labs/AIVIN-SDK/blob/main/docs/MANIFEST.md#mcp-proxy-plugins) for the full `proxy_config`
field reference.

**Auth for a `mcp create` plugin, interactively**: leave `--auth-secret-key` off in a real terminal
and you're asked "Does this MCP server need auth?" with three choices:

- **No auth needed.**
- **One shared token for everyone** (typical for a remote/sse server) - the classic bearer-token
  case, sent as `proxy_config.auth_secret_key`/`auth_type`. One value, shared by the whole org.
- **One or more environment variables** (typical for a local/stdio server) - drops into a loop
  ("Variable 1 name:", Enter on blank to stop) where each declared name is either left for **every
  workspace to configure on its own** later (no OAuth - the platform's own "configure this plugin"
  screen collects the value per workspace) or bound to a **connector** (search-as-you-type over
  `aivin connector search`'s same endpoint, list your org's if the query is left blank, or register
  a brand new one right there - same flow as `aivin connector register`, no separate command
  needed) for automatic per-user/per-workspace OAuth resolution.

This maps onto `manifest.initable`/`manifest.initial[varName].connection_id` - the fields the
backend's plugin execution path (`PluginProxyService.resolveMcpEnv`) actually reads to merge
credentials at call time, in increasing priority: the shared `auth_secret_key` first, then each
workspace's own configured value, then OAuth auto-fill for any field bound to a connector. This is
genuinely three tiers merged per call, not three alternatives to choose between - declaring some
fields as connector-bound and others as "workspace configures it" on the very same plugin is normal
if the MCP server needs more than one kind of credential.

Only declarable interactively - like `aivin connector register`, there's no non-interactive/scripted
form for the env-var loop (declaring several named fields isn't something to automate blindly).

**What `--connector <id>` actually does (and doesn't)**: it sets the manifest's top-level
`connection_id` directly, without going through the loop above. That field only drives the
"requires logging in to a connector" readiness badge (see `plugin info`/`plugin search`'s detail
view) - it is **not** read by the MCP execution path at all, so it injects nothing into the running
MCP server by itself. If you use the interactive env-var loop and bind a field to a connector, the
top-level `connection_id` gets set *for* you automatically (derived from whichever connector the
declared field(s) actually use), for consistency with that badge - you shouldn't normally need
`--connector` directly unless you're deliberately setting the readiness badge independently of any
declared env var.

`aivin mcp <url>` (below) offers a simpler, single-connector version of this same idea - one prompt
to attach a connector to every generated manifest at once, right before the final deploy
confirmation, for when a whole MCP server shares one auth scheme rather than needing individual
per-tool env-var declarations.

## `aivin login`

Saves an API key **once, machine-wide**, to `~/.aivin/credentials` - not the current project's
`.env`. Logging in is a per-machine thing, not a per-project one, so you only need to run this once
regardless of how many plugin projects you work in - every project's `deploy`/`test`/`plugin make`
picks it up automatically.

```
Options:
  -k, --api-key <key>  Set API key directly (skip login entirely)
  --basic              Log in with email/password directly in the terminal instead of a browser
  --google             Alias of the default browser flow - pick Google once the page opens
  --client <client>    Client/org id to use with --basic (default: "aivin.cloud")
```

**Default (no flags) - browser flow, recommended:**

```bash
aivin login
```

Opens your default browser to the platform's actual login page (`https://brain.aivin.cloud`) with
a one-time state token and a `localhost` callback URL. Log in exactly the way you normally would in the
browser - custom-domain org, password, Google, OTP, whatever applies to your account. Once you
confirm on the "Aivin CLI wants to create an API Key" prompt that appears after login, a fresh key
is minted (named after this machine's hostname, replacing any previous key with that same name) and
handed back to a tiny local HTTP server the CLI started for this one request, then saved to
`~/.aivin/credentials`. The browser tab never shows you the raw key - only the CLI does.

`--google` doesn't change anything technically; it's just documentation that once the page opens
you can pick "Log in with Google" there, same as any other login on that page.

**`--basic` - no browser, terminal-only:**

```bash
aivin login --basic
```

Prompts for email/password directly and logs in against the default/shared client only (`--client`,
falls back to `"aivin.cloud"`). If your account belongs to a custom-domain organization, this won't
resolve that domain for you - use the default browser flow instead, which handles it the same way
the web login page does.

**Already have a key:**

```bash
aivin login --api-key <key>
```

Skips login entirely - just saves the given key to `~/.aivin/credentials`.

## `aivin whoami`

Shows which account is currently active on this machine - reads `~/.aivin/credentials` straight
off disk, **no server call**, so it works offline and never fails due to a network/auth problem
(if anything, it's the fastest way to check that a previous `aivin login` actually saved
something).

```bash
aivin whoami
```

```
✅ Logged in
   Email:  jane@example.com
   Name:   Jane Doe
   Org:    Acme Inc
   Server: https://api.aivin.cloud
   Logged in at: 1/15/2026, 10:30:00 AM
```

Email/name/org/login-time only exist at all if the currently-effective `API_KEY` is the exact one
`aivin login` saved (i.e. `~/.aivin/credentials`, the machine-wide default) - identity is captured
once, at login time, and cached alongside the key. If a project's own `.env` overrides `API_KEY`
with a different key, `whoami` says so explicitly instead of guessing:

```
   (API_KEY is from this project's .env, not `aivin login` - no recorded identity/login time)
```

## `aivin key`

Manages *named* API keys on your account - separate from the one machine-wide key `aivin login`
saves. Useful for giving a CI pipeline, a teammate's script, or any other caller its own key you can
revoke independently later.

```
Commands:
  gen [options] <name>     Create (or replace) a named API key for your account - shown only once
  revoke [options] <name>  Revoke a named API key for your account
  list [options]           List API keys on your account
```

```bash
aivin key gen "ci-pipeline"         # prompts for your account password, prints the new key once
aivin key gen "ci-pipeline" --save  # also saves it to ~/.aivin/credentials as this machine's default
aivin key list                      # see what's on your account
aivin key revoke "ci-pipeline"      # revoke it by name
```

All three authenticate with the `API_KEY` `aivin login` already saved - no email/password prompt for
`list`/`revoke`. `gen` is the exception: it still asks for your **account password** (not email) as
a step-up check, since minting a new key from an existing one is the one action here that could
otherwise let an already-leaked key re-provision itself indefinitely even after you revoke it.
`list`/`revoke` only read or remove access, never grant it, so they need no such check.

`aivin key gen` replaces (not accumulates) any existing key with the same name, the same way
re-running `aivin login` replaces this machine's own key.

## `aivin browser [mission]`

Runs an **AI Browser** mission - a multi-step, self-correcting agent that drives an actual browser
(not this plugin's code) to complete a goal. Two modes, picked by `--remote`:

```
Options:
  --remote                 Use a server-side pooled browser instead of your own local one (no
                            local browser needed, no cookies/logins carried over)
  --debug-port <port>      Local mode only: port to look for/launch your browser's remote
                            debugging on (default: 9222, auto-tries a few nearby ports if that
                            one is taken by something else)
  --browser <edge|chrome>  Local mode only: which browser to drive - default: auto-detects your
                            OS's actual default browser, falling back to whichever of Edge/Chrome
                            is installed
  --url <url>              Local mode only: open this URL before the mission starts, instead of a
                            blank page (auto-guessed for a few well-known sites mentioned by name
                            in the mission if omitted)
  --workspace <id>         Workspace id to run in (default: your personal workspace)
  --project <id>           Project id within the workspace (--remote only)
  --agent <id>             Agent id to run as (default: an auto-created/cached agent for local
                            mode, or the workspace's default agent for --remote)
  --no-watch                Fire the mission and return immediately - skip streaming live
                            progress and auto-opening the viewer
  --view                    Just (re)open the fullscreen interactive viewer for whatever HIL
                            session is already active - no mission is started
```

**Local mode (default)** - drives your own, already-running browser via its remote-debugging
protocol (CDP). Uses a dedicated Chrome/Edge profile (`~/.aivin/browser-profile`), not your regular
daily-driver profile - real cookies/logins persist there across runs, but the first time you use a
given site you'll need to log in once, same as opening it in a fresh browser. If nothing's
listening on the debug port yet, `aivin browser` prints the exact launch command for your OS/browser
instead of failing silently:

```bash
aivin browser "Find the top 3 posts on Hacker News right now and summarize them"
```

A live viewer window opens automatically once the mission needs human input (HIL) or, by default,
as soon as it starts - `--no-watch` skips this and just prints progress to the terminal instead.

**Remote mode (`--remote`)** - runs on a server-side pooled browser instead, no local browser
required, no cookies from your machine carried over. Useful for CI, headless environments, or
missions that don't need a logged-in session on a specific real account.

```bash
aivin browser --remote "Check the current price of BTC on coinmarketcap.com"
```

`aivin browser --view` alone (no mission) reopens the interactive viewer for whatever HIL session
is already active, without starting anything new - handy if you closed the auto-opened window by
accident.

## `aivin do <agent_nickname> <mission>`

Has a specific agent start a background mission toward a free-text goal (`POST /agent/start-work`),
not a specific deployed plugin. The agent runs the mission on its own, checking in via the
progress stream (see below); this is the CLI-native equivalent of typing into the platform's chat
and choosing which AI Staff agent should handle it.

```
Options:
  --workspace <id>  Workspace id to run in (default: your personal workspace)
  --project <id>    Project id within the workspace
  --no-watch        Fire the mission and return immediately - skip streaming live progress
```

```bash
aivin do supportbot "Summarize today's support tickets and post the summary to #digest"
```

- `<agent_nickname>` is matched against the resolved workspace's already-installed agents (by
  nickname, name, or id). Omit either argument and you'll be prompted interactively - the mission
  prompt if only the agent is given, or a picker over the workspace's agents if only the mission is
  given (in a non-interactive shell, both are required up front).
- If the nickname doesn't match anything in the workspace, or the workspace has no agents at all
  yet, you're offered a choice: search & install one from the marketplace, or create a brand new
  one - so `aivin do` never dead-ends on an empty workspace (see `aivin agent install`/`aivin agent
  make` below, which this reuses).

By default it then streams the mission's live progress in the terminal (same realtime channel
`aivin plugin logs` uses under the hood) until the run finishes or you press Ctrl+C - pass
`--no-watch` to just fire it and return immediately instead.

If `--workspace` is omitted, it runs in your **personal workspace** (the platform always resolves
that first when no workspace is given).

### `aivin do job <description>`

Creates a new **automation job** - recurring background work on a cron-style schedule, independent
of any single chat/mission invocation (`POST /automation/jobs/create`).

```
Options:
  --workspace <id>      Workspace id to create the job in (default: your personal workspace)
  --project <id>        Project id within the workspace
  --agent <id>          Agent id the job runs as (default: the workspace's default agent)
  --schedule <condition>  Natural-language schedule, e.g. "every Monday at 9am" (default: let the
                         platform infer one)
```

```bash
aivin do job "Compile last week's support tickets into a summary and post it to #digest"
aivin do job "Send a daily standup reminder" --schedule "every weekday at 9am"
```

If `--schedule` is omitted, the platform infers a cadence (or falls back to manual) from the
description itself - pass it explicitly if you already know the cadence, to skip the extra
inference call.

## `aivin task [description]`

Creates a new task (`POST /task/create`) from a plain-language description - the description
becomes both the task's title (truncated if long) and its full content.

```
Options:
  --workspace <id>  Workspace id to create the task in (default: your personal workspace)
  --project <id>    Project id within the workspace
  --assignee <userId>  User id to assign the task to (default: unassigned)
```

```bash
aivin task "Follow up with the customer about their refund request"
```

`aivin task` also has subcommands for the rest of the task lifecycle:

```
Commands:
  list [options]          List tasks in a project
  mine [options]          List tasks assigned to you in a project
  get [id]                Get a task by id
  update [options] [id]   Update a task
  delete [id]             Delete a task
```

```bash
aivin task list --status todo                          # list open tasks in your first project
aivin task list --project <id> --assignee <userId>      # filter by project/assignee
aivin task mine                                          # tasks assigned to you
aivin task get <id>                                      # full task details (JSON)
aivin task update <id> --status done                     # move a task to done
aivin task update <id> --title "New title" --priority high
aivin task delete <id>
```

`list`/`mine` are scoped to a single project (the backend's real `/task/:projectId/list` route) -
`--project` defaults to the resolved workspace's first project, and throws if it has none (a
Personal workspace typically has no projects; pass `--project <id>` explicitly, or run
`aivin workspace` to find one).

## `aivin workspace`

Interactive picker: lists your workspaces (personal workspace first), lets you select one, then
lists that workspace's projects so you can pick the corresponding one - printing the resolved
`--workspace`/`--project` ids to pass to `aivin do`/`do job`/`task`.

```
Options:
  --plain  Print a flat list instead of the interactive picker (for scripts/CI)
```

```bash
aivin workspace
```

Non-TTY contexts (scripts, CI, piped output) or `--plain` print a flat listing instead of the
interactive prompts.

## `aivin agent`

Search the AI Staff marketplace, install an agent into a workspace, create a brand new one, or
publish one you own. `aivin do` calls into the same install/create flows automatically when it
can't resolve `<agent_nickname>`.

```
Commands:
  search [options] [query]     Search the AI Staff marketplace for an agent
  install [options] [query]    Search the marketplace and install an agent into a workspace
  make [options]                Create a brand new AI Staff agent
  publish [options] [agentId]  Publish an agent you own to the marketplace
```

```bash
aivin agent search "customer support"                    # browse the marketplace
aivin agent install "customer support"                    # search + pick + install into your personal workspace
aivin agent install --workspace <id>                      # no query - opens the same interactive picker `aivin do` uses
aivin agent make --name "Ada" --nickname ada --email ada@example.com --bio "Support triage bot"
aivin agent publish <agentId>                             # make an agent you own visible in the marketplace
```

- `install`/`make` default to your personal workspace when `--workspace` is omitted.
- `make` calls `POST /ai-staff/create`; passing the target workspace at creation time auto-installs
  the new agent there too (no separate `install` call needed).
- `publish` is a two-step platform operation under the hood (`POST /ai-staff/update` with
  `is_published: true`, then `POST /ai-staff/push` to promote the workspace's local copy to the
  shared master) - both scoped to the workspace the agent actually lives/was authored in.

## `aivin project`

Create, rename, or delete a project within a workspace (the backend has no separate "list projects"
endpoint - use `aivin workspace` to browse a workspace's existing projects).

```
Commands:
  create [options] [name]  Create a new project in a workspace
  update [options] [id]    Update a project (currently: rename)
  delete [options] [id]    Delete a project
```

```bash
aivin project create "Q3 Launch"
aivin project update <id> --name "Q3 Launch (renamed)"
aivin project delete <id>
```

All three default to your personal workspace when `--workspace` is omitted.

## Environment variables

`aivin login` saves your key once to `~/.aivin/credentials` and every plugin project on the
machine picks it up automatically - there's no per-project credential to manage.

| Variable            | Used by                                          | Default                     | When you'd touch it                                          |
| -------------------- | -------------------------------------------------- | ----------------------------- | ---------------------------------------------------------------- |
| `SDK_ENDPOINT`  | SDK calls, `aivin start`                   | `sdk.aivin.cloud:443`      | Point `main()`'s SDK calls at a local/dev/staging backend instead of production. Staging: `beta-sdk.aivin.vn:50052` (dedicated Cloudflare Tunnel TLS port - production goes through a load balancer on the standard 443 port instead, a different setup). |
| `AIVIN_BASE_URL`     | `deploy`, `test`, `plugin make/convert/trigger`, `login --basic` | `https://api.aivin.cloud`    | Only for a self-hosted or staging instance. Staging: `https://beta-api.aivin.vn`. |
| `AIVIN_WEB_URL`      | `login` (browser flow)                             | `https://brain.aivin.cloud`  | Only for a self-hosted or staging instance.                   |
| `LOCAL_TEST_PORT`    | `aivin start`                                       | `4001`                       | Only if `4001` is already taken on your machine.              |
| `LOCAL_TEST_HOST`    | `aivin start`                                       | `127.0.0.1`                  | Loopback-only by default (`/invoke` has no auth) - only widen this if you deliberately want another device on your network to reach it. See [sdk repo's SECURITY.md](https://github.com/aivin-labs/AIVIN-SDK/blob/main/docs/SECURITY.md). |
| `AIVIN_SANDBOX_WORKER` | `aivin start`, deployed containers                | `false`                      | Set `true` to run `src/main.ts` inside an isolated `worker_threads.Worker` (no direct access to the container's secret, restricted fs/child_process) instead of loading it in-process. Off by default - see [sdk repo's worker-sandbox.md](https://github.com/aivin-labs/AIVIN-SDK/blob/main/docs/draft/plugins/worker-sandbox.md). |

Everything else (`SDK_SECRET`, `SDK_GRPC_SERVER_BIND`, `SDK_GRPC_TLS`, `NODE_ENV`, ...) is
either injected automatically inside a deployed container or has a working zero-config default -
not something you're expected to set by hand.

## See also

- [GETTING_STARTED.md](./GETTING_STARTED.md) - the narrative walkthrough these commands fit into
- [MANIFEST.md (sdk repo)](https://github.com/aivin-labs/AIVIN-SDK/blob/main/docs/MANIFEST.md) - every `manifest.json` field, including MCP proxy plugins
- [PLUGIN_DEVELOPMENT_GUIDE.md (sdk repo)](https://github.com/aivin-labs/AIVIN-SDK/blob/main/docs/PLUGIN_DEVELOPMENT_GUIDE.md) - writing and testing a handler
- [SDK.md (sdk repo)](https://github.com/aivin-labs/AIVIN-SDK/blob/main/docs/SDK.md) - everything the SDK exposes inside `main()`
