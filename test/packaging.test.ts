import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');

test('npm pack output excludes the duplicate BTP admin config', () => {
  const stdout = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: rootDir,
    encoding: 'utf8',
  });
  const parsed = JSON.parse(stdout) as Array<{ files: Array<{ path: string }> }>;
  const paths = parsed.flatMap((entry) => entry.files.map((f) => f.path));

  assert.ok(paths.length > 0, 'expected npm pack to report packaged files');
  assert.ok(
    !paths.includes('dist/config/btp-admin-api-config copy.json'),
    'dist/config/btp-admin-api-config copy.json must not be packaged',
  );
});
