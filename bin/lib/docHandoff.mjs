import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { fetchWebUrl } from './context.mjs';
import { defaultWebUrl } from './servers.mjs';
import { missionAuthHeaders, missionServerUrl, resolveWorkspace } from './workspace.mjs';
import { driveOpenUrl, OpenFileError, OpenFileFailure } from './openFile.mjs';

const DEFAULT_WEB_URL = 'https://app.aivin.cloud';
const MAX_MATERIAL_FILES = 12;
const MAX_MATERIAL_BYTES = 60_000;
const ALLOWED_EXTS = new Set(['docx', 'xlsx', 'pptx', 'md']);

async function resolveWebUrl(serverUrl) {
  return process.env.AIVIN_WEB_URL || (await fetchWebUrl(serverUrl)) || defaultWebUrl(serverUrl) || DEFAULT_WEB_URL;
}

function readUtf8Bounded(filePath, maxChars) {
  const abs = path.resolve(filePath);
  const raw = fs.readFileSync(abs, 'utf8');
  return raw.slice(0, maxChars).trim();
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

  const serverUrl = customServerUrl || missionServerUrl();
  const auth = customAuth || missionAuthHeaders();
  const ws = workspace && customServerUrl
    ? { id: workspace }
    : await resolveWorkspace(serverUrl, auth, workspace);
  const workspaceId = String(ws.id || ws._id);

  let groundingText = typeof grounding === 'string' ? grounding.trim() : '';
  if (!groundingText && groundingFile) {
    groundingText = readUtf8Bounded(groundingFile, 40_000);
  }

  const files = (Array.isArray(materialFiles) ? materialFiles : [])
    .filter((f) => typeof f === 'string' && f.trim())
    .slice(0, MAX_MATERIAL_FILES);

  const materials = [];
  for (const file of files) {
    const content = readUtf8Bounded(file, MAX_MATERIAL_BYTES);
    if (!content) continue;
    materials.push({ name: path.basename(file), content });
  }

  const payload = {
    prompt: cleanPrompt,
    extension: ext,
    ...(name ? { name: String(name).trim().slice(0, 200) } : {}),
    ...(folder ? { folder_id: String(folder).trim() } : {}),
    ...(groundingText ? { grounding: groundingText.slice(0, 40_000) } : {}),
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
