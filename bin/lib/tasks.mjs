import chalk from 'chalk';
import axios from 'axios';
import inquirer from 'inquirer';
import { missionServerUrl, missionAuthHeaders, resolveWorkspace, resolveAgentId, listWorkspaces } from './workspace.mjs';

export async function createAutomationJob(description, options) {
  const serverUrl = missionServerUrl();
  const authHeaders = missionAuthHeaders();

  const workspace = await resolveWorkspace(serverUrl, authHeaders, options.workspace);
  const agentId = resolveAgentId(workspace, options.agent);

  console.log(chalk.blue('🔄 Creating automation job...'));
  console.log(chalk.gray(`   Workspace: ${workspace.name || workspace.id}`));

  let response;
  try {
    response = await axios.post(
      `${serverUrl}/automation/jobs/create`,
      {
        mission: description.length > 60 ? `${description.slice(0, 57)}...` : description,
        prompt: description,
        agent_id: agentId,
        workspace_id: workspace.id || workspace._id,
        project_id: options.project,
        schedule_condition: options.schedule,
      },
      authHeaders,
    );
  } catch (error) {
    const message = error.response?.data?.message || error.message || error.code || 'Unknown error';
    throw new Error(`Failed to create automation job: ${message}`, { cause: error });
  }

  const job = response.data ?? {};
  console.log(chalk.green('✅ Automation job created!'));
  console.log(chalk.gray(`   ID: ${job.id}`));
  console.log(chalk.gray(`   Mission: ${job.mission}`));
  if (job.schedule_condition) console.log(chalk.gray(`   Schedule: ${job.schedule_condition}`));
  if (job.next_run) console.log(chalk.gray(`   Next run: ${job.next_run}`));
}

/**
 * A workspace's `projects` array has no guaranteed "default" entry the way `agents`/Personal do -
 * just take the first one when --project is omitted, and say so explicitly if there isn't one
 * (list/mine are scoped by project on the backend, unlike create/get/update/delete which take a
 * bare task id or no project at all).
 */
export function resolveProjectId(workspace, explicitProjectId) {
  if (explicitProjectId) return explicitProjectId;
  const projectId = workspace.projects?.[0]?.id;
  if (!projectId) {
    throw new Error(
      `Workspace "${workspace.name || workspace.id}" has no projects - pass --project <id> (see \`aivin workspace\`).`,
    );
  }
  return projectId;
}

export async function listTasks(options) {
  const serverUrl = missionServerUrl();
  const authHeaders = missionAuthHeaders();

  const workspace = await resolveWorkspace(serverUrl, authHeaders, options.workspace);
  const projectId = resolveProjectId(workspace, options.project);

  const params = {};
  if (options.status) params.status = options.status;
  if (options.assignee) params.assign_id = options.assignee;
  if (options.search) params.search = options.search;

  let response;
  try {
    response = await axios.get(`${serverUrl}/task/${projectId}/list`, { ...authHeaders, params });
  } catch (error) {
    const message = error.response?.data?.message || error.message || error.code || 'Unknown error';
    throw new Error(`Failed to list tasks: ${message}`, { cause: error });
  }

  const tasks = Array.isArray(response.data) ? response.data : response.data?.items || [];
  if (tasks.length === 0) {
    console.log(chalk.yellow('No tasks found.'));
    return;
  }
  console.log(chalk.blue(`${tasks.length} task(s) in project ${projectId}:\n`));
  tasks.forEach((t) => {
    console.log(`${chalk.bold(t.title || t.id)}  ${chalk.gray(`(${t.id})`)}`);
    console.log(
      chalk.gray(
        `   status: ${t.status}${t.priority ? `  priority: ${t.priority}` : ''}${t.assign_id ? `  assignee: ${t.assign_id}` : ''}`,
      ),
    );
  });
}

