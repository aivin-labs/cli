import chalk from 'chalk';
import axios from 'axios';
import inquirer from 'inquirer';
import { openBrowser } from './auth.mjs';

const POLL_INTERVAL_MS = 3000;
const OAUTH_WAIT_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * `/plugins/execute` comes back `status: 'needs_auth'` when a plugin's connector isn't configured
 * yet (PluginExecutionService.resolveExecutionAuth on the backend) - `data.auth_flow` tells us
 * which of the two ways to fix that: 'oauth' (open a browser, same as the web app's "Connect"
 * button) or 'form' (a handful of plain fields, e.g. SMTP host/user/pass - no browser involved).
 * Returns true once the connector is actually usable (so the caller can retry the trigger), false
 * if the user declined or it failed/timed out.
 */
export async function resolveConnectorAuth(data, { serverUrl, apiKey, workspaceId }) {
  const authHeaders = { headers: { Authorization: `Bearer ${apiKey || 'dev-token'}` } };
  const provider = data?.auth_params?.provider;
  if (!provider) return false;

  return data.auth_flow === 'form'
    ? resolveFormConnector(data, { serverUrl, authHeaders, workspaceId, provider })
    : resolveOAuthConnector(data, { serverUrl, authHeaders, workspaceId, provider });
}

async function resolveOAuthConnector(data, { serverUrl, authHeaders, workspaceId, provider }) {
  console.log(chalk.yellow(`\n⚠ This plugin needs you to connect "${provider}" first.`));
  const { proceed } = await inquirer.prompt([
    { type: 'confirm', name: 'proceed', message: 'Open your browser to connect now?', default: true },
  ]);
  if (!proceed) return false;

  let triggerUrl;
  try {
    const initRes = await axios.post(
      `${serverUrl}/plugins/auth/init`,
      { workspace_id: workspaceId, provider, scopes: data.auth_params?.scopes },
      authHeaders,
    );
    if (!initRes.data?.success) throw new Error(initRes.data?.error || 'init failed');
    triggerUrl = initRes.data.trigger_url;
  } catch (error) {
    console.log(chalk.red(`Couldn't start the connect flow: ${error.response?.data?.error || error.message}`));
    return false;
  }

  console.log(chalk.blue('🌐 Opening your browser to connect...'));
  console.log(chalk.gray(`   ${triggerUrl}`));
  console.log(chalk.gray('   Not opened automatically? Paste that URL into your browser.'));
  openBrowser(triggerUrl);

  console.log(chalk.gray('   Waiting for you to finish in the browser (3 min timeout)...'));
  const deadline = Date.now() + OAUTH_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    try {
      const statusRes = await axios.get(`${serverUrl}/plugins/auth/status`, {
        ...authHeaders,
        params: { workspace_id: workspaceId, provider },
      });
      const status = statusRes.data?.status;
      // Anything other than these two "still needs work" states means the connection is now usable
      // (PluginAuthService.resolveConnectionStatus only ever returns those two, or a connected state).
      if (status && status !== 'needs_auth' && status !== 'needs_scope_upgrade') {
        console.log(chalk.green(`✅ Connected "${provider}".`));
        return true;
      }
    } catch {
      // Best-effort polling - a transient network blip shouldn't abort the whole wait.
    }
  }
  console.log(chalk.yellow('Timed out waiting for the connection - run the command again once you\'ve connected.'));
  return false;
}

async function resolveFormConnector(data, { serverUrl, authHeaders, workspaceId, provider }) {
  const fields = data.auth_params?.form_fields;
  if (!Array.isArray(fields) || fields.length === 0) {
    console.log(
      chalk.yellow(
        `\n⚠ This plugin needs connector "${provider}" configured, but the CLI couldn't find its field list ` +
          '- configure it from the web app\'s Settings → Connections instead.',
      ),
    );
    return false;
  }

  console.log(chalk.yellow(`\n⚠ This plugin needs connector "${provider}" configured:`));
  const values = {};
  for (const field of fields) {
    const label = field.label || field.name;
    const message = field.description ? `${label} (${field.description}):` : `${label}:`;

    if (field.type === 'boolean') {
      const { value } = await inquirer.prompt([{ type: 'confirm', name: 'value', message, default: false }]);
      values[field.name] = value;
      continue;
    }

    const { value } = await inquirer.prompt([
      {
        type: field.type === 'secret' ? 'password' : 'input',
        name: 'value',
        message: field.required ? `${message} (required)` : message,
        mask: field.type === 'secret' ? '*' : undefined,
        validate: (input) => {
          if (!input) return field.required ? 'Required' : true;
          if (field.type === 'number' && Number.isNaN(Number(input))) return 'Enter a number';
          return true;
        },
      },
    ]);
    if (!value) continue; // blank optional field - leave it out
    values[field.name] = field.type === 'number' ? Number(value) : value;
  }

  try {
    await axios.post(`${serverUrl}/plugins/auth/form`, { workspace_id: workspaceId, connector_id: provider, values }, authHeaders);
    console.log(chalk.green(`✅ Configured "${provider}".`));
    return true;
  } catch (error) {
    const message = error.response?.data?.error || error.message;
    console.log(chalk.red(`Couldn't save connector: ${message}`));
    return false;
  }
}
