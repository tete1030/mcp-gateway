import assert from 'node:assert/strict';
import test from 'node:test';
import { createBearerIdentity, createLocalServiceIdentity, createEventAuthorizer, SERVICE_SECRET_HEADER } from '../src/identity.mjs';
import { createAggregateGateway } from '../src/aggregate-gateway.mjs';

const request = headers => new Request('http://127.0.0.1/mcp', { method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });

test('bearer boundary delegates verification and rejects missing, invalid or unverified identity', async () => {
  let calls = 0;
  const authenticate = createBearerIdentity({ verifyToken: async token => {
    calls++;
    return token === 'public-fixture-token' ? { id: 'A', scopes: ['tools:use'] } : undefined;
  } });
  assert.equal(await authenticate(request({})), undefined);
  assert.equal(await authenticate(request({ Authorization: 'Basic fixture' })), undefined);
  assert.equal(calls, 0);
  assert.equal(await authenticate(request({ Authorization: 'Bearer wrong' })), undefined);
  const principal = await authenticate(request({ Authorization: 'Bearer public-fixture-token' }));
  assert.equal(principal.id, 'A'); assert.equal(principal.kind, 'external_verifier');
  const broken = createBearerIdentity({ verifyToken: async () => ({ id: 'A', scopes: 'unvalidated' }) });
  assert.equal(await broken(request({ Authorization: 'Bearer fixture' })), undefined);
  assert.throws(() => createBearerIdentity({}), /verifier/);
});

test('local-hop secret maps only to fixed owner and is separate from connector/HA bearer', async t => {
  const fixture = 'public-dummy-local-service-secret-32-bytes';
  const authenticate = createLocalServiceIdentity({ readServiceSecret: async () => fixture, owner: 'fixed-owner', scopes: ['tools:use'] });
  const gateway = createAggregateGateway({ backends: [], authenticate }); t.after(() => gateway.close());
  assert.equal((await gateway.fetch(request({ Authorization: 'Bearer HA_DUMMY_TOKEN' }))).status, 401);
  assert.equal((await gateway.fetch(request({ [SERVICE_SECRET_HEADER]: 'wrong', Authorization: 'Bearer connector-fixture' }))).status, 401);
  const valid = request({ [SERVICE_SECRET_HEADER]: fixture, Authorization: 'Bearer connector-fixture', 'x-mcp-gateway-principal': 'forged-user' });
  assert.equal((await gateway.fetch(valid)).status, 200);
  const principal = await authenticate(request({ [SERVICE_SECRET_HEADER]: fixture }));
  assert.equal(principal.id, 'fixed-owner'); assert.equal(principal.kind, 'local_service');
  principal.scopes.push('events:emit');
  assert.deepEqual((await authenticate(request({ [SERVICE_SECRET_HEADER]: fixture }))).scopes, ['tools:use']);
});

test('event policy resolves current owner, per-action scopes and filter grants every time', async () => {
  let current = { id: 'A', scopes: ['events:list', 'events:subscribe'], allowedKinds: ['warning'] };
  const authorize = createEventAuthorizer({ resolvePrincipal: async () => current });
  assert.equal(await authorize('A', 'list'), true);
  assert.equal(await authorize('A', 'subscribe', { arguments: { kind: 'cat' } }), false);
  assert.equal(await authorize('A', 'deliver', { arguments: { kind: 'warning' } }), true);
  assert.equal(await authorize('A', 'emit', { arguments: { kind: 'warning' } }), false);
  assert.equal(await authorize('B', 'deliver', { arguments: { kind: 'warning' } }), false);
  current = undefined;
  assert.equal(await authorize('A', 'deliver', { arguments: { kind: 'warning' } }), false);
});