export async function listMyTasks(options) {
  const serverUrl = missionServerUrl();
  const authHeaders = missionAuthHeaders();

  const workspace = await resolveWorkspace(serverUrl, authHeaders, options.workspace);
  const projectId = resolveProjectId(workspace, options.project);

  let response;
  try {
    response = await axios.get(`${serverUrl}/task/${projectId}/my-task`, authHeaders);
  } catch (error) {
    const message = error.response?.data?.message || error.message || error.code || 'Unknown error';
    throw new Error(`Failed to list your tasks: ${message}`, { cause: error });
  }

  const tasks = Array.isArray(response.data) ? response.data : response.data?.items || [];
  if (tasks.length === 0) {
    console.log(chalk.yellow('No tasks assigned to you in this project.'));
    return;
  }
  console.log(chalk.blue(`${tasks.length} task(s) assigned to you:\n`));
  tasks.forEach((t) => {
    console.log(`${chalk.bold(t.title || t.id)}  ${chalk.gray(`(${t.id})`)}  ${chalk.gray(t.status)}`);
  });
}

export async function getTaskById(id) {
  const serverUrl = missionServerUrl();
  const authHeaders = missionAuthHeaders();

  let response;
  try {
    response = await axios.get(`${serverUrl}/task/${id}`, authHeaders);
  } catch (error) {
    const message = error.response?.data?.message || error.message || error.code || 'Unknown error';
    throw new Error(`Failed to get task: ${message}`, { cause: error });
  }

  console.log(JSON.stringify(response.data ?? {}, null, 2));
}

export async function updateTaskById(id, options) {
  const serverUrl = missionServerUrl();
  const authHeaders = missionAuthHeaders();

  const data = {};
  if (options.status) data.status = options.status;
  if (options.title) data.title = options.title;
  if (options.description) data.description = options.description;
  if (options.assignee) data.assign_id = options.assignee;
  if (options.priority) data.priority = options.priority;
  if (Object.keys(data).length === 0) {
    throw new Error('Nothing to update - pass at least one of --status/--title/--description/--assignee/--priority.');
  }

  let response;
  try {
    response = await axios.post(`${serverUrl}/task/${id}/update`, data, authHeaders);
  } catch (error) {
    const message = error.response?.data?.message || error.message || error.code || 'Unknown error';
    throw new Error(`Failed to update task: ${message}`, { cause: error });
  }

  const task = response.data ?? {};
  console.log(chalk.green('✅ Task updated!'));
  console.log(chalk.gray(`   Status: ${task.status}`));
}

// ✅ FIX: had no confirmation at all before - unlike every other destructive command in this CLI
// (`plugin delete`, `pluginstore rm`/`rm-node`), a typo'd id here deleted immediately with nothing
// to catch it. Same `-y/--yes` escape hatch for scripts/CI as those commands.
export async function deleteTaskById(id, options = {}) {
  const serverUrl = missionServerUrl();
  const authHeaders = missionAuthHeaders();

  if (!options.yes) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error('Refusing to delete without confirmation in a non-interactive session - pass --yes to delete anyway.');
    }
    const { confirm } = await inquirer.prompt([
      { type: 'confirm', name: 'confirm', message: `Delete task "${id}"? This can't be undone.`, default: false },
    ]);
    if (!confirm) {
      console.log(chalk.gray('Cancelled.'));
      return;
    }
  }

  try {
    await axios.delete(`${serverUrl}/task/${id}/delete`, authHeaders);
  } catch (error) {
    const message = error.response?.data?.message || error.message || error.code || 'Unknown error';
    throw new Error(`Failed to delete task: ${message}`, { cause: error });
  }

  console.log(chalk.green(`✅ Task ${id} deleted.`));
}

/**
 * Pure assembly of `POST /task/create`'s body, split out of createTask() so it's unit-testable
 * without stubbing axios/inquirer. Backend's TaskService._sanitizeCreateTaskInput whitelists
 * `description`, not `content` - sending the wrong key here used to look like success (200 + a
 * task id back) while silently dropping the user's actual text, which is exactly the kind of drift
 * a regression test on this function's output shape catches going forward.
 */
