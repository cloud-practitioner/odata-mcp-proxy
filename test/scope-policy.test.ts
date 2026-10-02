// Unit coverage of the `requiredScope` policy on the generated tools and the
// discovery executor: enforcement is the default for programmatic callers,
// `enforceScopes: false` lets tokenless calls through, and navigation tools
// enforce the scope of their parent's read operations (list, or get on a keyed
// entity set — either one suffices), so they grant exactly what `_list`/`_get`
// with the navigation path and `execute_operation` grant.
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

/**
 * Connect a client to a server set up by `register`. With `token`, every
 * request carries it as authInfo, as the HTTP transport does for an
 * XSUAA-authenticated caller.
 */
async function connect(register: (server: McpServer) => void, token?: string) {
  const server = createMcpServer('test', '1.0.0');
  register(server);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  if (token) {
    const send = ct.send.bind(ct);
    ct.send = (message, options) =>
      send(message, { ...options, authInfo: { token, clientId: 'c', scopes: [] } });
  }
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
  assert.equal(nav.isError, true);
  assert.match(nav.content[0].text!, /Unauthorized: no token provided/);
  assert.deepEqual(calls, [], 'navigation tools are scoped like the parent read operations');
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

// ─── Navigation tools ────────────────────────────────────────────────────────

const NAV_TOOL = 'IntegrationPackages_IntegrationDesigntimeArtifacts_list';
const NAV_URL = "GET IntegrationPackages('P')/IntegrationDesigntimeArtifacts";

/** PACKAGES with the given list/get operations. */
function packagesWith(operations: EntitySetDefinition['operations'], keyed = true): EntitySetDefinition {
  return { ...PACKAGES, keys: keyed ? PACKAGES.keys : [], operations };
}

/**
 * Call the navigation tool and every equivalent read path (`_list` and `_get`
 * with the navigation in `path`, `execute_operation` list/get with
 * `navProperty`) with one token, and return which of them were allowed.
 */
async function navigationDecisions(def: EntitySetDefinition, token: string) {
  const calls: string[] = [];
  const client = fakeClient(calls);
  const index = buildIndex([{ name: 'cpi', client, entitySets: [def] }], ['all']);
  const { mcp, server } = await connect((s) => {
    registerAllTools(s, client, [def], ['all'], undefined, { enforceScopes: true });
    registerDiscoveryTools(s, { discovery: { mode: 'search' }, index, pinned: [], enforceScopes: true });
  }, token);
  const { tools } = await mcp.listTools();
  const names = new Set(tools.map((t) => t.name));

  const attempts: Array<[string, string, Record<string, unknown>]> = [
    ['nav tool', NAV_TOOL, { path: "('P')" }],
    ['_list', 'IntegrationPackages_list', { path: "('P')/IntegrationDesigntimeArtifacts" }],
    ['_get', 'IntegrationPackages_get', { path: "('P')/IntegrationDesigntimeArtifacts" }],
  ];
  for (const operation of ['list', 'get']) {
    if (index[0]?.available.includes(operation as never)) {
      attempts.push([`execute_operation ${operation}`, 'execute_operation', {
        api: 'cpi', entitySet: 'IntegrationPackages', operation,
        path: "('P')", navProperty: 'IntegrationDesigntimeArtifacts',
      }]);
    }
  }

  const allowed: Record<string, boolean> = {};
  for (const [label, name, args] of attempts) {
    if (!names.has(name)) continue;
    calls.length = 0;
    const result = await mcp.callTool({ name, arguments: args }) as Result;
    allowed[label] = !result.isError;
    if (result.isError) {
      assert.match(result.content[0].text!, /^Error: (Forbidden|Unauthorized)/, `${label}: ${result.content[0].text}`);
      assert.deepEqual(calls, [], `${label}: a refused call must not reach the backend`);
    } else {
      assert.deepEqual(calls, [NAV_URL], label);
    }
  }
  await server.close();
  return { allowed, registered: names.has(NAV_TOOL) };
}

test('XSUAA: the navigation tool refuses a token without the read scope', async () => {
  const { allowed } = await navigationDecisions(PACKAGES, jwtWith(['app.write']));
  assert.deepEqual(allowed, {
    'nav tool': false, _list: false, _get: false,
    'execute_operation list': false, 'execute_operation get': false,
  });
});

test('XSUAA: the navigation tool allows a token with the read scope', async () => {
  const { allowed } = await navigationDecisions(PACKAGES, jwtWith(['app.read']));
  assert.deepEqual(allowed, {
    'nav tool': true, _list: true, _get: true,
    'execute_operation list': true, 'execute_operation get': true,
  });
});

test('XSUAA: the navigation tool reports the missing scope', async () => {
  const { mcp, server } = await connect((s) =>
    registerAllTools(s, fakeClient([]), [PACKAGES], ['all'], undefined, { enforceScopes: true }),
  jwtWith(['app.write']));
  const nav = await mcp.callTool({ name: NAV_TOOL, arguments: { path: "('P')" } }) as Result;
  assert.equal(nav.isError, true);
  assert.match(nav.content[0].text!, /Forbidden: operation requires scope 'read'/);
  await server.close();
});

test('XSUAA: list and get with different scopes — either scope reaches the navigation', async () => {
  const def = packagesWith({
    list: { enabled: true, requiredScope: 'read' },
    get: { enabled: true, requiredScope: 'audit' },
  });

  const listOnly = await navigationDecisions(def, jwtWith(['app.read']));
  assert.deepEqual(listOnly.allowed, {
    'nav tool': true, _list: true, _get: false,
    'execute_operation list': true, 'execute_operation get': false,
  });

  const getOnly = await navigationDecisions(def, jwtWith(['app.audit']));
  assert.deepEqual(getOnly.allowed, {
    'nav tool': true, _list: false, _get: true,
    'execute_operation list': false, 'execute_operation get': true,
  });

  const neither = await navigationDecisions(def, jwtWith(['app.write']));
  assert.deepEqual(neither.allowed, {
    'nav tool': false, _list: false, _get: false,
    'execute_operation list': false, 'execute_operation get': false,
  });

  const { mcp, server } = await connect((s) =>
    registerAllTools(s, fakeClient([]), [def], ['all'], undefined, { enforceScopes: true }),
  jwtWith(['app.write']));
  const nav = await mcp.callTool({ name: NAV_TOOL, arguments: { path: "('P')" } }) as Result;
  assert.match(nav.content[0].text!, /Forbidden: operation requires one of the scopes 'read', 'audit'/);
  await server.close();
});

test('XSUAA: an unscoped read operation leaves the navigation unscoped', async () => {
  const def = packagesWith({ list: { enabled: true, requiredScope: 'read' }, get: true });
  const { allowed } = await navigationDecisions(def, jwtWith(['app.write']));
  assert.deepEqual(allowed, {
    'nav tool': true, _list: false, _get: true,
    'execute_operation list': false, 'execute_operation get': true,
  });
});

test('XSUAA: a disabled read operation does not grant the navigation', async () => {
  const def = packagesWith({
    list: { enabled: false, requiredScope: 'other' },
    get: { enabled: true, requiredScope: 'read' },
  });
  const other = await navigationDecisions(def, jwtWith(['app.other']));
  assert.deepEqual(other.allowed, { 'nav tool': false, _get: false, 'execute_operation get': false });
  const read = await navigationDecisions(def, jwtWith(['app.read']));
  assert.deepEqual(read.allowed, { 'nav tool': true, _get: true, 'execute_operation get': true });
});

test('XSUAA: get on a keyless entity set does not grant the navigation', async () => {
  const def = packagesWith({
    list: { enabled: true, requiredScope: 'read' },
    get: { enabled: true, requiredScope: 'audit' },
  }, false);
  const { allowed } = await navigationDecisions(def, jwtWith(['app.audit']));
  assert.deepEqual(allowed, { 'nav tool': false, _list: false, 'execute_operation list': false });
});

test('navigation tools are not registered without an enabled read operation', async () => {
  for (const def of [
    packagesWith({ list: false, get: false, create: { enabled: true, requiredScope: 'write' } }),
    packagesWith({ get: true, create: true }, false),
  ]) {
    const { mcp, server } = await connect((s) =>
      registerAllTools(s, fakeClient([]), [def], ['all'], undefined, { enforceScopes: false }));
    const { tools } = await mcp.listTools();
    assert.ok(!tools.some((t) => t.name === NAV_TOOL), tools.map((t) => t.name).join(', '));
    assert.ok(tools.some((t) => t.name === 'IntegrationPackages_create'));
    await server.close();
  }
});
