// End-to-end test: boots the built server (dist/index.js) over stdio against a
// local HTTP stub standing in for the OAuth token endpoint and SAP CPI, and
// asserts that the update operation sends the HTTP method configured in
// `operations.update.method` (PUT for CPI externalized parameters, which
// replace rather than merge) through both the generated `_update` tool and the
// discovery `execute_operation` executor, that PATCH stays the default, and
// that a malformed API config stops the server at startup. Run
// `npm run build` first.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = join(rootDir, 'test', 'fixtures', 'e2e-method-config.json');
const serverEntry = join(rootDir, 'dist', 'index.js');

const CONFIGURATION = "IntegrationDesigntimeArtifacts(Id='F',Version='active')/$links/Configurations('k')";

interface Recorded { method: string; url: string; body: unknown }

let stub: Server;
let baseUrl: string;
const requests: Recorded[] = [];

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

before(async () => {
  stub = createServer(async (req, res) => {
    const body = await readBody(req);
    const url = decodeURIComponent(req.url ?? '');

    if (url === '/oauth/token') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'stub-token', expires_in: 3600 }));
      return;
    }
    if (String(req.headers['x-csrf-token']).toLowerCase() === 'fetch') {
      res.writeHead(200, { 'x-csrf-token': 'stub-csrf' });
      res.end();
      return;
    }
    requests.push({
      method: req.method ?? '',
      url,
      body: body.length > 0 ? JSON.parse(body.toString('utf8')) : undefined,
    });
    res.writeHead(204);
    res.end();
  });
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
});

after(() => {
  stub.close();
});

function serverEnv(apiConfigFile: string): Record<string, string> {
  const env = { ...(process.env as Record<string, string>) };
  delete env.VCAP_SERVICES;
  return {
    ...env,
    MCP_TRANSPORT: 'stdio',
    API_CONFIG_FILE: apiConfigFile,
    LOG_LEVEL: 'error',
    E2E_METHOD_DEST_BASE_URL: baseUrl,
    E2E_METHOD_DEST_TOKEN_URL: `${baseUrl}/oauth/token`,
    E2E_METHOD_DEST_CLIENT_ID: 'id',
    E2E_METHOD_DEST_CLIENT_SECRET: 'secret',
  };
}

async function withClient(fn: (client: Client) => Promise<void>, apiConfigFile = configPath): Promise<void> {
  assert.ok(existsSync(serverEntry), 'dist/index.js missing - run `npm run build` first');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    cwd: rootDir,
    env: serverEnv(apiConfigFile),
  });
  const client = new Client({ name: 'e2e-method-test', version: '0.0.0' });
  await client.connect(transport);
  try {
    await fn(client);
  } finally {
    await client.close();
  }
}

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

function textOf(result: ToolResult): string {
  assert.equal(result.content[0].type, 'text');
  return result.content[0].text ?? '';
}

/** Call a tool and return the single backend request it produced. */
async function backendRequest(client: Client, name: string, args: Record<string, unknown>): Promise<Recorded> {
  requests.length = 0;
  const result = await call(client, name, args);
  assert.ok(!result.isError, textOf(result));
  assert.equal(requests.length, 1, `expected one backend request, got ${JSON.stringify(requests)}`);
  return requests[0];
}

test('update tool configured with method PUT sends PUT with the body', async () => {
  await withClient(async (client) => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'IntegrationFlowConfigurations_update');
    assert.ok(tool, 'IntegrationFlowConfigurations_update must be registered');
    assert.match(tool.description ?? '', /\(PUT\)/);

    const request = await backendRequest(client, 'IntegrationFlowConfigurations_update', {
      path: "(Id='F',Version='active')/$links/Configurations('k')",
      body: { ParameterValue: 'v2' },
    });
    assert.deepEqual(request, { method: 'PUT', url: `/api/v1/${CONFIGURATION}`, body: { ParameterValue: 'v2' } });
  });
});

test('discovery execute_operation update sends the configured PUT', async () => {
  await withClient(async (client) => {
    const request = await backendRequest(client, 'execute_operation', {
      api: 'cpi',
      entitySet: 'IntegrationFlowConfigurations',
      operation: 'update',
      path: "(Id='F',Version='active')/$links/Configurations('k')",
      body: { ParameterValue: 'v2' },
    });
    assert.deepEqual(request, { method: 'PUT', url: `/api/v1/${CONFIGURATION}`, body: { ParameterValue: 'v2' } });

    const search = await call(client, 'search_operations', { query: 'IntegrationFlowConfigurations', detail: 'full' });
    const entry = (JSON.parse(textOf(search)) as { results: Array<{ entitySet: string; operationDetails: Array<{ operation: string; method: string }> }> })
      .results.find((r) => r.entitySet === 'IntegrationFlowConfigurations');
    assert.deepEqual(entry?.operationDetails, [
      { operation: 'update', method: 'PUT', requiresKeysInPath: true, requiresBody: true },
    ]);
  });
});

