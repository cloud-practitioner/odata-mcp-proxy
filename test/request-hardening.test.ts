// Regression tests for the request-building hardening (fork scan F3, F4, F19):
//
//   F3  — a model-supplied path cannot escape its entity set via `..`/`%2e`,
//         and the built URL stays under the entity set's prefix.
//   F4  — disallowed headers are stripped from the outbound request while the
//         destination-supplied bearer is untouched.
//   F19 — a navigation segment is inserted before any query string.
//
// Each flaw is exercised at the shared helper level and through BOTH the static
// registry tools and the discovery executor, since both forward `path`/`headers`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseApiConfig } from '../src/config/api-config-schema.js';
import { resolveOperation } from '../src/config/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/server/mcp-server.js';
import { registerAllTools, type EntitySetDefinition } from '../src/tools/registry.js';
import { buildIndex, registerDiscoveryTools } from '../src/tools/discovery.js';
import { buildEntityPath, PathValidationError } from '../src/tools/path-guard.js';
import { sanitizeRequestHeaders } from '../src/client/odata-client.js';
import type { ODataClient } from '../src/client/odata-client.js';

// ─── F3 / F19: buildEntityPath unit coverage ─────────────────────────────────

const PREFIX = '/api/v1';
const NAV = ['Configurations'];

test('buildEntityPath keeps a query-only path under the entity-set prefix', () => {
  const full = buildEntityPath({ urlPath: 'Packages', pathPrefix: PREFIX, path: "?$filter=Name eq 'x'", navProperties: [] });
  assert.equal(full, "Packages?$filter=Name eq 'x'");
});

test('buildEntityPath rejects a traversal path (F3)', () => {
  assert.throws(
    () => buildEntityPath({ urlPath: 'Packages', pathPrefix: PREFIX, path: "/../Secrets('x')", navProperties: [] }),
    PathValidationError,
  );
});

test('buildEntityPath rejects encoded dot-dot (F3)', () => {
  assert.throws(
    () => buildEntityPath({ urlPath: 'Packages', pathPrefix: PREFIX, path: "('a')/%2e%2e/%2e%2e/Secrets", navProperties: [] }),
    PathValidationError,
  );
});

test('buildEntityPath rejects backslashes and fragments (F3)', () => {
  assert.throws(() => buildEntityPath({ urlPath: 'P', pathPrefix: PREFIX, path: '\\evil', navProperties: [] }), PathValidationError);
  assert.throws(() => buildEntityPath({ urlPath: 'P', pathPrefix: PREFIX, path: "('a')#frag", navProperties: [] }), PathValidationError);
});

test('buildEntityPath rejects a path that does not start with ( ? or / (F3)', () => {
  assert.throws(
    () => buildEntityPath({ urlPath: 'Packages', pathPrefix: PREFIX, path: 'OtherEntitySet', navProperties: [] }),
    PathValidationError,
  );
});

test('buildEntityPath allows navigation into a declared property (F3)', () => {
  const full = buildEntityPath({ urlPath: 'Packages', pathPrefix: PREFIX, path: '/Configurations', navProperties: NAV });
  assert.equal(full, 'Packages/Configurations');
});

test('buildEntityPath accepts a single REST key with or without query options', () => {
  for (const navProperties of [[], NAV]) {
    for (const path of ['/subaccountGUID', '/subaccountGUID?$select=Id']) {
      const full = buildEntityPath({ urlPath: 'subaccounts', pathPrefix: '/accounts/v1', path, navProperties });
      assert.equal(full, `subaccounts${path}`);
      assert.equal(new URL(`/accounts/v1/${full}`, 'https://backend.example').pathname, '/accounts/v1/subaccounts/subaccountGUID');
    }
  }
});

test('buildEntityPath rejects empty REST keys and further undeclared path segments', () => {
  for (const navProperties of [[], NAV]) {
    for (const path of ['/', '/?$top=1', '//seg', '/seg/more', '/seg/more?$top=1', '/seg/']) {
      assert.throws(
        () => buildEntityPath({ urlPath: 'Packages', pathPrefix: PREFIX, path, navProperties }),
        PathValidationError,
        path,
      );
    }
  }
});

test('buildEntityPath preserves declared navigation paths with keys and further segments', () => {
  const path = "/Configurations('k')/Values?$top=1";
  assert.equal(buildEntityPath({ urlPath: 'Packages', pathPrefix: PREFIX, path, navProperties: NAV }), `Packages${path}`);
});

