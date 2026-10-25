// MCP_READ_ONLY=true: write operations are removed from every entity set, so no
// write tool is registered or discoverable, and the client refuses any request
// other than GET.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn } from 'node:child_process';
import { applyReadOnly, parseReadOnly } from '../src/config/read-only.js';
import { loadConfig } from '../src/config/index.js';
import { ODataClient } from '../src/client/odata-client.js';
import type { EntitySetDefinition } from '../src/tools/registry.js';

function entitySet(): EntitySetDefinition {
  return {
    entitySet: 'Packages',
    description: 'integration packages',
    category: 'artifacts',
    keys: [{ name: 'Id', type: 'string' }],
    operations: {
      list: true,
      get: { enabled: true, requiredScope: 'read' },
      create: true,
      update: { enabled: true, requiredScope: 'write' },
      delete: true,
    },
  } as EntitySetDefinition;
}

test('applyReadOnly disables create, update and delete and keeps list and get', () => {
  const apis = [{ entitySets: [entitySet(), entitySet()] }];
  applyReadOnly(apis);
  for (const set of apis[0].entitySets) {
    assert.equal(set.operations.list, true);
    assert.deepEqual(set.operations.get, { enabled: true, requiredScope: 'read' });
    assert.equal(set.operations.create, false);
    assert.equal(set.operations.update, false);
    assert.equal(set.operations.delete, false);
  }
});

test('a read-only client refuses every write without reaching the destination', async () => {
  let reached = 0;
  const client = new ODataClient(async () => { reached++; throw new Error('destination reached'); }, '/api/v1', 1000, true, true);
  for (const call of [
    () => client.post('Packages', { Id: 'X' }),
    () => client.patch("Packages('X')", { Name: 'Y' }),
    () => client.put("Packages('X')", { Name: 'Y' }),
    () => client.delete("Packages('X')"),
    () => client.execute('POST', 'Packages', { Id: 'X' }),
    () => client.execute('merge', "Packages('X')", { Name: 'Y' }),
  ]) {
    await assert.rejects(call(), /read-only/i);
  }
  assert.equal(reached, 0);
});

test('a read-only client still sends GET', async () => {
  let reached = 0;
  const client = new ODataClient(async () => { reached++; throw new Error('destination reached'); }, '/api/v1', 1000, true, true);
  await assert.rejects(client.execute('GET', 'Packages'), /destination reached/);
  await assert.rejects(client.get('Packages'), /destination reached/);
  assert.equal(reached, 2);
});

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');

