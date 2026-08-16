import fs from 'fs';
import os from 'os';
import path from 'path';
import chalk from 'chalk';
import axios from 'axios';
import inquirer from 'inquirer';
import { withSpinner, requireArg } from './util.mjs';

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
function writeWorkerIdentity(dataDir, { beEndpoint, orgId, storeId, storeName, nodeId, nodeLabel, workerToken, sdkGrpcEndpoint }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const filePath = path.join(dataDir, 'worker-identity.json');
  const payload = {
    version: 1,
    be_endpoint: beEndpoint,
    org_id: orgId,
    store_id: storeId,
    store_name: storeName || '',
    node_id: nodeId,
    node_label: nodeLabel || '',
    worker_token: workerToken,
    // Tuỳ chọn — chỉ có nếu BE cấu hình SDK_GRPC_EXTERNAL_PUBLIC_ENDPOINT (xem
    // PluginStoreRegistryService.ts's resolveSdkGrpcPublicEndpoint). Cho phép node self-host gọi
    // AI-call RPC (ScanAwesomeMcpList/ScanSingleMcpRepo) qua worker_token thay vì cần
    // SDK_ENDPOINT/SDK_SECRET riêng — xem WorkerConnectClient.configureSdkTransport() phía service.
    ...(sdkGrpcEndpoint ? { sdk_grpc_endpoint: sdkGrpcEndpoint } : {}),
    paired_at: new Date().toISOString(),
  };
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
  return filePath;
}

// How long `attach`/`create` wait for the just-written node to actually show up `online` before
// giving up and printing troubleshooting hints - long enough to cover a running aivin-service
// noticing the file (~200ms) + dialing WorkerHub.Connect + TLS handshake, short enough that a
// first-time setup (container not started yet) doesn't feel like the command hung.
const NODE_ONLINE_POLL_TOTAL_MS = 12000;
const NODE_ONLINE_POLL_INTERVAL_MS = 1500;

/** Polls `GET /stores` until `nodeId` shows `status: 'online'` or the budget runs out. Best-effort -
 *  a transient network/auth error while polling is swallowed (not fatal to `attach`/`create`
 *  itself, which already succeeded server-side); the caller just sees "not online yet". */
async function waitForNodeOnline(storeId, nodeId) {
  const deadline = Date.now() + NODE_ONLINE_POLL_TOTAL_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, NODE_ONLINE_POLL_INTERVAL_MS));
    try {
      const res = await axios.get(`${storeBaseUrl()}/stores`, storeAuthHeaders());
      const store = (res.data || []).find((s) => s.store_id === storeId);
      const node = store?.nodes?.find((n) => n.node_id === nodeId);
      if (node?.status === 'online') return true;
    } catch {
      // transient - keep polling until the deadline
    }
  }
  return false;
}

async function printAttachResult(res, dataDir) {
  const { store, node, worker_token, worker_hub_endpoint, sdk_grpc_endpoint } = res.data;
  const filePath = writeWorkerIdentity(dataDir, {
    beEndpoint: worker_hub_endpoint,
    orgId: store.owner_org_id,
    storeId: store.store_id,
    storeName: store.label,
    nodeId: node.node_id,
    nodeLabel: node.label,
    workerToken: worker_token,
    sdkGrpcEndpoint: sdk_grpc_endpoint,
  });
  console.log(chalk.green(`\n✅ Node "${node.node_id}" attached to store "${store.store_id}"`));
  console.log(chalk.gray(`   Credential written to ${filePath}`));
  console.log(
    chalk.gray(
      `   If aivin-service isn't running yet: docker run -v ${dataDir}:/app/data ... (mount this exact directory as WORKER_DATA_DIR)`,
    ),
  );

  // Best-effort confirmation, not a hard requirement - a fresh setup with aivin-service not
  // started yet is expected to still be "offline" here, that's normal, not a failure. This only
  // upgrades a previously-silent "trust me, it worked" into an actual observed state, so a broken
  // connect (bad token/TLS/tunnel/firewall) is caught right here instead of surfacing later as a
  // confusing "no nodes attached"/trigger-hangs-then-524 the next time this store is used.
  const online = await withSpinner(`   Waiting for "${node.node_id}" to come online`, () => waitForNodeOnline(store.store_id, node.node_id));
  if (online) {
    console.log(chalk.green(`   ✅ Connected - node is online.`));
  } else {
    console.log(chalk.yellow(`   ⏳ Not online yet.`));
    console.log(chalk.gray('      Normal if aivin-service isn\'t running yet on this credential\'s data dir - nothing else to do,'));
    console.log(chalk.gray('      it picks up the file within ~200ms once started, no restart needed.'));
    console.log(chalk.gray(`      Already running and still offline after a bit? Check: it can reach ${worker_hub_endpoint} over TLS`));
    console.log(chalk.gray('      (firewall/tunnel in the way?), and its own logs for a connect error. Re-check with `aivin pluginstore ls`.'));
    console.log(
      chalk.gray(
        `      If this node never comes online, remove it with \`aivin pluginstore rm-node ${store.store_id} ${node.node_id}\` and re-attach once fixed.`,
      ),
    );
  }
}