test('buildEntityPath rejects controls in every suffix form before URL normalization', () => {
  const controls = [...Array.from({ length: 32 }, (_, i) => i), ...Array.from({ length: 33 }, (_, i) => i + 127)];
  for (const code of controls) {
    const control = String.fromCharCode(code);
    for (const path of ["('x')/." + control + './ProductsAdmin', `/subaccount${control}GUID`, `?$filter=Name eq '${control}'`, `/Configurations${control}`]) {
      assert.throws(
        () => buildEntityPath({ urlPath: 'Products', pathPrefix: PREFIX, path, navProperties: NAV }),
        PathValidationError,
        JSON.stringify(path),
      );
    }
  }
});

test('buildEntityPath rejects trailing spaces stripped by URL normalization', () => {
  for (const path of ["('x') ", '/subaccountGUID ', '?$top=1 ']) {
    assert.throws(
      () => buildEntityPath({ urlPath: 'Products', pathPrefix: PREFIX, path, navProperties: [] }),
      PathValidationError,
    );
  }
});

test('buildEntityPath rejects a normalized prefix collision even without a raw path traversal', () => {
  assert.throws(
    () => buildEntityPath({
      urlPath: 'Products',
      pathPrefix: PREFIX,
      path: "('x')",
      navProperty: '../ProductsAdmin',
      navProperties: ['../ProductsAdmin'],
    }),
    PathValidationError,
  );
});

test('buildEntityPath preserves exact, keyed and slash entity boundaries', () => {
  for (const path of ['', '?$top=1', "('x')", '/subaccountGUID', '/Configurations']) {
    assert.equal(buildEntityPath({ urlPath: 'Products', pathPrefix: PREFIX, path, navProperties: NAV }), `Products${path}`);
  }
});

test('buildEntityPath applies forbidden-token checks to REST keys and queries', () => {
  for (const path of ['/..', '/%2E%2e', '/seg\\more', '/seg#fragment', '/seg?query=..', '/seg?query=%2E', '/seg?query=\\value', '/seg?query=#fragment']) {
    assert.throws(
      () => buildEntityPath({ urlPath: 'subaccounts', pathPrefix: '/accounts/v1', path, navProperties: [] }),
      PathValidationError,
      path,
    );
  }
});

test('buildEntityPath inserts the nav segment before a query string (F19)', () => {
  const full = buildEntityPath({
    urlPath: 'Packages',
    pathPrefix: PREFIX,
    path: "('k')?$top=10",
    navProperty: 'Configurations',
    navProperties: NAV,
  });
  assert.equal(full, "Packages('k')/Configurations?$top=10", 'nav must come before the query string');
});

test('buildEntityPath appends the nav segment when there is no query string (F19)', () => {
  const full = buildEntityPath({
    urlPath: 'Packages',
    pathPrefix: PREFIX,
    path: "('k')",
    navProperty: 'Configurations',
    navProperties: NAV,
  });
  assert.equal(full, "Packages('k')/Configurations");
});

// ─── F4: header sanitisation unit coverage ───────────────────────────────────

test('sanitizeRequestHeaders strips Host, Authorization, Cookie, x-csrf-token, X-Forwarded-*, Proxy-* (F4)', () => {
  const safe = sanitizeRequestHeaders({
    Host: 'attacker.example',
    Authorization: 'Bearer stolen',
    Cookie: 'session=1',
    'x-csrf-token': 'forged',
    'X-Forwarded-Host': 'attacker.example',
    'Proxy-Authorization': 'Basic x',
    Accept: 'application/json',
  });
  assert.deepEqual(safe, { Accept: 'application/json' }, 'only the allowlisted header survives');
});

test('sanitizeRequestHeaders is case-insensitive for the forbidden set (F4)', () => {
  const safe = sanitizeRequestHeaders({ HOST: 'x', AUTHORIZATION: 'y', 'X-FORWARDED-FOR': 'z' });
  assert.deepEqual(safe, {});
});

test('sanitizeRequestHeaders keeps legitimate OData headers (F4)', () => {
  const headers = { 'If-Match': 'W/"1"', Prefer: 'return=minimal', 'Content-Type': 'application/json' };
  assert.deepEqual(sanitizeRequestHeaders(headers), headers);
});

