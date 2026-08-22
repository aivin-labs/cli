import chalk from 'chalk';
import axios from 'axios';
import inquirer from 'inquirer';
import { trustBadge, browseResults } from './pluginTrigger.mjs';
import { withSpinner, DEFAULT_API_TIMEOUT_MS } from './util.mjs';

// ── Connectors - reusable OAuth apps / credential-form namespaces plugins can reference ────────

export function connectorAuthHeaders() {
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    console.log(chalk.yellow('⚠️  API_KEY not set - run `aivin login` first'));
  }
  // ✅ FIX: no call site in this file set a `timeout` before - worst case was `registerConnector`,
  // where a hang meant re-typing an entire OAuth client_secret from scratch after Ctrl+C. Setting it
  // once here (this object is passed straight through as the axios config everywhere it's used)
  // covers every call site.
  return { headers: { Authorization: `Bearer ${apiKey || 'dev-token'}` }, timeout: DEFAULT_API_TIMEOUT_MS };
}

export function connectorBaseUrl() {
  return process.env.AIVIN_BASE_URL || 'https://api.aivin.cloud';
}

export function formatConnectorListLine(connector, isSelected) {
  const marker = isSelected ? chalk.cyan('❯ ') : '  ';
  const label = connector.name || connector.id;
  const name = isSelected ? chalk.bold.cyan(label) : label;
  const badge = connector.is_official ? chalk.green(' ✓') : '';
  const deprecated = connector.deprecated ? chalk.red(' [deprecated]') : '';
  return `${marker}${name}${badge}${deprecated}${chalk.gray(`  (${connector.id}, ${connector.type})`)}`;
}

export function formatConnectorDetail(connector) {
  const lines = [];
  lines.push(chalk.bold.cyan(connector.name || connector.id) + '  ' + trustBadge(connector));
  lines.push(chalk.gray(connector.id));
  lines.push(`${chalk.gray('type')}       ${connector.type}`);
  lines.push(`${chalk.gray('visibility')} ${connector.visibility}${connector.store_status ? ` (${connector.store_status})` : ''}`);
  if (connector.description) lines.push(`\n${connector.description}`);
  // Backend's ConnectorManifest nests OAuth/form details under `config` (discriminated by `type`) -
  // not top-level `oauth`/`fields` (see ConnectorDTO.ts's RegisterConnectorDto/ConnectorManifest and
  // ConnectorService.sanitize, which keeps `config` intact). Reading the wrong path here used to
  // print an empty detail section for every connector regardless of what it actually holds.
  if (connector.type === 'oauth' && connector.config) {
    lines.push(`\n${chalk.gray('authorize_url')} ${connector.config.authorize_url}`);
    lines.push(`${chalk.gray('access_url')}    ${connector.config.access_url}`);
    if (connector.config.scopes?.length) lines.push(`${chalk.gray('scopes')}        ${connector.config.scopes.join(', ')}`);
  } else if (connector.type === 'credential_form' && connector.config?.fields?.length) {
    lines.push(`\n${chalk.gray('fields')}\n${connector.config.fields.map(f => `  - ${f.name}${f.required ? ' (required)' : ''}${f.label ? `: ${f.label}` : ''}`).join('\n')}`);
  }
  lines.push(chalk.gray(`\nReference it from a plugin manifest's connection_id: "${connector.id}"`));
  return lines.join('\n');
}

export async function searchConnectors(query, options) {
  const params = { query };
  if (options.limit) params.limit = options.limit;

  let response;
  try {
    response = await axios.get(`${connectorBaseUrl()}/connectors/search`, { ...connectorAuthHeaders(), params });
  } catch (error) {
    const message = error.response?.data?.message || error.message || error.code || 'Unknown error';
    throw new Error(`Search failed: ${message}`, { cause: error });
  }

  const results = response.data || [];
  if (results.length === 0) {
    console.log(chalk.yellow(`No connectors found matching "${query}".`));
    return;
  }

  if (process.stdout.isTTY && process.stdin.isTTY && !options.plain) {
    await browseResults(results, `Found ${results.length} connector(s) matching "${query}":\n`, formatConnectorListLine, formatConnectorDetail);
    return;
  }

  console.log(chalk.blue(`Found ${results.length} connector(s) matching "${query}":\n`));
  for (const c of results) {
    console.log(chalk.bold(c.name || c.id) + chalk.gray(`  (${c.id}, ${c.type})`));
    if (c.description) console.log(`  ${c.description}`);
    console.log();
  }
}

