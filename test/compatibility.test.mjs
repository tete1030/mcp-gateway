import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteEventStore } from '../src/store.mjs';
import { SyntheticEvents, EVENT_NAME } from '../src/events.mjs';
import { createLocalServiceIdentity, SERVICE_SECRET_HEADER } from '../src/identity.mjs';
import { parseThinConfig } from '../src/config.mjs';
import { tunnelCommand } from '../src/tunnel.mjs';

test('an explicit compatibility header is used consistently and cannot fall back to the default', async () => {
  const fixture = 'PUBLIC_SERVICE_CREDENTIAL_FIXTURE_ONLY_32_BYTES';
  const header = 'x-previous-fixture-service-secret';
  const auth = createLocalServiceIdentity({ owner: 'fixture-owner', scopes: ['tools:use'], header, readServiceSecret: async () => fixture });
  const request = values => new Request('http://127.0.0.1/mcp', { headers: values });
  assert.equal(await auth(request({ [SERVICE_SECRET_HEADER]: fixture })), undefined);
  assert.equal((await auth(request({ [header]: fixture }))).id, 'fixture-owner');
  assert.equal(await auth(request({ [header]: 'wrong' })), undefined);
  assert.throws(() => createLocalServiceIdentity({ owner: 'fixture-owner', scopes: [], header: 'authorization', readServiceSecret: async () => fixture }));
  const input = JSON.parse(await readFile(new URL('../config/thin.example.json', import.meta.url)));
  input.identity.serviceSecretHeader = header;
  input.tunnel = { id: 'tunnel_EXAMPLE', organizationId: 'org-EXAMPLE', secretRef: 'service' };
  const command = tunnelCommand(parseThinConfig(input), 'http://127.0.0.1:8787/mcp');
  assert.ok(command.includes(`${header}: env:PUBLIC_SERVICE_FIXTURE`));
  assert.ok(!command.some(x => x.startsWith(`${SERVICE_SECRET_HEADER}:`)));
});

test('explicit storage encryption context reopens existing subscriptions and rejects a different context', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-gateway-context-fixture-'));
  const file = join(dir, 'events.sqlite'), key = Buffer.alloc(32, 7), encryptionNamespace = 'fixture-previous-format-v1';
  let store = await SQLiteEventStore.open({ file, key, encryptionNamespace });
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const events = new SyntheticEvents({ store, authorize: async () => true,
    send: async (_url, packet) => ({ status: 200, body: JSON.stringify({ challenge: JSON.parse(packet.body).challenge }) }) });
  const first = await events.subscribe('fixture-owner', { name: EVENT_NAME, arguments: { kind: 'warning' },
    delivery: { mode: 'webhook', url: 'https://receiver.example/fixture', secret: `whsec_${Buffer.alloc(32, 1).toString('base64')}` } });
  const previous = await store.listSubscriptions('fixture-owner'); store.close();
  store = await SQLiteEventStore.open({ file, key, encryptionNamespace });
  assert.deepEqual(await store.listSubscriptions('fixture-owner'), previous);
  assert.equal(previous[0].id, first.id); store.close();
  await assert.rejects(SQLiteEventStore.open({ file, key, encryptionNamespace: 'different-format-v1' }), /initialization failed/);
  store = await SQLiteEventStore.open({ file, key, encryptionNamespace });
});

test('fresh configuration has neutral defaults and validates compatibility fields', async () => {
  const input = JSON.parse(await readFile(new URL('../config/thin.example.json', import.meta.url)));
  input.events.state = { databaseFile: '/var/lib/mcp-gateway/events.sqlite', keyRef: 'state' };
  const config = parseThinConfig(input);
  assert.equal(config.identity.serviceSecretHeader, 'x-mcp-gateway-service-secret');
  assert.equal(config.events.state.encryptionNamespace, 'mcp-gateway-events-v1');
  for (const mutate of [x => x.identity.serviceSecretHeader = 'Authorization', x => x.events.state.encryptionNamespace = 'invalid\ncontext']) {
    const changed = structuredClone(input); mutate(changed); assert.throws(() => parseThinConfig(changed));
  }
});
