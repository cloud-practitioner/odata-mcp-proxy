// End-to-end tests for the HTTP-posture hardening, booting the built server
// (dist/index.js) over the HTTP transport.
//
//   - F5: on Cloud Foundry (VCAP_APPLICATION present) HTTP mode without an
//     XSUAA binding used to fail OPEN — every tool reachable unauthenticated
//     while holding the destination's credentials. The server now refuses to
//     start in that posture unless ALLOW_UNAUTHENTICATED_HTTP=true opts in.
//     Local HTTP (no VCAP_APPLICATION) and stdio are unaffected.
//   - F6: a local HTTP instance used to reflect any CORS origin with
//     credentials, run the Streamable HTTP transport with no DNS-rebinding
//     protection, and bind all interfaces. It now binds loopback, rejects a
//     foreign Host header (403), and does not echo an arbitrary Origin.
//
// Run `npm run build` first (the `npm test` script does).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = join(rootDir, 'test', 'fixtures', 'e2e-http-config.json');
const serverEntry = join(rootDir, 'dist', 'index.js');

const INIT_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'e2e-http-posture', version: '0.0.0' },
  },
});

async function freePort(): Promise<number> {
  const probe: Server = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

type Booted = { url: string; port: number; child: ChildProcess; output: () => string };

/** Spawn the HTTP server; resolve once /health answers (or reject on exit). */
async function startHttp(extra: Record<string, string>): Promise<Booted> {
  assert.ok(existsSync(serverEntry), 'dist/index.js missing — run `npm run build` first');
  const port = await freePort();
  const env = { ...(process.env as Record<string, string>) };
  delete env.VCAP_SERVICES;
  delete env.VCAP_APPLICATION;
  const child = spawn(process.execPath, [serverEntry], {
    cwd: rootDir,
    env: {
      ...env,
      MCP_TRANSPORT: 'http',
      PORT: String(port),
      API_CONFIG_FILE: configPath,
      LOG_LEVEL: 'info',
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // HTTP-mode logs go to stdout (dev) / stderr (SDK); capture both.
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
  child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode}: ${output}`);
    try {
      if ((await fetch(`${url}/health`)).ok) return { url, port, child, output: () => output };
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`server did not become healthy: ${output}`);
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

/** Spawn and wait for the process to exit, capturing output and exit code. */
async function bootAndExit(extra: Record<string, string>): Promise<{ status: number | null; output: string }> {
  assert.ok(existsSync(serverEntry), 'dist/index.js missing — run `npm run build` first');
  const port = await freePort();
  const env = { ...(process.env as Record<string, string>) };
  delete env.VCAP_SERVICES;
  delete env.VCAP_APPLICATION;
  const child = spawn(process.execPath, [serverEntry], {
    cwd: rootDir,
    env: {
      ...env,
      MCP_TRANSPORT: 'http',
      PORT: String(port),
      API_CONFIG_FILE: configPath,
      LOG_LEVEL: 'info',
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
  child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
  const status = await new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  return { status, output };
}

/** POST /mcp with full control over the Host header (fetch forbids setting it). */
function rawInitialize(port: number, host: string): Promise<{ status: number; sessionId: string | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: {
          Host: host,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'content-length': Buffer.byteLength(INIT_BODY),
        },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({
          status: res.statusCode ?? 0,
          sessionId: res.headers['mcp-session-id'] as string | undefined,
          body,
        }));
      },
    );
    req.on('error', reject);
    req.end(INIT_BODY);
  });
}

// ─── F5: Cloud Foundry HTTP without XSUAA fails closed ───────────────────────────

test('F5: HTTP on Cloud Foundry without XSUAA refuses to start', async () => {
  const { status, output } = await bootAndExit({
    VCAP_APPLICATION: JSON.stringify({ application_name: 'odata-mcp-proxy' }),
  });
  assert.equal(status, 1, output);
  assert.match(output, /Refusing to start/, output);
  assert.match(output, /XSUAA/, output);
  assert.doesNotMatch(output, /HTTP server listening/, output);
});

test('F5: ALLOW_UNAUTHENTICATED_HTTP=true opts in to an open CF server', async () => {
  const { url, child, output } = await startHttp({
    VCAP_APPLICATION: JSON.stringify({ application_name: 'odata-mcp-proxy' }),
    ALLOW_UNAUTHENTICATED_HTTP: 'true',
  });
  try {
    assert.ok((await fetch(`${url}/health`)).ok);
    assert.match(output(), /HTTP server listening/);
  } finally {
    await stopHttp(child);
  }
});

test('F5: local HTTP without XSUAA still starts (no VCAP_APPLICATION)', async () => {
  const { url, child } = await startHttp({});
  try {
    const health = await (await fetch(`${url}/health`)).json() as { status: string; oauth: boolean };
    assert.equal(health.status, 'ok');
    assert.equal(health.oauth, false);
  } finally {
    await stopHttp(child);
  }
});

// ─── F6: local HTTP posture (loopback bind, DNS-rebinding, CORS) ──────────────────

test('F6: local HTTP binds loopback, rejects a foreign Host, and allows loopback', async () => {
  const { port, child, output } = await startHttp({});
  try {
    // Binds loopback, not all interfaces.
    assert.match(output(), new RegExp(`HTTP server listening on 127\\.0\\.0\\.1:${port}`));

    // A DNS-rebinding page points its Host at the local server: rejected (403)
    // instead of being issued a session (the pre-fix behaviour).
    const rebind = await rawInitialize(port, 'rebind.evil.example');
    assert.equal(rebind.status, 403, rebind.body);
    assert.equal(rebind.sessionId, undefined);
    assert.match(rebind.body, /Invalid Host header/);

    // A legitimate same-machine caller still gets a session.
    const ok = await rawInitialize(port, `127.0.0.1:${port}`);
    assert.equal(ok.status, 200, ok.body);
    assert.ok(ok.sessionId, 'a valid Host must still be issued a session id');
  } finally {
    await stopHttp(child);
  }
});

test('F6: local HTTP does not reflect an arbitrary CORS origin with credentials', async () => {
  const { url, child } = await startHttp({});
  try {
    const evil = await fetch(`${url}/mcp`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' },
    });
    assert.notEqual(evil.headers.get('access-control-allow-origin'), 'https://evil.example');
    assert.equal(evil.headers.get('access-control-allow-origin'), null);
  } finally {
    await stopHttp(child);
  }
});