export async function listConnectors(options) {
  const params = {};
  if (options.page) params.page = options.page;
  if (options.limit) params.limit = options.limit;
  if (options.includeDeprecated) params.include_deprecated = 'true';

  let response;
  try {
    response = await axios.get(`${connectorBaseUrl()}/connectors/list`, { ...connectorAuthHeaders(), params });
  } catch (error) {
    const message = error.response?.data?.message || error.message || error.code || 'Unknown error';
    throw new Error(`List failed: ${message}`, { cause: error });
  }

  const { items = [], total = 0 } = response.data || {};
  if (items.length === 0) {
    console.log(chalk.yellow('No connectors found.'));
    return;
  }

  if (process.stdout.isTTY && process.stdin.isTTY && !options.plain) {
    await browseResults(items, `${total} connector(s):\n`, formatConnectorListLine, formatConnectorDetail);
    return;
  }

  console.log(chalk.blue(`${total} connector(s):\n`));
  for (const c of items) {
    console.log(chalk.bold(c.name || c.id) + chalk.gray(`  (${c.id}, ${c.type})`));
    if (c.description) console.log(`  ${c.description}`);
    console.log();
  }
}

/**
 * Pure assembly of the request body `POST /connectors/register` expects, split out of
 * registerConnector() so it's unit-testable without stubbing inquirer prompts - this exact
 * assembly (nesting under `config`, not top-level `oauth`/`fields`) is what drifted from the
 * backend's actual RegisterConnectorDto before and broke every registration; a regression test
 * pins the shape down going forward. `oauthAnswers`/`fields` are already-collected inquirer
 * answers, not prompted here.
 */
export function buildRegisterConnectorDto(base, { oauthAnswers, fields } = {}) {
  const dto = { id: base.id, name: base.name, description: base.description || undefined, image: base.image || undefined, type: base.type, visibility: base.visibility };

  // ⚠ Backend's RegisterConnectorDto expects these nested under `config` (discriminated by `type` -
  // see ConnectorDTO.ts / ConnectorService.register, which reads `dto.config.authorize_url` /
  // `dto.config.fields`, never a top-level `dto.oauth`/`dto.fields`). This used to send them
  // top-level, which the backend's `config` field (now validated with `@IsObject()`, previously
  // silently stripped by the global whitelist ValidationPipe for having no class-validator
  // decorators at all) would see as missing/wrong-shaped - registration failed every time regardless
  // of what was typed here.
  if (base.type === 'oauth') {
    dto.config = {
      authorize_url: oauthAnswers.authorize_url,
      access_url: oauthAnswers.access_url,
      profile_url: oauthAnswers.profile_url || undefined,
      client_id: oauthAnswers.client_id,
      client_secret: oauthAnswers.client_secret,
      scopes: oauthAnswers.scopes ? oauthAnswers.scopes.split(',').map((s) => s.trim()).filter(Boolean) : [],
    };
  } else {
    if (!fields || fields.length === 0) throw new Error('credential_form connectors need at least one field');
    dto.config = { fields };
  }
  return dto;
}

