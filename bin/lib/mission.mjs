import chalk from 'chalk';
import axios from 'axios';
import { missionServerUrl, missionAuthHeaders, resolveWorkspace, resolveAgentInteractive } from './workspace.mjs';
import { parseApiKeyClient } from './auth.mjs';
import { streamMissionLog, openBrowserViewer } from './missionStream.mjs';
import { runBrowserMissionLocal, runBrowserMissionRemote } from './browserAutomation.mjs';

export async function runBrowserMission(mission, options) {
  const serverUrl = missionServerUrl();
  const apiKey = process.env.API_KEY;
  const tenantClient = parseApiKeyClient(apiKey || '') || 'unknown';

  // --view alone (no mission) - just open the viewer for whatever HIL session is already active,
  // without starting a new mission. Useful if the auto-open above was missed/closed by accident.
  // Same for both modes - the viewer just reacts to whatever browser:cast-start fires next.
  if (options.view) {
    await openBrowserViewer(serverUrl, apiKey, tenantClient);
    return;
  }

  if (options.remote) {
    await runBrowserMissionRemote(mission, options);
  } else {
    await runBrowserMissionLocal(mission, options);
  }
}

export async function runMission(agentNickname, mission, options) {
  const serverUrl = missionServerUrl();
  const apiKey = process.env.API_KEY;
  const authHeaders = missionAuthHeaders();

  const workspace = await resolveWorkspace(serverUrl, authHeaders, options.workspace);
  const agent = await resolveAgentInteractive(serverUrl, authHeaders, workspace, agentNickname);
  const agentId = agent.id || agent.agent_id;

  console.log(chalk.blue('🚀 Doing:'), mission);
  console.log(chalk.gray(`   Workspace: ${workspace.name || workspace.id}   Agent: ${agent.nickname || agent.name || agentId}`));

  let response;
  try {
    response = await axios.post(
      `${serverUrl}/agent/start-work`,
      {
        prompt: mission,
        mission,
        workspace_id: workspace.id || workspace._id,
        agent_id: agentId,
        project_id: options.project,
      },
      authHeaders,
    );
  } catch (error) {
    const message = error.response?.data?.message || error.message || error.code || 'Unknown error';
    throw new Error(`Failed to start mission: ${message}`, { cause: error });
  }

  const result = response.data ?? {};
  if (result.success === false) {
    throw new Error(result.message || 'Failed to start mission');
  }
  const threadId = result.data?.thread_id;
  console.log(chalk.gray(`   Thread: ${threadId || 'unknown'}`));

  if (options.watch !== false && threadId) {
    await streamMissionLog(serverUrl, apiKey, threadId);
  }
}
