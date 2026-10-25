// Per-operation scope coverage. Every operation of the entity set carries its
// own distinct `requiredScope`, so a mix-up inside the registry or the
// discovery executor (for example `_delete` checking the update scope) fails a
// test. The other scope tests use one scope on every operation, which cannot
// detect such a mix-up.
//
// Each CRUD tool and `execute_operation` must:
//   - accept a token holding exactly the scope of its own operation, and
//   - refuse a token holding only the scope of any other operation, without
//     reaching the backend.
//
// A second case uses ci-mcp-server's policy (list/get = read, create/update =
// write, delete = admin): an editor (read + write) must not delete.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpServer } from '../src/server/mcp-server.js';
import { registerAllTools, type EntitySetDefinition } from '../src/tools/registry.js';
import { buildIndex, registerDiscoveryTools } from '../src/tools/discovery.js';
import type { ODataClient } from '../src/client/odata-client.js';

const APP = 'app!t1';
const OPERATIONS = ['list', 'get', 'create', 'update', 'delete'] as const;
type Operation = (typeof OPERATIONS)[number];

const METHOD: Record<Operation, string> = {
  list: 'GET', get: 'GET', create: 'POST', update: 'PATCH', delete: 'DELETE',
};

/** Arguments that satisfy every validation of the named tool and the executor. */
const ARGS: Record<Operation, { path?: string; body?: Record<string, unknown> }> = {
  list: {},
  get: { path: "('P')" },
  create: { body: { Id: 'P' } },
  update: { path: "('P')", body: { Name: 'N' } },
  delete: { path: "('P')" },
};

function definition(scopes: Record<Operation, string>): EntitySetDefinition {
  const operations = Object.fromEntries(
    OPERATIONS.map((op) => [op, { enabled: true, requiredScope: scopes[op] }]),
  );
  return {
    entitySet: 'IntegrationPackages',
    description: 'integration packages',
    category: 'integration-content',
    keys: [{ name: 'Id', type: 'string' }],
    operations,
  } as EntitySetDefinition;
}

function fakeClient(calls: string[]): ODataClient {
  return {
    execute: async (method: string, path: string) => {
      calls.push(`${method} ${path}`);
      return { ok: true };
    },
  } as unknown as ODataClient;
}

/** An unsigned JWT carrying the given app-qualified scopes; only the payload is decoded. */
function jwtWith(scopes: string[]): string {
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${part({ alg: 'none' })}.${part({ scope: scopes.map((s) => `${APP}.${s}`) })}.sig`;
}

type Result = { isError?: boolean; content: Array<{ type: string; text?: string }> };

async function connect(def: EntitySetDefinition, calls: string[], token: string) {
  const client = fakeClient(calls);
  const server: McpServer = createMcpServer('test', '1.0.0');
  registerAllTools(server, client, [def], ['all'], undefined, { xsappname: APP });
  registerDiscoveryTools(server, {
    discovery: { mode: 'search' },
    index: buildIndex([{ name: 'cpi', client, entitySets: [def] }], ['all']),
    pinned: [],
    xsappname: APP,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const send = ct.send.bind(ct);
  ct.send = (message, options) => send(message, { ...options, authInfo: { token, clientId: 'c', scopes: [] } });
  const mcp = new Client({ name: 'c', version: '1' });
  await Promise.all([mcp.connect(ct), server.connect(st)]);
  return { mcp, server };
}

/** Both entry points of one operation: the generated tool and the discovery executor. */
function entryPoints(op: Operation): Array<[string, Record<string, unknown>]> {
  return [
    [`IntegrationPackages_${op}`, { ...ARGS[op] }],
    ['execute_operation', { api: 'cpi', entitySet: 'IntegrationPackages', operation: op, ...ARGS[op] }],
  ];
}

function expectedCall(op: Operation): string {
  const suffix = ARGS[op].path ?? '';
  return `${METHOD[op]} IntegrationPackages${suffix}`;
}

test('each operation requires its own scope on the CRUD tool and on execute_operation', async () => {
  const scopes = { list: 'sc_list', get: 'sc_get', create: 'sc_create', update: 'sc_update', delete: 'sc_delete' };
  const def = definition(scopes);

  for (const held of OPERATIONS) {
    const calls: string[] = [];
    const { mcp, server } = await connect(def, calls, jwtWith([scopes[held]]));
    try {
      for (const op of OPERATIONS) {
        for (const [name, args] of entryPoints(op)) {
          calls.length = 0;
          const result = (await mcp.callTool({ name, arguments: args })) as Result;
          const label = `${name} (${op}) with only the ${held} scope`;
          if (op === held) {
            assert.ok(!result.isError, `${label}: ${result.content[0].text}`);
            assert.deepEqual(calls, [expectedCall(op)], label);
          } else {
            assert.equal(result.isError, true, `${label} must be refused`);
            assert.match(result.content[0].text!, new RegExp(`Forbidden: operation requires scope '${scopes[op]}'`), label);
            assert.deepEqual(calls, [], `${label} must not reach the backend`);
          }
        }
      }
    } finally {
      await server.close();
    }
  }
});

test('with ci-mcp-server policy an editor can write but not delete, an admin can delete', async () => {
  const def = definition({ list: 'read', get: 'read', create: 'write', update: 'write', delete: 'admin' });
  const cases: Array<[string, string[], Record<Operation, boolean>]> = [
    ['viewer', ['read'], { list: true, get: true, create: false, update: false, delete: false }],
    ['editor', ['read', 'write'], { list: true, get: true, create: true, update: true, delete: false }],
    ['admin only', ['admin'], { list: false, get: false, create: false, update: false, delete: true }],
    ['everything', ['read', 'write', 'admin'], { list: true, get: true, create: true, update: true, delete: true }],
  ];

  for (const [role, scopes, allowed] of cases) {
    const calls: string[] = [];
    const { mcp, server } = await connect(def, calls, jwtWith(scopes));
    try {
      for (const op of OPERATIONS) {
        for (const [name, args] of entryPoints(op)) {
          calls.length = 0;
          const result = (await mcp.callTool({ name, arguments: args })) as Result;
          assert.equal(!result.isError, allowed[op], `${role}: ${name} (${op}): ${result.content[0].text}`);
          assert.deepEqual(calls, allowed[op] ? [expectedCall(op)] : [], `${role}: ${name} (${op}) backend access`);
        }
      }
    } finally {
      await server.close();
    }
  }
});
