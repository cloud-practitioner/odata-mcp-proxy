// MCP_READ_ONLY=true: write operations are removed from every entity set, so no
// write tool is registered or discoverable, and the client refuses any request
// other than GET.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { applyReadOnly } from '../src/config/read-only.js';
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

async function listToolNames(readOnly: boolean): Promise<string[]> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    MCP_TRANSPORT: 'stdio',
    API_CONFIG_FILE: join(rootDir, 'test', 'fixtures', 'read-only-config.json'),
    LOG_LEVEL: 'error',
  };
  if (readOnly) env.MCP_READ_ONLY = 'true';
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
