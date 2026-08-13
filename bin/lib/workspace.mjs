import chalk from 'chalk';
import axios from 'axios';
import inquirer from 'inquirer';
import { parseApiKeyClient } from './auth.mjs';
import { browseResults } from './pluginTrigger.mjs';

// ── Missions, automation jobs, tasks, and workspace/project selection ─────────────────────────
//
// `aivin do` / `aivin do job` / `aivin task` are thin CLI wrappers over the same platform
// endpoints the web app's chat/automation/task UIs already use (`/agent/start-work`,
// `/automation/jobs/create`, `/task/create`) - not a new mechanism, just a terminal-native way to
// reach them with the already-saved API_KEY. All three default to your personal workspace when
// --workspace is omitted, since GET /workspace/list always returns the caller's Personal
// workspace first (see WorkspaceService.listWorkspace on the backend).

export function missionAuthHeaders() {
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    console.log(chalk.yellow('⚠️  API_KEY not set - run `aivin login` first'));
  }
  // `x-client-slug` - required for any request hitting the API host directly (no browser
  // Origin/Referer for TrustDomainService to map): checkRegisteredClient falls back to the Host
  // header otherwise (e.g. "beta_api_aivin_vn"), which never matches a real registered_clients
  // entry - not a missing-tenant error, just a gap between "FE calls via its own domain" (has an
  // Origin) and "CLI/SDK calls the API host directly" (nothing to map but this header). Same fix
  // as test-sdk's mintCap.ts applies for its own direct calls.
  const clientSlug = apiKey ? parseApiKeyClient(apiKey) : undefined;
  return {
    headers: {
      Authorization: `Bearer ${apiKey || 'dev-token'}`,
      ...(clientSlug ? { 'x-client-slug': clientSlug } : {}),
    },
  };
}

export function missionServerUrl() {
  return process.env.AIVIN_BASE_URL || 'https://api.aivin.cloud';
}

export async function listWorkspaces(serverUrl, authHeaders) {
  let res;
  try {
    res = await axios.get(`${serverUrl}/workspace/list`, authHeaders);
  } catch (error) {
    // axios leaves `error.message` empty for some connection-level failures (e.g. ECONNREFUSED) -
    // fall back to `error.code` so this never surfaces as a bare, content-free "❌ ".
    const message = error.response?.data?.message || error.message || error.code || 'Unknown error';
    throw new Error(`Couldn't reach ${serverUrl} to look up workspaces: ${message}`, { cause: error });
  }
  return Array.isArray(res.data) ? res.data : res.data?.items || [];
}

/**
 * workspaces[0] IS "your personal workspace" whenever --workspace is omitted - the backend always
 * unshifts the caller's Personal workspace to the front of GET /workspace/list's response.
 */
export async function resolveWorkspace(serverUrl, authHeaders, explicitId) {
  const workspaces = await listWorkspaces(serverUrl, authHeaders);
  if (explicitId) {
    const match = workspaces.find((w) => (w.id || w._id) === explicitId);
    if (!match) throw new Error(`Workspace "${explicitId}" not found or not accessible.`);
    return match;
  }
  const personal = workspaces[0];
  if (!personal) throw new Error('No workspace found for this account. Pass --workspace <id>.');
  return personal;
}

/**
 * A workspace's `agents` array always has its client's default AI Staff agent unshifted to the
 * front (see WorkspaceService.assembleEnrichedWorkspace) - so agents[0] is a sensible default
 * whenever --agent is omitted, same reasoning as resolveWorkspace's workspaces[0].
 */
export function resolveAgentId(workspace, explicitAgentId) {
  if (explicitAgentId) return explicitAgentId;
  const agentId = workspace.agents?.[0]?.id || workspace.agents?.[0]?.agent_id;
  if (!agentId) {
    throw new Error(`Workspace "${workspace.name || workspace.id}" has no agent to run as - pass --agent <id>.`);
  }
  return agentId;
}

// ── AI Staff agents - marketplace search, install into a workspace, create, publish ────────────

export function formatAgentListLine(agent, isSelected) {
  const marker = isSelected ? chalk.cyan('❯ ') : '  ';
  const label = agent.nickname || agent.name || agent.id || agent.agent_id;
  const name = isSelected ? chalk.bold.cyan(label) : label;
  return `${marker}${name}${chalk.gray(`  (${agent.id || agent.agent_id})`)}`;
}

