// End-to-end test for HTTP session management (F16): boots the built server
// (dist/index.js) over the HTTP transport and asserts that
//   - the server generates its own session id on initialize, ignoring a
//     client-supplied mcp-session-id header (so a caller cannot choose or
//     hijack another session's id), and
//   - GET/DELETE /mcp with an unknown session id return 404 (not 400).
// Run `npm run build` first.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = join(rootDir, 'test', 'fixtures', 'e2e-http-config.json');
const serverEntry = join(rootDir, 'dist', 'index.js');

const PORT = 20000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;

let child: ChildProcess;

const INIT_BODY = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'e2e-http-session', version: '0.0.0' },
  },
};

async function waitForHealth(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error('server did not become healthy in time');
    await new Promise((r) => setTimeout(r, 100));
  }
}

before(async () => {
  assert.ok(existsSync(serverEntry), 'dist/index.js missing - run `npm run build` first');
  const env = { ...(process.env as Record<string, string>) };
  delete env.VCAP_SERVICES;
  child = spawn(process.execPath, [serverEntry], {
    cwd: rootDir,
    env: {
      ...env,
      MCP_TRANSPORT: 'http',
      PORT: String(PORT),
      API_CONFIG_FILE: configPath,
      LOG_LEVEL: 'error',
      SESSION_IDLE_TTL_MS: '1000',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  await waitForHealth(30_000);
});

after(() => {
  child?.kill('SIGKILL');
});

test('initialize ignores a client-supplied session id and generates its own', async () => {
  const clientChosen = 'client-chosen-id-should-be-ignored';
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-session-id': clientChosen,
    },
    body: JSON.stringify(INIT_BODY),
  });
  assert.equal(res.status, 200);
  const assigned = res.headers.get('mcp-session-id');
  assert.ok(assigned, 'server must assign a session id on initialize');
  assert.notEqual(assigned, clientChosen, 'server must not reuse the client-supplied id');
});

test('GET /mcp with an unknown session id returns 404', async () => {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'GET',
    headers: {
      accept: 'text/event-stream',
      'mcp-session-id': 'does-not-exist',
    },
  });
  assert.equal(res.status, 404);
});

test('DELETE /mcp with an unknown session id returns 404', async () => {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'DELETE',
    headers: { 'mcp-session-id': 'does-not-exist' },
  });
  assert.equal(res.status, 404);
});
