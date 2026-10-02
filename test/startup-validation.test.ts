// End-to-end startup tests for the config-validation gaps that used to crash
// late (inside the per-session factory) instead of at startup:
//   - F12: an ENABLED_API_CATEGORIES value matching no entity set stops the
//     server at startup with a clear message instead of silently registering
//     zero tools.
//   - F10: a config that passes schema validation but would fail during tool
//     registration (a UI view referencing an unknown api) is caught by the
//     startup self-check (the throwaway session) rather than on first connect.
// Run `npm run build` first (the `npm test` script does).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const serverEntry = join(rootDir, 'dist', 'index.js');
const cliEntry = join(rootDir, 'dist', 'cli.js');

async function boot(config: unknown, extraEnv: Record<string, string> = {}, timeoutMs = 30_000, entry = serverEntry): Promise<{ status: number | null; output: string; stdout: string; stderr: string }> {
  assert.ok(existsSync(entry), `${entry} missing — run \`npm run build\` first`);
  const dir = mkdtempSync(join(rootDir, '.startup-test-'));
  const file = join(dir, 'api-config.json');
  try {
    writeFileSync(file, JSON.stringify(config));
    const env = { ...(process.env as Record<string, string>) };
    delete env.VCAP_SERVICES;
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [entry], {
        cwd: rootDir,
        env: { ...env, MCP_TRANSPORT: 'stdio', API_CONFIG_FILE: file, LOG_LEVEL: 'error', ...extraEnv },
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: timeoutMs,
      });
      // Keep stdin open, as an MCP client would, so EOF cannot mask a failure.
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (status) => resolve({ status, output: `${stdout}${stderr}`, stdout, stderr }));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const categorisedConfig = {
  server: { name: 's' },
  apis: [{
    name: 'a',
    destination: 'DEST',
    entitySets: [
      { entitySet: 'E1', category: 'monitoring', keys: [{ name: 'Id', type: 'string' }], operations: { list: true } },
    ],
  }],
};

const unknownApiConfig = {
  server: { name: 's' },
  apis: [{
    name: 'a',
    destination: 'DEST',
    entitySets: [{ entitySet: 'E1', keys: [{ name: 'Id', type: 'string' }], operations: { list: true } }],
  }],
  ui: [{ tool: 'UI_X', uri: 'ui://x', template: 't.html', data: { src: { api: 'nope', path: '/x' } } }],
};

for (const entry of [serverEntry, cliEntry]) {
  test(`an unknown ENABLED_API_CATEGORIES value fails startup instead of registering nothing (F12, ${entry})`, async () => {
    const { status, output, stdout, stderr } = await boot(categorisedConfig, { ENABLED_API_CATEGORIES: 'bogus' }, 30_000, entry);
    assert.equal(status, 1, output);
    assert.equal(stdout, '', output);
    assert.ok(stderr.includes('ENABLED_API_CATEGORIES references categor'), output);
    assert.ok(stderr.includes('bogus'), output);
    assert.ok(stderr.includes('monitoring'), output);
  });

  test(`a UI view referencing an unknown api fails stdio startup (F10, ${entry})`, async () => {
    const { status, output, stdout, stderr } = await boot(unknownApiConfig, { ENABLED_API_CATEGORIES: 'all' }, 30_000, entry);
    assert.equal(status, 1, output);
    assert.equal(stdout, '', output);
    assert.ok(stderr.includes('references unknown api "nope"'), output);
  });
}

test('a known ENABLED_API_CATEGORIES value does not trip the check (F12)', async () => {
  // With a valid category the server reaches the "running on stdio transport"
  // log and then blocks on stdin; a short timeout kills it afterwards. Seeing
  // that log proves it got past both the category check and the startup
  // self-check without rejecting a valid config.
  const { output } = await boot(categorisedConfig, { ENABLED_API_CATEGORIES: 'monitoring', LOG_LEVEL: 'info' }, 10_000);
  assert.ok(output.includes('running on stdio transport'), output);
  assert.ok(!output.includes('ENABLED_API_CATEGORIES references'), output);
});

test('startup accepts duplicate entity names when only one category is enabled (F10)', async () => {
  const config = {
    ...categorisedConfig,
    apis: [
      ...categorisedConfig.apis,
      {
        name: 'b', destination: 'DEST_B',
        entitySets: categorisedConfig.apis[0].entitySets.map((entity) => ({ ...entity, category: 'artifacts' })),
      },
    ],
  };
  const { output } = await boot(config, { ENABLED_API_CATEGORIES: 'monitoring', LOG_LEVEL: 'info' }, 10_000);
  assert.ok(output.includes('running on stdio transport'), output);
  assert.ok(!output.includes('duplicate tool name'), output);
});

test('a UI view referencing an unknown api fails HTTP startup before listening (F10)', async () => {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));

  const { status, output } = await boot(unknownApiConfig, {
    MCP_TRANSPORT: 'http', PORT: String(port), LOG_LEVEL: 'info', ENABLED_API_CATEGORIES: 'all',
  });
  assert.equal(status, 1, output);
  assert.ok(output.includes('references unknown api "nope"'), output);
  assert.ok(!output.includes('HTTP server listening'), output);
});
