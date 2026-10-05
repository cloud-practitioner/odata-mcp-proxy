import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { XsuaaCredentials, Logger } from '@arc-mcp/xsuaa-auth';
import {
  resolveRedirectUris,
  setupXsuaaAuth,
  XS_SECURITY_JSON_PATH_ENV,
} from '../src/server/oauth.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const consumingFixture = join(fixturesDir, 'redirect', 'consuming-xs-security.json');

const CLAUDE_REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const TEAMS_REDIRECT = 'https://teams.microsoft.com/api/platform/v1.0/oAuthRedirect';
const CURSOR_REDIRECT = 'http://localhost:3000/oauth/callback';
const INSPECTOR_REDIRECT = 'http://localhost:6274/callback';
const ATTACKER_REDIRECT = 'https://attacker.example/cb';

function capturingLogger() {
  const infos: string[] = [];
  const logger: Logger = {
    debug() {},
    info(message) { infos.push(message); },
    warn() {},
    error() {},
  };
  return { logger, infos };
}

/** Run `fn` with a temporary working directory, restoring the previous cwd afterwards. */
function withCwd<T>(setup: (dir: string) => void, fn: () => T): T {
  const previous = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), 'redirect-allowlist-'));
  try {
    setup(dir);
    process.chdir(dir);
    return fn();
  } finally {
    process.chdir(previous);
    rmSync(dir, { recursive: true, force: true });
  }
}

test('resolveRedirectUris: a consuming app xs-security.json in the working directory is honoured', () => {
  const { logger, infos } = capturingLogger();
  const patterns = withCwd(
    (dir) => copyFileSync(consumingFixture, join(dir, 'xs-security.json')),
    () => resolveRedirectUris({}, logger),
  );
  assert.ok(patterns.includes(CLAUDE_REDIRECT), 'claude.ai redirect honoured');
  assert.ok(patterns.includes(TEAMS_REDIRECT), 'Teams redirect honoured');
  assert.ok(patterns.includes(CURSOR_REDIRECT), 'Cursor redirect honoured');
  assert.ok(patterns.includes('http://localhost:6274/**'), 'MCP Inspector redirect honoured');
  assert.ok(!patterns.some((uri) => uri.includes('cfapps')), 'bundled CF routes not used');
  assert.ok(infos.some((m) => m.includes('working-directory xs-security.json')), 'logs working-directory source');
});

test('resolveRedirectUris: the env-var override wins over the working directory', () => {
  const { logger, infos } = capturingLogger();
  // cwd has a DIFFERENT xs-security.json; the explicit env path must still win.
  const patterns = withCwd(
    (dir) => writeFileSync(
      join(dir, 'xs-security.json'),
      JSON.stringify({ 'oauth2-configuration': { 'redirect-uris': ['https://only-in-cwd.example/cb'] } }),
    ),
    () => resolveRedirectUris({ [XS_SECURITY_JSON_PATH_ENV]: consumingFixture }, logger),
  );
  assert.ok(patterns.includes(CLAUDE_REDIRECT), 'env-var list honoured');
  assert.ok(!patterns.includes('https://only-in-cwd.example/cb'), 'working-directory list ignored');
  assert.ok(infos.some((m) => m.includes(XS_SECURITY_JSON_PATH_ENV)), 'logs env-var source');
});

test('resolveRedirectUris: a relative env-var path resolves against the working directory', () => {
  const { logger } = capturingLogger();
  const patterns = withCwd(
    (dir) => copyFileSync(consumingFixture, join(dir, 'custom-xs-security.json')),
    () => resolveRedirectUris({ [XS_SECURITY_JSON_PATH_ENV]: 'custom-xs-security.json' }, logger),
  );
  assert.ok(patterns.includes(CLAUDE_REDIRECT), 'relative env-var path resolved against cwd');
});

test('resolveRedirectUris: falls back to the bundled list when neither env nor cwd file exists', () => {
  const { logger, infos } = capturingLogger();
  const patterns = withCwd(() => {}, () => resolveRedirectUris({}, logger));
  assert.ok(patterns.some((uri) => uri.includes('cfapps')), 'bundled CF routes present');
  assert.ok(!patterns.includes(CLAUDE_REDIRECT), 'bundled list does not include claude.ai');
  assert.ok(infos.some((m) => m.includes('bundled xs-security.json')), 'logs bundled source');
});

test('resolveRedirectUris: a bad explicit path fails rather than silently falling back', () => {
  const { logger } = capturingLogger();
  assert.throws(
    () => resolveRedirectUris({ [XS_SECURITY_JSON_PATH_ENV]: '/no/such/xs-security.json' }, logger),
    (err: Error) => err.message.includes(XS_SECURITY_JSON_PATH_ENV) && err.message.includes('/no/such/xs-security.json'),
  );
});

test('setupXsuaaAuth: registration honours the consuming list and refuses absent redirects', async () => {
  const { logger } = capturingLogger();
  const credentials: XsuaaCredentials = {
    url: 'http://127.0.0.1:1/unused',
    clientid: 'sb-consuming!t1',
    clientsecret: 'test-secret-for-codecs',
    xsappname: 'ci-mcp-server',
    uaadomain: '127.0.0.1',
  };
  const app = express();
  app.use(express.json());
  let server: Server | undefined;
  const previousEnv = process.env[XS_SECURITY_JSON_PATH_ENV];
  process.env[XS_SECURITY_JSON_PATH_ENV] = consumingFixture;
  try {
    const port = await new Promise<number>((resolve) => {
      server = createServer(app);
      server.listen(0, '127.0.0.1', () => resolve((server!.address() as AddressInfo).port));
    });
    const appUrl = `http://127.0.0.1:${port}`;
    setupXsuaaAuth(app, credentials, appUrl, logger);

    const discovery = await (await fetch(`${appUrl}/.well-known/oauth-authorization-server`)).json();
    const register = (redirectUri: string) => fetch(discovery.registration_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [redirectUri], token_endpoint_auth_method: 'none', client_name: 'test' }),
    });

    for (const redirectUri of [CLAUDE_REDIRECT, TEAMS_REDIRECT, CURSOR_REDIRECT, INSPECTOR_REDIRECT]) {
      const response = await register(redirectUri);
      assert.equal(response.status, 201, `registration should succeed for ${redirectUri}`);
      const body = await response.json();
      assert.ok(body.client_id, `client_id issued for ${redirectUri}`);
    }

    const refused = await register(ATTACKER_REDIRECT);
    assert.equal(refused.status, 400, 'attacker redirect refused');
    assert.equal((await refused.json()).error, 'invalid_client_metadata');
  } finally {
    if (previousEnv === undefined) delete process.env[XS_SECURITY_JSON_PATH_ENV];
    else process.env[XS_SECURITY_JSON_PATH_ENV] = previousEnv;
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  }
});
