// Packaging guard: the npm tarball must not ship stray files. In particular the
// old "btp-admin-api-config copy.json" duplicate must stay out of the published
// dist/, and the published file list must contain no " copy" duplicates at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');

test('npm pack output contains no stray "copy" config files', () => {
  const stdout = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: rootDir,
    encoding: 'utf8',
  });
  const parsed = JSON.parse(stdout) as Array<{ files: Array<{ path: string }> }>;
  const paths = parsed.flatMap((entry) => entry.files.map((f) => f.path));

  assert.ok(paths.length > 0, 'expected npm pack to report packaged files');
  assert.ok(
    !paths.some((p) => p.includes('btp-admin-api-config copy.json')),
    'stray "btp-admin-api-config copy.json" must not be packaged',
  );
  assert.ok(
    !paths.some((p) => / copy\.[A-Za-z0-9]+$/.test(p)),
    `no " copy" duplicate files may be packaged, found: ${paths
      .filter((p) => / copy\.[A-Za-z0-9]+$/.test(p))
      .join(', ')}`,
  );
});
