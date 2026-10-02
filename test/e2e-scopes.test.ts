// End-to-end test for the `requiredScope` policy: scopes are enforced only
// when the transport authenticates a caller (HTTP with XSUAA bound). Boots the
// built server (dist/index.js) against a local HTTP stub standing in for the
// OAuth token endpoint and SAP CPI, with a config shaped like ci-mcp-server's
// where every enabled operation carries a `requiredScope`.
//
//   - stdio: scoped tools reach the backend (no caller token ever exists) and
//     a startup warning says the scopes are not enforced. Scopes on disabled
//     operations or on entity sets filtered out by ENABLED_API_CATEGORIES do
//     not trigger the warning.
//   - HTTP without XSUAA: same, over Streamable HTTP.
//   - HTTP with XSUAA bound: a request without a bearer token is rejected,
//     and an XSUAA-authenticated caller (a token signed with a test key the
//     fake binding trusts) reaches a navigation tool only with the parent's
//     read scope, like `_list` with the navigation path and execute_operation.
//
// Run `npm run build` first (the `npm test` script does).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = join(rootDir, 'test', 'fixtures', 'e2e-scopes-config.json');
const unregisteredScopesConfigPath = join(rootDir, 'test', 'fixtures', 'e2e-scopes-unregistered-config.json');
const serverEntry = join(rootDir, 'dist', 'index.js');

const PACKAGES = { d: { results: [{ Id: 'Pkg_A', Name: 'Package A' }] } };
const ARTIFACTS = { d: { results: [{ Id: 'Flow_A', PackageId: 'Pkg_A' }] } };

let stub: Server;
let baseUrl: string;
const backendCalls: string[] = [];

before(async () => {
  stub = createServer((req, res) => {
    const url = decodeURIComponent(req.url ?? '');
    if (url === '/oauth/token') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'stub-token', expires_in: 3600 }));
      return;
    }
    if (String(req.headers['x-csrf-token']).toLowerCase() === 'fetch') {
      res.writeHead(200, { 'x-csrf-token': 'stub-csrf' });
      res.end();
      return;
    }
    backendCalls.push(`${req.method} ${url}`);
    if (req.method === 'GET' && url === '/api/v1/IntegrationPackages') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(PACKAGES));
      return;
    }
    if (req.method === 'GET' && url === "/api/v1/IntegrationPackages('Pkg_A')/IntegrationDesigntimeArtifacts") {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(ARTIFACTS));
      return;
    }
    if (req.method === 'GET' && url === '/api/v1/MessageProcessingLogs') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ d: { results: [] } }));
      return;
    }
    if (req.method === 'POST' && url === '/api/v1/IntegrationPackages') {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ d: { Id: 'Pkg_B' } }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'Not Found', message: { lang: 'en', value: `no stub for ${url}` } } }));
  });
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
});

after(() => {
  stub.close();
});

/** Server env with local destination credentials pointing at the stub. */
function serverEnv(extra: Record<string, string>): Record<string, string> {
  const env = { ...(process.env as Record<string, string>) };
  delete env.VCAP_SERVICES;
  return {
    ...env,
    API_CONFIG_FILE: configPath,
    E2E_SCOPES_DEST_BASE_URL: baseUrl,
    E2E_SCOPES_DEST_TOKEN_URL: `${baseUrl}/oauth/token`,
    E2E_SCOPES_DEST_CLIENT_ID: 'id',
    E2E_SCOPES_DEST_CLIENT_SECRET: 'secret',
    ...extra,
  };
}

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

function textOf(result: ToolResult): string {
  assert.equal(result.content[0].type, 'text');
  return result.content[0].text ?? '';
}

// ─── stdio ───────────────────────────────────────────────────────────────────

test('stdio: scoped tools reach the backend without a caller token', async () => {
  assert.ok(existsSync(serverEntry), 'dist/index.js missing — run `npm run build` first');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    cwd: rootDir,
    env: serverEnv({ MCP_TRANSPORT: 'stdio', LOG_LEVEL: 'warn' }),
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  const client = new Client({ name: 'e2e-scopes-test', version: '0.0.0' });
  await client.connect(transport);

  try {
    backendCalls.length = 0;

    const list = await call(client, 'IntegrationPackages_list', {});
    assert.ok(!list.isError, textOf(list));
    assert.deepEqual(JSON.parse(textOf(list)), PACKAGES);

    const nav = await call(client, 'IntegrationPackages_IntegrationDesigntimeArtifacts_list', {
      path: "('Pkg_A')",
    });
    assert.ok(!nav.isError, textOf(nav));
    assert.deepEqual(JSON.parse(textOf(nav)), ARTIFACTS);

    const create = await call(client, 'IntegrationPackages_create', { body: { Id: 'Pkg_B' } });
    assert.ok(!create.isError, textOf(create));
    assert.deepEqual(JSON.parse(textOf(create)), { d: { Id: 'Pkg_B' } });

    // Not pinned in hybrid mode: reached through the discovery executor.
    const executed = await call(client, 'execute_operation', {
      api: 'cpi', entitySet: 'MessageProcessingLogs', operation: 'list',
    });
    assert.ok(!executed.isError, textOf(executed));

    assert.deepEqual(backendCalls, [
      'GET /api/v1/IntegrationPackages',
      "GET /api/v1/IntegrationPackages('Pkg_A')/IntegrationDesigntimeArtifacts",
      'POST /api/v1/IntegrationPackages',
      'GET /api/v1/MessageProcessingLogs',
    ]);

    assert.match(
      stderr,
      /requiredScope is not enforced: no XSUAA-authenticated caller \(stdio transport\)/,
    );
  } finally {
    await client.close();
  }
});

