import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
async function check(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
    if (entry.isDirectory()) await check(path);
    else if (entry.name.endsWith('.mjs')) {
      const result = spawnSync(process.execPath, ['--check', path.pathname], { stdio: 'inherit' });
      if (result.status !== 0) process.exit(result.status ?? 1);
    }
  }
}
for (const folder of ['src', 'test', 'scripts']) await check(new URL('../' + folder + '/', import.meta.url));
