// Regression test for F7: the SAP Cloud SDK's own Winston logger must not write
// to stdout over stdio, because stdout is the MCP JSON-RPC channel. This boots
// the built server (dist/index.js) over stdio against a local HTTP stub whose
// CSRF-token fetch FAILS, driving the SDK to log a warning. We tap the child's
// raw stdout and assert every emitted line is valid JSON-RPC — one stray SDK log
// line on stdout would break JSON.parse in a strict MCP stdio client. Run
// `npm run build` first.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = join(rootDir, 'test', 'fixtures', 'e2e-binary-config.json');
const serverEntry = join(rootDir, 'dist', 'index.js');

let stub: Server;
let baseUrl: string;

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
    await readBody(req);
    const url = decodeURIComponent(req.url ?? '');

    if (url === '/oauth/token') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'stub-token', expires_in: 3600 }));
      return;
    }
    // CSRF-token fetch (x-csrf-token: fetch): fail WITHOUT returning a token
    // header, so the SDK logs a warning ("Failed to get CSRF token ...").
    if (String(req.headers['x-csrf-token']).toLowerCase() === 'fetch') {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'csrf unavailable' }));
      return;
    }
    // The actual create, attempted without a CSRF token: succeed so the tool
    // call resolves cleanly and the test exercises the warning path only.
    if (req.method === 'POST' && url === '/api/v1/IntegrationDesigntimeArtifacts') {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ d: { Id: 'Flow_A_copy' } }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'Not Found', message: { lang: 'en', value: 'not found' } } }));
  });
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
});

after(() => {
  stub.close();
});

/** Minimal newline-delimited JSON-RPC driver over a child's stdio. */
class RawStdioClient {
  readonly stdoutChunks: Buffer[] = [];
  readonly stderrChunks: Buffer[] = [];
  private buffer = '';
  private readonly pending = new Map<number, (msg: Record<string, unknown>) => void>();

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on('data', (c: Buffer) => {
      this.stdoutChunks.push(c);
      this.buffer += c.toString('utf8');
      let idx: number;
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        if (line.trim().length === 0) continue;
        // A parse failure here IS the bug; let it throw and fail the test.
        const msg = JSON.parse(line) as Record<string, unknown>;
        const id = msg['id'];
        if (typeof id === 'number' && this.pending.has(id)) {
          this.pending.get(id)!(msg);
          this.pending.delete(id);
        }
      }
    });
    child.stderr.on('data', (c: Buffer) => this.stderrChunks.push(c));
  }

  notify(method: string, params?: unknown): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  request(id: number, method: string, params?: unknown): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  get stdout(): string {
    return Buffer.concat(this.stdoutChunks).toString('utf8');
  }
}

test('stdout stays pure JSON-RPC while an SDK CSRF-token fetch fails under stdio', async () => {
  assert.ok(existsSync(serverEntry), 'dist/index.js missing — run `npm run build` first');

  const env = { ...(process.env as Record<string, string>) };
  delete env.VCAP_SERVICES;
  const child = spawn(process.execPath, [serverEntry], {
    cwd: rootDir,
    env: {
      ...env,
      MCP_TRANSPORT: 'stdio',
      API_CONFIG_FILE: configPath,
      // info level so the SDK's warn-level CSRF message would be emitted.
      LOG_LEVEL: 'info',
      E2E_BINARY_DEST_BASE_URL: baseUrl,
      E2E_BINARY_DEST_TOKEN_URL: `${baseUrl}/oauth/token`,
      E2E_BINARY_DEST_CLIENT_ID: 'id',
      E2E_BINARY_DEST_CLIENT_SECRET: 'secret',
    },
  }) as ChildProcessWithoutNullStreams;

  const client = new RawStdioClient(child);

  try {
    const init = await client.request(1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'raw-csrf-test', version: '0.0.0' },
    });
    assert.equal(init['id'], 1);
    assert.ok((init['result'] as Record<string, unknown>)?.['serverInfo'], 'initialize must return serverInfo');

    client.notify('notifications/initialized');

    // A CSRF-protected create: the SDK first fetches a CSRF token, which the
    // stub fails, making the SDK log a warning. Pre-fix that warning lands on
    // stdout and corrupts the stream.
    const callResult = await client.request(2, 'tools/call', {
      name: 'IntegrationDesigntimeArtifacts_create',
      arguments: { body: { Id: 'Flow_A_copy', Name: 'copy', PackageId: 'Pkg', ArtifactContent: 'eA==' } },
    });
    assert.equal(callResult['id'], 2);
    assert.ok(!(callResult['result'] as Record<string, unknown>)?.['isError'], `tool call failed: ${JSON.stringify(callResult)}`);

    // Every non-empty stdout line must be valid JSON-RPC (jsonrpc: "2.0").
    const lines = client.stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    assert.ok(lines.length >= 2, `expected at least two JSON-RPC lines, got: ${client.stdout}`);
    for (const line of lines) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch (err) {
        assert.fail(`non-JSON line on stdout (SDK log leaked into MCP channel): ${JSON.stringify(line)} — ${String(err)}`);
      }
      assert.equal(parsed['jsonrpc'], '2.0', `stdout line is not JSON-RPC: ${line}`);
    }

    // Sanity: the SDK warning really was produced — it belongs on stderr.
    const stderr = Buffer.concat(client.stderrChunks).toString('utf8');
    assert.match(stderr, /CSRF token/i, 'the SDK CSRF warning should appear on stderr');
  } finally {
    child.stdin.end();
    child.kill();
  }
});
