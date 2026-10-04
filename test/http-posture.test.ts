// Unit tests for the local-HTTP hardening helpers (F6): the server must bind
// loopback off Cloud Foundry, must not reflect an arbitrary CORS origin while
// credentials are enabled, and must pin the Streamable HTTP transport's
// DNS-rebinding protection to loopback Host/Origin in local mode. On Cloud
// Foundry (VCAP_APPLICATION) it binds all interfaces and leaves rebinding
// protection off (the bearer guard and router cover it there).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createHttpServer,
  httpBindHost,
  resolveCorsOrigin,
  mcpTransportSecurity,
} from '../src/server/http.js';

const SAVED = {
  VCAP_APPLICATION: process.env.VCAP_APPLICATION,
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
async function startApp(): Promise<{ url: string; close: () => Promise<void> }> {
  // Reserve a free port first so createHttpServer() builds its CORS allow-list
  // for the same port the server actually listens on.
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  const app = createHttpServer(port);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

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
