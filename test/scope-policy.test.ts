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
import { authorize, checkScope, registerAllTools, registerEntityTools, type EntitySetDefinition } from '../src/tools/registry.js';
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
function jwtWith(scopes: string[] | string): string {
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${part({ alg: 'none' })}.${part({ scope: scopes })}.sig`;
}

/** An unsigned JWT with an arbitrary payload (to exercise non-array scope claims). */
function jwtWithPayload(payload: Record<string, unknown>): string {
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${part({ alg: 'none' })}.${part(payload)}.sig`;
}

// ─── F18: scope matching ──────────────────────────────────────────────────────

test('checkScope with xsappname matches only the app-qualified scope (F18)', () => {
  const app = 'ci-mcp-server!t42';
  // A foreign app's `.read` must not satisfy our `read`.
  assert.throws(
    () => checkScope('read', jwtWith(['some-other-app!t99.read']), { xsappname: app }),
    /Forbidden: operation requires scope 'read'/,
  );
  // A built-in like `uaa.user` must not satisfy a bare `user` via suffix match.
  assert.throws(
    () => checkScope('user', jwtWith(['openid', 'uaa.user']), { xsappname: app }),
    /Forbidden: operation requires scope 'user'/,
  );
  // Our own qualified scope is accepted.
  assert.doesNotThrow(() => checkScope('read', jwtWith([`${app}.read`]), { xsappname: app }));
  assert.throws(() => checkScope('admin', jwtWith(['foreign-app.admin']), { xsappname: app }), /Forbidden/);
  assert.throws(() => checkScope('admin', jwtWith(['admin']), { xsappname: app }), /Forbidden/);
  assert.throws(() => checkScope('uaa.user', jwtWith(['uaa.user']), { xsappname: app }), /Forbidden/);
  assert.doesNotThrow(() => checkScope('uaa.user', jwtWith([`${app}.uaa.user`]), { xsappname: app }));
});

test('checkScope qualifies dotted local scope names for array and string claims', () => {
  for (const scope of [['app!t1.orders.read'], 'openid app!t1.orders.read']) {
    assert.doesNotThrow(() => checkScope('orders.read', jwtWith(scope), { xsappname: 'app!t1' }));
  }
  for (const scope of [['orders.read'], 'orders.read', ['foreign-app.orders.read']]) {
    assert.throws(() => checkScope('orders.read', jwtWith(scope), { xsappname: 'app!t1' }), /Forbidden/);
  }
});

test('checkScope handles a space-separated string scope claim (F18)', () => {
  const app = 'ci-mcp-server!t42';
  // A non-array `scope` claim must not throw "invalid token"; it is split on spaces.
  assert.doesNotThrow(() =>
    checkScope('read', jwtWithPayload({ scope: `openid ${app}.read` }), { xsappname: app }),
  );
  assert.throws(
    () => checkScope('write', jwtWithPayload({ scope: `openid ${app}.read` }), { xsappname: app }),
    /Forbidden: operation requires scope 'write'/,
  );
  assert.throws(
    () => checkScope('admin', jwtWithPayload({ scope: 'foreign-app.admin' }), { xsappname: app }),
    /Forbidden/,
  );
  assert.throws(
    () => checkScope('user', jwtWithPayload({ scope: 'openid uaa.user' }), { xsappname: app }),
    /Forbidden/,
  );
});

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

test('enforcing entry points reject missing application context', async () => {
  const calls: string[] = [];
  const client = fakeClient(calls);
  const index = buildIndex([{ name: 'cpi', client, entitySets: [PACKAGES] }], ['all']);
  const { mcp, server } = await connect((s) => {
    for (const options of [{}, { enforceScopes: true }, { xsappname: '' }, { xsappname: '  ' }]) {
      for (const [scope, token] of [
        ['admin', jwtWith(['foreign-app.admin'])],
        ['user', jwtWith(['uaa.user'])],
        [undefined, undefined],
      ] as const) {
        assert.throws(() => checkScope(scope, token, options), /Scope enforcement requires a non-empty xsappname/);
        assert.throws(() => authorize(scope, token, options), /Scope enforcement requires a non-empty xsappname/);
      }
      assert.throws(() => registerEntityTools(s, client, PACKAGES, options), /Scope enforcement requires a non-empty xsappname/);
      for (const definitions of [[PACKAGES], []]) {
        assert.throws(() => registerAllTools(s, client, definitions, ['all'], undefined, options), /Scope enforcement requires a non-empty xsappname/);
      }
      assert.throws(() => registerDiscoveryTools(s, {
        discovery: { mode: 'search' }, index, pinned: [], ...options,
      }), /Scope enforcement requires a non-empty xsappname/);
    }
  });
  await assert.rejects(() => mcp.listTools(), { code: -32601 });
  assert.deepEqual(calls, []);
  await server.close();
});

