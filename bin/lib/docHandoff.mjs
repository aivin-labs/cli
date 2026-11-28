import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { fetchWebUrl } from './context.mjs';
import { defaultWebUrl } from './servers.mjs';
import { missionAuthHeaders, missionServerUrl, resolveWorkspace } from './workspace.mjs';
import { driveOpenUrl, OpenFileError, OpenFileFailure } from './openFile.mjs';

const DEFAULT_WEB_URL = 'https://app.aivin.cloud';
const MAX_MATERIAL_FILES = 12;
const MAX_MATERIAL_CHARS = 40_000;
const MAX_GROUNDING_CHARS = 40_000;
const ALLOWED_EXTS = new Set(['docx', 'xlsx', 'pptx', 'md']);

async function resolveWebUrl(serverUrl) {
  return process.env.AIVIN_WEB_URL || (await fetchWebUrl(serverUrl)) || defaultWebUrl(serverUrl) || DEFAULT_WEB_URL;
}

function readUtf8Bounded(filePath, maxChars) {
  const abs = path.resolve(filePath);
  const raw = fs.readFileSync(abs, 'utf8');
  return raw.slice(0, maxChars).trim();
}

function collectHandoffMaterials({ grounding, groundingFile, materialFiles = [] } = {}) {
  let groundingText = typeof grounding === 'string' ? grounding.trim() : '';
  if (!groundingText && groundingFile) {
    groundingText = readUtf8Bounded(groundingFile, MAX_GROUNDING_CHARS);
  }
  if (groundingText) {
    groundingText = groundingText.slice(0, MAX_GROUNDING_CHARS);
  }

  const files = (Array.isArray(materialFiles) ? materialFiles : [])
    .filter((f) => typeof f === 'string' && f.trim())
    .slice(0, MAX_MATERIAL_FILES);

  const materials = [];
  for (const file of files) {
    const content = readUtf8Bounded(file, MAX_MATERIAL_CHARS);
    if (!content) continue;
    materials.push({ name: path.basename(file), content });
  }

  return { groundingText, materials };
}

async function resolveHandoffTarget({ workspace, serverUrl: customServerUrl, auth: customAuth } = {}) {
  if (!customAuth && !process.env.API_KEY) throw new OpenFileFailure(OpenFileError.NOT_LOGGED_IN);
  const serverUrl = customServerUrl || missionServerUrl();
  const auth = customAuth || missionAuthHeaders();
  const ws = workspace && customServerUrl
    ? { id: workspace }
    : await resolveWorkspace(serverUrl, auth, workspace);
  const workspaceId = String(ws.id || ws._id);
  return { serverUrl, auth, workspaceId };
}

/**
 * Bàn giao ngược việc soạn tài liệu nghiệp vụ (docx / xlsx / pptx / md) từ công cụ ngoài (vd LightCode)
 * lên bộ máy soạn thảo AI của AIVIN kèm gói nguyên liệu sự thật.
 * Trả ngay link AIVIN Drive trong lúc AIVIN tiếp tục soạn ở nền.
 */
