# @aivin-labs/cli

Building an AI agent that does real work — one that calls an LLM, reasons over your data, uses
tools, and knows when to hand a decision back to a human — usually means weeks of infrastructure
before you write a single line of business logic: a service to host it, an SDK to wire the model
calls, auth, queues, logging, a deploy pipeline. [Aivin](https://aivin.cloud) exists to collapse
that. Describe what you want built, and get back a real, typed, callable, observable service in
minutes — not sprints.

`@aivin-labs/cli` is your entry point into that platform, and your main tool for working inside
the Aivin ecosystem day to day. Instead of hand-rolling a service, you run `aivin init`, describe
what the plugin should do, and get a real, deployable TypeScript project — hot-reloading local dev
server, typed input/output, and a one-command path to production included. Everything after that —
testing, logs, connectors, MCP integrations, agents, automation — is one more `aivin` command
away, so you can build agentic applications that plug straight into the platform without ever
leaving your terminal or editor.

This package is the interactive tooling only; the plugin runtime library your generated code
actually imports at runtime is
[`@aivin-labs/sdk`](https://www.npmjs.com/package/@aivin-labs/sdk) (`ai`, `vector`, `store`, ...),
installed automatically as a dependency of every project this CLI scaffolds. See
[Relationship to @aivin-labs/sdk](#relationship-to-aivin-labssdk) below for how the two packages
divide responsibilities.

## The Aivin ecosystem

Aivin isn't just a place to host one function — it's a small, composable ecosystem for agentic
software, and this CLI is how you reach every piece of it:

- **Plugins** — the core unit of work: a typed function (`main(mission, input, ctx)`), deployed as
  its own container, callable by name, and searchable by every other plugin or agent in your org
  (`aivin plugin search`, `call()` from the SDK). Write one by hand (`aivin create`), have AI
  generate it from a description (`aivin init` / `aivin plugin make`), or convert an existing
  project into one in place (`aivin plugin convert`).
- **MCP proxies** — wrap any [Model Context Protocol](https://modelcontextprotocol.io) server's
  tools, resources, or prompts as first-class Aivin plugins with zero code (`aivin mcp <url>`),
  so the growing MCP ecosystem becomes instantly usable by your agents.
- **Connectors** — shared OAuth apps and credential namespaces (`aivin connector`), so ten plugins
  that all need "the org's Slack" don't each prompt the user for a separate login.
- **AI Staff agents** — persistent, nameable agents you target with a mission, that use your
  plugins as tools and can pause to ask a human for input mid-task (HIL). Install one from the
  marketplace or build your own (`aivin agent`, `aivin do`).
- **Automation jobs** — recurring, scheduled work described in plain language
  (`aivin do job "..."`) — no cron syntax to write.
- **AI Browser** — a self-correcting agent that drives a real browser, yours or a server-side one,
  to complete a goal end-to-end (`aivin browser`).
- **Workspaces, projects, and tasks** — the organizing structure everything above lives in, plus a
  lightweight task tracker (`aivin task`) for the human side of the work.
- **Plugin Marketplace** — plugins and MCP proxies you build here aren't limited to your own org:
  submit them for community review and publish to Aivin's public Plugin Marketplace
  (`aivin mcp <url> --publish`), so the AI capabilities you develop become reusable building
  blocks other teams on the platform can search for and call, not just your own.
- **Local, agent-supervised execution** — this CLI is also how Aivin reaches onto *your* machine to
  get real work done, always under an explicit mission and never as open-ended remote access:
  `aivin browser` drives a dedicated local browser profile (your own cookies/logins, isolated from
  your daily-driver browser) so an agent can act on real logged-in sites, and `aivin start` can run
  your plugin code inside a sandboxed `worker_threads.Worker` (`AIVIN_SANDBOX_WORKER=true`) with no
  direct access to secrets or the filesystem. Every run stays scoped to the mission that started
  it, with human-in-the-loop checkpoints (HIL) whenever an agent needs your go-ahead.

Put together: you describe the outcome you want, and Aivin's building blocks — plugins, agents,
connectors, MCP tools — compose into it. `aivin` is how you author, test, and ship each of those
pieces from your own terminal, on top of whatever editor/CI workflow you already use.

## Table of contents

- [The Aivin ecosystem](#the-aivin-ecosystem)
- [Install](#install)
- [Quick start](#quick-start)
- [What you get from a scaffold](#what-you-get-from-a-scaffold)
- [Command overview](#command-overview)
- [Environment variables](#environment-variables)
- [Documentation](#documentation)
- [Relationship to @aivin-labs/sdk](#relationship-to-aivin-labssdk)
- [Development](#development)
- [License](#license)

## Install

```bash
npm install -g @aivin-labs/cli
aivin --version
```

Requires Node.js ≥ 22.0.0 — the SDK relies on Node's native TypeScript execution to load
`src/main.ts` directly, with no separate build step. `aivin start`/`aivin test` check this up
front and fail with a clear message (not a cryptic loader error) if your Node is too old.

## Quick start

```bash
aivin init my-plugin          # ask what the plugin should do, scaffold + generate working code
cd my-plugin && npm install

aivin start                   # run it locally - gRPC server + an HTTP test shim on :4001

aivin login                   # save an API key (once per machine)
aivin test                    # verify on a non-production instance first
aivin deploy                  # ship it
```

`aivin init` asks what the plugin should do, then scaffolds the project **and** generates real
working code from that description in one step. Prefer a blank scaffold you write by hand?
`aivin create my-plugin` does just the scaffolding, no AI step. Already have a project instead of
a description? `aivin plugin convert` turns an existing directory into a plugin in place.

## What you get from a scaffold

Both `aivin init` and `aivin create` produce the same project shape (`init` additionally writes
`src/service.ts` — see [CLI.md](docs/CLI.md#aivin-init-name)):

```
my-plugin/
├── manifest.json    # shared fields + plugins[] - identity, input/output schema, triggers
├── src/
│   └── main.ts        # (+ service.ts, if you used `aivin init`)
├── package.json      # depends only on @aivin-labs/sdk; "start" runs `aivin-server` directly
├── tsconfig.json      # editor/type-checking config, not used to build anything at deploy time
├── AGENTS.md          # orientation for a coding agent (Claude Code, Cursor, ...) in this project
├── test/              # a real, runnable example test using createMockSDK
├── .env                # local-only config (SDK_ENDPOINT, etc.)
└── .gitignore
```

`manifest.json`'s `description` is what the AI planner reads to decide when to use your plugin —
fill it in precisely. Full field reference lives in
[MANIFEST.md (sdk repo)](https://github.com/aivin-labs/AIVIN-SDK/blob/main/docs/MANIFEST.md).

## Command overview

Every command supports `--help` for its full flag list (`aivin <command> --help`). This table is
a map — see [docs/CLI.md](docs/CLI.md) for the complete reference, including exact flags,
examples, and behavior notes for each one.

| Command | What it does |
| --- | --- |
| `aivin init [name]` | Scaffold a plugin **and** AI-generate its code from a description, in one step |
| `aivin create [name]` | Scaffold a blank plugin project, no AI step |
| `aivin validate` | Validate `manifest.json` (or `--json`/`--stdin`) without touching the network |
| `aivin start` | Run the plugin locally (real gRPC server + `:4001` HTTP test shim), with hot-reload |
| `aivin deploy` | Deploy the current plugin to your org |
| `aivin test` | Deploy to a non-production instance, then smoke-test it and save a report |
| `aivin plugin search <query>` | Search the platform's plugin ecosystem for something to reuse |
| `aivin plugin info <id>` | Show one plugin's detail directly by id, no search query needed |
| `aivin plugin ask [mission]` | One-shot: auto-pick the best-matching plugin for a mission and trigger it, like an agent would |
| `aivin plugin make <description>` | AI-generate `src/main.ts` from a natural-language description |
| `aivin plugin convert [hint]` | Turn an existing project in the current directory into a plugin |
| `aivin plugin trigger [mission] [input]` | Invoke a deployed plugin for real and print the result |
| `aivin plugin logs [pluginId]` | Tail a deployed plugin's live console output |
| `aivin connector` | Register/search/list reusable OAuth or credential-form connectors |
| `aivin pluginstore` | Attach a self-hosted `aivin-service` worker to your org as a plugin store |
| `aivin mcp <url>` | Scan an MCP server and convert everything it finds into deployed plugin(s) |
| `aivin mcp create <name>` | Scaffold a single manifest-only plugin that proxies one MCP tool/resource/prompt |
| `aivin login [baseUrl]` | Log in and save an API key for this machine (browser flow by default) |
| `aivin whoami` | Show which account is logged in on this machine |
| `aivin key` | Manage named API keys (`gen` / `revoke` / `list`) for your account |
| `aivin browser [mission]` | Run an AI Browser mission, driving a real local or server-side browser |
| `aivin do [agentNickname] [mission]` | Have an AI Staff agent work toward a goal in the background |
| `aivin do job [description]` | Create a recurring automation job from a plain-language description |
| `aivin task [description]` | Create, list, get, update, or delete tasks in a project |
| `aivin workspace` | Browse your workspaces/projects and pick one for `--workspace`/`--project` |
| `aivin agent` | Search, install, create, and publish AI Staff agents |
| `aivin project` | Create, rename, and delete projects within a workspace |

## Environment variables

Most projects never need any of these — `aivin login` saves your key once, machine-wide, and
sensible defaults cover local development. Set them in a project's `.env` (or your shell) to
override:

| Variable | Used by | Default |
| --- | --- | --- |
| `SDK_ENDPOINT` | SDK calls, `aivin start` | `sdk.aivin.cloud:443` |
| `AIVIN_BASE_URL` | `deploy`, `test`, `plugin make/convert/trigger`, `login --basic` | `https://api.aivin.cloud` |
| `AIVIN_WEB_URL` | `login` (browser flow) | `https://brain.aivin.cloud` |
| `LOCAL_TEST_PORT` | `aivin start` | `4001` |
| `LOCAL_TEST_HOST` | `aivin start` | `127.0.0.1` (loopback-only — `/invoke` has no auth) |
| `AIVIN_SANDBOX_WORKER` | `aivin start`, deployed containers | `false` |

Full descriptions and when you'd actually touch each one: [CLI.md#environment-variables](docs/CLI.md#environment-variables).

## Documentation

- [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md) — the full narrative walkthrough: scaffold,
  write, test, deploy, and use a plugin from the CLI, plus everything else `aivin` drives (tasks,
  AI Browser missions, workspaces, agents).
- [docs/CLI.md](docs/CLI.md) — every command, flag, and environment variable, for lookup.
- [docs/CHANGELOG.md](docs/CHANGELOG.md) — release history.
- [`@aivin-labs/sdk`'s own docs](https://github.com/aivin-labs/AIVIN-SDK/tree/main/docs) — the SDK
  API your plugin code calls (`ai`, `vector`, `store`, ...), `manifest.json`'s field reference, and
  `ctx`. This package doesn't duplicate that content.

## Relationship to @aivin-labs/sdk

- **This package (`@aivin-labs/cli`)** is dev tooling: it never runs inside a deployed plugin
  container, only on your machine (or CI). Its own `aivin --version` is independent of whatever
  `@aivin-labs/sdk` version a given plugin project has installed.
- **`@aivin-labs/sdk`** is the runtime library (`import { ai, ... } from '@aivin-labs/sdk'`) and
  also ships `bin/server.mjs` (exposed as the `aivin-server` binary) — the actual process a
  deployed plugin container runs via `npm start`. `aivin start`/`aivin test` resolve and run this
  binary from the **current project's own** installed `@aivin-labs/sdk`, not from this CLI's
  install location, so a scaffolded project's `package.json` depends on `@aivin-labs/sdk` directly
  and never needs this CLI package installed inside the container.

## Development

```bash
npm install
npm run lint      # eslint .
npm run format    # prettier --write .
npm test          # node --test test/cli.validate.test.mjs
```

## License

MIT
