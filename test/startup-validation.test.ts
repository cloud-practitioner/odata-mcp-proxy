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
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const serverEntry = join(rootDir, 'dist', 'index.js');

/** Boot the built server over stdio with a written config + env, return exit. */
function boot(config: unknown, extraEnv: Record<string, string> = {}, timeoutMs = 30_000): { status: number | null; output: string; file: string } {
  assert.ok(existsSync(serverEntry), 'dist/index.js missing — run `npm run build` first');
  const dir = mkdtempSync(join(tmpdir(), 'odata-mcp-proxy-startup-'));
  const file = join(dir, 'api-config.json');
  try {
    writeFileSync(file, JSON.stringify(config));
    const env = { ...(process.env as Record<string, string>) };
    delete env.VCAP_SERVICES;
    const result = spawnSync(process.execPath, [serverEntry], {
      cwd: rootDir,
      env: { ...env, MCP_TRANSPORT: 'stdio', API_CONFIG_FILE: file, LOG_LEVEL: 'error', ...extraEnv },
      input: '',
      encoding: 'utf8',
      timeout: timeoutMs,
    });
    // The failure is reported on whichever stream the process used before exit;
    // combine both so the assertions do not depend on that detail.
    return { status: result.status, output: `${result.stdout}${result.stderr}`, file };
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

test('an unknown ENABLED_API_CATEGORIES value fails startup instead of registering nothing (F12)', () => {
  const { status, output } = boot(categorisedConfig, { ENABLED_API_CATEGORIES: 'bogus' });
  assert.notEqual(status, 0);
  assert.ok(output.includes('ENABLED_API_CATEGORIES references categor'), output);
  assert.ok(output.includes('bogus'), output);
  assert.ok(output.includes('monitoring'), output);
});

test('a known ENABLED_API_CATEGORIES value does not trip the check (F12)', () => {
  // With a valid category the server reaches the "running on stdio transport"
  // log and then blocks on stdin; a short timeout kills it afterwards. Seeing
  // that log proves it got past both the category check and the startup
  // self-check without rejecting a valid config.
  const { output } = boot(categorisedConfig, { ENABLED_API_CATEGORIES: 'monitoring', LOG_LEVEL: 'info' }, 10_000);
  assert.ok(output.includes('running on stdio transport'), output);
  assert.ok(!output.includes('ENABLED_API_CATEGORIES references'), output);
});

test('a UI view referencing an unknown api fails startup via the self-check (F10)', () => {
  const config = {
    server: { name: 's' },
    apis: [{
      name: 'a',
      destination: 'DEST',
      entitySets: [{ entitySet: 'E1', keys: [{ name: 'Id', type: 'string' }], operations: { list: true } }],
    }],
    ui: [{ tool: 'UI_X', uri: 'ui://x', template: 't.html', data: { src: { api: 'nope', path: '/x' } } }],
  };
  const { status, output } = boot(config);
  assert.notEqual(status, 0);
  assert.ok(output.includes('references unknown api "nope"'), output);
});
