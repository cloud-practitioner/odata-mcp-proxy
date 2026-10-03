// Run `npm run build` first.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, request, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpServer, isXsuaaConfigured } from '../src/server/http.js';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = join(rootDir, 'test', 'fixtures', 'e2e-binary-config.json');
const serverEntry = join(rootDir, 'dist', 'index.js');

let cpiStub: Server;
let cpiBaseUrl: string;
const uploads: Buffer[] = [];

let proc: ChildProcess;
let serverPort: number;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function waitForHealth(port: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('HTTP server did not become healthy in time');
}

before(async () => {
  cpiStub = createServer(async (req, res) => {
    const body = await readBody(req);
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
    if (req.method === 'POST' && url === '/api/v1/IntegrationDesigntimeArtifacts') {
      const payload = JSON.parse(body.toString('utf8')) as { ArtifactContent: string };
      uploads.push(Buffer.from(payload.ArtifactContent, 'base64'));
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ d: { Id: 'Flow_A_copy' } }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'Not Found', message: { lang: 'en', value: 'not found' } } }));
  });
  await new Promise<void>((resolve) => cpiStub.listen(0, '127.0.0.1', resolve));
  cpiBaseUrl = `http://127.0.0.1:${(cpiStub.address() as AddressInfo).port}`;

  // Pick a free port for the MCP HTTP server.
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  serverPort = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  assert.ok(existsSync(serverEntry), 'dist/index.js missing — run `npm run build` first');
  const env = { ...(process.env as Record<string, string>) };
  delete env.VCAP_SERVICES;
  proc = spawn(process.execPath, [serverEntry], {
    cwd: rootDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...env,
      MCP_TRANSPORT: 'http',
      PORT: String(serverPort),
      CORS_ORIGIN: 'https://mcp-client.example',
      API_CONFIG_FILE: configPath,
      LOG_LEVEL: 'error',
      E2E_BINARY_DEST_BASE_URL: cpiBaseUrl,
      E2E_BINARY_DEST_TOKEN_URL: `${cpiBaseUrl}/oauth/token`,
      E2E_BINARY_DEST_CLIENT_ID: 'id',
      E2E_BINARY_DEST_CLIENT_SECRET: 'secret',
    },
  });
  await waitForHealth(serverPort);
});

after(() => {
  proc?.kill();
  cpiStub.close();
});

test('a large base64 artifact body (over the old 100 kb default) is accepted and reaches the backend', async () => {
  const artifactBytes = Buffer.alloc(225 * 1024, 0xab);
  const artifactContent = artifactBytes.toString('base64');
  assert.ok(artifactContent.length > 100 * 1024, 'test body must exceed the old 100 kb default');

  for (const path of ['/mcp', '/MCP', '/McP/']) {
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${serverPort}${path}`));
    const client = new Client({ name: 'e2e-http-body-test', version: '0.0.0' });
    await client.connect(transport);
    try {
      uploads.length = 0;
      const result = (await client.callTool({
        name: 'IntegrationDesigntimeArtifacts_create',
        arguments: { body: { Id: 'Flow_A_copy', Name: 'copy', PackageId: 'Pkg', ArtifactContent: artifactContent } },
      })) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
      assert.ok(!result.isError, `create failed: ${JSON.stringify(result.content)}`);
      assert.equal(uploads.length, 1, 'backend must have received the upload');
      assert.ok(uploads[0].equals(artifactBytes), 'uploaded bytes must round-trip');
    } finally {
      await client.close();
    }
  }
});

test('an over-limit body returns a JSON MCP error, not an HTML 413', async () => {
  const huge = 'a'.repeat(51 * 1024 * 1024);
  const payload = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'x', version: '0', pad: huge } },
  });

  for (const path of ['/mcp', '/MCP', '/McP/']) {
    const res = await fetch(`http://127.0.0.1:${serverPort}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        origin: 'https://mcp-client.example',
      },
      body: payload,
    });

    assert.equal(res.status, 413, 'over-limit body must yield 413');
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://mcp-client.example');
    const contentType = res.headers.get('content-type') ?? '';
    assert.match(contentType, /application\/json/, `expected JSON content type, got: ${contentType}`);

    const text = await res.text();
    assert.ok(!/<html/i.test(text), `body must not be an HTML error page: ${text.slice(0, 200)}`);
    const json = JSON.parse(text) as { jsonrpc?: string; error?: { code?: number; message?: string } };
    assert.equal(json.jsonrpc, '2.0', 'error must be a JSON-RPC envelope');
    assert.ok(typeof json.error?.code === 'number', 'error must carry a numeric code');
    assert.match(json.error?.message ?? '', /too large/i, 'message should explain the size limit');
  }
});

