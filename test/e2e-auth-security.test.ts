// =============================================================================
// Regression tests for the OAuth / inbound-auth security findings (fork scan
// F1, F2, F17), reproduced against the built HTTP server after adopting
// `@arc-mcp/xsuaa-auth` (upstream PR #5).
//
// Each test is the reproduction from the fork-scan report (section 8,
// `.scratch/repro-oauth.ts`) turned into an assertion that the vulnerability no
// longer reproduces. The server is booted with a FAKE XSUAA binding pointing at
// a local stub — no real tenant or secret is used.
//
//   F1  — unauthenticated DCR must not echo the bound XSUAA client_secret.
//   F2  — OAuth proxy: no open redirect; token endpoint requires client auth;
//         PKCE S256 is enforced (challenge forwarded to XSUAA at authorize).
//   F17 — callback error page escapes input (no reflected XSS); OAuth codes /
//         refresh tokens are redacted from the request log; discovery metadata
//         is built from a configured base URL, not the request Host header.
// =============================================================================

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const serverEntry = join(rootDir, 'dist', 'index.js');
const configPath = join(rootDir, 'test', 'fixtures', 'e2e-config.json');

const FAKE_SECRET = 'fake-secret-for-repro';

// Records bodies POSTed to the fake XSUAA /oauth/token — used to prove the proxy
// never forwarded its own client_secret for an unauthenticated token redemption.
const tokenRequests: string[] = [];

let xsuaa: Server;
let xsuaaUrl: string;
let child: ChildProcess;
let url: string;
let discovery: {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  code_challenge_methods_supported?: string[];
};
// Accumulated server stdout+stderr, scanned by the token-logging test (F17).
let serverLogs = '';

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

before(async () => {
  assert.ok(existsSync(serverEntry), 'dist/index.js missing — run `npm run build` first');

  // Fake XSUAA: records token POSTs, hands back a token for any request. It does
  // NOT enforce PKCE/client auth — the point is that our proxy rejects the
  // attack BEFORE it ever reaches here.
  xsuaa = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if ((req.url ?? '').startsWith('/oauth/token')) {
        tokenRequests.push(body);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          access_token: 'victim-access-token',
          refresh_token: 'victim-refresh-token',
          token_type: 'bearer',
        }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((resolve) => xsuaa.listen(0, '127.0.0.1', resolve));
  xsuaaUrl = `http://127.0.0.1:${(xsuaa.address() as AddressInfo).port}`;

  const port = await freePort();
  const vcap = {
    xsuaa: [{
      label: 'xsuaa',
      name: 'x',
      tags: ['xsuaa'],
      credentials: {
        clientid: 'sb-fake!t1',
        clientsecret: FAKE_SECRET,
        url: xsuaaUrl,
        uaadomain: '127.0.0.1',
        xsappname: 'fake',
      },
    }],
  };
  const env = {
    ...(process.env as Record<string, string>),
    MCP_TRANSPORT: 'http',
    PORT: String(port),
    // info level so the request logger actually emits — the F17 test asserts the
    // path is logged while the query string (code / refresh_token) is redacted.
    LOG_LEVEL: 'info',
    VCAP_SERVICES: JSON.stringify(vcap),
    API_CONFIG_FILE: configPath,
  };
  // Ensure no reverse-proxy override leaks in from the ambient env.
  delete (env as Record<string, string>).PUBLIC_BASE_URL;

  child = spawn(process.execPath, [serverEntry], { cwd: rootDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.on('data', (c: Buffer) => { serverLogs += c.toString('utf8'); });
  child.stderr?.on('data', (c: Buffer) => { serverLogs += c.toString('utf8'); });

  url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode}: ${serverLogs}`);
    try { if ((await fetch(`${url}/health`)).ok) break; } catch { /* starting */ }
    if (Date.now() > deadline) { child.kill(); throw new Error(`server not healthy: ${serverLogs}`); }
    await new Promise((r) => setTimeout(r, 100));
  }

  const health = await (await fetch(`${url}/health`)).json() as { oauth: boolean };
  assert.equal(health.oauth, true, 'the fake binding must enable the XSUAA OAuth proxy');

  discovery = await (await fetch(`${url}/.well-known/oauth-authorization-server`)).json() as typeof discovery;
});

after(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await exited;
  }
  xsuaa?.close();
});

/** Register a public (PKCE, no secret) DCR client and return its client_id. */
async function registerClient(redirectUri = 'http://localhost:3000/oauth/callback'): Promise<{
  client_id: string;
  client_secret?: string;
  status: number;
}> {
  const res = await fetch(discovery.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [redirectUri], token_endpoint_auth_method: 'none' }),
  });
  const body = await res.json().catch(() => ({})) as { client_id: string; client_secret?: string };
  return { ...body, status: res.status };
}

// ─── F1 — DCR must not leak the XSUAA client secret ───────────────────────────

test('F1: the legacy unauthenticated DCR path no longer exists', async () => {
  // The old fork exposed POST /oauth/client-registration which echoed the bound
  // XSUAA client_secret. It is gone (the SDK router owns registration).
  const res = await fetch(`${url}/oauth/client-registration`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(res.status, 404, 'the secret-echoing /oauth/client-registration route must not exist');
});

test('F1: dynamic client registration does not return the bound XSUAA client_secret', async () => {
  const reg = await registerClient();
  assert.equal(reg.status, 201, 'DCR should succeed for an allowlisted redirect_uri');
  // Stateless HMAC client id, not the XSUAA service-binding client id.
  assert.ok(reg.client_id.startsWith('mcp-'), `expected an HMAC client id, got ${reg.client_id}`);
  assert.notEqual(reg.client_id, 'sb-fake!t1');
  // The response must NEVER carry the bound XSUAA secret. A public client gets
  // no secret at all; a confidential one would get a value DERIVED from its own
  // client_id — in neither case the XSUAA client_secret.
  assert.notEqual(reg.client_secret, FAKE_SECRET, 'DCR must not echo the XSUAA client_secret');
});

// ─── F2 — open redirect + token redemption with no client auth / no PKCE ──────

test('F2: /authorize rejects an arbitrary (off-allowlist) redirect_uri', async () => {
  const reg = await registerClient();
  const q = new URLSearchParams({
    client_id: reg.client_id,
    response_type: 'code',
    redirect_uri: 'https://attacker.example/cb',
    code_challenge: 'CHAL123',
    code_challenge_method: 'S256',
    state: 's1',
  });
  const res = await fetch(`${url}/authorize?${q}`, { redirect: 'manual' });
  assert.equal(res.status, 400, 'an unregistered attacker redirect_uri must be rejected, not forwarded');
  assert.equal(res.headers.get('location'), null, 'no redirect may be issued for a rejected redirect_uri');
});

test('F2: /authorize forwards the PKCE S256 challenge to XSUAA via the server callback and a signed state', async () => {
  const reg = await registerClient();
  const q = new URLSearchParams({
    client_id: reg.client_id,
    response_type: 'code',
    redirect_uri: 'http://localhost:3000/oauth/callback',
    code_challenge: 'CHAL123',
    code_challenge_method: 'S256',
    state: 'clientstate',
  });
  const res = await fetch(`${url}/authorize?${q}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  const location = res.headers.get('location');
  assert.ok(location, 'authorize must redirect to XSUAA');
  const target = new URL(location!);
  // Redirect goes to the real authorization server (XSUAA), not the client/attacker.
  assert.equal(target.origin, xsuaaUrl, 'authorize must redirect to XSUAA');
  // PKCE: the client challenge is forwarded as S256, so XSUAA enforces the
  // code_verifier check at token exchange (the proxy is stateless by design).
  assert.equal(target.searchParams.get('code_challenge'), 'CHAL123');
  assert.equal(target.searchParams.get('code_challenge_method'), 'S256');
  // Open-redirect defence: XSUAA is sent the SERVER's own callback, and the
  // client's redirect_uri + state ride inside an opaque signed state token.
  assert.match(target.searchParams.get('redirect_uri') ?? '', /\/oauth\/callback$/);
  assert.notEqual(target.searchParams.get('state'), 'clientstate', 'state must be an opaque signed token');
  // Discovery still advertises S256, now truthfully enforced end-to-end.
  assert.deepEqual(discovery.code_challenge_methods_supported, ['S256']);
});

test('F2: /oauth/callback does not forward a code to an attacker on a forged state', async () => {
  const res = await fetch(`${url}/oauth/callback?code=CODE123&state=forged`, { redirect: 'manual' });
  assert.equal(res.status, 400, 'an unverifiable state must fail closed, not 302 the code onward');
  assert.equal(res.headers.get('location'), null, 'no code may be forwarded for a forged state');
});

test('F2: the token endpoint rejects code redemption with no client authentication', async () => {
  tokenRequests.length = 0;
  const res = await fetch(discovery.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=authorization_code&code=CODE123',
  });
  assert.ok(res.status === 400 || res.status === 401, `expected client-auth rejection, got ${res.status}`);
  // The proxy must NOT have redeemed the code upstream with its own secret.
  assert.equal(
    tokenRequests.some((b) => new URLSearchParams(b).get('client_secret') === FAKE_SECRET),
    false,
    'the proxy must not redeem an unauthenticated code with its own client_secret',
  );
});