test('stdio: log output, including the scope warning, stays off stdout', async () => {
  assert.ok(existsSync(serverEntry), 'dist/index.js missing — run `npm run build` first');
  const child = spawn(process.execPath, [serverEntry], {
    cwd: rootDir,
    env: serverEnv({ MCP_TRANSPORT: 'stdio', LOG_LEVEL: 'debug' }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout!.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
  child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });

  const exited = new Promise((resolve) => child.once('exit', resolve));
  const responded = new Promise<void>((resolve) => {
    child.stdout!.on('data', () => { if (stdout.includes('"id":1')) resolve(); });
  });
  child.stdin!.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
  }) + '\n');
  await responded;
  child.stdin!.end();
  child.kill('SIGTERM');
  await exited;

  for (const line of stdout.split('\n').filter(Boolean)) {
    assert.doesNotThrow(() => JSON.parse(line), `non-JSON-RPC line on stdout: ${line}`);
  }
  assert.match(stderr, /requiredScope is not enforced/);
});

test('stdio: scopes only on disabled operations or filtered-out entity sets do not warn', async () => {
  assert.ok(existsSync(serverEntry), 'dist/index.js missing — run `npm run build` first');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    cwd: rootDir,
    env: serverEnv({
      MCP_TRANSPORT: 'stdio',
      LOG_LEVEL: 'info',
      API_CONFIG_FILE: unregisteredScopesConfigPath,
      ENABLED_API_CATEGORIES: 'message-processing-logs',
    }),
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  const client = new Client({ name: 'e2e-scopes-unregistered', version: '0.0.0' });
  await client.connect(transport);

  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ['MessageProcessingLogs_get', 'MessageProcessingLogs_list']);

    backendCalls.length = 0;
    const list = await call(client, 'MessageProcessingLogs_list', {});
    assert.ok(!list.isError, textOf(list));
    assert.deepEqual(backendCalls, ['GET /api/v1/MessageProcessingLogs']);

    assert.match(stderr, /Tool registration complete/, 'info logs must reach stderr');
    assert.doesNotMatch(stderr, /requiredScope is not enforced/);
  } finally {
    await client.close();
  }
});

