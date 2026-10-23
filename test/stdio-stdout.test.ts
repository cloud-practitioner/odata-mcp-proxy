// Over stdio, stdout carries the JSON-RPC stream and nothing else. Boots the built
// server (dist/index.js) at the default log level and checks that every line it
// writes to stdout is a JSON-RPC message. Run `npm run build` first (the `npm test`
// script does).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = join(rootDir, 'test', 'fixtures', 'e2e-config.json');
const serverEntry = join(rootDir, 'dist', 'index.js');

test('stdio server writes only JSON-RPC to stdout at LOG_LEVEL=info', async () => {
  assert.ok(existsSync(serverEntry), 'dist/index.js missing — run `npm run build` first');

  const child = spawn(process.execPath, [serverEntry], {
    cwd: rootDir,
    env: {
      ...process.env,
      MCP_TRANSPORT: 'stdio',
      API_CONFIG_FILE: configPath,
      LOG_LEVEL: 'info',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });

  try {
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'stdout-test', version: '0.0.0' } },
    }) + '\n');

    const deadline = Date.now() + 15000;
    while (!stdout.split('\n').some((l) => l.includes('"id":1')) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }

    const lines = stdout.split('\n').filter((l) => l.trim() !== '');
    assert.ok(lines.length > 0, `no answer on stdout; stderr: ${stderr.slice(0, 500)}`);
    for (const line of lines) {
      let message: { jsonrpc?: string } | undefined;
      try {
        message = JSON.parse(line);
      } catch {
        assert.fail(`stdout line is not JSON-RPC: ${line.slice(0, 200)}`);
      }
      assert.equal(message?.jsonrpc, '2.0', `stdout line is not JSON-RPC: ${line.slice(0, 200)}`);
    }
    assert.ok(stderr.length > 0, 'the info-level startup logs should appear on stderr');
  } finally {
    child.kill();
  }
});
