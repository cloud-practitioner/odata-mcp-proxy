import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createHttpServer, isXsuaaConfigured } from '../src/server/http.js';
import { OAuthStateCodec } from '@arc-mcp/xsuaa-auth';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const serverEntry = join(rootDir, 'dist', 'index.js');
const configPath = join(rootDir, 'test', 'fixtures', 'e2e-config.json');
const FAKE_SECRET = 'fake-secret-for-repro';
const CLIENT_ID = 'sb-fake!t1';
const REDIRECT_URI = 'http://localhost:4004/oauth/callback';
const VERIFIER = 'v'.repeat(64);
const challenge = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');
const tokenRequests: string[] = [];
const revokedTokens: string[] = [];
const codes = new Map<string, { challenge: string; redirectUri: string }>();
const refreshTokens = new Set<string>();
let xsuaa: Server;
let xsuaaUrl: string;
let child: ChildProcess;
let url: string;
let serverLogs = '';
let discovery: {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  revocation_endpoint: string;
  code_challenge_methods_supported?: string[];
};

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

before(async () => {
  assert.ok(existsSync(serverEntry), 'dist/index.js missing — run npm run build first');
  xsuaa = createServer((req, res) => {
    const target = new URL(req.url ?? '/', 'http://stub');
    if (target.pathname === '/oauth/authorize') {
      const code = randomUUID();
      codes.set(code, {
        challenge: target.searchParams.get('code_challenge') ?? '',
        redirectUri: target.searchParams.get('redirect_uri') ?? '',
      });
      const callback = new URL(target.searchParams.get('redirect_uri')!);
      callback.searchParams.set('code', code);
      callback.searchParams.set('state', target.searchParams.get('state')!);
      res.writeHead(302, { location: callback.toString() });
      res.end();
      return;
    }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const params = new URLSearchParams(body);
      if (target.pathname === '/oauth/revoke') {
        revokedTokens.push(params.get('token') ?? '');
        refreshTokens.delete(params.get('token') ?? '');
        res.writeHead(200);
        res.end();
        return;
      }
      if (target.pathname !== '/oauth/token') {
        res.writeHead(404);
        res.end();
        return;
      }
      tokenRequests.push(body);
      let valid = params.get('client_id') === CLIENT_ID && params.get('client_secret') === FAKE_SECRET;
      if (params.get('grant_type') === 'authorization_code') {
        const code = params.get('code') ?? '';
        const grant = codes.get(code);
        const verifier = params.get('code_verifier');
        valid = valid && !!grant && !!verifier && challenge(verifier) === grant.challenge &&
          params.get('redirect_uri') === grant.redirectUri;
        if (valid) codes.delete(code);
      } else if (params.get('grant_type') === 'refresh_token') {
        const token = params.get('refresh_token') ?? '';
        valid = valid && refreshTokens.has(token);
        if (valid) refreshTokens.delete(token);
      } else {
        valid = false;
      }
      res.writeHead(valid ? 200 : 400, { 'content-type': 'application/json' });
      if (!valid) {
        res.end(JSON.stringify({ error: 'invalid_grant' }));
        return;
      }
      const refreshToken = randomUUID();
      refreshTokens.add(refreshToken);
      res.end(JSON.stringify({
        access_token: 'victim-access-token',
        refresh_token: refreshToken,
        token_type: 'bearer',
      }));
    });
  });
  await new Promise<void>((resolve) => xsuaa.listen(0, '127.0.0.1', resolve));
  xsuaaUrl = `http://127.0.0.1:${(xsuaa.address() as AddressInfo).port}`;
  const port = await freePort();
  url = `http://127.0.0.1:${port}`;
  const vcap = { xsuaa: [{ credentials: {
    clientid: CLIENT_ID,
    clientsecret: FAKE_SECRET,
    url: xsuaaUrl,
    uaadomain: '127.0.0.1',
    xsappname: 'fake',
  } }] };
  child = spawn(process.execPath, [serverEntry], {
    cwd: rootDir,
    env: {
      ...process.env,
      MCP_TRANSPORT: 'http', PORT: String(port), LOG_LEVEL: 'info',
      VCAP_SERVICES: JSON.stringify(vcap), API_CONFIG_FILE: configPath,
      PUBLIC_BASE_URL: url,
      VCAP_APPLICATION: JSON.stringify({ application_uris: ['external.example'] }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk: Buffer) => { serverLogs += chunk.toString('utf8'); });
  child.stderr?.on('data', (chunk: Buffer) => { serverLogs += chunk.toString('utf8'); });
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited: ${serverLogs}`);
    try { if ((await fetch(`${url}/health`)).ok) break; } catch { /* starting */ }
    if (Date.now() > deadline) { child.kill(); throw new Error(`server not healthy: ${serverLogs}`); }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal((await (await fetch(`${url}/health`)).json()).oauth, true);
  discovery = await (await fetch(`${url}/.well-known/oauth-authorization-server`)).json();
  for (const endpoint of [discovery.authorization_endpoint, discovery.token_endpoint, discovery.registration_endpoint]) {
    assert.equal(new URL(endpoint).origin, url);
  }
});

after(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await exited;
  }
  await new Promise<void>((resolve) => xsuaa?.close(() => resolve()));
});

async function registerClient(method = 'none', redirectUri = REDIRECT_URI) {
  const response = await fetch(discovery.registration_endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [redirectUri], token_endpoint_auth_method: method, client_name: randomUUID() }),
  });
  const body = await response.json() as { client_id: string; client_secret?: string };
  return { ...body, status: response.status };
}

async function authorize(clientId: string, method = 'GET', redirectUri = REDIRECT_URI) {
  const params = new URLSearchParams({
    client_id: clientId, response_type: 'code', redirect_uri: redirectUri,
    code_challenge: challenge(VERIFIER), code_challenge_method: 'S256', state: 'client+state',
  });
  return fetch(`${discovery.authorization_endpoint}${method === 'GET' ? `?${params}` : ''}`, {
    method, redirect: 'manual',
    ...(method === 'POST' ? {
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: params,
    } : {}),
  });
}

async function issueCode(clientId: string, method = 'GET') {
  const response = await authorize(clientId, method);
  assert.equal(response.status, 302);
  const target = new URL(response.headers.get('location')!);
  assert.equal(target.origin, xsuaaUrl);
  assert.equal(target.searchParams.get('code_challenge'), challenge(VERIFIER));
  assert.equal(target.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(target.searchParams.get('redirect_uri'), `${url}/oauth/callback`);
  const upstreamResponse = await fetch(target, { redirect: 'manual' });
  const callbackUrl = upstreamResponse.headers.get('location')!;
  const rawCode = new URL(callbackUrl).searchParams.get('code')!;
  const callback = await fetch(callbackUrl, { redirect: 'manual' });
  assert.equal(callback.status, 302);
  const clientTarget = new URL(callback.headers.get('location')!);
  assert.equal(clientTarget.origin, new URL(REDIRECT_URI).origin);
  assert.equal(clientTarget.searchParams.get('state'), 'client+state');
  return { code: clientTarget.searchParams.get('code')!, rawCode, callbackUrl };
}

async function token(params: Record<string, string>) {
  return fetch(discovery.token_endpoint, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
}

function withEnv(values: Record<string, string | undefined>, action: () => void) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    action();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('R1: absent bindings stay open; malformed and incomplete bindings fail closed at both entry points', () => {
  for (const binding of [undefined, '{}', '{"destination":[]}', '{"xsuaa":[]}']) {
    withEnv({ VCAP_SERVICES: binding }, () => {
      assert.equal(isXsuaaConfigured(), false);
      const app = createHttpServer(4004);
      assert.ok(app);
    });
  }
  const credentials = { url: xsuaaUrl, clientid: CLIENT_ID, clientsecret: FAKE_SECRET, xsappname: 'fake', uaadomain: '127.0.0.1' };
  const invalid = ['', 'not-json', 'null', '[]', '{"xsuaa":null}', '{"xsuaa":[{}]}'];
  for (const key of Object.keys(credentials)) {
    invalid.push(JSON.stringify({ xsuaa: [{ credentials: { ...credentials, [key]: undefined } }] }));
  }
  for (const binding of invalid) {
    withEnv({ VCAP_SERVICES: binding }, () => {
      assert.throws(() => isXsuaaConfigured());
      assert.throws(() => createHttpServer(4004));
    });
  }
  withEnv({ VCAP_SERVICES: JSON.stringify({ xsuaa: [{ credentials }] }), PUBLIC_BASE_URL: url }, () => {
    assert.equal(isXsuaaConfigured(), true);
    assert.ok(createHttpServer(4004));
  });
});

test('R6: public URLs with a base path, query, fragment, credentials, or non-HTTP scheme are refused', () => {
  const credentials = { url: xsuaaUrl, clientid: CLIENT_ID, clientsecret: FAKE_SECRET, xsappname: 'fake', uaadomain: '127.0.0.1' };
  for (const publicUrl of ['https://proxy.example/base', 'https://proxy.example/?query=1', 'https://proxy.example/#frag', 'https://user@proxy.example', 'ftp://proxy.example']) {
    withEnv({ VCAP_SERVICES: JSON.stringify({ xsuaa: [{ credentials }] }), PUBLIC_BASE_URL: publicUrl }, () => {
      assert.throws(() => createHttpServer(4004), /HTTP\(S\) origin/);
    });
  }
});

test('F1: unauthenticated DCR does not expose the XSUAA secret for public or confidential clients', async () => {
  const legacy = await fetch(`${url}/oauth/client-registration`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(legacy.status, 404);
  for (const method of ['none', 'client_secret_post']) {
    const client = await registerClient(method);
    assert.equal(client.status, 201);
    assert.ok(client.client_id.startsWith('mcp-'));
    assert.notEqual(client.client_id, CLIENT_ID);
    assert.notEqual(client.client_secret, FAKE_SECRET);
    if (method === 'none') assert.equal(client.client_secret, undefined);
    else assert.ok(client.client_secret);
  }
});

test('F2/R5: unconfigured manual-client callbacks are rejected for authorize GET/POST and DCR', async () => {
  for (const redirectUri of ['https://attacker.example/cb', 'https://callback.mistral.ai/v1/integrations_auth/oauth2_callback']) {
    for (const method of ['GET', 'POST']) {
      const response = await authorize(CLIENT_ID, method, redirectUri);
      assert.equal(response.status, 400);
      assert.equal(response.headers.get('location'), null);
    }
    assert.equal((await registerClient('none', redirectUri)).status, 400);
  }
  await issueCode(CLIENT_ID, 'POST');
});

test('R5: valid signed callback states cannot bypass redirect policy on success or error', async () => {
  const codec = new OAuthStateCodec(FAKE_SECRET);
  const state = codec.encode({
    clientId: CLIENT_ID,
    clientRedirectUri: 'https://callback.mistral.ai/v1/integrations_auth/oauth2_callback',
    clientState: JSON.stringify({ challenge: challenge(VERIFIER), state: 'clientstate' }),
  });
  for (const reply of [{ code: 'CODE123' }, { error: 'access_denied' }]) {
    const params = new URLSearchParams({ state, ...reply });
    const response = await fetch(`${url}/oauth/callback?${params}`, { redirect: 'manual' });
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('location'), null);
  }
});

test('F2: forged callback state never forwards an authorization code', async () => {
  const response = await fetch(`${url}/oauth/callback?code=CODE123&state=forged`, { redirect: 'manual' });
  assert.equal(response.status, 400);
  assert.equal(response.headers.get('location'), null);
});

test('F2: public code exchange rejects missing/mismatched PKCE and another client before contacting XSUAA', async () => {
  const client = await registerClient();
  const other = await registerClient();
  const grant = await issueCode(client.client_id);
  for (const params of [
    { client_id: client.client_id },
    { client_id: client.client_id, code_verifier: 'wrong'.repeat(16) },
    { client_id: other.client_id, code_verifier: VERIFIER },
    { client_id: client.client_id, code_verifier: VERIFIER, redirect_uri: 'http://localhost:4004/wrong' },
  ]) {
    const count = tokenRequests.length;
    const response = await token({ grant_type: 'authorization_code', code: grant.code, ...params });
    assert.equal(response.status, 400);
    assert.equal(tokenRequests.length, count);
  }
  const count = tokenRequests.length;
  assert.equal((await token({ grant_type: 'authorization_code', code: grant.rawCode, client_id: client.client_id, code_verifier: VERIFIER })).status, 400);
  assert.equal(tokenRequests.length, count);
  const response = await token({ grant_type: 'authorization_code', code: grant.code, client_id: client.client_id, code_verifier: VERIFIER });
  assert.equal(response.status, 200);
  assert.equal(tokenRequests.length, count + 1);
  const upstream = new URLSearchParams(tokenRequests.at(-1));
  assert.equal(upstream.get('code'), grant.rawCode);
  assert.equal(upstream.get('code_verifier'), VERIFIER);
  assert.deepEqual(discovery.code_challenge_methods_supported, ['S256']);
});

test('F2: confidential clients must authenticate and still satisfy PKCE', async () => {
  const client = await registerClient('client_secret_post');
  const grant = await issueCode(client.client_id, 'POST');
  for (const secret of [undefined, 'wrong-secret']) {
    const count = tokenRequests.length;
    const response = await token({ grant_type: 'authorization_code', code: grant.code, client_id: client.client_id, code_verifier: VERIFIER, ...(secret ? { client_secret: secret } : {}) });
    assert.equal(response.status, 400);
    assert.equal(tokenRequests.length, count);
  }
  const count = tokenRequests.length;
  assert.equal((await token({ grant_type: 'authorization_code', code: grant.code, client_id: client.client_id, client_secret: client.client_secret!, code_verifier: 'bad'.repeat(22) })).status, 400);
  assert.equal(tokenRequests.length, count);
  assert.equal((await token({ grant_type: 'authorization_code', code: grant.code, client_id: client.client_id, client_secret: client.client_secret!, code_verifier: VERIFIER })).status, 200);
});

test('F2: refresh ownership survives rotation and applies to public/confidential clients and revocation', async () => {
  for (const method of ['none', 'client_secret_post']) {
    const client = await registerClient(method);
    const other = await registerClient();
    const grant = await issueCode(client.client_id);
    const auth = { client_id: client.client_id, ...(client.client_secret ? { client_secret: client.client_secret } : {}) };
    const issued = await (await token({ grant_type: 'authorization_code', code: grant.code, code_verifier: VERIFIER, ...auth })).json() as { refresh_token: string };
    let refresh = issued.refresh_token;
    for (let rotation = 0; rotation < 2; rotation++) {
      const count = tokenRequests.length;
      assert.equal((await token({ grant_type: 'refresh_token', refresh_token: refresh, client_id: other.client_id })).status, 400);
      assert.equal(tokenRequests.length, count);
      if (method !== 'none') {
        assert.equal((await token({ grant_type: 'refresh_token', refresh_token: refresh, client_id: client.client_id })).status, 400);
        assert.equal(tokenRequests.length, count);
      }
      const response = await token({ grant_type: 'refresh_token', refresh_token: refresh, ...auth });
      assert.equal(response.status, 200);
      refresh = (await response.json()).refresh_token;
    }
    const rawRefresh = [...refreshTokens].at(-1)!;
    const count = tokenRequests.length;
    assert.equal((await token({ grant_type: 'refresh_token', refresh_token: rawRefresh, ...auth })).status, 400);
    assert.equal(tokenRequests.length, count);
    const revokedCount = revokedTokens.length;
    const revoke = (clientAuth: Record<string, string>) => fetch(discovery.revocation_endpoint, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refresh, token_type_hint: 'refresh_token', ...clientAuth }),
    });
    await revoke({ client_id: other.client_id });
    assert.equal(revokedTokens.length, revokedCount);
    assert.equal((await revoke(auth)).status, 200);
    assert.equal(revokedTokens.at(-1), rawRefresh);
  }
});

test('F2: code redemption without any client identity never reaches XSUAA', async () => {
  const count = tokenRequests.length;
  assert.equal((await token({ grant_type: 'authorization_code', code: 'CODE123' })).status, 400);
  assert.equal(tokenRequests.length, count);
});

test('F17: valid signed callback state reaches the HTML-escaping error page', async () => {
  const client = await registerClient();
  const response = await authorize(client.client_id);
  const state = new URL(response.headers.get('location')!).searchParams.get('state')!;
  const payload = '<script>alert("x")</script>';
  const params = new URLSearchParams({ state, error: payload, error_description: payload });
  const callback = await fetch(`${url}/oauth/callback?${params}`, { redirect: 'manual' });
  assert.equal(callback.status, 400);
  assert.equal(callback.headers.get('location'), null);
  const html = await callback.text();
  assert.equal(html.includes(payload), false);
  assert.ok(html.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'));
});

test('F17: the advertised token endpoint rejects GET and redacts refresh tokens and codes from logs', async () => {
  const marker = serverLogs.length;
  const count = tokenRequests.length;
  const response = await fetch(`${discovery.token_endpoint}?grant_type=refresh_token&refresh_token=RT-SENTINEL-123`);
  assert.equal(response.status, 405);
  assert.equal(tokenRequests.length, count);
  await fetch(`${url}/oauth/callback?code=CODE-SENTINEL-999&state=zz`, { redirect: 'manual' });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const fresh = serverLogs.slice(marker);
  assert.equal(fresh.includes('RT-SENTINEL-123'), false);
  assert.equal(fresh.includes('CODE-SENTINEL-999'), false);
  assert.ok(fresh.includes(`${new URL(discovery.token_endpoint).pathname}?<redacted>`));
  assert.ok(fresh.includes('/oauth/callback?<redacted>'));
});

test('F17/R4: discovery uses the pinned public origin despite Host and ambient CF metadata', async () => {
  const response = await fetch(`${url}/.well-known/oauth-authorization-server`, { headers: { host: 'evil.example' } });
  const meta = await response.json() as Record<string, string>;
  for (const key of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint', 'issuer']) {
    assert.equal(new URL(meta[key]).origin, url);
  }
});