export function formatAgentDetail(agent) {
  const lines = [];
  const id = agent.id || agent.agent_id;
  lines.push(chalk.bold.cyan(agent.nickname || agent.name || id));
  lines.push(chalk.gray(id));
  if (agent.name && agent.name !== agent.nickname) lines.push(`${chalk.gray('name')}     ${agent.name}`);
  if (agent.email) lines.push(`${chalk.gray('email')}    ${agent.email}`);
  if (agent.bio) lines.push(`\n${agent.bio}`);
  const pluginIds = agent.plugins?.plugin_ids;
  if (Array.isArray(pluginIds) && pluginIds.length > 0) {
    lines.push(`\n${chalk.gray('plugins')}  ${pluginIds.join(', ')}`);
  }
  lines.push(chalk.gray(`\nUse with: --agent ${id}`));
  return lines.join('\n');
}

/**
 * `aivin agent list` - browse agents already INSTALLED in a workspace (not the marketplace, see
 * `agent search` for that). Reuses the same ↑/↓ move, space/enter for details, q/esc to quit
 * picker `plugin search`/`connector list` already use (`browseResults`, defined in
 * pluginTrigger.mjs) instead of inventing a second picker style for the same "browse a list, open
 * one item's detail" shape. Falls back to a flat print for scripts/CI or --plain, same as those.
 */
export async function listAgentsCmd(options) {
  const serverUrl = missionServerUrl();
  const authHeaders = missionAuthHeaders();
  const workspace = await resolveWorkspace(serverUrl, authHeaders, options.workspace);

  const agents = workspace.agents || [];
  if (agents.length === 0) {
    console.log(chalk.yellow(`No agents in workspace "${workspace.name || workspace.id}" - run \`aivin agent install\`/\`aivin agent make\` first.`));
    return;
  }

  if (process.stdout.isTTY && process.stdin.isTTY && !options.plain) {
    await browseResults(agents, `${agents.length} agent(s) in "${workspace.name || workspace.id}":\n`, formatAgentListLine, formatAgentDetail);
    return;
  }

  console.log(chalk.blue(`${agents.length} agent(s) in "${workspace.name || workspace.id}":\n`));
  agents.forEach((a) => {
    console.log(chalk.bold(a.nickname || a.name || a.id) + chalk.gray(`  (${a.id || a.agent_id})`));
    if (a.bio) console.log(`  ${a.bio}`);
  });
}

export async function searchAgents(serverUrl, authHeaders, { query, workspaceId, limit } = {}) {
  const params = {};
  if (query) params.query = query;
  if (workspaceId) params.workspace_id = workspaceId;
  if (limit) params.limit = limit;
  let response;
  try {
    response = await axios.get(`${serverUrl}/ai-staff/search`, { ...authHeaders, params });
  } catch (error) {
    const message = error.response?.data?.message || error.message || error.code || 'Unknown error';
    throw new Error(`Agent search failed: ${message}`, { cause: error });
  }
  const data = response.data;
  return Array.isArray(data) ? data : data?.items || [];
}

export async function pullAgentIntoWorkspace(serverUrl, authHeaders, { agentId, workspaceId }) {
  try {
    await axios.post(`${serverUrl}/ai-staff/pull`, { agent_id: agentId, workspace_id: workspaceId }, authHeaders);
  } catch (error) {
    const message = error.response?.data?.message || error.message || error.code || 'Unknown error';
    throw new Error(`Failed to install agent into workspace: ${message}`, { cause: error });
  }
}

export async function createAgent(serverUrl, authHeaders, { name, nickname, email, bio, workspaceId }) {
  let response;
  try {
    response = await axios.post(
      `${serverUrl}/ai-staff/create`,
      { name, nickname, email, bio, original_workspace_id: workspaceId },
      authHeaders,
    );
  } catch (error) {
    const message = error.response?.data?.message || error.message || error.code || 'Unknown error';
    throw new Error(`Failed to create agent: ${message}`, { cause: error });
  }
  return response.data ?? {};
}

export async function publishAgent(serverUrl, authHeaders, { agentId, workspaceId }) {
  try {
    await axios.post(`${serverUrl}/ai-staff/update`, { id: agentId, workspace_id: workspaceId, is_published: true }, authHeaders);
    await axios.post(`${serverUrl}/ai-staff/push`, { agent_id: agentId, workspace_id: workspaceId }, authHeaders);
  } catch (error) {
    const message = error.response?.data?.message || error.message || error.code || 'Unknown error';
    throw new Error(`Failed to publish agent: ${message}`, { cause: error });
  }
}

/**
 * Interactively resolves which agent `aivin do` should run as: matches `agentNickname` against
 * the workspace's already-installed agents (by nickname/name/id) if given, otherwise prompts to
 * pick one. If the nickname doesn't match anything, or the workspace has no agents at all yet,
 * offers to search-and-install one from the marketplace or create a brand new one, so `aivin do`
 * never dead-ends just because a workspace hasn't been set up with an agent yet.
 */
