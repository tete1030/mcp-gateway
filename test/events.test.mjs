import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test, { after } from 'node:test';
import { Webhook } from 'standardwebhooks';
import { SyntheticEvents, MemorySubscriptionStore, EVENT_NAME, canonical, subscriptionId } from '../src/events.mjs';
import { callbackUrl, publicAddress, createCallbackTransport } from '../src/callback.mjs';
import { createAggregateGateway } from '../src/aggregate-gateway.mjs';

// These public dummy fixture bytes are not an account credential.
const secret = `whsec_${Buffer.alloc(32, 1).toString('base64')}`;
const params = () => ({ name: EVENT_NAME, arguments: { kind: 'cat' }, cursor: null, ttlMs: 60_000,
  delivery: { mode: 'webhook', url: 'https://callback.example/events', secret } });
const withoutSecret = input => ({ name: input.name, arguments: input.arguments,
  delivery: { mode: input.delivery.mode, url: input.delivery.url } });
const payload = { kind: 'cat', source: 'synthetic_poc', message: 'Synthetic cat fixture; no device action' };
const stores = [];
after(() => { for (const store of stores) store.close(); });

function fixture({ send, authorize = async () => true, now, pause } = {}) {
  const calls = [];
  const store = new MemorySubscriptionStore();
  stores.push(store);
  // Test convenience only: publication commits, then a separate worker drains.
  // Production publish() returns queued IDs without blocking on network delivery.
  store.all = async () => (await Promise.all(['A', 'principal-A', 'principal-B', 'principal-C'].map(p => store.listSubscriptions(p)))).flat();
  let time = new Date();
  const clock = now ?? (() => time);
  const wait = pause ?? (async ms => { time = new Date(time.getTime() + ms); });
  const mockSend = async (url, packet) => {
    calls.push({ url, ...packet });
    // A mock receiver verifies signatures before echoing the single-use challenge.
    const data = new Webhook(secret).verify(packet.body, packet.headers);
    if (data.type === 'verification') return { status: 200, body: JSON.stringify({ challenge: data.challenge }) };
    return { status: 204, body: '' };
  };
  const engine = new SyntheticEvents({ store, authorize, send: send ?? mockSend, now: clock });
  const enqueue = engine.publish.bind(engine);
  engine.publish = async (owner, data) => {
    const result = await enqueue(owner, data);
    const deliveries = [];
    for (let n = 0; n < 100; n++) {
      const step = await engine.drainOne();
      if (!step) break;
      if (step.outcome === 'retry') await wait(Math.max(0, step.retryAt - clock().getTime()));
      else deliveries.push(step);
    }
    return { ...result, deliveries };
  };
  return { store, calls, engine };
}

test('discovery, signed verification and signed synthetic delivery match the webhook contract', async () => {
  const { engine, calls } = fixture();
  const listing = await engine.list('principal-A');
  assert.deepEqual(listing.events[0].delivery, ['webhook']);
  assert.equal(listing.events[0].name, EVENT_NAME);
  const sub = await engine.subscribe('principal-A', params());
  assert.match(sub.id, /^sub_[a-f0-9]{64}$/);
  assert.deepEqual({ cursor: sub.cursor, truncated: sub.truncated }, { cursor: null, truncated: false });
  const result = await engine.publish('principal-A', payload);
  assert.equal(result.deliveries[0].outcome, 'delivered');
  assert.equal(calls.length, 2);
  const decoded = new Webhook(secret).verify(calls[1].body, calls[1].headers);
  assert.equal(decoded.eventId, calls[1].headers['webhook-id']);
  assert.equal(decoded.name, EVENT_NAME);
  assert.deepEqual(decoded.data, payload);
  assert.equal(decoded.type, undefined);
  assert.equal(calls[1].headers['X-MCP-Subscription-Id'], sub.id);
});

test('refresh is deterministic and separate principals cannot unsubscribe each other', async () => {
  const { engine, store } = fixture();
  const first = await engine.subscribe('principal-A', params());
  assert.equal((await engine.subscribe('principal-A', params())).id, first.id);
  const second = await engine.subscribe('principal-B', params());
  assert.notEqual(second.id, first.id);
  await engine.unsubscribe('principal-C', withoutSecret(params()));
  assert.equal((await store.all()).length, 2);
  await engine.unsubscribe('principal-A', withoutSecret(params()));
  await engine.unsubscribe('principal-A', withoutSecret(params()));
  assert.equal((await store.all()).length, 1);
  assert.equal((await store.all())[0].id, second.id);
  assert.equal(canonical({ z: 1, a: { c: 2, b: 3 } }), canonical({ a: { b: 3, c: 2 }, z: 1 }));
  assert.equal(subscriptionId('A', params()), subscriptionId('A', { ...params(), ttlMs: 90_000 }));
});

