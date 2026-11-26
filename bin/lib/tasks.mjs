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

export function shapeTaskForJson(raw) {
  const t = (raw?.data && typeof raw.data === 'object' && !Array.isArray(raw.data) ? raw.data : raw) ?? {};
  const assignId = t.assign_id ? String(t.assign_id) : '';
  const historyMatch = Array.isArray(t.handler_history)
    ? [...t.handler_history].reverse().find((h) => h?.member_id && String(h.member_id) === assignId && h?.member_name)
    : undefined;
  const assigneeName = t.assignee_name || historyMatch?.member_name || undefined;
  const assignee = t.assignee || assigneeName || assignId || null;
  const dueAt = t.due_at ?? t.to_date ?? null;
  const comments = Array.isArray(t.comments)
    ? t.comments.map((c) => ({
        ...c,
        id: c?.id,
        author: c?.author || c?.work_agent_name || c?.user_name || c?.user_id || 'Unknown',
        body: c?.body ?? c?.content ?? '',
        at: c?.at ?? c?.created_at ?? null,
      }))
    : [];
  const attachments = Array.isArray(t.attachments)
    ? t.attachments.map((a) => ({
        ...a,
        id: a?.id || a?.file_id,
        name: a?.name,
        size: a?.size,
        mime: a?.mime || a?.mime_type,
      }))
    : [];
  return {
    ...t,
    id: t.id || t._id,
    title: t.title ?? '',
    status: t.status ?? '',
    priority: t.priority ?? null,
    assignee,
    ...(assigneeName ? { assignee_name: assigneeName } : {}),
    due_at: dueAt,
    parent_id: t.parent_id ?? null,
    depends_on: Array.isArray(t.depends_on) ? t.depends_on : [],
    workflow_step: t.workflow_step ?? t.step ?? null,
    description: t.description ?? '',
    comments,
    attachments,
  };
}

const BINARY_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|ico|avif|mp4|mov|avi|mkv|webm|mp3|wav|ogg|m4a|flac|zip|rar|7z|tar|gz|tgz|exe|dll|so|dylib|bin|iso|dmg|woff2?|ttf|otf)$/i;
const BINARY_MIME_RE = /^(image|video|audio|font)\/|^application\/(octet-stream|zip|x-zip-compressed|x-rar-compressed|x-7z-compressed|gzip|x-tar|x-msdownload|wasm)$/i;

function isBinaryAttachment(att) {
  const type = String(att?.type || '').toLowerCase();
  if (type === 'image' || type === 'video' || type === 'audio') return true;
  const mime = String(att?.mime || att?.mime_type || '').trim().toLowerCase().split(';')[0];
  if (mime && BINARY_MIME_RE.test(mime)) return true;
  const ext = att?.extension ? `.${String(att.extension).replace(/^\./, '')}` : String(att?.name || '');
  return BINARY_EXT_RE.test(ext);
}

function cutUtf8Bytes(text, maxBytes = 12_000) {
  const s = String(text ?? '');
  const limit = Number.isFinite(Number(maxBytes)) && Number(maxBytes) > 0
    ? Math.min(200_000, Math.max(64, Math.floor(Number(maxBytes))))
    : 12_000;
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= limit) return s;
  let end = limit;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

