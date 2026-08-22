import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validatePluginConfig,
  incrementVersion,
  validateMcpProxyConfig,
  buildDeploymentPayload,
  buildMcpManifest,
  parseMcpArgs,
  guessConnectorQueryFromEnvVarName,
  setFieldConnector,
  buildRegisterConnectorDto,
  buildCreateTaskPayload,
} from '../bin/cli.mjs';

test('validatePluginConfig accepts a well-formed config', () => {
  const result = validatePluginConfig({ name: 'my-plugin', description: 'Does things' });
  assert.deepEqual(result, { valid: true, errors: [] });
});

test('validatePluginConfig rejects an uppercase/space-containing name', () => {
  const result = validatePluginConfig({ name: 'My Plugin', description: 'Does things' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('name')));
});

test('validatePluginConfig requires a description', () => {
  const result = validatePluginConfig({ name: 'my-plugin' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('description')));
});

test('incrementVersion bumps the patch component', () => {
  assert.equal(incrementVersion('1.2.3'), '1.2.4');
  assert.equal(incrementVersion('1.0.0'), '1.0.1');
});

test('incrementVersion defaults a missing/empty version to 1.0.0 before bumping', () => {
  assert.equal(incrementVersion(undefined), '1.0.1');
});

test('validateMcpProxyConfig requires mcp_command for stdio transport', () => {
  const errors = validateMcpProxyConfig({ mcp_transport: 'stdio', mcp_kind: 'tool', mcp_tool_name: 'x' });
  assert.ok(errors.some((e) => e.includes('mcp_command')));
});

test('validateMcpProxyConfig requires mcp_url for sse transport', () => {
  const errors = validateMcpProxyConfig({ mcp_transport: 'sse', mcp_kind: 'tool', mcp_tool_name: 'x' });
  assert.ok(errors.some((e) => e.includes('mcp_url')));
});

test('validateMcpProxyConfig rejects an unknown transport', () => {
  const errors = validateMcpProxyConfig({ mcp_transport: 'ws', mcp_kind: 'tool', mcp_tool_name: 'x' });
  assert.ok(errors.some((e) => e.includes('mcp_transport')));
});

test('validateMcpProxyConfig requires the identifying field per mcp_kind', () => {
  assert.ok(
    validateMcpProxyConfig({ mcp_transport: 'sse', mcp_url: 'https://x', mcp_kind: 'resource' }).some((e) =>
      e.includes('mcp_resource_uri'),
    ),
  );
  assert.ok(
    validateMcpProxyConfig({ mcp_transport: 'sse', mcp_url: 'https://x', mcp_kind: 'prompt' }).some((e) =>
      e.includes('mcp_prompt_name'),
    ),
  );
  assert.deepEqual(
    validateMcpProxyConfig({ mcp_transport: 'sse', mcp_url: 'https://x', mcp_kind: 'tool', mcp_tool_name: 'go' }),
    [],
  );
});

test('validatePluginConfig surfaces nested mcp proxy errors with a proxy_config prefix', () => {
  const result = validatePluginConfig({
    name: 'my-mcp-plugin',
    description: 'desc',
    proxy_config: { type: 'mcp', mcp_transport: 'stdio' },
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e === 'proxy_config.mcp_command is required for stdio transport'));
});

test('buildDeploymentPayload omits the files key entirely for a proxy manifest', () => {
  const payload = buildDeploymentPayload({ id: 'p1', name: 'p1', proxy_config: { type: 'mcp' } }, undefined);
  assert.deepEqual(payload, { id: 'p1', manifest: { id: 'p1', name: 'p1', proxy_config: { type: 'mcp' } } });
  assert.ok(!('files' in payload));
});

test('buildDeploymentPayload includes files for a regular code plugin', () => {
  const manifest = { id: 'p2', name: 'p2' };
  const payload = buildDeploymentPayload(manifest, { 'src/main.ts': 'export {}' });
  assert.deepEqual(payload, { id: 'p2', manifest, files: { 'src/main.ts': 'export {}' } });
});

test('buildDeploymentPayload sends a batch manifest array with files, no top-level id', () => {
  const manifest = [
    { id: 'p3a', name: 'p3a', func: 'summarizeTicket' },
    { id: 'p3b', name: 'p3b', func: 'tagUrgency' },
  ];
  const payload = buildDeploymentPayload(manifest, { 'src/main.ts': 'export {}' });
  assert.deepEqual(payload, { manifest, files: { 'src/main.ts': 'export {}' } });
  assert.ok(!('id' in payload));
});

test('buildDeploymentPayload omits files for a batch manifest where every entry is a proxy', () => {
  const manifest = [
    { id: 'p4a', name: 'p4a', proxy_config: { type: 'mcp' } },
    { id: 'p4b', name: 'p4b', proxy_config: { type: 'mcp' } },
  ];
  const payload = buildDeploymentPayload(manifest, undefined);
  assert.deepEqual(payload, { manifest });
  assert.ok(!('files' in payload));
});