test('wrong challenge, redirect or rejected callback cannot activate a subscription', async () => {
  for (const response of [{ status: 200, body: '{"challenge":"wrong"}' }, { status: 302, body: '{}' }, { status: 403, body: '{}' }]) {
    const { engine, store } = fixture({ send: async () => response });
    await assert.rejects(engine.subscribe('A', params()), error => error.code === -32015);
    assert.equal((await store.all()).length, 0);
  }
});

test('verification cache is bounded in time and key rotation signs with both keys temporarily', async () => {
  const replacement = `whsec_${Buffer.alloc(32, 2).toString('base64')}`;
  let time = new Date();
  const packets = [];
  const f = fixture({ now: () => time, send: async (_url, packet) => {
    packets.push(packet);
    const decoded = JSON.parse(packet.body);
    return { status: 200, body: decoded.type === 'verification' ? JSON.stringify({ challenge: decoded.challenge }) : '' };
  } });
  const original = await f.engine.subscribe('A', params());
  await f.engine.subscribe('A', params());
  assert.equal(packets.length, 1);
  time = new Date(time.getTime() + 30_001);
  await f.engine.subscribe('A', params()); assert.equal(packets.length, 2);
  const changed = { ...params(), ttlMs: 600_000, delivery: { ...params().delivery, secret: replacement } };
  assert.equal((await f.engine.subscribe('A', changed)).id, original.id);
  assert.equal(packets.length, 3); // A new signing key gets a new verified challenge.
  await f.engine.publish('A', payload);
  const rotated = packets.at(-1);
  assert.equal(rotated.headers['webhook-signature'].split(' ').length, 2);
  new Webhook(secret).verify(rotated.body, rotated.headers);
  new Webhook(replacement).verify(rotated.body, rotated.headers);
  time = new Date(time.getTime() + 300_001);
  await f.engine.publish('A', payload);
  assert.equal(packets.at(-1).headers['webhook-signature'].split(' ').length, 1);
});

test('secret bounds, strict schemas, finite TTL and webhook-only delivery are enforced', async () => {
  const { engine } = fixture();
  for (const patch of [
    { delivery: { ...params().delivery, secret: `whsec_${Buffer.alloc(23).toString('base64')}` } },
    { delivery: { ...params().delivery, mode: 'polling' } },
    { delivery: { ...params().delivery, url: 'http://callback.example/events' } },
    { ttlMs: 0 }, { cursor: 'unsupported' },
    { arguments: { kind: 'cat', entity: 'vacuum.real_device' } },
  ]) await assert.rejects(engine.subscribe('A', { ...params(), ...patch }));
  await assert.rejects(engine.publish('A', { ...payload, source: 'real_ha' }));
});

test('authorization applies to discovery, subscribe, refresh, unsubscribe, emission and each retry', async () => {
  let allowed = true;
  let deliveries = 0;
  const f = fixture({ authorize: async principal => allowed && principal !== 'blocked',
    send: async (_url, packet) => {
      const decoded = JSON.parse(packet.body);
      if (decoded.type === 'verification') return { status: 200, body: JSON.stringify({ challenge: decoded.challenge }) };
      deliveries++; allowed = false; return { status: 503, body: '' };
    } });
  await assert.rejects(f.engine.list(null));
  await assert.rejects(f.engine.subscribe('blocked', params()));
  await f.engine.subscribe('A', params());
  const sent = await f.engine.publish('A', payload);
  assert.equal(sent.deliveries[0].outcome, 'revoked');
  assert.equal(deliveries, 1);
  await assert.rejects(f.engine.list('A'));
  await assert.rejects(f.engine.subscribe('A', params()));
  await assert.rejects(f.engine.unsubscribe('A', withoutSecret(params())));
  await assert.rejects(f.engine.publish('A', payload));
});

test('delivery retries reuse exact body and event id with fresh timestamps/signatures', async () => {
  const packets = [];
  let clock = new Date();
  const f = fixture({ now: () => clock, pause: async () => { clock = new Date(clock.getTime() + 1000); },
    send: async (_url, packet) => {
      const decoded = JSON.parse(packet.body);
      if (decoded.type === 'verification') return { status: 200, body: JSON.stringify({ challenge: decoded.challenge }) };
      packets.push(packet); return { status: packets.length === 3 ? 200 : 503, body: '' };
    } });
  await f.engine.subscribe('A', params());
  assert.equal((await f.engine.publish('A', payload)).deliveries[0].outcome, 'delivered');
  assert.equal(packets.length, 3);
  assert.equal(new Set(packets.map(x => x.body)).size, 1);
  assert.equal(new Set(packets.map(x => x.headers['webhook-id'])).size, 1);
  assert.equal(new Set(packets.map(x => x.headers['webhook-timestamp'])).size, 3);
  assert.equal(new Set(packets.map(x => x.headers['webhook-signature'])).size, 3);
  for (const packet of packets) new Webhook(secret).verify(packet.body, packet.headers);
});