// ─── F17 — token logging, reflected XSS, Host-driven discovery ────────────────

test('F17: the callback error page does not reflect error_description unescaped', async () => {
  const payload = '<script>alert(document.domain)</script>';
  const res = await fetch(`${url}/oauth/callback?error=x&error_description=${encodeURIComponent(payload)}`);
  const html = await res.text();
  assert.equal(html.includes(payload), false, 'error_description must not be reflected as raw HTML (XSS)');
});

test('F17: OAuth codes and refresh tokens are redacted from the request log', async () => {
  const marker = serverLogs.length; // only scan what this test produces
  await fetch(`${url}/oauth/token?grant_type=refresh_token&refresh_token=RT-SENTINEL-123`).catch(() => {});
  await fetch(`${url}/oauth/callback?code=CODE-SENTINEL-999&state=zz`, { redirect: 'manual' }).catch(() => {});
  await new Promise((r) => setTimeout(r, 500));
  const fresh = serverLogs.slice(marker);
  assert.equal(fresh.includes('RT-SENTINEL-123'), false, 'refresh_token must not appear in the log');
  assert.equal(fresh.includes('CODE-SENTINEL-999'), false, 'auth code must not appear in the log');
  // Prove the request WAS logged (path kept) — so the absence above is redaction,
  // not merely a silent logger.
  assert.match(fresh, /\/oauth\/token\?<redacted>/, 'the path should still be logged with the query redacted');
});

test('F17: discovery metadata is built from a configured base URL, not the Host header', async () => {
  const res = await fetch(`${url}/.well-known/oauth-authorization-server`, { headers: { host: 'evil.example' } });
  const meta = await res.json() as { authorization_endpoint: string; issuer: string; token_endpoint: string };
  assert.equal(meta.authorization_endpoint.includes('evil.example'), false, 'Host header must not drive discovery URLs');
  assert.equal(meta.issuer.includes('evil.example'), false);
  assert.equal(meta.token_endpoint.includes('evil.example'), false);
});