async function listToolNames(readOnly: boolean | string): Promise<string[]> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    MCP_TRANSPORT: 'stdio',
    API_CONFIG_FILE: join(rootDir, 'test', 'fixtures', 'read-only-config.json'),
    LOG_LEVEL: 'error',
  };
  if (typeof readOnly === 'string') env.MCP_READ_ONLY = readOnly;
  else if (readOnly) env.MCP_READ_ONLY = 'true';
  else delete env.MCP_READ_ONLY;
  const client = new Client({ name: 'read-only-test', version: '0.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(rootDir, 'dist', 'index.js')], cwd: rootDir, env }));
  try {
    return (await client.listTools()).tools.map((t) => t.name);
  } finally {
    await client.close();
  }
}

test('the stdio server registers no write tool in read-only mode', async () => {
  const writable = await listToolNames(false);
  for (const name of ['Packages_list', 'Packages_get', 'Packages_create', 'Packages_update', 'Packages_delete']) {
    assert.ok(writable.includes(name), `${name} missing without read-only mode`);
  }
  const readOnly = await listToolNames(true);
  assert.ok(readOnly.includes('Packages_list'));
  assert.ok(readOnly.includes('Packages_get'));
  for (const name of ['Packages_create', 'Packages_update', 'Packages_delete']) {
    assert.ok(!readOnly.includes(name), `${name} registered in read-only mode`);
  }
});

test('a client without read-only mode still sends writes', async () => {
  let reached = 0;
  const client = new ODataClient(async () => { reached++; throw new Error('destination reached'); });
  await assert.rejects(client.post('Packages', { Id: 'X' }), /destination reached/);
  assert.equal(reached, 1);
});

// ─── MCP_READ_ONLY value parsing ─────────────────────────────────────────────
// "true"/"false" (any case) and "1"/"0" are accepted; unset or empty is off;
// any other value refuses startup so a typo cannot silently grant write access.

const WRITE_TOOLS = ['Packages_create', 'Packages_update', 'Packages_delete'];

test('parseReadOnly accepts true and 1 in any case, with surrounding whitespace', () => {
  for (const value of ['true', 'TRUE', 'True', 'tRuE', '1', ' true ', ' 1\n']) {
    assert.equal(parseReadOnly(value), true, JSON.stringify(value));
  }
});

test('parseReadOnly treats false, 0, unset and empty as off', () => {
  for (const value of ['false', 'FALSE', 'False', '0', '', '   ', undefined]) {
    assert.equal(parseReadOnly(value), false, JSON.stringify(value));
  }
});

test('parseReadOnly rejects every other value', () => {
  for (const value of ['yes', 'no', 'on', 'off', 'y', 't', 'tru', 'truee', '2', '-1', '01', '10', 'true,false', 'enabled']) {
    assert.equal(parseReadOnly(value), undefined, JSON.stringify(value));
  }
});

test('loadConfig maps MCP_READ_ONLY to readOnly and refuses an unknown value naming the variable', () => {
  const previous = process.env.MCP_READ_ONLY;
  try {
    for (const [value, expected] of [['TRUE', true], ['1', true], ['false', false], ['0', false], ['', false]] as const) {
      process.env.MCP_READ_ONLY = value;
      assert.equal(loadConfig().readOnly, expected, JSON.stringify(value));
    }
    delete process.env.MCP_READ_ONLY;
    assert.equal(loadConfig().readOnly, false);

    for (const value of ['yes', 'on', '2']) {
      process.env.MCP_READ_ONLY = value;
      assert.throws(
        () => loadConfig(),
        (error: Error) =>
          error.message.includes('MCP_READ_ONLY') &&
          error.message.includes(`"${value}"`) &&
          error.message.includes('true, false, 1, 0'),
        value,
      );
    }
  } finally {
    if (previous === undefined) delete process.env.MCP_READ_ONLY;
    else process.env.MCP_READ_ONLY = previous;
  }
});

for (const value of ['TRUE', 'True', '1']) {
  test(`the stdio server registers no write tool with MCP_READ_ONLY=${value}`, async () => {
    const names = await listToolNames(value);
    assert.ok(names.includes('Packages_list'));
    assert.ok(names.includes('Packages_get'));
    for (const name of WRITE_TOOLS) assert.ok(!names.includes(name), `${name} registered with MCP_READ_ONLY=${value}`);
  });
}

for (const value of ['false', 'FALSE', '0', '']) {
  test(`the stdio server keeps write tools with MCP_READ_ONLY=${JSON.stringify(value)}`, async () => {
    const names = await listToolNames(value);
    for (const name of WRITE_TOOLS) assert.ok(names.includes(name), `${name} missing with MCP_READ_ONLY=${JSON.stringify(value)}`);
  });
}

for (const value of ['yes', 'on', 'truee']) {
  test(`the stdio server refuses to start with MCP_READ_ONLY=${value}`, async () => {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      MCP_TRANSPORT: 'stdio',
      API_CONFIG_FILE: join(rootDir, 'test', 'fixtures', 'read-only-config.json'),
      LOG_LEVEL: 'error',
      MCP_READ_ONLY: value,
    };
    const child = spawn(process.execPath, [join(rootDir, 'dist', 'index.js')], {
      cwd: rootDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30_000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    const status = await new Promise<number | null>((resolve) => child.on('close', resolve));
    assert.equal(status, 1, stderr);
    assert.equal(stdout, '');
    assert.match(stderr, /MCP_READ_ONLY/);
    assert.ok(stderr.includes(`"${value}"`), stderr);
    assert.match(stderr, /Accepted values: true, false, 1, 0/);
  });
}
