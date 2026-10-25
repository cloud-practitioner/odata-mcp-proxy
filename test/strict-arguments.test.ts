// Tool schemas advertise `additionalProperties: false`, so the runtime must
// match: an unknown top-level argument (for example `{"$top": 1}`, which looks
// like an OData query option but is not a tool parameter) fails the call with a
// tool error naming the key, and never reaches the backend. Before this, the
// SDK silently dropped the key and the call ran without it.
//
// Covers the generated per-entity tools, navigation tools, the discovery
// tools (search_operations, execute_operation) and UI view tools, in-process
// and over the built stdio server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createMcpServer } from '../src/server/mcp-server.js';
import { registerAllTools, type EntitySetDefinition } from '../src/tools/registry.js';
import { buildIndex, registerDiscoveryTools } from '../src/tools/discovery.js';
import { registerUiTools } from '../src/ui/register.js';
import { clearTemplateCache } from '../src/ui/templates.js';
import type { ODataClient } from '../src/client/odata-client.js';
import type { UiViewDefinition } from '../src/config/index.js';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = join(rootDir, 'test', 'fixtures');

const PACKAGES: EntitySetDefinition = {
  entitySet: 'IntegrationPackages',
  description: 'integration packages',
  category: 'integration-content',
  keys: [{ name: 'Id', type: 'string' }],
  operations: { list: true, get: true, create: true, update: true, delete: true },
  navigationProperties: [{ name: 'IntegrationDesigntimeArtifacts', description: 'artifacts', isCollection: true }],
} as EntitySetDefinition;

const VIEW: UiViewDefinition = {
  tool: 'UI_Hello',
  description: 'Interactive hello view',
  uri: 'ui://test/hello',
  template: 'ui/hello.html',
  inputs: { who: { type: 'string', required: true, description: 'Who to greet' } },
  data: { items: { api: 'cpi', path: 'items?who={who}' } },
  partials: { '/*__STYLE__*/': 'ui/style.css' },
};

type Result = { isError?: boolean; content: Array<{ type: string; text?: string }> };

async function connect(calls: string[]) {
  clearTemplateCache();
  const client = {
    execute: async (method: string, path: string) => {
      calls.push(`${method} ${path}`);
      return { ok: true };
    },
  } as unknown as ODataClient;
  const server = createMcpServer('test', '1.0.0');
  registerAllTools(server, client, [PACKAGES], ['all'], undefined, { enforceScopes: false });
  registerDiscoveryTools(server, {
    discovery: { mode: 'hybrid' },
    index: buildIndex([{ name: 'cpi', client, entitySets: [PACKAGES] }], ['all']),
    pinned: [],
    enforceScopes: false,
  });
  registerUiTools(server, {
    views: [VIEW], clientsByApi: { cpi: client }, baseDir: fixturesDir, scopeOptions: { enforceScopes: false },
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'c', version: '1' });
  await Promise.all([mcp.connect(ct), server.connect(st)]);
  return { mcp, server };
}

const GENERATED = [
  'IntegrationPackages_list',
  'IntegrationPackages_get',
  'IntegrationPackages_create',
  'IntegrationPackages_update',
  'IntegrationPackages_delete',
  'IntegrationPackages_IntegrationDesigntimeArtifacts_list',
];

/** Valid arguments for each tool, to prove a call without the unknown key works. */
const VALID: Record<string, Record<string, unknown>> = {
  IntegrationPackages_list: {},
  IntegrationPackages_get: { path: "('P')" },
  IntegrationPackages_create: { body: { Id: 'P' } },
  IntegrationPackages_update: { path: "('P')", body: { Name: 'N' } },
  IntegrationPackages_delete: { path: "('P')" },
  IntegrationPackages_IntegrationDesigntimeArtifacts_list: { path: "('P')" },
  search_operations: { query: 'packages' },
  execute_operation: { api: 'cpi', entitySet: 'IntegrationPackages', operation: 'list' },
  UI_Hello: { who: 'World' },
};

test('every tool advertises additionalProperties:false', async () => {
  const { mcp, server } = await connect([]);
  const { tools } = await mcp.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), Object.keys(VALID).sort());
  for (const tool of tools) {
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
  }
  await server.close();
});

test('every tool rejects an unknown top-level argument and names the key', async () => {
  const calls: string[] = [];
  const { mcp, server } = await connect(calls);
  try {
    for (const [name, valid] of Object.entries(VALID)) {
      calls.length = 0;
      for (const unknown of [{ $top: 1 }, { top: 5 }]) {
        const result = (await mcp.callTool({ name, arguments: { ...valid, ...unknown } })) as Result;
        const key = Object.keys(unknown)[0];
        assert.equal(result.isError, true, `${name} must reject "${key}"`);
        const text = result.content[0].text ?? '';
        assert.match(text, /Unrecognized key/i, `${name}: ${text}`);
        assert.ok(text.includes(`"${key}"`), `${name} must name the key "${key}": ${text}`);
      }
      assert.deepEqual(calls, [], `${name}: a rejected call must not reach the backend`);
    }
  } finally {
    await server.close();
  }
});

test('every tool still accepts its documented arguments', async () => {
  const calls: string[] = [];
  const { mcp, server } = await connect(calls);
  try {
    for (const [name, valid] of Object.entries(VALID)) {
      const result = (await mcp.callTool({ name, arguments: valid })) as Result;
      assert.ok(!result.isError, `${name}: ${result.content[0].text}`);
    }
    for (const name of GENERATED) {
      const result = (await mcp.callTool({ name, arguments: { ...VALID[name], headers: { 'x-test': '1' } } })) as Result;
      assert.ok(!result.isError, `${name} with headers: ${result.content[0].text}`);
    }
  } finally {
    await server.close();
  }
});

test('the stdio server rejects {"$top":1} on a list tool and never calls the backend', async () => {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    MCP_TRANSPORT: 'stdio',
    API_CONFIG_FILE: join(fixturesDir, 'read-only-config.json'),
    LOG_LEVEL: 'error',
  };
  delete env.VCAP_SERVICES;
  // No destination credentials exist: a call that got past validation would
  // fail with a destination error instead of the validation error asserted here.
  const client = new Client({ name: 'strict-arguments', version: '0.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(rootDir, 'dist', 'index.js')], cwd: rootDir, env }));
  try {
    const result = (await client.callTool({ name: 'Packages_list', arguments: { $top: 1 } })) as Result;
    assert.equal(result.isError, true);
    const text = result.content[0].text ?? '';
    assert.match(text, /Invalid arguments for tool Packages_list/);
    assert.match(text, /Unrecognized key\(s\) in object: '\$top'/);
  } finally {
    await client.close();
  }
});
