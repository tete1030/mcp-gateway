import { readFile } from 'node:fs/promises';
import { parseThinConfig } from '../src/config.mjs';
const path = process.argv[2];
if (!path) throw new Error('Usage: node scripts/validate-config.mjs PATH');
parseThinConfig(JSON.parse(await readFile(path, 'utf8')));
console.log('Gateway configuration valid; no network or runtime changes.');