test('update without a configured method still sends PATCH', async () => {
  await withClient(async (client) => {
    const { tools } = await client.listTools();
    assert.match(tools.find((t) => t.name === 'IntegrationPackages_update')?.description ?? '', /\(PATCH\)/);

    const viaTool = await backendRequest(client, 'IntegrationPackages_update', {
      path: "('P')",
      body: { Name: 'renamed' },
    });
    assert.deepEqual(viaTool, { method: 'PATCH', url: "/api/v1/IntegrationPackages('P')", body: { Name: 'renamed' } });

    const viaDiscovery = await backendRequest(client, 'execute_operation', {
      api: 'cpi',
      entitySet: 'IntegrationPackages',
      operation: 'update',
      path: "('P')",
      body: { Name: 'renamed' },
    });
    assert.equal(viaDiscovery.method, 'PATCH');
  });
});

// ─── Startup validation ──────────────────────────────────────────────────────

/** Boot the server against a mutated copy of the fixture and return how it exited. */
function startWith(mutate: (config: any) => void): { status: number | null; stderr: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'odata-mcp-proxy-method-'));
  const file = join(dir, 'api-config.json');
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    mutate(config);
    writeFileSync(file, JSON.stringify(config));
    const result = spawnSync(process.execPath, [serverEntry], {
      cwd: rootDir,
      env: serverEnv(file),
      input: '',
      encoding: 'utf8',
      timeout: 30_000,
    });
    return { status: result.status, stderr: result.stderr, file };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('an invalid update method fails startup with a clear message', () => {
  const { status, stderr, file } = startWith((config) => {
    config.apis[0].entitySets[0].operations.update.method = 'POST';
  });
  assert.notEqual(status, 0);
  assert.ok(stderr.includes(`API config validation failed for ${file}`), stderr);
  assert.ok(
    stderr.includes("apis[0].entitySets[0].operations.update.method: Invalid enum value. Expected 'PATCH' | 'PUT', received 'POST'"),
    stderr,
  );
});

test('a misspelled operations key fails startup with a clear message', () => {
  const { status, stderr } = startWith((config) => {
    config.apis[0].entitySets[0].operations.update = { enabled: true, requiredscope: 'write' };
  });
  assert.notEqual(status, 0);
  assert.ok(
    stderr.includes("apis[0].entitySets[0].operations.update: Unrecognized key(s) in object: 'requiredscope'"),
    stderr,
  );
});

test('a config omitting optional fields still starts, registers its tools and applies the defaults', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'odata-mcp-proxy-method-'));
  const file = join(dir, 'api-config.json');
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    delete config.server.version;
    delete config.server.description;
    delete config.apis[0].name;
    delete config.apis[0].pathPrefix;
    for (const entity of config.apis[0].entitySets) {
      delete entity.description;
      delete entity.category;
    }
    config.apis[0].entitySets[1].navigationProperties = [{ name: 'IntegrationDesigntimeArtifacts' }];
    writeFileSync(file, JSON.stringify(config));

    await withClient(async (client) => {
      const packageVersion = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8')).version;
      assert.equal(client.getServerVersion()?.version, packageVersion);

      const { tools } = await client.listTools();
      assert.match(tools.find((t) => t.name === 'IntegrationPackages_update')?.description ?? '', /^Update an existing IntegrationPackages \(PATCH\)/);
      assert.ok(tools.some((t) => t.name === 'IntegrationPackages_IntegrationDesigntimeArtifacts_list'));

      const viaDiscovery = await backendRequest(client, 'execute_operation', {
        api: 'api0',
        entitySet: 'IntegrationPackages',
        operation: 'update',
        path: "('P')",
        body: { Name: 'renamed' },
      });
      assert.deepEqual(viaDiscovery, { method: 'PATCH', url: "/api/v1/IntegrationPackages('P')", body: { Name: 'renamed' } });

      const schema = await client.readResource({ uri: 'odata://api0/IntegrationPackages' });
      assert.equal((JSON.parse(String(schema.contents[0].text)) as { api: string }).api, 'api0');

      const request = await backendRequest(client, 'IntegrationFlowConfigurations_update', {
        path: "(Id='F',Version='active')/$links/Configurations('k')",
        body: { ParameterValue: 'v2' },
      });
      assert.deepEqual(request, { method: 'PUT', url: `/api/v1/${CONFIGURATION}`, body: { ParameterValue: 'v2' } });
    }, file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