export async function createStore(storeId, options) {
  const interactive = process.stdout.isTTY && process.stdin.isTTY;

  if (!storeId) {
    if (!interactive) throw new Error('Store id is required - pass it as an argument (non-interactive session).');
    const { answer } = await inquirer.prompt([{ type: 'input', name: 'answer', message: 'Store id (slug, e.g. phong-ban-a):' }]);
    storeId = answer;
  }

  let label = options.label;
  if (!label && interactive) {
    const { answer } = await inquirer.prompt([{ type: 'input', name: 'answer', message: 'Store name:', default: storeId }]);
    label = answer;
  }

  const nodeLabel = options.nodeLabel || os.hostname();

  try {
    const res = await withSpinner(`📦 Creating store "${storeId}"`, () =>
      axios.post(`${storeBaseUrl()}/stores`, { store_id: storeId, label, node_label: nodeLabel }, storeAuthHeaders()),
    );
    await printAttachResult(res, options.dataDir || defaultDataDir());
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
    await printAttachResult(res, options.dataDir || defaultDataDir());
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
    if (options.plain !== true && (s.nodes || []).length === 0) {
      // `kind=system` (the "aivin default" store) is served by Aivin's own managed fleet, not by
      // self-host nodes attached via this CLI - it ALWAYS has 0 nodes here, by design, not because
      // anything is wrong. Printing the same "(no nodes attached)" line self-host stores use made
      // this look like a standing error on every single `ls` for every account.
      console.log(chalk.gray(s.kind === 'system' ? '   (served by Aivin\'s managed fleet - self-host nodes not applicable)' : '   (no nodes attached)'));
    }
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

/** `rm-node` - removes ONE node from a store without touching any other node attached to it
 *  (unlike `rm`, which revokes every node's credential at once). Meant for cleaning up a node that
 *  never came online (bad token/TLS/network at `attach` time - see `waitForNodeOnline` above) and
 *  is just sitting there `offline` forever, without having to nuke and re-pair every other machine
 *  attached to the same store. BE refuses this for a node that's currently `online` (409) - detach
 *  it there first (stop aivin-service, or `aivin pluginstore detach` on that machine). */
export async function removeNode(storeId, nodeId, options) {
  storeId = await requireArg(storeId, { prompt: 'Store id:', usage: 'Usage: aivin pluginstore rm-node <store_id> <node_id>' });
  nodeId = await requireArg(nodeId, { prompt: 'Node id to remove:', usage: 'Usage: aivin pluginstore rm-node <store_id> <node_id>' });

  if (!options.yes) {
    const { confirm } = await inquirer.prompt([
      { type: 'confirm', name: 'confirm', message: `Remove node "${nodeId}" from store "${storeId}"? This can't be undone.`, default: false },
    ]);
    if (!confirm) {
      console.log(chalk.gray('Cancelled.'));
      return;
    }
  }

  try {
    await withSpinner(`🗑  Removing node "${nodeId}"`, () =>
      axios.delete(`${storeBaseUrl()}/stores/${encodeURIComponent(storeId)}/nodes/${encodeURIComponent(nodeId)}`, storeAuthHeaders()),
    );
    console.log(chalk.green(`✅ Node "${nodeId}" removed from store "${storeId}".`));
  } catch (error) {
    const message = error.response?.data?.message?.message || error.response?.data?.message || error.message;
    if (error.response?.status === 409) {
      throw new Error(`${message} - this node is still online. Stop aivin-service (or run \`aivin pluginstore detach\` on that machine) first.`, { cause: error });
    }
    throw new Error(`Remove node failed: ${message}`, { cause: error });
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
