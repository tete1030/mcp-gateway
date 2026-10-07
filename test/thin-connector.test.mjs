import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Webhook } from 'standardwebhooks';
import { SQLiteEventStore } from '../src/store.mjs';
import { McpEvents, subscriptionId } from '../src/events.mjs';
import { HaMcpEvents } from '../src/connectors/ha/events.mjs';
import { HaEventSocket } from '../src/connectors/ha/socket.mjs';
import { resources, entityIds, eventTypes, eventDefinitions } from '../src/connectors/ha/contract.mjs';
import { parseThinConfig } from '../src/config.mjs';
const owner = 'public-thin-owner', key = Buffer.alloc(32, 8), secret = `whsec_${Buffer.alloc(32, 2).toString('base64')}`;
const delivery = { mode: 'webhook', url: 'https://connectors.api.openai.com/public-thin-fixture', secret };
const fixtureTime = Date.now();
export function packet(r = resources[2], phase = 'attention', incident = 'public-incident') {
  return { entityId: r.entityId, eventId: `${incident}:${phase}`, occurredAt: new Date(fixtureTime).toISOString(),
    expiresAt: new Date(fixtureTime + 7200_000).toISOString(),
    data: { eventVersion: 1, source: 'ha_selected_entities', ruleId: r.ruleId, deviceId: r.deviceId,
      incidentId: incident, phase, severity: phase === 'attention' ? 'warning' : 'info',
      observedAt: new Date(fixtureTime).toISOString(), summary: 'Public synthetic condition; no actual HA state' } };
}
function fixture(store = new SQLiteEventStore(':memory:', key), { status = 200 } = {}) {
  const packets = [];
  const send = async (_url, p) => {
    const data = new Webhook(secret).verify(p.body, p.headers); packets.push(data);
    return { status: data.type === 'verification' ? 200 : status, body: JSON.stringify({ challenge: data.challenge }) };
  };
  const engine = new HaMcpEvents({ store, owner, entityIds, now: () => new Date(fixtureTime), authorize: async id => id === owner,
    send, retry: { delaysSeconds: [1, 5, 30], jitter: false } });
  return { engine, store, packets, send };
}
async function subscribe(e, r = resources[2], includeRecovery = true, ids = [r.deviceId]) {
  return e.subscribe(owner, { name: r.name, arguments: { deviceIds: ids, includeRecovery }, delivery });
}
test('strict thin config has no rule DSL and cannot expand approved HA entities', () => {
  const c = { configVersion: 2, mode: 'aggregate', identity: { ownerId: owner, secretRef: 'service' }, secrets: { service: { env: 'PUBLIC_SERVICE' } },
    backends: [{ id: 'ha', enabled: false, transport: 'streamable_http', url: 'https://ha.example.invalid/mcp' }],
    events: { enabled: false, callback: { mode: 'exact_host_allowlist', allowedHosts: ['connectors.api.openai.com'] } },
    haConnector: { backendId: 'ha', entityIds } };
  assert.equal(parseThinConfig(c).haConnector.eventsEnabled, false);
  for (const change of [x => x.events.rules = [], x => x.events.budget = { perHour: 6 }, x => x.haConnector.forSeconds = 600,
    x => x.haConnector.entityIds = ['device_tracker.private'], x => x.haConnector.entityIds = [], x => x.haConnector.historyEnabled = true,
    x => x.haConnector.eventsEnabled = true]) { const x = structuredClone(c); change(x); assert.throws(() => parseThinConfig(x)); }
});
test('all five resources preserve event payload, occurrence, signed callback and paired recovery', async t => {
  const { engine, store, packets } = fixture(); t.after(() => { engine.stop(); store.close(); });
  for (const r of resources) {
    await subscribe(engine, r);
    const attention = packet(r, 'attention', `public-${r.ruleId}`);
    assert.equal((await engine.receive(r.eventType, attention)).queued, 1);
    assert.equal((await engine.drainOne()).outcome, 'delivered');
    assert.equal(packets.at(-1).eventId, attention.eventId); assert.equal(packets.at(-1).timestamp, attention.occurredAt);
    assert.deepEqual(packets.at(-1).data, attention.data);
    assert.equal((await engine.receive(r.eventType, packet(r, 'recovered', `public-${r.ruleId}`))).queued, 1);
    assert.equal((await engine.drainOne()).outcome, 'delivered');
  }
});
test('device and recovery filters remain subscriber parameters; source data is not inferred', async t => {
  const { engine, store } = fixture(); t.after(() => { engine.stop(); store.close(); });
  await subscribe(engine, resources[2], false);
  assert.equal((await engine.receive(resources[3].eventType, packet(resources[3], 'attention', 'public-other-hopper'))).queued, 0);
  assert.equal((await engine.receive(resources[2].eventType, packet())).queued, 1); await engine.drainOne();
  assert.equal((await engine.receive(resources[2].eventType, packet(resources[2], 'recovered'))).queued, 0);
  for (const mutate of [p => p.entityId = 'device_tracker.private', p => p.data.ruleId = 'invented', p => p.data.deviceId = 'wrong',
    p => p.data.context = { user_id: 'not-allowed' }, p => p.data.severity = 'info', p => p.expiresAt = new Date(fixtureTime + 2 * 86400_000).toISOString()]) {
    const p = packet(); mutate(p); assert.equal((await engine.receive(resources[2].eventType, p)).outcome, 'rejected');
  }
  assert.equal((await engine.receive('state_changed', packet())).outcome, 'rejected');
});
test('undelivered attention is cancelled on recovery without opening another business state', async t => {
  const { engine, store } = fixture(); t.after(() => { engine.stop(); store.close(); }); await subscribe(engine);
  await engine.receive(resources[2].eventType, packet()); assert.equal(await store.pendingCount(owner), 1);
  assert.equal((await engine.receive(resources[2].eventType, packet(resources[2], 'recovered'))).outcome, 'attention_not_delivered');
  assert.equal(await store.pendingCount(owner), 0); assert.equal(typeof store.commitBusiness, 'undefined');
});
test('concurrent duplicate frames produce one pending event and retries preserve source identity', async t => {
  const { engine, store } = fixture(undefined, { status: 503 }); t.after(() => { engine.stop(); store.close(); }); await subscribe(engine);
  const outcomes = await Promise.all([engine.receive(resources[2].eventType, packet()), engine.receive(resources[2].eventType, packet())]);
  assert.deepEqual(outcomes.map(x => x.outcome), ['queued', 'duplicate']); assert.equal(await store.pendingCount(owner), 1);
  assert.equal((await engine.drainOne()).outcome, 'retry'); assert.equal(await store.pendingCount(owner), 1);
});
test('old store/owner/contracts retain six subscriptions, pending jobs and refreshed ID across candidate restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-gateway-thin-compat-')); const file = join(dir, 'events.sqlite');
  let store = await SQLiteEventStore.open({ file, key }); const f = fixture(store);
  const old = new McpEvents({ store, definitions: eventDefinitions, authorize: async id => id === owner, send: f.send, now: () => new Date(fixtureTime) });
  const groups = new Map(); for (const r of resources) groups.set(r.name, [...(groups.get(r.name) ?? []), r.deviceId]);
  for (const [name, ids] of groups) await old.subscribe(owner, { name, arguments: { deviceIds: ids, includeRecovery: true }, delivery });
  await old.subscribe(owner, { name: 'gateway__digest', arguments: {}, delivery });
  await old.subscribe(owner, { name: 'poc__synthetic', arguments: { kind: 'cat' }, delivery });
  const before = await store.listSubscriptions(owner), r = resources[0], p = packet(r);
  await old.publish(owner, p.data, { name: r.name, meta: { incidentId: p.data.incidentId, phase: 'attention', expiresAt: fixtureTime + 7200_000 } });
  old.stop(); store.close(); store = await SQLiteEventStore.open({ file, key }); const next = fixture(store).engine;
  t.after(async () => { next.stop(); store.close(); await rm(dir, { recursive: true, force: true }); });
  assert.deepEqual(await store.listSubscriptions(owner), before); assert.equal(before.length, 6); assert.equal(await store.pendingCount(owner), 1);
  assert.equal((await next.drainOne()).outcome, 'delivered');
  const input = { name: r.name, arguments: { deviceIds: [r.deviceId], includeRecovery: true }, delivery };
  assert.equal((await next.subscribe(owner, input)).id, subscriptionId(owner, input));
  const after = await store.listSubscriptions(owner); assert.equal(after.length, 6);
  const a = after.find(x => x.name === r.name), b = before.find(x => x.name === r.name);
  assert.equal(a.generation, b.generation); assert.equal(a.id, b.id);
});
class Socket extends EventTarget {
  static sockets = []; readyState = 1; sent = [];
  constructor(url) { super(); this.url = url; Socket.sockets.push(this); }
  send(value) { this.sent.push(JSON.parse(value)); }
  frame(value) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event('close')); }
}
const flush = () => new Promise(resolve => setImmediate(resolve));
test('HA websocket subscribes only four explicit event types; disconnect does not infer or replay state', async t => {
  const timers = [], received = [], socket = new HaEventSocket({ url: 'ws://ha.example.invalid/api/websocket', secretRef: 'ha' },
    { WebSocketImpl: Socket, resolveSecret: async () => 'PUBLIC_HA_TOKEN_FIXTURE', receive: async (...a) => received.push(a),
      schedule: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; }, cancel: () => {} });
  t.after(() => socket.stop()); socket.start(); const ws = Socket.sockets.at(-1);
  ws.frame({ type: 'auth_required' }); await flush(); ws.frame({ type: 'auth_ok' }); await flush();
  const commands = ws.sent.filter(x => x.type === 'subscribe_events'); assert.deepEqual(commands.map(x => x.event_type), eventTypes);
  for (const s of commands) ws.frame({ type: 'result', id: s.id, success: true }); await flush(); assert.equal(socket.health().state, 'connected');
  ws.frame({ type: 'event', id: commands[0].id, event: { event_type: 'state_changed', data: { private: true } } }); await flush(); assert.equal(received.length, 0);
  ws.frame({ type: 'event', id: commands[0].id, event: { event_type: commands[0].event_type, data: packet(resources[0]) } }); await flush(); assert.equal(received.length, 1);
  ws.close(); await flush(); assert.equal(socket.health().connectionGaps, 1); timers.at(-1).fn();
  ws.frame({ type: 'event', id: commands[0].id, event: { event_type: commands[0].event_type, data: packet(resources[0]) } }); await flush(); assert.equal(received.length, 1);
  assert.equal(socket.health().replay, false);
});
test('HA permission rejection stops reconnect and never falls back to broad state reads', async t => {
  const timers = [], socket = new HaEventSocket({ url: 'ws://ha.example.invalid/api/websocket', secretRef: 'ha' },
    { WebSocketImpl: Socket, resolveSecret: async () => 'PUBLIC_HA_TOKEN_FIXTURE', receive: () => assert.fail('No event permitted'),
      schedule: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; }, cancel: () => {} });
  t.after(() => socket.stop()); socket.start(); Socket.sockets.at(-1).frame({ type: 'auth_invalid' }); await flush();
  assert.equal(socket.health().state, 'permission_rejected'); assert.equal(timers.length, 1);
});