export async function resolveAgentInteractive(serverUrl, authHeaders, workspace, agentNickname) {
  const agents = workspace.agents || [];
  const workspaceId = workspace.id || workspace._id;

  if (agentNickname) {
    const match = agents.find((a) => a.nickname === agentNickname || a.id === agentNickname || a.name === agentNickname);
    if (match) return match;
    console.log(chalk.yellow(`No agent named "${agentNickname}" found in workspace "${workspace.name}".`));
  }

  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    throw new Error(
      agents.length > 0
        ? `Pass --agent <id> (one of: ${agents.map((a) => a.nickname || a.name || a.id).join(', ')}), or run this in an interactive terminal.`
        : `Workspace "${workspace.name}" has no agents - run \`aivin agent install\`/\`aivin agent make\` first, or run this in an interactive terminal.`,
    );
  }

  const NEW_AGENT_ACTIONS = {
    INSTALL: '__install__',
    CREATE: '__create__',
  };

  if (agents.length === 0) {
    console.log(chalk.gray(`Workspace "${workspace.name}" has no agents yet.`));
    const { action } = await inquirer.prompt([
      {
        type: 'select',
        name: 'action',
        message: 'What would you like to do?',
        choices: [
          { name: 'Search & install an agent from the marketplace', value: NEW_AGENT_ACTIONS.INSTALL },
          { name: 'Create a brand new agent', value: NEW_AGENT_ACTIONS.CREATE },
        ],
      },
    ]);
    return action === NEW_AGENT_ACTIONS.INSTALL
      ? installAgentInteractive(serverUrl, authHeaders, workspaceId)
      : createAgentInteractive(serverUrl, authHeaders, workspaceId);
  }

  const choices = [
    ...agents.map((a) => ({ name: a.nickname || a.name || a.id, value: a.id || a.agent_id })),
    { name: chalk.gray('+ Search & install a different agent from the marketplace'), value: NEW_AGENT_ACTIONS.INSTALL },
    { name: chalk.gray('+ Create a brand new agent'), value: NEW_AGENT_ACTIONS.CREATE },
  ];
  const { pickedAgentId } = await inquirer.prompt([
    { type: 'select', name: 'pickedAgentId', message: 'Which agent should run this?', choices },
  ]);
  if (pickedAgentId === NEW_AGENT_ACTIONS.INSTALL) return installAgentInteractive(serverUrl, authHeaders, workspaceId);
  if (pickedAgentId === NEW_AGENT_ACTIONS.CREATE) return createAgentInteractive(serverUrl, authHeaders, workspaceId);
  return agents.find((a) => (a.id || a.agent_id) === pickedAgentId);
}

export async function installAgentInteractive(serverUrl, authHeaders, workspaceId) {
  const { query } = await inquirer.prompt([
    { type: 'input', name: 'query', message: 'Search the marketplace for an agent:', validate: (v) => v.trim().length > 0 || 'Required' },
  ]);
  const results = await searchAgents(serverUrl, authHeaders, { query, workspaceId, limit: 10 });
  if (results.length === 0) {
    throw new Error(`No marketplace agents found matching "${query}".`);
  }
  const { pickedAgent } = await inquirer.prompt([
    {
      type: 'select',
      name: 'pickedAgent',
      message: 'Install which agent?',
      choices: results.map((a) => ({ name: `${a.nickname || a.name}${a.bio ? chalk.gray(`  - ${a.bio}`) : ''}`, value: a })),
    },
  ]);
  await pullAgentIntoWorkspace(serverUrl, authHeaders, { agentId: pickedAgent.id, workspaceId });
  console.log(chalk.green(`✅ Installed "${pickedAgent.nickname || pickedAgent.name}" into this workspace.`));
  return pickedAgent;
}

export async function createAgentInteractive(serverUrl, authHeaders, workspaceId) {
  const answers = await inquirer.prompt([
    { type: 'input', name: 'name', message: 'Agent name:', validate: (v) => v.trim().length > 0 || 'Required' },
    { type: 'input', name: 'nickname', message: 'Agent nickname (used to @-mention/target it):', validate: (v) => v.trim().length > 0 || 'Required' },
    { type: 'input', name: 'email', message: 'Agent email:', validate: (v) => v.trim().length > 0 || 'Required' },
    { type: 'input', name: 'bio', message: 'Short bio (optional):' },
  ]);
  const agent = await createAgent(serverUrl, authHeaders, { ...answers, workspaceId });
  console.log(chalk.green(`✅ Created agent "${agent.nickname || agent.name}".`));
  return agent;
}
