// Unit coverage of the `requiredScope` policy on the generated tools and the
// discovery executor: enforcement is the default for programmatic callers,
// `enforceScopes: false` lets tokenless calls through, and navigation tools
// stay unscoped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpServer } from '../src/server/mcp-server.js';
import { authorize, registerAllTools, type EntitySetDefinition } from '../src/tools/registry.js';
import { buildIndex, registerDiscoveryTools } from '../src/tools/discovery.js';
import type { ODataClient } from '../src/client/odata-client.js';

const PACKAGES: EntitySetDefinition = {
  entitySet: 'IntegrationPackages',
  description: 'integration packages',
  category: 'integration-content',
  keys: [{ name: 'Id', type: 'string' }],
  operations: {
    list: { enabled: true, requiredScope: 'read' },
    get: { enabled: true, requiredScope: 'read' },
    create: { enabled: true, requiredScope: 'write' },
    update: false,
    delete: false,
  },
  navigationProperties: [{ name: 'IntegrationDesigntimeArtifacts', description: 'artifacts', isCollection: true }],
} as EntitySetDefinition;

function fakeClient(calls: string[]): ODataClient {
  return {
    execute: async (method: string, path: string) => {
      calls.push(`${method} ${path}`);
      return { ok: true };
    },
  } as unknown as ODataClient;
}

/** An unsigned JWT carrying the given scopes; checkScope only decodes the payload. */
function jwtWith(scopes: string[]): string {
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${part({ alg: 'none' })}.${part({ scope: scopes })}.sig`;
}

async function connect(register: (server: McpServer) => void) {
  const server = createMcpServer('test', '1.0.0');
  register(server);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'c', version: '1' });
  await Promise.all([mcp.connect(ct), server.connect(st)]);
  return { mcp, server };
}

type Result = { isError?: boolean; content: Array<{ type: string; text?: string }> };

test('registerAllTools without scope options still rejects a tokenless scoped call', async () => {
  const calls: string[] = [];
  const { mcp, server } = await connect((s) =>
    registerAllTools(s, fakeClient(calls), [PACKAGES], ['all']));

  const list = await mcp.callTool({ name: 'IntegrationPackages_list', arguments: {} }) as Result;
  assert.equal(list.isError, true);
  assert.match(list.content[0].text!, /Unauthorized: no token provided/);
  assert.deepEqual(calls, [], 'scope check must precede the backend call');

  const nav = await mcp.callTool({
    name: 'IntegrationPackages_IntegrationDesigntimeArtifacts_list',
    arguments: { path: "('P')" },
  }) as Result;
  assert.ok(!nav.isError, nav.content[0].text);
  assert.deepEqual(calls, ["GET IntegrationPackages('P')/IntegrationDesigntimeArtifacts"]);
  await server.close();
});

test('enforceScopes: false lets tokenless scoped calls reach the backend', async () => {
  const calls: string[] = [];
  const { mcp, server } = await connect((s) =>
    registerAllTools(s, fakeClient(calls), [PACKAGES], ['all'], undefined, { enforceScopes: false }));

  for (const [name, args] of [
    ['IntegrationPackages_list', {}],
    ['IntegrationPackages_create', { body: { Id: 'P' } }],
    ['IntegrationPackages_IntegrationDesigntimeArtifacts_list', { path: "('P')" }],
  ] as const) {
    const result = await mcp.callTool({ name, arguments: args }) as Result;
    assert.ok(!result.isError, `${name}: ${result.content[0].text}`);
  }
  assert.deepEqual(calls, [
    'GET IntegrationPackages',
    'POST IntegrationPackages',
    "GET IntegrationPackages('P')/IntegrationDesigntimeArtifacts",
  ]);
  await server.close();
});

test('authorize enforces by default and checks the token scopes', () => {
  assert.throws(() => authorize('read', jwtWith(['app.write'])), /Forbidden: operation requires scope 'read'/);
  assert.doesNotThrow(() => authorize('read', jwtWith(['app.read'])));
  assert.throws(() => authorize('read', undefined), /Unauthorized: no token provided/);
  assert.throws(() => authorize('read', undefined, { enforceScopes: true }), /Unauthorized/);
  assert.doesNotThrow(() => authorize('read', undefined, { enforceScopes: false }));
  assert.doesNotThrow(() => authorize(undefined, undefined));
});

test('discovery executor honours enforceScopes: false', async () => {
  const calls: string[] = [];
  const client = fakeClient(calls);
  const index = buildIndex([{ name: 'cpi', client, entitySets: [PACKAGES] }], ['all']);
  const { mcp, server } = await connect((s) =>
    registerDiscoveryTools(s, { discovery: { mode: 'search' }, index, pinned: [], enforceScopes: false }));

  const result = await mcp.callTool({
    name: 'execute_operation',
    arguments: { api: 'cpi', entitySet: 'IntegrationPackages', operation: 'create', body: { Id: 'P' } },
  }) as Result;
  assert.ok(!result.isError, result.content[0].text);
  assert.deepEqual(calls, ['POST IntegrationPackages']);
  await server.close();
});