test('buildMcpManifest produces a valid stdio+tool proxy config with undefined fields stripped', () => {
  const manifest = buildMcpManifest('my-plugin', 'desc', {
    transport: 'stdio',
    command: 'npx',
    args: '-y some-mcp-server',
    kind: 'tool',
    toolName: 'search',
  });
  assert.equal(manifest.proxy_config.type, 'mcp');
  assert.equal(manifest.proxy_config.mcp_command, 'npx');
  assert.deepEqual(manifest.proxy_config.mcp_args, ['-y', 'some-mcp-server']);
  assert.equal(manifest.proxy_config.mcp_url, undefined);
  assert.equal(validatePluginConfig(manifest).valid, true);
});

test('buildMcpManifest strips an empty resourceMimeType instead of writing ""', () => {
  const manifest = buildMcpManifest('my-plugin', 'desc', {
    transport: 'sse',
    url: 'https://example.com/mcp',
    kind: 'resource',
    resourceUri: 'file:///a.txt',
    resourceMimeType: '',
  });
  // The key stays present with an `undefined` value (that's how the other stripped fields here
  // work too) - what actually matters is JSON.stringify drops it, since that's what ends up on
  // disk/over the wire.
  assert.equal(manifest.proxy_config.mcp_resource_mime_type, undefined);
  assert.ok(!('mcp_resource_mime_type' in JSON.parse(JSON.stringify(manifest.proxy_config))));
});

test('buildMcpManifest defaults auth_type to bearer, or forwards an explicit --auth-type', () => {
  const defaulted = buildMcpManifest('my-plugin', 'desc', {
    transport: 'stdio', command: 'npx', kind: 'tool', toolName: 'search', authSecretKey: 'my-secret',
  });
  assert.equal(defaulted.proxy_config.auth_type, 'bearer');

  const overridden = buildMcpManifest('my-plugin', 'desc', {
    transport: 'stdio', command: 'npx', kind: 'tool', toolName: 'search', authSecretKey: 'my-secret', authType: 'api_key',
  });
  assert.equal(overridden.proxy_config.auth_type, 'api_key');
});

test('buildMcpManifest sets connection_id at the top level, not inside proxy_config', () => {
  const manifest = buildMcpManifest('my-plugin', 'desc', {
    transport: 'stdio', command: 'npx', kind: 'tool', toolName: 'search', connectorId: 'slack-conn',
  });
  assert.equal(manifest.connection_id, 'slack-conn');
  assert.ok(!('connection_id' in manifest.proxy_config));
});

test('buildMcpManifest omits connection_id entirely when no connector was chosen', () => {
  const manifest = buildMcpManifest('my-plugin', 'desc', {
    transport: 'stdio', command: 'npx', kind: 'tool', toolName: 'search',
  });
  assert.ok(!('connection_id' in manifest));
});

test('buildMcpManifest turns envFields into initable + per-field initial.connection_id (the fields PluginProxyService actually reads)', () => {
  const manifest = buildMcpManifest('my-plugin', 'desc', {
    transport: 'stdio', command: 'npx', kind: 'tool', toolName: 'search',
    envFields: [
      { name: 'GITHUB_TOKEN', connectorId: 'github-oauth' },
      { name: 'GITHUB_ORG' }, // no connector - workspace fills this in later
    ],
  });
  assert.deepEqual(manifest.initable, ['GITHUB_TOKEN', 'GITHUB_ORG']);
  assert.deepEqual(manifest.initial.GITHUB_TOKEN, { source: 'static', connection_id: 'github-oauth' });
  assert.deepEqual(manifest.initial.GITHUB_ORG, { source: 'static' });
  // Derived from the (single) connector actually used by a field - not something set independently.
  assert.equal(manifest.connection_id, 'github-oauth');
});

test('buildMcpManifest picks the first connector (sorted) as top-level connection_id when envFields use more than one', () => {
  const manifest = buildMcpManifest('my-plugin', 'desc', {
    transport: 'stdio', command: 'npx', kind: 'tool', toolName: 'search',
    envFields: [
      { name: 'SLACK_TOKEN', connectorId: 'slack-oauth' },
      { name: 'GITHUB_TOKEN', connectorId: 'github-oauth' },
    ],
  });
  assert.equal(manifest.connection_id, 'github-oauth'); // 'github-oauth' < 'slack-oauth'
});

test('buildMcpManifest omits initable/initial entirely when there are no envFields', () => {
  const manifest = buildMcpManifest('my-plugin', 'desc', {
    transport: 'stdio', command: 'npx', kind: 'tool', toolName: 'search',
  });
  assert.ok(!('initable' in manifest));
  assert.ok(!('initial' in manifest));
});

test('parseMcpArgs splits on whitespace and respects quoted values with spaces', () => {
  assert.deepEqual(parseMcpArgs('-y some-mcp-server'), ['-y', 'some-mcp-server']);
  assert.deepEqual(parseMcpArgs('--path "C:\\Program Files\\mcp"'), ['--path', 'C:\\Program Files\\mcp']);
});