test('sanitizeRequestHeaders drops anything not on the allowlist (F4)', () => {
  assert.deepEqual(sanitizeRequestHeaders({ 'X-Custom': '1', Accept: 'application/json' }), { Accept: 'application/json' });
});

// ─── Integration: both the registry tools and the discovery executor ─────────

interface Call { method: string; path: string; headers?: Record<string, string> }

/** A fake client whose pathPrefix mirrors a real API, recording forwarded calls. */
function fakeClient(calls: Call[], pathPrefix = PREFIX): ODataClient {
  return {
    pathPrefix,
    execute: async (method: string, path: string, _b?: unknown, headers?: Record<string, string>) => {
      calls.push({ method, path, headers });
      return { ok: true };
    },
  } as unknown as ODataClient;
}

const PACKAGES: EntitySetDefinition = {
  entitySet: 'Packages',
  description: 'integration packages',
  category: 'integration-content',
  keys: [{ name: 'Id', type: 'string' }],
  operations: { list: true, get: true, create: true, update: true, delete: true },
  navigationProperties: [{ name: 'Configurations', description: 'externalized parameters', isCollection: true }],
} as EntitySetDefinition;

async function connect(
  calls: Call[],
  definitions: Array<{ name: string; pathPrefix?: string; entitySets: EntitySetDefinition[] }> = [{ name: 'cpi', entitySets: [PACKAGES] }],
) {
  const apis = definitions.map((api) => ({ ...api, client: fakeClient(calls, api.pathPrefix) }));
  const server = createMcpServer('t', '1');
  for (const api of apis) registerAllTools(server, api.client, api.entitySets, ['all'], undefined, { xsappname: 'app' });
  registerDiscoveryTools(server, { discovery: { mode: 'hybrid' }, index: buildIndex(apis, ['all']), pinned: [], xsappname: 'app' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'c', version: '1' });
  await Promise.all([mcp.connect(ct), server.connect(st)]);
  return { mcp, server };
}

function result(r: { isError?: boolean; content: Array<{ text?: string }> }) {
  return r;
}

test('all registry and discovery routes block URL-normalized traversal into a higher-scoped prefix sibling', async () => {
  const calls: Call[] = [];
  const products: EntitySetDefinition = { ...PACKAGES, entitySet: 'Products' };
  const admin: EntitySetDefinition = {
    ...PACKAGES,
    entitySet: 'ProductsAdmin',
    operations: { list: { enabled: true, requiredScope: 'admin' } },
    navigationProperties: [],
  };
  const { mcp, server } = await connect(calls, [{ name: 'cpi', entitySets: [products, admin] }]);
  try {
    for (const discovery of [false, true]) {
      const denied = await mcp.callTool({
        name: discovery ? 'execute_operation' : 'ProductsAdmin_list',
        arguments: discovery ? { api: 'cpi', entitySet: 'ProductsAdmin', operation: 'list' } : {},
      });
      assert.equal(denied.isError, true);
      for (const control of ['\t', '\r', '\n']) {
        const path = `('x')/.${control}./ProductsAdmin`;
        assert.equal(new URL(`${PREFIX}/Products${path}`, 'https://backend.example').pathname, `${PREFIX}/ProductsAdmin`);
        for (const operation of ['list', 'get', 'create', 'update', 'delete'] as const) {
          const response = await mcp.callTool({
            name: discovery ? 'execute_operation' : `Products_${operation}`,
            arguments: {
              ...(discovery ? { api: 'cpi', entitySet: 'Products', operation } : {}),
              path,
              ...(['create', 'update'].includes(operation) ? { body: { Name: 'x' } } : {}),
            },
          });
          assert.equal(response.isError, true, `${discovery ? 'discovery' : 'registry'} ${operation}`);
        }
        const navResponse = await mcp.callTool({
          name: discovery ? 'execute_operation' : 'Products_Configurations_list',
          arguments: {
            ...(discovery ? { api: 'cpi', entitySet: 'Products', operation: 'get', navProperty: 'Configurations' } : {}),
            path,
          },
        });
        assert.equal(navResponse.isError, true);
      }
    }
    assert.equal(calls.length, 0, 'no path may reach the protected sibling through Products');
    for (const discovery of [false, true]) {
      for (const [operation, method] of [['list', 'GET'], ['get', 'GET'], ['create', 'POST'], ['update', 'PATCH'], ['delete', 'DELETE']]) {
        const response = await mcp.callTool({
          name: discovery ? 'execute_operation' : `Products_${operation}`,
          arguments: {
            ...(discovery ? { api: 'cpi', entitySet: 'Products', operation } : {}),
            path: "('x')",
            ...(['create', 'update'].includes(operation) ? { body: { Name: 'x' } } : {}),
          },
        });
        assert.notEqual(response.isError, true);
        assert.deepEqual(calls.at(-1), { method, path: "Products('x')", headers: undefined });
      }
    }
  } finally {
    await server.close();
  }
});