function stripDocHtml(raw) {
  const text = typeof raw === 'string' ? raw : raw == null ? '' : JSON.stringify(raw);
  return text
    .replace(/<\s*(br|\/p|\/div|\/li|\/tr|\/h[1-6])\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

export async function getTaskById(id, options = {}) {
  const serverUrl = missionServerUrl();
  if (!process.env.API_KEY) {
    throw new Error(`Not logged in to ${serverUrl} — run \`aivin login\` first.`);
  }
  const authHeaders = missionAuthHeaders();

  let response;
  try {
    response = await axios.get(`${serverUrl}/task/${encodeURIComponent(id)}`, authHeaders);
  } catch (error) {
    if (error.response?.status === 401) {
      throw new Error(`Not logged in to ${serverUrl} (HTTP 401) — run \`aivin login\` first.`, { cause: error });
    }
    const message = error.response?.data?.message || error.message || error.code || 'Unknown error';
    throw new Error(`Failed to get task: ${message}`, { cause: error });
  }

  const shaped = shapeTaskForJson(response.data ?? {});
  if (options.json) {
    console.log(JSON.stringify(shaped));
    return shaped;
  }
  console.log(JSON.stringify(shaped, null, 2));
  return shaped;
}

export async function getTaskAttachmentText(id, options = {}) {
  const serverUrl = missionServerUrl();
  if (!process.env.API_KEY) {
    throw new Error(`Not logged in to ${serverUrl} — run \`aivin login\` first.`);
  }
  const needle = String(options.attachment ?? '').trim();
  if (!needle) {
    throw new Error('Usage: aivin task attachment <id> --attachment=<idOrName> [--max-bytes=<n>]');
  }
  const maxBytes = Number.isFinite(Number(options.maxBytes)) && Number(options.maxBytes) > 0
    ? Math.min(200_000, Math.max(64, Math.floor(Number(options.maxBytes))))
    : 12_000;
  const authHeaders = missionAuthHeaders();

  try {
    const res = await axios.get(`${serverUrl}/task/${encodeURIComponent(id)}/attachment`, {
      ...authHeaders,
      params: { attachment: needle, max_bytes: maxBytes },
    });
    const body = res.data?.data ?? res.data ?? {};
    if (options.json) {
      console.log(JSON.stringify(body));
      return body;
    }
    if (body.binary) {
      const msg = body.message || `Tệp "${body.name || needle}" là tệp nhị phân (${body.mime || 'binary'}), không đọc được dạng chữ.`;
      console.log(msg);
      return body;
    }
    console.log(cutUtf8Bytes(body.text ?? '', maxBytes));
    return body;
  } catch (error) {
    if (error.response?.status === 401) {
      throw new Error(`Not logged in to ${serverUrl} (HTTP 401) — run \`aivin login\` first.`, { cause: error });
    }
    const i18n = String(error.response?.data?.i18n || '');
    // Chỉ fallback qua GET /task/:id + GET /fileshare khi máy chủ cũ chưa có route /task/:id/attachment
    if (error.response?.status !== 404 || i18n.startsWith('TASK.')) {
      const message = error.response?.data?.message || error.message || error.code || 'Unknown error';
      throw new Error(`Failed to read task attachment: ${message}`, { cause: error });
    }
  }

  // Fallback tương thích máy chủ chưa cập nhật endpoint /task/:id/attachment
  const taskRes = await axios.get(`${serverUrl}/task/${encodeURIComponent(id)}`, authHeaders);
  const task = shapeTaskForJson(taskRes.data ?? {});
  const fromComments = (task.comments || []).flatMap((c) => (Array.isArray(c?.attachments) ? c.attachments : []));
  const all = [...(task.attachments || []), ...fromComments];
  const lower = needle.toLowerCase();
  const att = all.find((a) => String(a?.id ?? '') === needle || String(a?.file_id ?? '') === needle || String(a?.name ?? '') === needle)
    || all.find((a) => String(a?.id ?? '').toLowerCase() === lower || String(a?.file_id ?? '').toLowerCase() === lower || String(a?.name ?? '').toLowerCase() === lower);
  if (!att) {
    throw new Error(`Attachment "${needle}" not found on task ${id}.`);
  }
  if (isBinaryAttachment(att)) {
    const msg = `Tệp "${att.name || needle}" là tệp nhị phân (${att.mime || att.mime_type || att.extension || att.type || 'binary'}), không đọc được dạng chữ.`;
    if (options.json) console.log(JSON.stringify({ id: att.id || att.file_id, name: att.name, binary: true, text: '', message: msg }));
    else console.log(msg);
    return { binary: true, message: msg };
  }
  const fileId = att.file_id || (typeof att.url === 'string' && att.url.startsWith('fileshare://') ? att.url.slice('fileshare://'.length) : '');
  if (fileId && task.workspace_id) {
    const fileRes = await axios.get(`${serverUrl}/fileshare/${encodeURIComponent(task.workspace_id)}/${encodeURIComponent(fileId)}`, authHeaders);
    const doc = fileRes.data?.data ?? fileRes.data ?? {};
    const ext = String(doc.extension || att.extension || '').toLowerCase();
    const raw = (ext === 'docx' || ext === 'doc' || ext === 'html') ? stripDocHtml(doc.content ?? '') : String(doc.content ?? '');
    const sliced = cutUtf8Bytes(raw, maxBytes);
    if (options.json) console.log(JSON.stringify({ id: att.id || fileId, name: att.name || doc.name, binary: false, text: sliced }));
    else console.log(sliced);
    return { binary: false, text: sliced };
  }
  if (typeof att.text === 'string') {
    const sliced = cutUtf8Bytes(att.text, maxBytes);
    if (options.json) console.log(JSON.stringify({ id: att.id, name: att.name, binary: false, text: sliced }));
    else console.log(sliced);
    return { binary: false, text: sliced };
  }
  const msg = `Tệp "${att.name || needle}" là tệp nhị phân hoặc không có nội dung chữ trực tiếp, không đọc được dạng chữ.`;
  if (options.json) console.log(JSON.stringify({ id: att.id, name: att.name, binary: true, text: '', message: msg }));
  else console.log(msg);
  return { binary: true, message: msg };
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
// `workspace_id` must also be in the body: the backend's ValidationPipe checks `ProjectRequest` (workspace_id required) before the
// handler copies it from the URL, so a body without it is rejected with "workspace_id should not be empty" (found 17/11/2026).

export async function upsertProject(serverUrl, authHeaders, { workspaceId, id, name }) {
  let response;
  try {
    response = await axios.post(`${serverUrl}/project/${workspaceId}/project/edit`, { workspace_id: workspaceId, id, name }, authHeaders);
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