export function buildCreateTaskPayload(description, workspaceId, options = {}) {
  return {
    title: description.length > 80 ? `${description.slice(0, 77)}...` : description,
    description,
    workspace_id: workspaceId,
    project_id: options.project,
    assign_id: options.assignee,
  };
}

export async function createTask(description, options) {
  const serverUrl = missionServerUrl();
  const authHeaders = missionAuthHeaders();

  const workspace = await resolveWorkspace(serverUrl, authHeaders, options.workspace);

  console.log(chalk.blue('📋 Creating task...'));
  console.log(chalk.gray(`   Workspace: ${workspace.name || workspace.id}`));

  let response;
  try {
    response = await axios.post(
      `${serverUrl}/task/create`,
      buildCreateTaskPayload(description, workspace.id || workspace._id, options),
      authHeaders,
    );
  } catch (error) {
    const message = error.response?.data?.message || error.message || error.code || 'Unknown error';
    throw new Error(`Failed to create task: ${message}`, { cause: error });
  }

  const task = response.data ?? {};
  console.log(chalk.green('✅ Task created!'));
  console.log(chalk.gray(`   ID: ${task.id}`));
  console.log(chalk.gray(`   Title: ${task.title}`));
  console.log(chalk.gray(`   Status: ${task.status}`));
}

/**
 * `aivin workspace` - interactive workspace + project picker (arrow-key inquirer prompts, matching
 * `aivin create`'s existing interactive style) so a user can find a workspace/project id to pass
 * as --workspace/--project to `aivin do`/`do job`/`task`, without memorizing them upfront.
 */
export async function pickWorkspaceAndProject(options) {
  const serverUrl = missionServerUrl();
  const authHeaders = missionAuthHeaders();
  const workspaces = await listWorkspaces(serverUrl, authHeaders);

  if (workspaces.length === 0) {
    console.log(chalk.yellow('No workspace found for this account.'));
    return;
  }

  if (!process.stdout.isTTY || !process.stdin.isTTY || options.plain) {
    for (const ws of workspaces) {
      console.log(chalk.bold(ws.name || ws.id) + chalk.gray(`  (${ws.id})${ws.name === 'Personal' ? '  [personal]' : ''}`));
      (ws.projects || []).forEach((p) => console.log(chalk.gray(`    - ${p.name || p.id}  (${p.id})`)));
    }
    return;
  }

  const { workspaceId } = await inquirer.prompt([
    {
      type: 'select',
      name: 'workspaceId',
      message: 'Select a workspace:',
      choices: workspaces.map((ws) => ({
        name: `${ws.name || ws.id}${ws.name === 'Personal' ? chalk.gray('  (personal)') : ''}`,
        value: ws.id || ws._id,
      })),
    },
  ]);
  const workspace = workspaces.find((ws) => (ws.id || ws._id) === workspaceId);

  let projectId;
  if (workspace.projects?.length > 0) {
    const { pickedProjectId } = await inquirer.prompt([
      {
        type: 'select',
        name: 'pickedProjectId',
        message: 'Select a project:',
        choices: [
          { name: chalk.gray('(none - workspace level)'), value: null },
          ...workspace.projects.map((p) => ({ name: p.name || p.id, value: p.id })),
        ],
      },
    ]);
    projectId = pickedProjectId;
  } else {
    console.log(chalk.gray(`\n"${workspace.name || workspace.id}" has no projects yet - staying at workspace level (no --project needed).`));
  }

  console.log(chalk.green('\n✅ Selected:'));
  console.log(`   ${chalk.gray('Workspace:')} ${chalk.bold(workspace.name || 'unnamed')}`);
  if (projectId) {
    const project = workspace.projects.find((p) => p.id === projectId);
    console.log(`   ${chalk.gray('Project:')}   ${chalk.bold(project?.name || 'unnamed')}`);
  }
  console.log(chalk.gray('\nUse with `aivin do`/`aivin do job`/`aivin task`:'));
  console.log(`   --workspace ${workspace.id || workspace._id}${projectId ? ` --project ${projectId}` : ''}`);
}