test('410/413 stop retries and expired/unsubscribed subscriptions are inactive', async () => {
  for (const status of [410, 413]) {
    let delivered = 0;
    const f = fixture({ send: async (_url, packet) => {
      const data = JSON.parse(packet.body);
      if (data.type === 'verification') return { status: 200, body: JSON.stringify({ challenge: data.challenge }) };
      delivered++; return { status, body: '' };
    } });
    await f.engine.subscribe('A', params());
    assert.equal((await f.engine.publish('A', payload)).deliveries[0].outcome, 'terminal');
    assert.equal(delivered, 1);
  }
  let time = new Date();
  const f = fixture({ now: () => time });
  await f.engine.subscribe('A', params()); time = new Date(time.getTime() + 60_001);
  assert.deepEqual((await f.engine.publish('A', payload)).deliveries, []);
  await f.engine.unsubscribe('A', withoutSecret(params()));
  assert.deepEqual((await f.engine.publish('A', payload)).deliveries, []);
  assert.equal(f.store.durable, false); // Does NOT pretend to verify persistence across process restart.
});

test('HTTPS callbacks reject local/private/reserved/mapped addresses and alternate ports', () => {
  for (const value of ['127.0.0.1', '10.0.0.1', '192.168.50.99', '172.16.0.1', '169.254.169.254',
    '100.64.0.1', '0.0.0.0', '224.0.0.1', '192.0.2.1', '::1', 'fc00::1', 'fe80::1', '2001:db8::1', '::ffff:127.0.0.1']) {
    assert.equal(publicAddress(value), false, value);
  }
  assert.equal(publicAddress('1.1.1.1'), true);
  assert.equal(publicAddress('2606:4700:4700::1111'), true);
  for (const value of ['http://example.com', 'https://user:pass@example.com', 'https://example.com:8443', 'https://example.com/#fragment']) {
    assert.throws(() => callbackUrl(value));
  }
});

test('callback socket uses validated address and resolves again before retries', async () => {
  let resolutions = 0; let requests = 0;
  const send = createCallbackTransport({
    lookup: async () => [{ address: ++resolutions === 1 ? '1.1.1.1' : '192.168.50.99', family: 4 }],
    request: (url, opts, receive) => {
      requests++; assert.equal(url.hostname, 'callback.example'); assert.equal(opts.headers.Host, 'callback.example');
      assert.equal(opts.agent, false);
      opts.lookup('callback.example', {}, (_err, address, family) => { assert.equal(address, '1.1.1.1'); assert.equal(family, 4); });
      const req = new EventEmitter(); req.destroy = () => {};
      req.end = () => queueMicrotask(() => {
        const res = new EventEmitter(); res.statusCode = 204; res.destroy = () => {};
        receive(res); res.emit('end');
      });
      return req;
    },
  });
  assert.equal((await send('https://callback.example/events', { body: '{}', headers: {} })).status, 204);
  await assert.rejects(send('https://callback.example/events', { body: '{}', headers: {} }), /address rejected/);
  assert.equal(requests, 1); assert.equal(resolutions, 2);
  const mixed = createCallbackTransport({ lookup: async () => [
    { address: '1.1.1.1', family: 4 }, { address: '127.0.0.1', family: 4 },
  ] });
  await assert.rejects(mixed('https://callback.example/events', { body: '{}', headers: {} }));
});

test('events RPCs are exposed only with injected authenticated test identity and engine', async t => {
  const { engine } = fixture();
  const gateway = createAggregateGateway({ backends: [], events: engine,
    authenticate: async () => ({ id: 'verified_test_only', scopes: ['tools:use'] }) });
  t.after(() => gateway.close());
  const call = async (method, input) => {
    const response = await gateway.fetch(new Request('http://127.0.0.1/mcp', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': method,
        ...(input.name ? { 'Mcp-Name': input.name } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...input, _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'events-test', version: '0.1' },
        'io.modelcontextprotocol/clientCapabilities': {},
      } } }),
    }));
    const text = await response.text();
    return response.headers.get('content-type').includes('text/event-stream')
      ? JSON.parse(text.split('\n').find(s => s.startsWith('data:')).slice(5)) : JSON.parse(text);
  };
  assert.deepEqual((await call('server/discover', {})).result.capabilities.events, {});
  assert.equal((await call('events/list', {})).result.events[0].name, EVENT_NAME);
  const subscribed = await call('events/subscribe', params());
  assert.match(subscribed.result.id, /^sub_/);
  const unsubscribed = (await call('events/unsubscribe', withoutSecret(params()))).result;
  assert.equal(unsubscribed.resultType, 'complete');
  assert.deepEqual(Object.keys(unsubscribed).filter(k => !['_meta', 'resultType'].includes(k)), []);
});