export async function registerConnector() {
  console.log(chalk.blue('🔌 Register a new connector\n'));

  const base = await inquirer.prompt([
    { type: 'input', name: 'id', message: 'Connector id (e.g. mailgun):' },
    { type: 'input', name: 'name', message: 'Display name:' },
    { type: 'input', name: 'description', message: 'Description (optional):' },
    { type: 'input', name: 'image', message: 'Logo/icon URL (optional):' },
    {
      type: 'select',
      name: 'type',
      message: 'Connector type:',
      choices: [
        { name: 'oauth - login flow (client_id/secret, authorize/token URLs)', value: 'oauth' },
        { name: 'credential_form - plain fields the user fills in (host, api_key, ...)', value: 'credential_form' },
      ],
    },
    {
      type: 'select',
      name: 'visibility',
      message: 'Visibility:',
      choices: [
        { name: 'private - only your org can reuse it', value: 'private' },
        { name: 'public - any org can find/reuse it (needs admin review first)', value: 'public' },
      ],
    },
  ]);

  let oauthAnswers, fields;
  if (base.type === 'oauth') {
    oauthAnswers = await inquirer.prompt([
      { type: 'input', name: 'authorize_url', message: 'Authorize URL:' },
      { type: 'input', name: 'access_url', message: 'Token/access URL:' },
      { type: 'input', name: 'profile_url', message: 'Profile URL (optional):' },
      { type: 'input', name: 'client_id', message: 'Client id:' },
      { type: 'password', name: 'client_secret', message: 'Client secret:' },
      { type: 'input', name: 'scopes', message: 'Scopes (comma-separated, optional):' },
    ]);
  } else {
    fields = [];
    console.log(chalk.gray('Add the fields a user must fill in (leave name blank to stop):'));
    for (;;) {
      const f = await inquirer.prompt([
        { type: 'input', name: 'name', message: `Field ${fields.length + 1} name:` },
      ]);
      if (!f.name) break;
      const rest = await inquirer.prompt([
        { type: 'input', name: 'label', message: 'Label (optional):' },
        { type: 'select', name: 'type', message: 'Type:', choices: ['string', 'number', 'boolean', 'secret'], default: 'string' },
        { type: 'confirm', name: 'required', message: 'Required?', default: true },
      ]);
      fields.push({ name: f.name, label: rest.label || undefined, type: rest.type, required: rest.required });
    }
    if (fields.length === 0) throw new Error('credential_form connectors need at least one field');
  }

  const dto = buildRegisterConnectorDto(base, { oauthAnswers, fields });

  // Warn about likely-duplicate connectors before submitting - registering "Gmail" when
  // official.google already covers the same thing just fragments the catalog.
  try {
    const dupRes = await withSpinner('🔎 Checking for similar connectors', () =>
      axios.get(`${connectorBaseUrl()}/connectors/check-duplicate`, {
        ...connectorAuthHeaders(),
        params: { name: dto.name },
      }),
    );
    const duplicates = dupRes.data?.duplicates || [];
    if (duplicates.length > 0) {
      console.log(chalk.yellow(`\n⚠ Similar connector(s) already exist - here's what they already provide, in case you can just reuse one instead:\n`));
      for (const d of duplicates) {
        console.log(formatConnectorDetail(d));
        console.log(chalk.gray('─'.repeat(40)));
      }
      const { proceed } = await inquirer.prompt([
        { type: 'confirm', name: 'proceed', message: 'Register this one anyway?', default: false },
      ]);
      if (!proceed) {
        console.log(chalk.gray('Cancelled.'));
        return;
      }
      dto.confirm_duplicate = true;
    }
  } catch (error) {
    console.log(chalk.gray(`(couldn't check for duplicates: ${error.message || 'unknown error'} - continuing)`));
  }

  try {
    const res = await withSpinner('🔌 Registering connector', () =>
      axios.post(`${connectorBaseUrl()}/connectors/register`, dto, connectorAuthHeaders()),
    );
    console.log(chalk.green(`\n✅ Registered connector "${res.data.connector.id}"`));
    console.log(chalk.gray(`   Reference it from a plugin manifest's connection_id: "${res.data.connector.id}"`));
    return res.data.connector;
  } catch (error) {
    const message = error.response?.data?.message?.message || error.response?.data?.message || error.message;
    throw new Error(`Register failed: ${message}`, { cause: error });
  }
}