test('bundled REST keys are forwarded by registry and discovery CRUD without allowing further traversal', async () => {
  const config = parseApiConfig(JSON.parse(await readFile(new URL('../src/config/btp-admin-api-config.json', import.meta.url), 'utf8')), 'btp-admin-api-config.json');
  const calls: Call[] = [];
  const { mcp, server } = await connect(calls, config.apis);
  try {
    for (const api of config.apis) {
      for (const definition of api.entitySets) {
        if (!['Subaccounts', 'Directories', 'EnvironmentInstances'].includes(definition.entitySet)) continue;
        for (const operation of ['get', 'update', 'delete'] as const) {
          if (!resolveOperation(definition.operations[operation]).enabled) continue;
          const method = operation === 'get' ? 'GET' : operation === 'update' ? 'PATCH' : 'DELETE';
          for (const discovery of [false, true]) {
            for (const path of ['/entityGUID', '/entityGUID?$select=Id', '/seg/more', '/seg/more?$top=1']) {
              const before = calls.length;
              const response = await mcp.callTool({
                name: discovery ? 'execute_operation' : `${definition.entitySet}_${operation}`,
                arguments: {
                  ...(discovery ? { api: api.name, entitySet: definition.entitySet, operation } : {}),
                  path,
                  ...(operation === 'update' ? { body: { displayName: 'x' } } : {}),
                },
              });
              if (path.startsWith('/seg/')) {
                assert.equal(response.isError, true);
                assert.equal(calls.length, before);
              } else {
                assert.notEqual(response.isError, true);
                assert.equal(calls.length, before + 1);
                assert.deepEqual(calls.at(-1), { method, path: `${definition.urlPath}${path}`, headers: undefined });
                assert.equal(new URL(`${api.pathPrefix}/${calls.at(-1)!.path}`, 'https://backend.example').pathname, `${api.pathPrefix}/${definition.urlPath}/entityGUID`);
              }
            }
          }
        }
      }
    }
  } finally {
    await server.close();
  }
});

test('registry tool rejects a traversal path before reaching the backend (F3)', async () => {
  const calls: Call[] = [];
  const { mcp, server } = await connect(calls);
  const r = result(await mcp.callTool({ name: 'Packages_list', arguments: { path: "/../Secrets('x')" } }) as never);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text!, /navigation property|outside|may not/i);
  assert.equal(calls.length, 0, 'the unsafe path must never reach the OData client');
  await server.close();
});

test('discovery executor rejects an encoded dot-dot path (F3)', async () => {
  const calls: Call[] = [];
  const { mcp, server } = await connect(calls);
  const r = result(await mcp.callTool({
    name: 'execute_operation',
    arguments: { api: 'cpi', entitySet: 'Packages', operation: 'get', path: "('a')/%2e%2e/Secrets" },
  }) as never);
  assert.equal(r.isError, true);
  assert.equal(calls.length, 0);
  await server.close();
});

test('registry nav tool inserts the nav segment before the query string (F19)', async () => {
  const calls: Call[] = [];
  const { mcp, server } = await connect(calls);
  await mcp.callTool({ name: 'Packages_Configurations_list', arguments: { path: "('k')?$top=5" } });
  assert.equal(calls[0].path, "Packages('k')/Configurations?$top=5");
  await server.close();
});

test('discovery executor inserts the nav segment before the query string (F19)', async () => {
  const calls: Call[] = [];
  const { mcp, server } = await connect(calls);
  await mcp.callTool({
    name: 'execute_operation',
    arguments: { api: 'cpi', entitySet: 'Packages', operation: 'get', path: "('k')?$top=5", navProperty: 'Configurations' },
  });
  assert.equal(calls[0].path, "Packages('k')/Configurations?$top=5");
  await server.close();
});
