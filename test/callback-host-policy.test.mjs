import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createCallbackTransport } from '../src/callback.mjs';
import { parseThinConfig } from '../src/config.mjs';
import { entityIds } from '../src/connectors/ha/contract.mjs';
import { SyntheticEvents, MemorySubscriptionStore, EVENT_NAME } from '../src/events.mjs';
import { Webhook } from 'standardwebhooks';
import { createSubscriptionDiagnostic } from '../src/event-diagnostics.mjs';

const hostname = 'actual-receiver.example'; // Public fixture, not a claimed platform host.
const url = `https://${hostname}/sensitive-callback-path?key=PUBLIC_PATH_FIXTURE`;
const secret = `whsec_${Buffer.alloc(32, 6).toString('base64')}`;
const policy = { mode: 'exact_host_allowlist', allowedHosts: [hostname] };
const config = callback => ({ configVersion: 2, mode: 'aggregate', identity: { ownerId: 'public-fixture-owner', secretRef: 'service' },
  secrets: { service: { env: 'PUBLIC_FIXTURE_SERVICE' } }, backends: [{ id: 'ha', enabled: false, transport: 'streamable_http', url: 'https://ha.example/mcp' }],
  haConnector: { backendId: 'ha', entityIds }, events: { enabled: false, callback } });
function mockRequest(respond, inspect = () => {}) {
  return (target, options, receive) => {
    inspect(target, options);
    const req = new EventEmitter(); req.end = body => queueMicrotask(() => {
      const packet = respond(body, options.headers), res = new EventEmitter();
      res.statusCode = packet.status; res.headers = packet.headers ?? {}; res.destroy = () => {};
      receive(res); if (packet.body) res.emit('data', Buffer.from(packet.body)); res.emit('end');
    }); return req;
  };
}
test('exact-host policy is explicit configuration and rejects wildcard, URL, IP, suffix and duplicate entries', () => {
  assert.deepEqual(parseThinConfig(config(policy)).events.callback, policy);
  assert.throws(() => parseThinConfig(config(undefined)));
  assert.deepEqual(parseThinConfig(config({ mode: 'exact_host_allowlist', allowedHosts: [] })).events.callback.allowedHosts, []);
  for (const hosts of [['*.example'], ['.example'], ['https://actual-receiver.example'], ['127.0.0.1'], ['198.18.0.1'],
    ['[::1]'], ['localhost'], ['actual-receiver.example.'], ['ACTUAL-receiver.example'], [hostname, hostname]]) {
    assert.throws(() => parseThinConfig(config({ mode: 'exact_host_allowlist', allowedHosts: hosts })));
  }
});
test('allowlisted host uses ordinary HTTPS with normal TLS and no DNS/IP precheck or custom socket lookup', async () => {
  let sent = 0;
  const send = createCallbackTransport({ policy, lookup: () => assert.fail('No separate DNS lookup'),
    request: mockRequest(() => ({ status: 204 }), (target, options) => {
      sent++; assert.equal(target.hostname, hostname); assert.equal(options.lookup, undefined);
      assert.equal(options.servername, hostname); assert.equal(options.rejectUnauthorized, true);
      assert.equal(options.headers.Host, hostname); assert.equal(options.agent, false);
    }) });
  assert.equal((await send(url, { body: '{}', headers: {} })).status, 204); assert.equal(sent, 1);
});
test('empty list, sibling/suffix lookalikes, userinfo, ports, fragments and literals cannot send a request', async () => {
  const opts = { policy, lookup: () => assert.fail('No DNS on rejected host'), request: () => assert.fail('No HTTP on rejected host') };
  const send = createCallbackTransport(opts);
  for (const value of ['https://other.example/events', `https://child.${hostname}/events`, `https://${hostname}.evil.example/events`,
    `https://user@${hostname}/events`, `https://@${hostname}/events`, `https://${hostname}:8443/events`,
    `http://${hostname}/events`, `https://${hostname}/events#fragment`, 'https://198.18.0.1/events',
    `https://${hostname}\\@evil.example/events`]) await assert.rejects(send(value, { body: '{}', headers: {} }));
  const empty = createCallbackTransport({ ...opts, policy: { mode: 'exact_host_allowlist', allowedHosts: [] } });
  await assert.rejects(empty(url, { body: '{}', headers: {} }), e => e.category === 'host_not_allowed');
});
test('signed challenge and delivery survive exact-host mode; redirect is returned once and cannot activate', async t => {
  for (const redirect of [false, true]) {
    const store = new MemorySubscriptionStore(); t.after(() => store.close()); let requests = 0;
    const send = createCallbackTransport({ policy, lookup: () => assert.fail('No precheck'), request: mockRequest((body, headers) => {
      requests++; const data = new Webhook(secret).verify(body, headers);
      if (redirect) return { status: 302, headers: { location: 'https://other.example/redirected' }, body: '' };
      return data.type === 'verification' ? { status: 200, body: JSON.stringify({ challenge: data.challenge }) } : { status: 204 };
    }) });
    const engine = new SyntheticEvents({ store, send, authorize: async () => true });
    const params = { name: EVENT_NAME, arguments: { kind: 'cat' }, delivery: { mode: 'webhook', url, secret } };
    if (redirect) {
      await assert.rejects(engine.subscribe('public-fixture-owner', params), e => e.code === -32015);
      assert.equal((await store.listSubscriptions('public-fixture-owner')).length, 0); assert.equal(requests, 1);
    } else {
      await engine.subscribe('public-fixture-owner', params);
      await engine.publish('public-fixture-owner', { source: 'synthetic_poc', kind: 'cat', message: 'Public fixture only' });
      assert.equal((await engine.drainOne()).outcome, 'delivered'); assert.equal(requests, 2);
    }
  }
});
test('retired hostname capture cannot enter diagnostics before or after authentication', async t => {
  const records = [], store = new MemorySubscriptionStore(); t.after(() => store.close());
  const send = createCallbackTransport({ policy: { mode: 'exact_host_allowlist', allowedHosts: [] } });
  const engine = new SyntheticEvents({ store, send, authorize: async owner => owner === 'public-fixture-owner', diagnostic: r => records.push(r) });
  const params = { name: EVENT_NAME, arguments: { kind: 'cat' }, delivery: { mode: 'webhook', url, secret } };
  await assert.rejects(engine.subscribe('unverified-fixture-owner', params));
  assert.ok(!records.some(r => r.hostname)); records.length = 0;
  await assert.rejects(engine.subscribe('public-fixture-owner', params), e => e.code === -32015);
  assert.ok(!records.some(r => r.phase === 'callback_hostname_observed' || r.hostname));
  assert.equal(records.find(r => r.phase === 'challenge_failed').errorCategory, 'host_not_allowed');
  const serialized = JSON.stringify(records);
  for (const value of [url, hostname, 'sensitive-callback-path', 'PUBLIC_PATH_FIXTURE', secret, 'public-fixture-owner']) assert.ok(!serialized.includes(value));
  const sanitized = [], report = createSubscriptionDiagnostic(r => sanitized.push(r));
  report('callback_hostname_observed', { hostname: url });
  report('subscribe_received', { hostname });
  assert.ok(sanitized.every(r => r.hostname === undefined));
});