// ─── HTTP ────────────────────────────────────────────────────────────────────

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** Spawn the HTTP server and wait until /health answers. */
async function startHttp(extra: Record<string, string>): Promise<{ url: string; child: ChildProcess }> {
  assert.ok(existsSync(serverEntry), 'dist/index.js missing — run `npm run build` first');
  const port = await freePort();
  const child = spawn(process.execPath, [serverEntry], {
    cwd: rootDir,
    env: serverEnv({ MCP_TRANSPORT: 'http', PORT: String(port), LOG_LEVEL: 'error', ...extra }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`server exited with ${child.exitCode}: ${stderr}`);
    }
    try {
      if ((await fetch(`${url}/health`)).ok) return { url, child };
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`server did not become healthy: ${stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function stopHttp(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await exited;
}

test('HTTP without XSUAA: scoped tools reach the backend', async () => {
  const { url, child } = await startHttp({});
  const client = new Client({ name: 'e2e-scopes-http', version: '0.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
    backendCalls.length = 0;

    const list = await call(client, 'IntegrationPackages_list', {});
    assert.ok(!list.isError, textOf(list));
    assert.deepEqual(JSON.parse(textOf(list)), PACKAGES);

    const nav = await call(client, 'IntegrationPackages_IntegrationDesigntimeArtifacts_list', {
      path: "('Pkg_A')",
    });
    assert.ok(!nav.isError, textOf(nav));
    assert.deepEqual(JSON.parse(textOf(nav)), ARTIFACTS);
    assert.deepEqual(backendCalls, [
      'GET /api/v1/IntegrationPackages',
      "GET /api/v1/IntegrationPackages('Pkg_A')/IntegrationDesigntimeArtifacts",
    ]);
  } finally {
    await client.close();
    await stopHttp(child);
  }
});

test('HTTP with XSUAA bound: a request without a bearer token is rejected', async () => {
  const vcap = {
    xsuaa: [{
      label: 'xsuaa',
      name: 'e2e-xsuaa',
      tags: ['xsuaa'],
      credentials: {
        clientid: 'sb-e2e',
        clientsecret: 'secret',
        url: baseUrl,
        uaadomain: '127.0.0.1',
        xsappname: 'e2e',
      },
    }],
  };
  const { url, child } = await startHttp({ VCAP_SERVICES: JSON.stringify(vcap) });
  try {
    const health = await (await fetch(`${url}/health`)).json() as { oauth: boolean };
    assert.equal(health.oauth, true, 'the fake binding must configure XSUAA');

    const response = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'e2e-scopes-http', version: '0.0.0' },
        },
      }),
    });
    assert.equal(response.status, 401);
    // The bearer guard now comes from the MCP SDK's `requireBearerAuth`
    // (via `@arc-mcp/xsuaa-auth`), which rejects a tokenless request with the
    // standard RFC 6750 `invalid_token` body rather than the previous
    // hand-rolled shape. The security property under test — a request without
    // a bearer token is rejected with 401 — is unchanged.
    assert.deepEqual(await response.json(), {
      error: 'invalid_token',
      error_description: 'Missing Authorization header',
    });
  } finally {
    await stopHttp(child);
  }
});

// ─── HTTP with XSUAA: scopes on navigation tools ─────────────────────────────

/**
 * A fake XSUAA binding that trusts a locally generated key, and a signer for
 * tokens @sap/xssec accepts against it. Tokens carry no `jku`/`kid`, so xssec
 * verifies them with the binding's `verificationkey` without fetching keys.
 */
function fakeXsuaa() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const vcap = {
    xsuaa: [{
      label: 'xsuaa',
      name: 'e2e-xsuaa',
      tags: ['xsuaa'],
      credentials: {
        clientid: 'sb-e2e',
        clientsecret: 'secret',
        url: baseUrl,
        uaadomain: '127.0.0.1',
        xsappname: 'e2e',
        verificationkey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      },
    }],
  };
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const sign = (scopes: string[]): string => {
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({
      azp: 'sb-e2e', cid: 'sb-e2e', client_id: 'sb-e2e', aud: ['sb-e2e', 'e2e'],
      zid: 'e2e-zone', ext_attr: { enhancer: 'XSUAA' }, grant_type: 'client_credentials',
      scope: scopes, iat: now, exp: now + 600,
    })}`;
    return `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(privateKey).toString('base64url')}`;
  };
  return { vcap, sign };
}

test('HTTP with XSUAA bound: navigation tools enforce the parent read scope', async () => {
  const { vcap, sign } = fakeXsuaa();
  // With VCAP_SERVICES present the SAP Cloud SDK resolves destinations by
  // name; the `destinations` env var points E2E_SCOPES_DEST at the stub.
  const { url, child } = await startHttp({
    VCAP_SERVICES: JSON.stringify(vcap),
    destinations: JSON.stringify([{ name: 'E2E_SCOPES_DEST', url: baseUrl }]),
  });

  async function connectAs(scopes: string[]): Promise<Client> {
    const client = new Client({ name: 'e2e-scopes-xsuaa', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${sign(scopes)}` } },
    }));
    return client;
  }

  const navigationPaths: Array<[string, Record<string, unknown>]> = [
    ['IntegrationPackages_IntegrationDesigntimeArtifacts_list', { path: "('Pkg_A')" }],
    ['IntegrationPackages_list', { path: "('Pkg_A')/IntegrationDesigntimeArtifacts" }],
    ['execute_operation', {
      api: 'cpi', entitySet: 'IntegrationPackages', operation: 'list',
      path: "('Pkg_A')", navProperty: 'IntegrationDesigntimeArtifacts',
    }],
  ];

  try {
    const withoutScope = await connectAs(['e2e.write']);
    try {
      backendCalls.length = 0;
      for (const [name, args] of navigationPaths) {
        const result = await call(withoutScope, name, args);
        assert.equal(result.isError, true, `${name} must refuse a token without the read scope`);
        assert.match(textOf(result), /Forbidden: operation requires scope 'read'/, name);
      }
      assert.deepEqual(backendCalls, [], 'a refused call must not reach the backend');
    } finally {
      await withoutScope.close();
    }

    const withScope = await connectAs(['e2e.read']);
    try {
      backendCalls.length = 0;
      for (const [name, args] of navigationPaths) {
        const result = await call(withScope, name, args);
        assert.ok(!result.isError, `${name}: ${textOf(result)}`);
        assert.deepEqual(JSON.parse(textOf(result)), ARTIFACTS, name);
      }
      assert.deepEqual(
        backendCalls,
        navigationPaths.map(() => "GET /api/v1/IntegrationPackages('Pkg_A')/IntegrationDesigntimeArtifacts"),
      );
    } finally {
      await withScope.close();
    }
  } finally {
    await stopHttp(child);
  }
});
