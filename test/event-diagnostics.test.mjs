import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { SyntheticEvents, MemorySubscriptionStore, EVENT_NAME } from '../src/events.mjs';
import { CallbackTransportError, callbackErrorCategory, createCallbackTransport } from '../src/callback.mjs';
import { createSubscriptionDiagnostic } from '../src/event-diagnostics.mjs';

const publicSecret = `whsec_${Buffer.alloc(32, 3).toString('base64')}`;
const input = () => ({ name: EVENT_NAME, arguments: { kind: 'cat' },
  delivery: { mode: 'webhook', url: 'https://private-callback-fixture.example/sensitive-path?auth=PUBLIC_TEST_VALUE', secret: publicSecret } });
const fields = ['correlationId', 'elapsedMs', 'errorCategory', 'httpStatus', 'phase'];
function assertSafe(records) {
  for (const r of records) {
    assert.deepEqual(Object.keys(r).sort(), fields);
    assert.match(r.correlationId, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
    assert.ok(Number.isInteger(r.elapsedMs) && r.elapsedMs >= 0);
  }
  const serialized = JSON.stringify(records);
  for (const sensitive of [input().delivery.url, publicSecret, 'sensitive-path', 'PUBLIC_TEST_VALUE', 'fixture-owner', 'authorization', 'webhook-signature']) {
    assert.ok(!serialized.includes(sensitive), `Diagnostic leaked ${sensitive}`);
  }
}
function fixture(t, send, diagnostic) {
  const store = new MemorySubscriptionStore(); t.after(() => store.close());
  return { store, engine: new SyntheticEvents({ store, send, diagnostic, authorize: async () => true }) };
}
test('subscription diagnostics correlate a verified commit without retaining inputs or challenge', async t => {
  const records = [];
  const { engine, store } = fixture(t, async (_url, packet) => ({ status: 200,
    body: JSON.stringify({ challenge: JSON.parse(packet.body).challenge }) }), r => records.push(r));
  await engine.subscribe('fixture-owner', input());
  assert.equal((await store.listSubscriptions('fixture-owner')).length, 1);
  assert.deepEqual(records.map(r => r.phase), ['subscribe_received', 'params_validated', 'authorized', 'destination_validated',
    'state_reserved', 'challenge_started', 'challenge_response', 'challenge_verified', 'state_committing', 'state_committed', 'subscribe_complete']);
  assert.equal(new Set(records.map(r => r.correlationId)).size, 1);
  assert.equal(records.find(r => r.phase === 'challenge_response').httpStatus, 200);
  assertSafe(records);
});
test('challenge failures distinguish HTTP, invalid JSON, missing echo, mismatch and timeout without leaking data', async t => {
  const cases = [
    [{ status: 403, body: input().delivery.url }, 'challenge_http_error', 403],
    [{ status: 200, body: publicSecret }, 'challenge_invalid_json', 200],
    [{ status: 200, body: '{}' }, 'challenge_missing_value', 200],
    [{ status: 200, body: '{"challenge":"PUBLIC_TEST_VALUE"}' }, 'challenge_mismatch', 200],
    [new CallbackTransportError('timeout'), 'timeout', null],
  ];
  for (const [response, category, http] of cases) {
    const records = [];
    const { engine, store } = fixture(t, async () => { if (response instanceof Error) throw response; return response; }, r => records.push(r));
    await assert.rejects(engine.subscribe('fixture-owner', input()), e => e.code === -32015);
    assert.equal((await store.listSubscriptions('fixture-owner')).length, 0);
    assert.equal(records.find(r => r.phase === 'challenge_failed').errorCategory, category);
    assert.equal(records.find(r => r.phase === 'challenge_response')?.httpStatus ?? null, http);
    assert.ok(!records.some(r => r.phase === 'state_committed'));
    assertSafe(records);
  }
});
test('diagnostic sinks cannot change subscription behavior, and only fixed fields/enums are emitted', async t => {
  const { engine } = fixture(t, async (_url, p) => ({ status: 200, body: JSON.stringify({ challenge: JSON.parse(p.body).challenge }) }),
    () => { throw Error(input().delivery.url + publicSecret); });
  assert.ok((await engine.subscribe('fixture-owner', input())).id);
  const records = [], report = createSubscriptionDiagnostic(r => records.push(r));
  report(input().delivery.url);
  report('subscribe_received', { httpStatus: 'PUBLIC_TEST_VALUE', errorCategory: publicSecret, secret: publicSecret, url: input().delivery.url });
  assert.equal(records.length, 1);
  assert.equal(records[0].httpStatus, null); assert.equal(records[0].errorCategory, null);
  assertSafe(records);
});
test('DNS/socket categories retain no endpoint or raw native error message', async () => {
  for (const [code, category] of [['ENOTFOUND', 'dns_not_found'], ['EAI_AGAIN', 'dns_failure'],
    ['ECONNREFUSED', 'connection_refused'], ['ECONNRESET', 'connection_reset'], ['ENETUNREACH', 'network_unreachable'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls_error'], ['ETIMEDOUT', 'timeout']]) {
    const error = Object.assign(Error(input().delivery.url + publicSecret), { code });
    const send = createCallbackTransport(code.startsWith('EAI') || code === 'ENOTFOUND'
      ? { lookup: async () => { throw error; } }
      : { lookup: async () => [{ address: '1.1.1.1', family: 4 }], request: () => {
        const req = new EventEmitter(); req.end = () => queueMicrotask(() => req.emit('error', error)); return req;
      } });
    await assert.rejects(send(input().delivery.url, { body: '{}', headers: {} }), e => {
      assert.equal(callbackErrorCategory(e), category);
      assert.ok(!e.message.includes(input().delivery.url)); assert.ok(!e.message.includes(publicSecret)); return true;
    });
  }
  assert.equal(callbackErrorCategory({ category: publicSecret, message: input().delivery.url, code: publicSecret }), 'transport_error');
  assert.equal(callbackErrorCategory({ name: 'AbortError', cause: { name: 'TimeoutError' } }), 'timeout');
});
test('storage failure is categorized before any network challenge and cannot create a subscription', async t => {
  const records = [], store = new MemorySubscriptionStore(); t.after(() => store.close());
  store.beginSubscription = async () => { throw Error(input().delivery.url + publicSecret); };
  const engine = new SyntheticEvents({ store, send: () => assert.fail('no challenge after storage failure'), authorize: async () => true,
    diagnostic: r => records.push(r) });
  await assert.rejects(engine.subscribe('fixture-owner', input()));
  assert.equal(records.at(-1).errorCategory, 'storage_error');
  assertSafe(records);
});
