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

test('buildEntityPath rejects a path that does not start with ( ? or /nav (F3)', () => {
  assert.throws(
    () => buildEntityPath({ urlPath: 'Packages', pathPrefix: PREFIX, path: 'OtherEntitySet', navProperties: [] }),
    PathValidationError,
  );
});

test('buildEntityPath allows navigation into a declared property (F3)', () => {
  const full = buildEntityPath({ urlPath: 'Packages', pathPrefix: PREFIX, path: '/Configurations', navProperties: NAV });
  assert.equal(full, 'Packages/Configurations');
});

test('buildEntityPath rejects navigation into an undeclared property (F3)', () => {
  assert.throws(
    () => buildEntityPath({ urlPath: 'Packages', pathPrefix: PREFIX, path: '/Secrets', navProperties: NAV }),
    PathValidationError,
  );
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
function fakeClient(calls: Call[]): ODataClient {
  return {
    pathPrefix: PREFIX,
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

async function connect(calls: Call[]) {
  const client = fakeClient(calls);
  const apis = [{ name: 'cpi', client, entitySets: [PACKAGES] }];
  const server = createMcpServer('t', '1');
  registerAllTools(server, client, [PACKAGES], ['all']);
  registerDiscoveryTools(server, { discovery: { mode: 'hybrid' }, index: buildIndex(apis, ['all']), pinned: [] });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'c', version: '1' });
  await Promise.all([mcp.connect(ct), server.connect(st)]);
  return { mcp, server };
}

function result(r: { isError?: boolean; content: Array<{ text?: string }> }) {
  return r;
}

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
