# Getting Started with @aivin-labs/cli

End-to-end walkthrough: from an empty folder to a deployed, discoverable Aivin plugin, using the
`aivin` command this package provides. For the full flag-by-flag reference of every command, see
[CLI.md](./CLI.md) instead — this doc is the narrative path through the same ground.

If you're looking for how to actually *write* the handler (the SDK API: `ai`, `vector`, `store`,
`ctx`, response shapes, testing with mocks, best practices) rather than how to drive the CLI, that
lives in [`@aivin-labs/sdk`'s own docs](https://github.com/aivin-labs/AIVIN-SDK/tree/main/docs) —
this guide links out to the relevant page at each step instead of duplicating it.

## 1. Prerequisites

| | |
| --- | --- |
| **Node.js** | ≥ 22.0.0 — the SDK relies on Node's native TypeScript support to load `src/main.ts` directly, no build step. Stable from Node 22.6, default from Node 24. |
| **This package** | `npm install -g @aivin-labs/cli` — gives you the `aivin` command used throughout this guide. |
| **Account** | An Aivin account, for `aivin login` / `aivin deploy` / `aivin test` (not needed for `aivin create`/`aivin start`, which are fully local). |
| **Docker** | Not required locally — the platform builds and runs your container remotely on `aivin deploy`. |

```bash
npm install -g @aivin-labs/cli
aivin --version
```

## 2. Create the plugin

Two starting points, depending on whether you want AI to write the first draft of your business
logic or you'd rather write it by hand:

```bash
# Guided, AI-assisted: asks what the plugin should do, then scaffolds AND generates real code
aivin init my-plugin
cd my-plugin && npm install
```

```bash
# Blank scaffold, no AI step: one src/main.ts you write by hand
aivin create my-plugin
cd my-plugin && npm install
```

`aivin init` writes `src/service.ts` (the AI-generated business logic — a plain
`execute(input, ctx)` function, no protocol boilerplate) plus a thin, static `src/main.ts` wrapper
that packages its result into the platform's response shape. `aivin create` writes one
`src/main.ts` you edit directly, exporting `main(mission, input, ctx)`. Regenerate either later
with `aivin plugin make "<description>"` — it targets whichever file your project actually uses.

Either way, you get:

```
my-plugin/
├── manifest.json    # shared fields + plugins[] — identity, input/output description, triggers
├── src/
│   └── main.ts        # (+ service.ts, if you used `aivin init`)
├── package.json      # depends only on @aivin-labs/sdk; "start" runs `aivin-server` directly
├── tsconfig.json      # editor/type-checking config (not used to build anything at deploy time)
├── AGENTS.md          # orientation for a coding agent (Claude Code, Cursor, ...) working in this project
├── test/              # a real, runnable example test using createMockSDK
├── .env                # local-only config (see step 4)
└── .gitignore
```

`manifest.json`'s `description` is what the AI planner reads to decide when to use your plugin —
fill it in precisely. Full field reference:
[MANIFEST.md](https://github.com/aivin-labs/AIVIN-SDK/blob/main/docs/MANIFEST.md) (in the sdk
repo — this is a runtime contract the SDK itself parses/validates, not a CLI concern).

Already have a project instead of a description to work from?

```bash
cd your-existing-project
aivin plugin convert
```

This scans your project's tree on demand (never uploads full file contents up front), plans
single-file vs. multi-file/multi-entry based on what it actually finds — including porting a
non-TypeScript project's real logic (e.g. Python) rather than editing it in place — then verifies
the result with a real `tsc` run plus a sandboxed smoke test before calling it done. See
[CLI.md#aivin-plugin-convert](./CLI.md#aivin-plugin-convert-hint) for the full loop,
overwrite-safety behavior, and `--force` (re-run conversion on a project already converted before).

Not sure something like this doesn't already exist? Check first:

```bash
aivin plugin search "what you're trying to build"
```

## 3. Write (or regenerate) the handler

This part is SDK API, not CLI — see:

- [PLUGIN_DEVELOPMENT_GUIDE.md](https://github.com/aivin-labs/AIVIN-SDK/blob/main/docs/PLUGIN_DEVELOPMENT_GUIDE.md) — writing `main()`/`execute()`, the `ctx` argument, best practices, idempotency
- [SDK.md](https://github.com/aivin-labs/AIVIN-SDK/blob/main/docs/SDK.md) — every namespace (`ai`, `vector`, `store`, `task`, ...) and how to call them
- [EXAMPLES.md](https://github.com/aivin-labs/AIVIN-SDK/blob/main/docs/EXAMPLES.md) — real plugins across common use cases

Or let AI write it from a description:

```bash
aivin plugin make "Summarize a support ticket and tag its urgency"
```

Review the output before relying on it — generated code is a strong starting point, not a
guarantee.

## 4. Test locally

### Unit tests — no network, no running server

```bash
npm test
```

`aivin create`/`aivin init` already scaffold a real, runnable test using `createMockSDK`/
`withMockSDK` — no real backend, no gRPC round trip. Keep it in sync as you change what your
handler calls/returns.

### Running it for real

```bash
aivin start
```

This starts two things:

1. A real gRPC server on `:50051` — the same protocol the production host uses to trigger your
   plugin. You generally won't call this directly.
2. An HTTP test shim on `:4001` for quick manual testing:

```bash
curl -X POST http://localhost:4001/invoke \
  -H 'content-type: application/json' \
  -d '{"input": {"text": "Some text to summarize"}}'
```

Want to see every SDK call as it happens instead of just a summary at the end?

```bash
aivin start --debug         # human-readable, live, one line per call
aivin start --debug-json    # same, one JSON object per line - easier for a script/coding agent to parse
```

`--no-watch` disables hot-reload (on by default — editing `src/`/`manifest.json` restarts your
handler in place, no Ctrl+C needed).

**SDK calls made during local testing default to the production backend** (`api.aivin.cloud`) if
`SDK_ENDPOINT` isn't set in `.env` — so `ai.prompt(...)` etc. work out of the box, against real
production data. Point `.env` at a local/dev backend instead if you don't want that:

```bash
# .env
SDK_ENDPOINT=localhost:50051
SDK_SECRET=
```

A one-time warning is logged whenever the production default is used, so it's never silent.

Under the hood, `aivin start` spawns your project's own installed `@aivin-labs/sdk`'s
`bin/server.mjs` (via its `aivin-server` bin entry) with a couple of extra env vars for the flags
above — the exact same process a deployed container runs via `npm start`. Running `npm start`
yourself locally works too; you just lose the `--debug`/`--no-watch` conveniences `aivin start`
adds on top.

## 5. Deploy

```bash
aivin login    # once per machine - saves an API key to ~/.aivin/credentials
aivin test      # deploy to a non-production test instance first
aivin deploy    # ship to your org
```

`aivin test` uses the same payload as `aivin deploy` but a different, non-production-only endpoint
— real container, real gRPC, real SDK calls, but not visible to anyone yet. It goes a step
further than a plain deploy: it generates sample input from your `manifest.json`'s `input` schema,
actually invokes the plugin, and writes a pass/fail report to `.test/<timestamp>.json`. Pass
`--workspace <id>` to pick which workspace it runs against, or `--no-smoke-test` to skip this and
just deploy.

Each successful deploy auto-increments `manifest.json`'s patch version.

Not every plugin needs custom code — `aivin mcp create <name>` scaffolds a manifest-only plugin
that proxies to an external [MCP](https://modelcontextprotocol.io) server's tool/resource/prompt
instead. `aivin deploy`/`aivin test` detect this automatically and skip the code upload entirely.
See
[MANIFEST.md#mcp-proxy-plugins](https://github.com/aivin-labs/AIVIN-SDK/blob/main/docs/MANIFEST.md#mcp-proxy-plugins).

## 6. Use the deployed plugin

```bash
aivin plugin trigger "summarize this" '{"text":"..."}'
aivin plugin trigger -a "Summarize this ticket: customer can't log in after the last update"
aivin plugin logs
```

`aivin plugin trigger` invokes it directly and prints the result — the exact same
`/plugins/execute` the platform's own Playground uses, so it's a real invocation, not a
simulation. `-a`/`--auto` skips writing structured JSON yourself — give it a free-text prompt and
the backend maps it onto `manifest.json`'s `input` schema for you. `aivin plugin logs` tails the
deployed plugin's own console output live.

## 7. Beyond one plugin

`aivin` is also how you drive your Aivin workspace directly, not just build plugins:

- `aivin connector register` — register a reusable connector (OAuth app / credential namespace)
  for a `manifest.json` `connection_id`; `aivin connector search`/`list` to find one that already
  exists instead of creating a duplicate.
- `aivin do "<goal>"` — have an AI Staff agent work toward a goal in the background, not a
  specific deployed plugin.
- `aivin browser "<mission>"` — run an AI Browser mission, driving your own local browser (own
  profile, own cookies — log in once, watch missions run live from then on).
- `aivin task "<description>"` — create a task from a plain-language description.
- `aivin workspace` / `aivin agent` / `aivin project` — browse workspaces, projects, and AI Staff
  agents, and pick one to use with `--workspace`/`--project`/`--agent` elsewhere.

Full flag reference for all of these: [CLI.md](./CLI.md).

## 8. Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `aivin start` fails with `EADDRINUSE` on the gRPC port | Something else (possibly another plugin instance) already owns `:50051`. Set `SDK_GRPC_SERVER_BIND=127.0.0.1:<other-port>`. |
| Local HTTP test shim didn't start, but the gRPC server did | The shim failing to bind (e.g. port `:4001` taken) never takes down the real server — check the log line, set `LOCAL_TEST_PORT` to something free. |
| `aivin start` fails with "Could not find @aivin-labs/sdk installed" | Run `npm install` in the plugin project first — `aivin start` resolves `bin/server.mjs` from *this project's own* installed `@aivin-labs/sdk`, not from the CLI's own install location. |
| `aivin deploy`/`aivin test` fails with 401/403 | Run `aivin login` again — it saves a fresh key to `~/.aivin/credentials`, shared by every project on this machine. |
| SDK calls seem to hit production unexpectedly | Expected if `SDK_ENDPOINT` isn't set in `.env` — it defaults to `api.aivin.cloud`. Set it to a local/dev backend if that's not what you want — see step 4. |
| Generated code from `aivin plugin make` doesn't compile/looks wrong | Review and edit — it's AI-generated, treat it like a first draft from a junior contributor. |
| `command not found: aivin` after `npm install` (not `-g`) in a plugin project | Only `@aivin-labs/sdk` is a dependency of a scaffolded plugin project, by design (the deployed container never needs the CLI) — `@aivin-labs/cli` is meant to be installed globally on your own machine, not per-project. |

## See also

- [CLI.md](./CLI.md) — every `aivin` command, option, and environment variable
- [SDK docs](https://github.com/aivin-labs/AIVIN-SDK/tree/main/docs) — everything your handler can call, `manifest.json`'s full field reference, `ctx`, examples
- [ARCHITECTURE.md (sdk repo)](https://github.com/aivin-labs/AIVIN-SDK/blob/main/docs/ARCHITECTURE.md) — how the transport/runtime works, for the curious
