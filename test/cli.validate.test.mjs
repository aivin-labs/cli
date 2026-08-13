import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validatePluginConfig,
  incrementVersion,
  validateMcpProxyConfig,
  buildDeploymentPayload,
  buildMcpManifest,
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