test('parseMcpArgs unescapes \\" and \\\\ inside a quoted value', () => {
  assert.deepEqual(parseMcpArgs('"say \\"hi\\""'), ['say "hi"']);
});

test('parseMcpArgs throws on an unterminated quote', () => {
  assert.throws(() => parseMcpArgs('--path "unterminated'), /Unterminated/);
});

test('guessConnectorQueryFromEnvVarName strips common credential suffixes and lowercases the first segment', () => {
  assert.equal(guessConnectorQueryFromEnvVarName('GITHUB_TOKEN'), 'github');
  assert.equal(guessConnectorQueryFromEnvVarName('GITHUB_PERSONAL_ACCESS_TOKEN'), 'github');
  assert.equal(guessConnectorQueryFromEnvVarName('SLACK_BOT_TOKEN'), 'slack');
  assert.equal(guessConnectorQueryFromEnvVarName('JIRA_API_KEY'), 'jira');
});

test('guessConnectorQueryFromEnvVarName falls back gracefully for unrecognized names', () => {
  assert.equal(guessConnectorQueryFromEnvVarName(''), '');
  assert.equal(guessConnectorQueryFromEnvVarName('SOME_CUSTOM_VAR'), 'some');
});

// ── Regression tests for bugs found/fixed 2026-08-21: CLI/backend contract drift ──────────────
// Each of these pins down the exact shape a real backend DTO expects, so a future edit that
// reintroduces the same class of mismatch (right-looking field, wrong name/nesting) fails a test
// immediately instead of only surfacing when a real user hits it.

test('setFieldConnector writes connection_id into initial[field], preserving other props on that field', () => {
  const initial = { API_KEY: { type: 'string', secret: true } };
  setFieldConnector(initial, 'API_KEY', 'firecrawl');
  assert.deepEqual(initial.API_KEY, { type: 'string', secret: true, source: 'static', connection_id: 'firecrawl' });
});

test('setFieldConnector creates the field entry if it does not exist yet', () => {
  const initial = {};
  setFieldConnector(initial, 'GITHUB_TOKEN', 'github');
  assert.deepEqual(initial.GITHUB_TOKEN, { source: 'static', connection_id: 'github' });
});

test('buildRegisterConnectorDto nests OAuth fields under `config`, matching backend RegisterConnectorDto - not top-level `oauth`', () => {
  const dto = buildRegisterConnectorDto(
    { id: 'slack', name: 'Slack', type: 'oauth', visibility: 'private' },
    { oauthAnswers: { authorize_url: 'https://slack.com/authorize', access_url: 'https://slack.com/token', client_id: 'a', client_secret: 's', scopes: 'chat:write, channels:read' } },
  );
  assert.equal(dto.config.authorize_url, 'https://slack.com/authorize');
  assert.equal(dto.config.client_secret, 's');
  assert.deepEqual(dto.config.scopes, ['chat:write', 'channels:read']);
  assert.ok(!('oauth' in dto), 'must not send a top-level `oauth` key - backend reads dto.config, not dto.oauth');
});

test('buildRegisterConnectorDto nests credential_form fields under `config`, matching backend RegisterConnectorDto - not top-level `fields`', () => {
  const dto = buildRegisterConnectorDto(
    { id: 'firecrawl', name: 'FireCrawl', type: 'credential_form', visibility: 'private' },
    { fields: [{ name: 'API_KEY', type: 'string', required: true }] },
  );
  assert.deepEqual(dto.config, { fields: [{ name: 'API_KEY', type: 'string', required: true }] });
  assert.ok(!('fields' in dto), 'must not send a top-level `fields` key - backend reads dto.config.fields, not dto.fields');
});

test('buildRegisterConnectorDto rejects a credential_form connector with no fields', () => {
  assert.throws(
    () => buildRegisterConnectorDto({ id: 'x', name: 'X', type: 'credential_form', visibility: 'private' }, { fields: [] }),
    /at least one field/,
  );
});

test('buildCreateTaskPayload sends `description`, not `content` - backend\'s create-task whitelist drops anything else silently', () => {
  const payload = buildCreateTaskPayload('Fix the login bug', 'ws1', { project: 'p1', assignee: 'u1' });
  assert.equal(payload.description, 'Fix the login bug');
  assert.ok(!('content' in payload), 'must not send `content` - TaskService._sanitizeCreateTaskInput whitelists `description` only');
  assert.equal(payload.workspace_id, 'ws1');
  assert.equal(payload.project_id, 'p1');
  assert.equal(payload.assign_id, 'u1');
});

test('buildCreateTaskPayload truncates the title to 80 chars but keeps the full text in description', () => {
  const longDescription = 'a'.repeat(120);
  const payload = buildCreateTaskPayload(longDescription, 'ws1', {});
  assert.equal(payload.title.length, 80);
  assert.equal(payload.description, longDescription);
});