export async function handoffCreateDoc({
  prompt,
  name,
  extension = 'docx',
  workspace,
  folder,
  grounding,
  groundingFile,
  materialFiles = [],
  lang,
  serverUrl: customServerUrl,
  auth: customAuth,
  webUrl: customWebUrl,
} = {}) {
  if (!customAuth && !process.env.API_KEY) throw new OpenFileFailure(OpenFileError.NOT_LOGGED_IN);
  const cleanPrompt = String(prompt || '').trim();
  if (!cleanPrompt) throw new Error('Prompt is required to create a document on AIVIN.');

  const ext = ALLOWED_EXTS.has(String(extension || '').toLowerCase())
    ? String(extension).toLowerCase()
    : 'docx';

  const { serverUrl, auth, workspaceId } = await resolveHandoffTarget({
    workspace,
    serverUrl: customServerUrl,
    auth: customAuth,
  });

  const { groundingText, materials } = collectHandoffMaterials({ grounding, groundingFile, materialFiles });

  const payload = {
    prompt: cleanPrompt,
    extension: ext,
    ...(name ? { name: String(name).trim().slice(0, 200) } : {}),
    ...(folder ? { folder_id: String(folder).trim() } : {}),
    ...(groundingText ? { grounding: groundingText } : {}),
    ...(materials.length ? { materials } : {}),
    ...(lang ? { lang: String(lang).trim() } : {}),
  };

  let res;
  try {
    res = await axios.post(
      `${serverUrl}/fileshare/${encodeURIComponent(workspaceId)}/handoff-create`,
      payload,
      { ...auth, timeout: 60_000 },
    );
  } catch (e) {
    const reason = e?.response?.data?.message || e?.message || e?.code || 'unknown error';
    throw new Error(`AIVIN document handoff failed: ${reason}`, { cause: e });
  }

  const data = res.data ?? {};
  const fileId = String(data.file_id || data.id || '');
  if (!fileId) throw new Error('AIVIN did not return a file_id for the created document.');

  const webUrl = customWebUrl || (await resolveWebUrl(serverUrl));
  const url = driveOpenUrl(webUrl, { fileId, workspaceId });
  return {
    url,
    fileId,
    workspaceId,
    ...(data.folder_id ? { folderId: String(data.folder_id) } : folder ? { folderId: String(folder) } : {}),
    name: String(data.name || name || ''),
    extension: String(data.extension || ext),
    status: String(data.status || 'generating'),
  };
}

/**
 * Bàn giao yêu cầu chỉnh sửa / thiết kế lại một tài liệu ĐÃ CÓ trên AIVIN Drive từ công cụ ngoài
 * (vd LightCode) sang bộ máy AI tài liệu của AIVIN kèm gói nguyên liệu sự thật.
 * Trả ngay link AIVIN Drive trong lúc AIVIN tiếp tục chỉnh sửa ở nền.
 */
export async function handoffEditDoc({
  fileId,
  prompt,
  workspace,
  grounding,
  groundingFile,
  materialFiles = [],
  lang,
  serverUrl: customServerUrl,
  auth: customAuth,
  webUrl: customWebUrl,
} = {}) {
  if (!customAuth && !process.env.API_KEY) throw new OpenFileFailure(OpenFileError.NOT_LOGGED_IN);
  const cleanFileId = String(fileId || '').trim();
  if (!cleanFileId) throw new Error('File ID is required to edit a document on AIVIN.');

  const cleanPrompt = String(prompt || '').trim();
  if (!cleanPrompt) throw new Error('Prompt is required to edit a document on AIVIN.');

  const { serverUrl, auth, workspaceId } = await resolveHandoffTarget({
    workspace,
    serverUrl: customServerUrl,
    auth: customAuth,
  });

  const { groundingText, materials } = collectHandoffMaterials({ grounding, groundingFile, materialFiles });

  const payload = {
    file_id: cleanFileId,
    prompt: cleanPrompt,
    ...(groundingText ? { grounding: groundingText } : {}),
    ...(materials.length ? { materials } : {}),
    ...(lang ? { lang: String(lang).trim() } : {}),
  };

  let res;
  try {
    res = await axios.post(
      `${serverUrl}/fileshare/${encodeURIComponent(workspaceId)}/handoff-edit`,
      payload,
      { ...auth, timeout: 60_000 },
    );
  } catch (e) {
    const reason = e?.response?.data?.message || e?.message || e?.code || 'unknown error';
    throw new Error(`AIVIN document edit handoff failed: ${reason}`, { cause: e });
  }

  const data = res.data ?? {};
  const returnedFileId = String(data.file_id || data.id || cleanFileId);
  const webUrl = customWebUrl || (await resolveWebUrl(serverUrl));
  const url = driveOpenUrl(webUrl, { fileId: returnedFileId, workspaceId });
  return {
    url,
    fileId: returnedFileId,
    workspaceId,
    ...(data.folder_id ? { folderId: String(data.folder_id) } : {}),
    name: String(data.name || ''),
    extension: String(data.extension || ''),
    status: String(data.status || 'editing'),
  };
}
