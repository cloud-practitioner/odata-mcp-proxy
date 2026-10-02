// End-to-end regression for header hardening (fork scan F4): boots the built
// server (dist/index.js) over stdio against a local HTTP stub standing in for
// the OAuth token endpoint and SAP CPI, and asserts that model-supplied headers
// are sanitised on the wire — the destination-issued bearer survives, forbidden
// headers (Host, Authorization, x-csrf-token, X-Forwarded-*, Proxy-*) never
// reach the backend, and an allowlisted header does — through both a generated
// tool and the discovery executor. Run `npm run build` first.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = join(rootDir, 'test', 'fixtures', 'e2e-method-config.json');
const serverEntry = join(rootDir, 'dist', 'index.js');

interface Recorded { method: string; url: string; headers: Record<string, string | string[] | undefined> }

let stub: Server;
let baseUrl: string;
const requests: Recorded[] = [];

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
    requests.push({ method: req.method ?? '', url, headers: req.headers });
    res.writeHead(204);
    res.end();
  });
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
});

after(() => stub.close());

function serverEnv(): Record<string, string> {
  const env = { ...(process.env as Record<string, string>) };
  delete env.VCAP_SERVICES;
  return {
    ...env,
    MCP_TRANSPORT: 'stdio',
    API_CONFIG_FILE: configPath,
    LOG_LEVEL: 'error',
    E2E_METHOD_DEST_BASE_URL: baseUrl,
    E2E_METHOD_DEST_TOKEN_URL: `${baseUrl}/oauth/token`,
    E2E_METHOD_DEST_CLIENT_ID: 'id',
    E2E_METHOD_DEST_CLIENT_SECRET: 'secret',
  };
}

async function withClient(fn: (client: Client) => Promise<void>): Promise<void> {
  assert.ok(existsSync(serverEntry), 'dist/index.js missing - run `npm run build` first');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    cwd: rootDir,
    env: serverEnv(),
  });
  const client = new Client({ name: 'e2e-headers-test', version: '0.0.0' });
  await client.connect(transport);
  try {
    await fn(client);
  } finally {
    await client.close();
  }
}

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };

/** Call a tool with poisoned headers and return the single backend request it produced. */
async function backendRequest(client: Client, name: string, args: Record<string, unknown>): Promise<Recorded> {
  requests.length = 0;
  const result = (await client.callTool({ name, arguments: args })) as ToolResult;
  assert.ok(!result.isError, result.content[0]?.text ?? 'tool error');
  assert.equal(requests.length, 1, `expected one backend request, got ${requests.length}`);
  return requests[0];
}

const POISONED = {
  Host: '127.0.0.1:1',
  Authorization: 'Bearer forged-by-model',
  Cookie: 'session=forged',
  'x-csrf-token': 'forged',
  'X-Forwarded-Host': 'attacker.example',
  'Proxy-Authorization': 'Basic forged',
  Prefer: 'return=minimal', // allowlisted — must survive
};

function assertSanitised(req: Recorded): void {
  // The destination-issued bearer survives; the model's forged one is gone.
  assert.equal(req.headers['authorization'], 'Bearer stub-token', 'destination bearer must survive');
  assert.notEqual(req.headers['host'], '127.0.0.1:1', 'forged Host must be stripped');
  assert.equal(req.headers['cookie'], undefined, 'Cookie must be stripped');
  assert.equal(req.headers['x-forwarded-host'], undefined, 'X-Forwarded-* must be stripped');
  assert.equal(req.headers['proxy-authorization'], undefined, 'Proxy-* must be stripped');
  // The forged CSRF token must not be what the model supplied.
  assert.notEqual(req.headers['x-csrf-token'], 'forged', 'forged CSRF token must be stripped');
  // The allowlisted header reaches the backend.
  assert.equal(req.headers['prefer'], 'return=minimal', 'allowlisted header must survive');
}

test('generated tool strips forbidden headers but keeps the destination bearer (F4)', async () => {
  await withClient(async (client) => {
    const req = await backendRequest(client, 'IntegrationFlowConfigurations_update', {
      path: "(Id='F',Version='active')/$links/Configurations('k')",
      body: { ParameterValue: 'v2' },
      headers: POISONED,
    });
    assertSanitised(req);
  });
});

test('discovery executor strips forbidden headers but keeps the destination bearer (F4)', async () => {
  await withClient(async (client) => {
    const req = await backendRequest(client, 'execute_operation', {
      api: 'cpi',
      entitySet: 'IntegrationFlowConfigurations',
      operation: 'update',
      path: "(Id='F',Version='active')/$links/Configurations('k')",
      body: { ParameterValue: 'v2' },
      headers: POISONED,
    });
    assertSanitised(req);
  });
});
