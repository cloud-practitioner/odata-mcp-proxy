// Unit tests for the local-HTTP hardening helpers (F6): the server must bind
// loopback off Cloud Foundry, must not reflect an arbitrary CORS origin while
// credentials are enabled, and must pin the Streamable HTTP transport's
// DNS-rebinding protection to loopback Host/Origin in local mode. On Cloud
// Foundry (VCAP_APPLICATION) it binds all interfaces and leaves rebinding
// protection off (the bearer guard and router cover it there).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  createHttpServer,
  httpBindHost,
  resolveCorsOrigin,
  mcpTransportSecurity,
  startHttpServer,
} from '../src/server/http.js';

const SAVED = {
  VCAP_APPLICATION: process.env.VCAP_APPLICATION,
  VCAP_SERVICES: process.env.VCAP_SERVICES,
  NODE_ENV: process.env.NODE_ENV,
  CORS_ORIGIN: process.env.CORS_ORIGIN,
};

afterEach(() => {
  for (const [key, value] of Object.entries(SAVED)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// ─── httpBindHost ──────────────────────────────────────────────────────────────

test('httpBindHost binds loopback locally and all interfaces on Cloud Foundry (F6)', () => {
  delete process.env.VCAP_APPLICATION;
  assert.equal(httpBindHost(), '127.0.0.1');

  process.env.VCAP_APPLICATION = JSON.stringify({ application_name: 'x' });
  assert.equal(httpBindHost(), '0.0.0.0');
});

for (const [environment, expectedHost] of [[undefined, '127.0.0.1'], ['{}', '0.0.0.0']] as const) {
  test(`startHttpServer binds ${expectedHost} regardless of a former interface override`, async (t) => {
    if (environment === undefined) delete process.env.VCAP_APPLICATION;
    else process.env.VCAP_APPLICATION = environment;
    delete process.env.VCAP_SERVICES;
    const app = createHttpServer(0);
    const listen = t.mock.method(app, 'listen');
    await Reflect.apply(startHttpServer, undefined, [
      app, 0, expectedHost === '127.0.0.1' ? '0.0.0.0' : '127.0.0.1',
    ]);
    const server = listen.mock.calls[0].result as Server;
    try {
      assert.equal((server.address() as AddressInfo).address, expectedHost);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}

// ─── resolveCorsOrigin ──────────────────────────────────────────────────────────

test('resolveCorsOrigin never reflects an arbitrary origin in local/dev (F6)', () => {
  delete process.env.NODE_ENV;
  delete process.env.CORS_ORIGIN;
  const origin = resolveCorsOrigin(4004);
  // Not `true`: cors reflects any caller only when origin === true.
  assert.notEqual(origin, true);
  assert.deepEqual(origin, ['http://127.0.0.1:4004', 'http://localhost:4004']);
});

test('resolveCorsOrigin appends a configured CORS_ORIGIN in local/dev (F6)', () => {
  delete process.env.NODE_ENV;
  process.env.CORS_ORIGIN = 'http://tool.localhost:3000';
  assert.deepEqual(resolveCorsOrigin(4004), [
    'http://127.0.0.1:4004',
    'http://localhost:4004',
    'http://tool.localhost:3000',
  ]);
});

test('resolveCorsOrigin in production is the configured origin or none', () => {
  process.env.NODE_ENV = 'production';
  delete process.env.CORS_ORIGIN;
  assert.equal(resolveCorsOrigin(4004), false);

  process.env.CORS_ORIGIN = 'https://client.example.com';
  assert.equal(resolveCorsOrigin(4004), 'https://client.example.com');
});

// ─── mcpTransportSecurity ───────────────────────────────────────────────────────

test('mcpTransportSecurity enables DNS-rebinding protection pinned to loopback locally (F6)', () => {
  delete process.env.VCAP_APPLICATION;
  delete process.env.CORS_ORIGIN;
  assert.deepEqual(mcpTransportSecurity(4004), {
    enableDnsRebindingProtection: true,
    allowedHosts: ['127.0.0.1:4004', 'localhost:4004'],
    allowedOrigins: ['http://127.0.0.1:4004', 'http://localhost:4004'],
  });
});

test('mcpTransportSecurity leaves rebinding protection off on Cloud Foundry (F6)', () => {
  process.env.VCAP_APPLICATION = JSON.stringify({ application_name: 'x' });
  assert.deepEqual(mcpTransportSecurity(4004), { enableDnsRebindingProtection: false });
});

// ─── CORS behaviour on the real Express app ─────────────────────────────────────

/** Start createHttpServer()'s app on an ephemeral loopback port. */
async function startApp(policyPort?: number): Promise<{ url: string; close: () => Promise<void> }> {
  // Reserve a free port first so createHttpServer() builds its CORS allow-list
  // for the same port the server actually listens on.
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  delete process.env.VCAP_SERVICES;
  const app = createHttpServer(policyPort ?? port);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

for (const hostname of ['localhost', '127.0.0.1']) {
  for (const host of [hostname, `${hostname}:80`]) {
    test(`MCP accepts Host ${host} and canonical port-80 Origin`, async () => {
      delete process.env.VCAP_APPLICATION;
      delete process.env.CORS_ORIGIN;
      const server = new McpServer({ name: 'default-port-test', version: '1.0.0' });
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        enableJsonResponse: true,
        ...mcpTransportSecurity(80),
      });
      await server.connect(transport);
      try {
        const response = await transport.handleRequest(new Request(`http://${hostname}/mcp`, {
          method: 'POST',
          headers: {
            Host: host,
            Origin: `http://${hostname}`,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'initialize',
            params: {
              protocolVersion: '2025-03-26', capabilities: {},
              clientInfo: { name: 'default-port-test', version: '1.0.0' },
            },
          }),
        }));
        assert.equal(response.status, 200, await response.text());
        const sessionId = response.headers.get('mcp-session-id');
        assert.ok(sessionId);
        const headers = {
          Host: host, Origin: `http://${hostname}`,
          accept: 'text/event-stream', 'mcp-session-id': sessionId,
          'mcp-protocol-version': '2025-03-26',
        };
        const stream = await transport.handleRequest(new Request(`http://${hostname}/mcp`, { headers }));
        assert.equal(stream.status, 200);
        const deleted = await transport.handleRequest(new Request(`http://${hostname}/mcp`, {
          method: 'DELETE', headers,
        }));
        assert.equal(deleted.status, 200, await deleted.text());
        await stream.body?.cancel();
      } finally {
        await server.close();
      }
    });
  }
}

test('CORS permits canonical loopback origins on port 80', async () => {
  delete process.env.NODE_ENV;
  delete process.env.CORS_ORIGIN;
  const { url, close } = await startApp(80);
  try {
    for (const origin of ['http://localhost', 'http://127.0.0.1']) {
      const response = await fetch(`${url}/mcp`, {
        method: 'OPTIONS',
        headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' },
      });
      assert.equal(response.headers.get('access-control-allow-origin'), origin);
      assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
    }
  } finally {
    await close();
  }
});

test('CORS does not echo an arbitrary Origin with credentials in local/dev (F6)', async () => {
  delete process.env.NODE_ENV;
  delete process.env.CORS_ORIGIN;
  const { url, close } = await startApp();
  try {
    // A malicious page's preflight must not be granted an allow-origin header.
    const evil = await fetch(`${url}/mcp`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.example',
        'Access-Control-Request-Method': 'POST',
      },
    });
    assert.notEqual(evil.headers.get('access-control-allow-origin'), 'https://evil.example');
    assert.equal(evil.headers.get('access-control-allow-origin'), null);

    // A loopback origin stays allowed so same-machine browser tooling works.
    const { port } = new URL(url);
    const good = await fetch(`${url}/mcp`, {
      method: 'OPTIONS',
      headers: {
        Origin: `http://127.0.0.1:${port}`,
        'Access-Control-Request-Method': 'POST',
      },
    });
    assert.equal(good.headers.get('access-control-allow-origin'), `http://127.0.0.1:${port}`);
    assert.equal(good.headers.get('access-control-allow-credentials'), 'true');
  } finally {
    await close();
  }
});
