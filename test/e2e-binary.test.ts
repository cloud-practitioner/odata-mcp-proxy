// End-to-end test: boots the built server (dist/index.js) over stdio against a
// local HTTP stub standing in for the OAuth token endpoint and SAP CPI, and
// asserts that response bodies reach the MCP client intact: binary `$value`
// content (an iflow zip) as a lossless base64 envelope, text `$value` content
// (a Groovy script) as text, JSON as parsed JSON, and OData errors as readable
// messages. Also covers the upload half of an artifact copy (`_create` with
// the downloaded base64 as `ArtifactContent`) and the progressive-discovery
// executor, which shares the same client path. A ~2 MB random zip is also
// downloaded and uploaded byte-identically over both stdio and HTTP, and the
// stub matches the raw request URL (no decoding) so the exact percent-encoding
// the server sends upstream is asserted. Run `npm run build` first.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = join(rootDir, 'test', 'fixtures', 'e2e-binary-config.json');
const serverEntry = join(rootDir, 'dist', 'index.js');

// A zip-like body: local file header magic followed by every byte value, so
// any lossy text decoding (e.g. UTF-8 with U+FFFD replacement) is detectable.
const ZIP_BYTES = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x08, 0x08, 0x08, 0x00, 0x89, 0x6c]),
  Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
  Buffer.from([0x50, 0x4b, 0x05, 0x06]),
]);
// Valid UTF-8 with non-ASCII characters, served with CPI's vendor content type.
const GROOVY = 'import com.sap.gateway.ip.core.customdev.util.Message\n// Grüße – ✓\ndef Message processData(Message message) { return message }\n';

// ~2 MB of random bytes behind a zip local-file-header magic: incompressible,
// and large enough to cross every chunk boundary on the stub, the OAuth/CSRF
// client, stdio pipes and Streamable HTTP.
const BIG_ZIP_BYTES = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), randomBytes(2 * 1024 * 1024)]);

const BOM_SCRIPT_BYTES = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(GROOVY, 'utf8')]);

const ARTIFACT = "IntegrationDesigntimeArtifacts(Id='Flow_A',Version='active')";
const BIG_ARTIFACT = "IntegrationDesigntimeArtifacts(Id='Flow_Big',Version='1.0%2F1')";
const SCRIPT = "IntegrationDesigntimeArtifacts(Id='Flow_A',Version='active')/Resources(Name='script1.groovy',ResourceType='groovy')";

let stub: Server;
let baseUrl: string;
const uploads: Buffer[] = [];
/** Raw request lines (`METHOD url`) of every backend request, URL exactly as sent. */
const requests: string[] = [];

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

before(async () => {
  stub = createServer(async (req, res) => {
    const body = await readBody(req);
    // Match the raw URL, exactly as the server sent it: decoding here would
    // hide a wrong percent-encoding (double-encoded or decoded characters).
    const url = req.url ?? '';
    if (url !== '/oauth/token' && String(req.headers['x-csrf-token']).toLowerCase() !== 'fetch') {
      requests.push(`${req.method} ${url}`);
    }

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
    if (req.method === 'GET' && url === `/api/v1/${BIG_ARTIFACT}/$value`) {
      res.writeHead(200, { 'content-type': 'application/zip' });
      res.end(BIG_ZIP_BYTES);
      return;
    }
    if (req.method === 'GET' && url === `/api/v1/${ARTIFACT}/$value`) {
      res.writeHead(200, { 'content-type': 'application/zip' });
      res.end(ZIP_BYTES);
      return;
    }
    if (req.method === 'GET' && url === `/api/v1/${ARTIFACT}/Resources(Name='bom.groovy',ResourceType='groovy')/$value`) {
      res.writeHead(200, { 'content-type': 'application/vnd.sap.integration.groovyscript' });
      res.end(BOM_SCRIPT_BYTES);
      return;
    }
    if (req.method === 'GET' && url === `/api/v1/${SCRIPT}/$value`) {
      res.writeHead(200, { 'content-type': 'application/vnd.sap.integration.groovyscript' });
      res.end(Buffer.from(GROOVY, 'utf8'));
      return;
    }
    if (req.method === 'GET' && url.startsWith('/api/v1/IntegrationDesigntimeArtifacts?')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ d: { results: [] } }));
      return;
    }
    if (req.method === 'GET' && url === `/api/v1/${ARTIFACT}`) {
      res.writeHead(200, { 'content-type': 'application/json;charset=utf-8' });
      res.end(JSON.stringify({ d: { Id: 'Flow_A', Name: 'Flüx A', Version: 'active' } }));
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
    res.end(JSON.stringify({ error: { code: 'Not Found', message: { lang: 'en', value: 'Integration artifact not found – ünknown' } } }));
  });
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
});

after(() => {
  stub.close();
});

type Transport = 'stdio' | 'http';

