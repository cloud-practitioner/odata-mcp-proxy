// Unit test: the HTTP /health endpoint reports the version declared in
// package.json rather than a hard-coded string, so releases stay in sync.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { createHttpServer } from '../src/server/http.js';
import { XsuaaAuth } from '../src/auth/xsuaa-auth.js';

const { version: packageVersion } = createRequire(import.meta.url)('../package.json') as {
  version: string;
};

test('/health reports the package.json version', async () => {
  const app = createHttpServer(0, new XsuaaAuth());
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; version: string };
    assert.equal(body.status, 'ok');
    assert.equal(body.version, packageVersion);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