test('registerAllTools with application context rejects a tokenless scoped call', async () => {
  const calls: string[] = [];
  const { mcp, server } = await connect((s) =>
    registerAllTools(s, fakeClient(calls), [PACKAGES], ['all'], undefined, { xsappname: 'app' }));

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
  const options = { xsappname: 'app' };
  assert.throws(() => authorize('read', jwtWith(['app.write']), options), /Forbidden: operation requires scope 'read'/);
  assert.doesNotThrow(() => authorize('read', jwtWith(['app.read']), options));
  assert.throws(() => authorize('read', undefined, options), /Unauthorized: no token provided/);
  assert.throws(() => authorize('read', undefined, { ...options, enforceScopes: true }), /Unauthorized/);
  assert.doesNotThrow(() => authorize('read', undefined, { enforceScopes: false }));
  assert.doesNotThrow(() => authorize('orders.read', 'invalid', { enforceScopes: false, xsappname: '' }));
  const disabled = { enforceScopes: false, xsappname: undefined };
  assert.throws(() => checkScope('admin', jwtWith(['undefined.admin']), disabled), /Scope enforcement requires a non-empty xsappname/);
  assert.doesNotThrow(() => authorize(undefined, undefined, options));
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

test('CRUD, navigation and discovery share exact app-local scope matching', async () => {
  for (const requiredScope of ['admin', 'user', 'orders.read']) {
    const scoped = { enabled: true, requiredScope };
    const definition: EntitySetDefinition = {
      ...PACKAGES,
      operations: { list: scoped, get: scoped, create: scoped, update: scoped, delete: scoped },
    };
    const attempts: Array<[string, Record<string, unknown>]> = [];
    for (const operation of ['list', 'get', 'create', 'update', 'delete']) {
      const args = { path: "('P')", body: { Id: 'P' } };
      attempts.push([`IntegrationPackages_${operation}`, args]);
      attempts.push(['execute_operation', { api: 'cpi', entitySet: 'IntegrationPackages', operation, ...args }]);
    }
    attempts.push(['IntegrationPackages_IntegrationDesigntimeArtifacts_list', { path: "('P')" }]);
    for (const operation of ['list', 'get']) {
      attempts.push(['execute_operation', {
        api: 'cpi', entitySet: 'IntegrationPackages', operation,
        path: "('P')", navProperty: 'IntegrationDesigntimeArtifacts',
      }]);
    }
    for (const stringClaim of [false, true]) {
      for (const [scope, allowed] of [
        [`foreign-app.${requiredScope}`, false],
        [requiredScope === 'user' ? 'uaa.user' : requiredScope, false],
        [`app!t1.${requiredScope}`, true],
      ] as const) {
        const calls: string[] = [];
        const client = fakeClient(calls);
        const token = jwtWith(stringClaim ? `openid ${scope}` : ['openid', scope]);
        const { mcp, server } = await connect((s) => {
          registerAllTools(s, client, [definition], ['all'], undefined, { xsappname: 'app!t1' });
          registerDiscoveryTools(s, {
            discovery: { mode: 'search' },
            index: buildIndex([{ name: 'cpi', client, entitySets: [definition] }], ['all']),
            pinned: [], xsappname: 'app!t1',
          });
        }, token);
        try {
          for (const [name, args] of attempts) {
            calls.length = 0;
            const result = await mcp.callTool({ name, arguments: args }) as Result;
            assert.equal(!result.isError, allowed, `${name}: ${scope}: ${result.content[0].text}`);
            assert.equal(calls.length, allowed ? 1 : 0, `${name}: backend access`);
            if (!allowed) assert.match(result.content[0].text!, /Forbidden/);
          }
        } finally {
          await server.close();
        }
      }
    }
  }
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
    registerAllTools(s, client, [def], ['all'], undefined, { enforceScopes: true, xsappname: 'app' });
    registerDiscoveryTools(s, { discovery: { mode: 'search' }, index, pinned: [], enforceScopes: true, xsappname: 'app' });
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
  return { allowed };
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
    registerAllTools(s, fakeClient([]), [PACKAGES], ['all'], undefined, { enforceScopes: true, xsappname: 'app' }),
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
    registerAllTools(s, fakeClient([]), [def], ['all'], undefined, { enforceScopes: true, xsappname: 'app' }),
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

test('without an enabled read operation the navigation tool is refused only when enforcing', async () => {
  for (const def of [
    packagesWith({ list: false, get: false, create: { enabled: true, requiredScope: 'write' } }),
    packagesWith({ get: true, create: true }, false),
  ]) {
    const calls: string[] = [];
    const open = await connect((s) =>
      registerAllTools(s, fakeClient(calls), [def], ['all'], undefined, { enforceScopes: false }));
    const allowed = await open.mcp.callTool({ name: NAV_TOOL, arguments: { path: "('P')" } }) as Result;
    assert.ok(!allowed.isError, allowed.content[0].text);
    assert.deepEqual(calls, [NAV_URL]);
    await open.server.close();

    for (const token of [jwtWith(['app.write', 'app.read']), undefined]) {
      const enforced = await connect((s) =>
        registerAllTools(s, fakeClient(calls), [def], ['all'], undefined, { enforceScopes: true, xsappname: 'app' }), token);
      const refused = await enforced.mcp.callTool({ name: NAV_TOOL, arguments: { path: "('P')" } }) as Result;
      assert.equal(refused.isError, true);
      assert.match(refused.content[0].text!, /Forbidden: no enabled read operation grants this call/);
      await enforced.server.close();
    }
    assert.deepEqual(calls, [NAV_URL], 'a refused navigation call must not reach the backend');
  }
});
