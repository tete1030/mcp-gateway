// Killed subprocess fixture: no tunnel, HA, HTTP listener or real credential.
import { writeSync } from 'node:fs';
import { SQLiteEventStore } from '../../src/store.mjs';
import { SyntheticEvents, EVENT_NAME } from '../../src/events.mjs';
const store = await SQLiteEventStore.open({ file: process.argv[2], key: Buffer.alloc(32, 7) });
const engine = new SyntheticEvents({ store, authorize: async () => true,
  send: async (_url, packet) => ({ status: 200, body: JSON.stringify({ challenge: JSON.parse(packet.body).challenge }) }) });
await engine.subscribe('crash-test-owner', { name: EVENT_NAME, arguments: { kind: 'cat' }, ttlMs: 600_000,
  delivery: { mode: 'webhook', url: 'https://callback.example/crash', secret: `whsec_${Buffer.alloc(32, 1).toString('base64')}` } });
const queued = await engine.publish('crash-test-owner', { kind: 'cat', source: 'synthetic_poc', message: 'crash fixture only' });
if (process.argv[3] === 'leased') await store.claimDue(Date.now());
writeSync(1, JSON.stringify({ eventId: queued.eventId }));
process.kill(process.pid, 'SIGKILL');