/** Environment for a server process whose local destination points at the stub. */
function serverEnv(extra: Record<string, string>): Record<string, string> {
  const env = { ...(process.env as Record<string, string>) };
  delete env.VCAP_SERVICES;
  return {
    ...env,
    API_CONFIG_FILE: configPath,
    LOG_LEVEL: 'error',
    E2E_BINARY_DEST_BASE_URL: baseUrl,
    E2E_BINARY_DEST_TOKEN_URL: `${baseUrl}/oauth/token`,
    E2E_BINARY_DEST_CLIENT_ID: 'id',
    E2E_BINARY_DEST_CLIENT_SECRET: 'secret',
    ...extra,
  };
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** Spawn the HTTP server (no XSUAA bound) and wait until /health answers. */
async function startHttp(): Promise<{ url: string; child: ChildProcess }> {
  const port = await freePort();
  const child = spawn(process.execPath, [serverEntry], {
    cwd: rootDir,
    env: serverEnv({ MCP_TRANSPORT: 'http', PORT: String(port) }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode}: ${stderr}`);
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

async function withClient(fn: (client: Client) => Promise<void>, transport: Transport = 'stdio'): Promise<void> {
  assert.ok(existsSync(serverEntry), 'dist/index.js missing — run `npm run build` first');
  const client = new Client({ name: 'e2e-binary-test', version: '0.0.0' });
  let child: ChildProcess | undefined;
  if (transport === 'stdio') {
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [serverEntry],
      cwd: rootDir,
      env: serverEnv({ MCP_TRANSPORT: 'stdio' }),
    }));
  } else {
    const started = await startHttp();
    child = started.child;
    await client.connect(new StreamableHTTPClientTransport(new URL(`${started.url}/mcp`)));
  }
  try {
    await fn(client);
  } finally {
    await client.close();
    if (child && child.exitCode === null) {
      const exited = new Promise((resolve) => child!.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
    }
  }
}

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

function textOf(result: ToolResult): string {
  assert.equal(result.content[0].type, 'text');
  return result.content[0].text ?? '';
}

interface BinaryEnvelope {
  contentType: string;
  encoding: string;
  size: number;
  data: string;
}

test('binary $value round-trips byte-identically through download and create', async () => {
  await withClient(async (client) => {
    const download = await call(client, 'IntegrationDesigntimeArtifacts_get', {
      path: "(Id='Flow_A',Version='active')/$value",
    });
    assert.ok(!download.isError, textOf(download));
    const envelope = JSON.parse(textOf(download)) as BinaryEnvelope;
    assert.equal(envelope.contentType, 'application/zip');
    assert.equal(envelope.encoding, 'base64');
    assert.equal(envelope.size, ZIP_BYTES.length);
    assert.ok(Buffer.from(envelope.data, 'base64').equals(ZIP_BYTES), 'downloaded bytes must match');

    uploads.length = 0;
    const create = await call(client, 'IntegrationDesigntimeArtifacts_create', {
      body: { Id: 'Flow_A_copy', Name: 'Flow A copy', PackageId: 'Pkg', ArtifactContent: envelope.data },
    });
    assert.ok(!create.isError, textOf(create));
    assert.deepEqual(JSON.parse(textOf(create)), { d: { Id: 'Flow_A_copy' } });
    assert.equal(uploads.length, 1);
    assert.ok(uploads[0].equals(ZIP_BYTES), 'uploaded ArtifactContent must match the original bytes');
  });
});

test('text $value with a non-text content type is returned as text', async () => {
  await withClient(async (client) => {
    const result = await call(client, 'IntegrationDesigntimeArtifacts_get', {
      path: "(Id='Flow_A',Version='active')/Resources(Name='script1.groovy',ResourceType='groovy')/$value",
    });
    assert.ok(!result.isError, textOf(result));
    assert.equal(JSON.parse(textOf(result)), GROOVY);
  });
});

test('BOM-prefixed text $value is byte-lossless through named and discovery tools', async () => {
  await withClient(async (client) => {
    const path = "(Id='Flow_A',Version='active')/Resources(Name='bom.groovy',ResourceType='groovy')/$value";
    for (const [name, args] of [
      ['IntegrationDesigntimeArtifacts_get', { path }],
      ['execute_operation', { api: 'cpi', entitySet: 'IntegrationDesigntimeArtifacts', operation: 'get', path }],
    ] as const) {
      const result = await call(client, name, args);
      assert.ok(!result.isError, textOf(result));
      const text: unknown = JSON.parse(textOf(result));
      assert.equal(typeof text, 'string');
      assert.equal((text as string).charCodeAt(0), 0xfeff);
      assert.ok(Buffer.from(text as string, 'utf8').equals(BOM_SCRIPT_BYTES), 'BOM and content bytes must survive MCP');
    }
  });
});

test('JSON GET is still parsed', async () => {
  await withClient(async (client) => {
    const result = await call(client, 'IntegrationDesigntimeArtifacts_get', {
      path: "(Id='Flow_A',Version='active')",
    });
    assert.ok(!result.isError, textOf(result));
    assert.deepEqual(JSON.parse(textOf(result)), { d: { Id: 'Flow_A', Name: 'Flüx A', Version: 'active' } });
  });
});

test('OData error body is surfaced as a readable error message', async () => {
  await withClient(async (client) => {
    const result = await call(client, 'IntegrationDesigntimeArtifacts_get', {
      path: "(Id='Missing',Version='active')",
    });
    assert.equal(result.isError, true);
    assert.equal(textOf(result), 'Error: Integration artifact not found – ünknown');
  });
});

test('progressive-discovery executor returns binary $value losslessly', async () => {
  await withClient(async (client) => {
    const result = await call(client, 'execute_operation', {
      api: 'cpi',
      entitySet: 'IntegrationDesigntimeArtifacts',
      operation: 'get',
      path: "(Id='Flow_A',Version='active')/$value",
    });
    assert.ok(!result.isError, textOf(result));
    const envelope = JSON.parse(textOf(result)) as BinaryEnvelope;
    assert.equal(envelope.encoding, 'base64');
    assert.ok(Buffer.from(envelope.data, 'base64').equals(ZIP_BYTES), 'downloaded bytes must match');
  });
});

// ─── ~2 MB zip and exact URL encoding, over both transports ──────────────────

for (const transport of ['stdio', 'http'] as const) {
  test(`${transport}: a ~2 MB random zip round-trips byte-identically through download and create`, async () => {
    assert.ok(BIG_ZIP_BYTES.length > 2 * 1024 * 1024);
    await withClient(async (client) => {
      requests.length = 0;
      uploads.length = 0;

      const path = "(Id='Flow_Big',Version='1.0%2F1')/$value";
      const download = await call(client, 'IntegrationDesigntimeArtifacts_get', { path });
      assert.ok(!download.isError, textOf(download).slice(0, 200));
      const envelope = JSON.parse(textOf(download)) as BinaryEnvelope;
      assert.equal(envelope.contentType, 'application/zip');
      assert.equal(envelope.encoding, 'base64');
      assert.equal(envelope.size, BIG_ZIP_BYTES.length);
      assert.ok(Buffer.from(envelope.data, 'base64').equals(BIG_ZIP_BYTES), 'downloaded bytes must match');

      const viaDiscovery = await call(client, 'execute_operation', {
        api: 'cpi', entitySet: 'IntegrationDesigntimeArtifacts', operation: 'get', path,
      });
      assert.ok(!viaDiscovery.isError, textOf(viaDiscovery).slice(0, 200));
      const discovered = JSON.parse(textOf(viaDiscovery)) as BinaryEnvelope;
      assert.ok(Buffer.from(discovered.data, 'base64').equals(BIG_ZIP_BYTES), 'discovery download bytes must match');

      const create = await call(client, 'IntegrationDesigntimeArtifacts_create', {
        body: { Id: 'Flow_Big_copy', Name: 'Flow Big copy', PackageId: 'Pkg', ArtifactContent: envelope.data },
      });
      assert.ok(!create.isError, textOf(create).slice(0, 200));
      assert.equal(uploads.length, 1);
      assert.ok(uploads[0].equals(BIG_ZIP_BYTES), 'uploaded ArtifactContent must match the original bytes');

      assert.deepEqual(requests, [
        `GET /api/v1/${BIG_ARTIFACT}/$value`,
        `GET /api/v1/${BIG_ARTIFACT}/$value`,
        'POST /api/v1/IntegrationDesigntimeArtifacts',
      ]);
    }, transport);
  });

  test(`${transport}: the exact request URL reaches the backend with its encoding intact`, async () => {
    await withClient(async (client) => {
      const cases: Array<[Record<string, unknown>, string]> = [
        // A key containing an already encoded slash must not be decoded or encoded twice.
        [{ path: "(Id='Flow_Big',Version='1.0%2F1')/$value" }, `GET /api/v1/${BIG_ARTIFACT}/$value`],
        // Query options: spaces and quotes are percent-encoded once; $-prefixed names stay literal.
        [{ path: "?$filter=Name eq 'a b'&$top=1" }, 'GET /api/v1/IntegrationDesigntimeArtifacts?$filter=Name%20eq%20%27a%20b%27&$top=1'],
        // Raw non-ASCII becomes UTF-8 percent-escapes; an already encoded value is not encoded twice.
        [{ path: "?$filter=Name eq 'Grüße'" }, 'GET /api/v1/IntegrationDesigntimeArtifacts?$filter=Name%20eq%20%27Gr%C3%BC%C3%9Fe%27'],
        [{ path: "?$filter=Name eq 'Gr%C3%BC%C3%9Fe'" }, 'GET /api/v1/IntegrationDesigntimeArtifacts?$filter=Name%20eq%20%27Gr%C3%BC%C3%9Fe%27'],
      ];
      for (const [args, expected] of cases) {
        requests.length = 0;
        const result = await call(client, 'IntegrationDesigntimeArtifacts_get', args);
        assert.ok(!result.isError, `${JSON.stringify(args)}: ${textOf(result).slice(0, 200)}`);
        assert.deepEqual(requests, [expected], JSON.stringify(args));
      }
    }, transport);
  });
}
