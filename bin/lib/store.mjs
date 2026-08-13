import fs from 'fs';
import os from 'os';
import path from 'path';
import chalk from 'chalk';
import axios from 'axios';
import inquirer from 'inquirer';
import { withSpinner } from './util.mjs';

// ── Plugin store (self-host aivin-service worker) — attach/create/ls/enable/disable/detach ──────
//
// Xem service/docs/self-host-worker-plan.md — "store" là kho chức năng hiển thị trong FE modal
// "Trung tâm điều khiển > Hạ tầng", 1 store có thể có nhiều node (nhiều máy `aivin-service` cùng
// attach). CLI chỉ lo: gọi REST của BE (mint token/tạo store), rồi ghi `worker-identity.json` vào
// thư mục đã mount volume của container `aivin-service` — service tự pair khi thấy file (fs.watch),
// không cần CLI biết service đang chạy hay chưa, không cần restart container.

export function storeAuthHeaders() {
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    console.log(chalk.yellow('⚠️  API_KEY not set - run `aivin login` first'));
  }
  return { headers: { Authorization: `Bearer ${apiKey || 'dev-token'}` } };
}

export function storeBaseUrl() {
  return process.env.AIVIN_BASE_URL || 'https://api.aivin.cloud';
}

function defaultDataDir() {
  return path.join(os.homedir(), '.aivin', 'service-data');
}

/** Ghi `worker-identity.json` — schema PHẢI khớp CHÍNH XÁC với `WorkerIdentity.ts` (repo
 *  `aivin-service`) đọc, không thêm/bớt field tuỳ tiện ở 1 phía mà không sửa phía kia. */
function writeWorkerIdentity(dataDir, { beEndpoint, orgId, storeId, nodeId, nodeLabel, workerToken }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const filePath = path.join(dataDir, 'worker-identity.json');
  const payload = {
    version: 1,
    be_endpoint: beEndpoint,
    org_id: orgId,
    store_id: storeId,
    node_id: nodeId,
    node_label: nodeLabel || '',
    worker_token: workerToken,
    paired_at: new Date().toISOString(),
  };
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
  return filePath;
}

function printAttachResult(res, dataDir) {
  const { store, node, worker_token, worker_hub_endpoint } = res.data;
  const filePath = writeWorkerIdentity(dataDir, {
    beEndpoint: worker_hub_endpoint,
    orgId: store.owner_org_id,
    storeId: store.store_id,
    nodeId: node.node_id,
    nodeLabel: node.label,
    workerToken: worker_token,
  });
  console.log(chalk.green(`\n✅ Node "${node.node_id}" attached to store "${store.store_id}"`));
  console.log(chalk.gray(`   Credential written to ${filePath}`));
  console.log(
    chalk.gray(
      `   If aivin-service isn't running yet: docker run -v ${dataDir}:/app/data ... (mount this exact directory as WORKER_DATA_DIR)`,
    ),
  );
  console.log(chalk.gray('   Already running? Nothing else to do - it picks up this file within ~200ms, no restart needed.'));
}

export async function createStore(storeId, options) {
  if (!storeId) {
    const { answer } = await inquirer.prompt([{ type: 'input', name: 'answer', message: 'Store id (slug, e.g. phong-ban-a):' }]);
    storeId = answer;
  }
  let label = options.label;
  if (!label && process.stdout.isTTY && process.stdin.isTTY) {
    const { answer } = await inquirer.prompt([{ type: 'input', name: 'answer', message: 'Display label:', default: storeId }]);
    label = answer;
  }

  try {
    const res = await withSpinner(`📦 Creating store "${storeId}"`, () =>
      axios.post(`${storeBaseUrl()}/stores`, { store_id: storeId, label, node_label: options.nodeLabel }, storeAuthHeaders()),
    );
    printAttachResult(res, options.dataDir || defaultDataDir());
  } catch (error) {
    const message = error.response?.data?.message?.message || error.response?.data?.message || error.message;
    throw new Error(`Create store failed: ${message}`, { cause: error });
  }
}

/** `attach` — nếu `store_id` chưa tồn tại (BE trả 404), hỏi tương tác tạo mới thay vì tự động tạo
 *  (tránh gõ nhầm store_id tạo ra 1 store rác không ai định tạo) — xem doc thiết kế mục 7. */