// ── Projects within a workspace - create/update/delete ─────────────────────────────────────────
//
// `POST /project/:workspaceId/project/edit` is a real upsert on the backend: omit `id` to create a
// new project, include it to update the matching one - there's no separate create endpoint.

export async function upsertProject(serverUrl, authHeaders, { workspaceId, id, name }) {
  let response;
  try {
    response = await axios.post(`${serverUrl}/project/${workspaceId}/project/edit`, { id, name }, authHeaders);
  } catch (error) {
    const message = error.response?.data?.message || error.message || error.code || 'Unknown error';
    throw new Error(`Failed to save project: ${message}`, { cause: error });
  }
  return response.data ?? {};
}

export async function deleteProjectById(serverUrl, authHeaders, { workspaceId, projectId }) {
  try {
    await axios.delete(`${serverUrl}/project/${workspaceId}/project/${projectId}/delete`, authHeaders);
  } catch (error) {
    const message = error.response?.data?.message || error.message || error.code || 'Unknown error';
    throw new Error(`Failed to delete project: ${message}`, { cause: error });
  }
}

export async function listProjectsCmd(options) {
  const serverUrl = missionServerUrl();
  const authHeaders = missionAuthHeaders();
  const workspace = await resolveWorkspace(serverUrl, authHeaders, options.workspace);

  const projects = workspace.projects || [];
  if (projects.length === 0) {
    console.log(chalk.yellow(`No projects in workspace "${workspace.name || workspace.id}".`));
    return;
  }
  console.log(chalk.blue(`${projects.length} project(s) in "${workspace.name || workspace.id}":\n`));
  projects.forEach((p) => {
    console.log(`${chalk.bold(p.name || p.id)}  ${chalk.gray(`(${p.id})`)}`);
  });
}

export async function createProjectCmd(name, options) {
  const serverUrl = missionServerUrl();
  const authHeaders = missionAuthHeaders();
  const workspace = await resolveWorkspace(serverUrl, authHeaders, options.workspace);
  const project = await upsertProject(serverUrl, authHeaders, { workspaceId: workspace.id || workspace._id, name });
  console.log(chalk.green('✅ Project created!'));
  console.log(chalk.gray(`   Workspace: ${workspace.name || workspace.id}`));
  console.log(chalk.gray(`   Name: ${project.name || name}`));
  if (project.id) console.log(chalk.gray(`   ID: ${project.id}`));
}

export async function updateProjectCmd(projectId, options) {
  const serverUrl = missionServerUrl();
  const authHeaders = missionAuthHeaders();
  if (!options.name) {
    throw new Error('Nothing to update - pass --name <new name>.');
  }
  const workspace = await resolveWorkspace(serverUrl, authHeaders, options.workspace);
  await upsertProject(serverUrl, authHeaders, { workspaceId: workspace.id || workspace._id, id: projectId, name: options.name });
  console.log(chalk.green(`✅ Project ${projectId} updated.`));
}

// ✅ FIX: had no confirmation at all before, and deleting a project is more consequential than
// deleting a single task (its tasks go with it) - same missing-protection issue as deleteTaskById
// above, same `-y/--yes` fix.
export async function deleteProjectCmd(projectId, options) {
  const serverUrl = missionServerUrl();
  const authHeaders = missionAuthHeaders();

  if (!options.yes) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error('Refusing to delete without confirmation in a non-interactive session - pass --yes to delete anyway.');
    }
    const { confirm } = await inquirer.prompt([
      { type: 'confirm', name: 'confirm', message: `Delete project "${projectId}"? Its tasks go with it. This can't be undone.`, default: false },
    ]);
    if (!confirm) {
      console.log(chalk.gray('Cancelled.'));
      return;
    }
  }

  const workspace = await resolveWorkspace(serverUrl, authHeaders, options.workspace);
  await deleteProjectById(serverUrl, authHeaders, { workspaceId: workspace.id || workspace._id, projectId });
  console.log(chalk.green(`✅ Project ${projectId} deleted.`));
}