test('XSUAA rejects unfinished large MCP bodies before parsing', async () => {
  const previousServices = process.env.VCAP_SERVICES;
  // A complete XSUAA binding so the bearer guard mounts on /mcp. The URL is
  // never contacted here: a tokenless request is rejected by the guard before
  // any upstream call or body parsing.
  process.env.VCAP_SERVICES = JSON.stringify({
    xsuaa: [{
      label: 'xsuaa',
      credentials: {
        clientid: 'id',
        clientsecret: 'secret',
        url: 'https://xsuaa.example',
        uaadomain: 'xsuaa.example',
        xsappname: 'e2e-body-limit',
      },
    }],
  });
  let server: Server | undefined;
  try {
    assert.equal(isXsuaaConfigured(), true);
    server = createServer(createHttpServer(0));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    for (const contentType of ['application/json', 'application/x-www-form-urlencoded']) {
      for (const method of ['POST', 'GET', 'DELETE']) {
        for (const path of ['/mcp', '/mcp/', '/MCP', '/McP/', '/MCP/unmatched']) {
          const status = await new Promise<number | undefined>((resolve, reject) => {
            const req = request({
              host: '127.0.0.1',
              port,
              path,
              method,
              headers: { 'content-type': contentType, 'content-length': String(49 * 1024 * 1024) },
            }, (res) => {
              res.resume();
              res.on('end', () => {
                req.destroy();
                resolve(res.statusCode);
              });
            });
            req.on('error', reject);
            req.setTimeout(2000, () => req.destroy(new Error('Authentication waited for the body')));
            req.flushHeaders();
          });
          assert.equal(status, 401, `${method} ${path} must reject before reading the body`);
        }
      }
    }
  } finally {
    if (previousServices === undefined) delete process.env.VCAP_SERVICES;
    else process.env.VCAP_SERVICES = previousServices;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});

test('public and unmatched routes retain the default JSON body limit', async () => {
  const body = JSON.stringify({ pad: 'a'.repeat(200 * 1024) });
  for (const path of ['/health', '/oauth/token', '/oauth/refresh', '/oauth/client-registration', '/missing', '/mcp/unmatched', '/MCP/unmatched']) {
    const res = await fetch(`http://127.0.0.1:${serverPort}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    assert.equal(res.status, 413, `${path} must retain the default limit`);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    await res.text();
  }
});

test('non-size JSON errors and URL-encoded parameter errors retain Express responses', async () => {
  for (const { body, contentType, status } of [
    { body: '{', contentType: 'application/json', status: 400 },
    {
      body: Array.from({ length: 1001 }, (_, i) => `p${i}=x`).join('&'),
      contentType: 'application/x-www-form-urlencoded',
      status: 413,
    },
  ]) {
    for (const path of ['/mcp', '/MCP', '/McP/']) {
      const res = await fetch(`http://127.0.0.1:${serverPort}${path}`, {
        method: 'POST',
        headers: { 'content-type': contentType },
        body,
      });
      assert.equal(res.status, status);
      assert.match(res.headers.get('content-type') ?? '', /text\/html/);
      await res.text();
    }
  }
});