export async function attachStore(storeId, options) {
  if (!storeId) {
    const { answer } = await inquirer.prompt([{ type: 'input', name: 'answer', message: 'Store id to attach to:' }]);
    storeId = answer;
  }

  try {
    const res = await withSpinner(`🔗 Attaching to store "${storeId}"`, () =>
      axios.post(`${storeBaseUrl()}/stores/${encodeURIComponent(storeId)}/attach`, { node_label: options.nodeLabel }, storeAuthHeaders()),
    );
    printAttachResult(res, options.dataDir || defaultDataDir());
  } catch (error) {
    if (error.response?.status === 404) {
      console.log(chalk.yellow(`Store "${storeId}" doesn't exist yet.`));
      if (process.stdout.isTTY && process.stdin.isTTY) {
        const { proceed } = await inquirer.prompt([{ type: 'confirm', name: 'proceed', message: 'Create it now?', default: true }]);
        if (proceed) return createStore(storeId, options);
      }
      console.log(chalk.gray('Cancelled - run `aivin pluginstore create <store_id>` to create it explicitly.'));
      return;
    }
    const message = error.response?.data?.message?.message || error.response?.data?.message || error.message;
    throw new Error(`Attach failed: ${message}`, { cause: error });
  }
}

export async function listStores(options) {
  let response;
  try {
    response = await axios.get(`${storeBaseUrl()}/stores`, storeAuthHeaders());
  } catch (error) {
    const message = error.response?.data?.message || error.message;
    throw new Error(`List failed: ${message}`, { cause: error });
  }

  const stores = response.data || [];
  if (stores.length === 0) {
    console.log(chalk.yellow('No plugin stores found.'));
    return;
  }

  console.log(chalk.blue(`${stores.length} store(s):\n`));
  for (const s of stores) {
    const online = s.nodes?.some((n) => n.status === 'online');
    const statusBadge = online ? chalk.green('● online') : chalk.gray('○ offline');
    const enabledBadge = s.enabled ? '' : chalk.red(' [disabled]');
    const kindBadge = s.kind === 'system' ? chalk.cyan(' [aivin default]') : '';
    console.log(`${chalk.bold(s.label || s.store_id)} ${chalk.gray(`(${s.store_id})`)} ${statusBadge}${enabledBadge}${kindBadge}`);
    for (const n of s.nodes || []) {
      const nodeStatus = n.status === 'online' ? chalk.green('online') : chalk.gray('offline');
      console.log(chalk.gray(`   - ${n.label || n.node_id} (${n.node_id}) ${nodeStatus}`));
    }
    if (options.plain !== true && (s.nodes || []).length === 0) console.log(chalk.gray('   (no nodes attached)'));
    console.log();
  }
}

export async function setStoreEnabled(storeId, enabled) {
  try {
    await withSpinner(`${enabled ? '▶️  Enabling' : '⏸  Disabling'} store "${storeId}"`, () =>
      axios.patch(`${storeBaseUrl()}/stores/${encodeURIComponent(storeId)}`, { enabled }, storeAuthHeaders()),
    );
    console.log(chalk.green(`✅ Store "${storeId}" ${enabled ? 'enabled' : 'disabled'}.`));
  } catch (error) {
    const message = error.response?.data?.message?.message || error.response?.data?.message || error.message;
    if (error.response?.status === 401 || error.response?.status === 403) {
      throw new Error(`${message} - this action requires org admin.`, { cause: error });
    }
    throw new Error(`${enabled ? 'Enable' : 'Disable'} failed: ${message}`, { cause: error });
  }
}

export async function deleteStore(storeId, options) {
  if (!options.yes) {
    const { confirmId } = await inquirer.prompt([
      {
        type: 'input',
        name: 'confirmId',
        message: chalk.red(`This revokes EVERY node attached to "${storeId}" (not just this machine). Type the store id to confirm:`),
      },
    ]);
    if (confirmId !== storeId) {
      console.log(chalk.gray('Cancelled - store id did not match.'));
      return;
    }
  }

  try {
    await withSpinner(`🗑  Deleting store "${storeId}"`, () => axios.delete(`${storeBaseUrl()}/stores/${encodeURIComponent(storeId)}`, storeAuthHeaders()));
    console.log(chalk.green(`✅ Store "${storeId}" deleted - all nodes revoked.`));
  } catch (error) {
    const message = error.response?.data?.message?.message || error.response?.data?.message || error.message;
    throw new Error(`Delete failed: ${message}`, { cause: error });
  }
}

/** `detach` — THUẦN CỤC BỘ, không gọi BE (xem doc thiết kế mục 7): chỉ xoá file credential của
 *  ĐÚNG máy này. `aivin-service`'s `WorkerIdentity.ts` tự bắt được qua `fs.watch` và disconnect. */
export function detachStore(options) {
  const dataDir = options.dataDir || defaultDataDir();
  const filePath = path.join(dataDir, 'worker-identity.json');
  if (!fs.existsSync(filePath)) {
    console.log(chalk.yellow(`No worker-identity.json found at ${filePath} - nothing to detach.`));
    return;
  }
  fs.unlinkSync(filePath);
  console.log(chalk.green(`✅ Detached - removed ${filePath}`));
  console.log(chalk.gray('   The running aivin-service (if any) will disconnect automatically - no restart needed.'));
}
