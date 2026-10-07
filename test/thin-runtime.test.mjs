import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Webhook } from 'standardwebhooks';
import { createThinAggregate } from '../src/aggregate.mjs';
import { parseThinConfig } from '../src/config.mjs';
import { entityIds, resources, eventDefinitions, createHaContract } from '../src/connectors/ha/contract.mjs';
import { SQLiteEventStore } from '../src/store.mjs';
import { SERVICE_SECRET_HEADER } from '../src/identity.mjs';
import { listenGateway } from '../src/listener.mjs';
const service = 'PUBLIC_THIN_SERVICE_FIXTURE_DO_NOT_DEPLOY', state = Buffer.alloc(32, 8).toString('base64');
const secret = `whsec_${Buffer.alloc(32, 3).toString('base64')}`;
const nativeTools = JSON.parse(await readFile(new URL('./fixtures/ha-tools.json', import.meta.url))).tools
  .map(t => Object.fromEntries(Object.entries(t).filter(([, value]) => value !== null)));
function config() { return { configVersion: 2, mode: 'aggregate', identity: { ownerId: 'public-owner', secretRef: 'service' },
  secrets: { service: { env: 'PUBLIC_SERVICE' }, ha: { env: 'PUBLIC_HA' }, state: { env: 'PUBLIC_STATE' } },
  backends: [{ id: 'ha', enabled: true, transport: 'streamable_http', url: 'http://ha.example.invalid/api/mcp/assist',
    auth: { type: 'bearer', secretRef: 'ha' }, protocolNegotiation: 'legacy' }],
  events: { enabled: true, state: { databaseFile: '/var/lib/mcp-gateway/events.sqlite', keyRef: 'state' }, callback: { mode: 'exact_host_allowlist', allowedHosts: ['connectors.api.openai.com'] } },
  haConnector: { backendId: 'ha', eventsEnabled: true, historyEnabled: true, entityIds } }; }
class Socket extends EventTarget {
  static sockets = []; readyState = 1; sent = [];
  constructor() { super(); Socket.sockets.push(this); }
  send(data) { this.sent.push(JSON.parse(data)); }
  frame(data) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) })); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event('close')); }
}
const flush = () => new Promise(resolve => setImmediate(resolve));
async function rpc(g, method, params = {}, credential = service) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', [SERVICE_SECRET_HEADER]: credential,
    'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': method };
  if (params.name) headers['Mcp-Name'] = params.name;
  params = { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'public-thin-mock', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} } };
  const req = new Request('http://127.0.0.1/mcp', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const res = await g.fetch(req), text = await res.text();
  return { status: res.status, message: JSON.parse(res.headers.get('content-type')?.includes('text/event-stream') ? text.split('\n').find(x => x.startsWith('data:')).slice(5) : text) };
}
for (const external of [false, true]) test(`isolated MCP mock routes native tools, History and signed events with ${external ? 'external' : 'default'} fixed mapping`, async t => {
  const mapping = { resources: resources.map(({ name, ...r }) => ({ ...r,
    entityId: r.entityId.replace('example_', 'deployment_example_'), deviceId: `sample_${r.deviceId}`,
    eventType: r.eventType.replace('mcp_ha_', 'sample_ha_') })) };
  const contract = createHaContract(external ? mapping : undefined);
  const { entityIds: selected, resources: bindings, eventDefinitions: definitions } = contract;
  const c = config(); c.haConnector.entityIds = selected;
  if (external) c.haConnector.contractFile = '/run/config/ha-resources.json';
  const dir = await mkdtemp(join(tmpdir(), 'mcp-gateway-thin-runtime-')), calls = [], delivered = [], timers = [];
  const fetchImpl = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init); assert.equal(req.headers.get('authorization'), 'Bearer PUBLIC_HA_FIXTURE');
    const url = new URL(req.url); assert.equal(url.origin, 'http://ha.example.invalid');
    if (url.pathname.startsWith('/api/history/period/')) {
      calls.push({ method: 'GET', entityIds: url.searchParams.get('filter_entity_id') });
      return Response.json([[{ entity_id: selected[2], state: 'off', last_changed: '2026-10-07T00:00:00Z', attributes: { private: 'excluded' } }]]);
    }
    assert.equal(url.pathname, '/api/mcp/assist');
    if (req.method !== 'POST') return new Response(null, { status: 405 });
    const message = await req.json(); calls.push(message);
    if (!('id' in message)) return new Response(null, { status: 202 });
    const result = message.method === 'initialize' ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'public-ha-fixture', version: '1' } }
      : message.method === 'tools/list' ? { tools: nativeTools }
        : message.method === 'tools/call' ? { content: [{ type: 'text', text: 'public native read result' }], _meta: { public: 'preserved' } } : undefined;
    assert.ok(result, message.method); return Response.json({ jsonrpc: '2.0', id: message.id, result });
  };
  const app = await createThinAggregate(c, { env: { PUBLIC_SERVICE: service, PUBLIC_HA: 'PUBLIC_HA_FIXTURE', PUBLIC_STATE: state }, fetchImpl,
    readHaContractFile: path => { assert.ok(external); assert.equal(path, c.haConnector.contractFile); return JSON.stringify(mapping); },
    WebSocketImpl: Socket, openStore: options => SQLiteEventStore.open({ ...options, file: join(dir, 'events.sqlite') }),
    schedule: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; }, cancel: () => {},
    send: async (_url, p) => { const body = new Webhook(secret).verify(p.body, p.headers); delivered.push(body); return { status: 200, body: JSON.stringify({ challenge: body.challenge }) }; } });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  assert.equal(app.rules, undefined); assert.equal((await rpc(app.gateway, 'tools/list', {}, 'wrong')).status, 401);
  const catalog = (await rpc(app.gateway, 'tools/list')).message.result.tools;
  assert.deepEqual(catalog.filter(x => x.name !== 'ha_history__query'), nativeTools); assert.equal(catalog.length, nativeTools.length + 1);
  assert.deepEqual((await rpc(app.gateway, 'events/list')).message.result.events.map(({ delivery, ...d }) => d), definitions);
  assert.deepEqual(catalog.at(-1).inputSchema.properties.entityIds.items.enum, selected);
  assert.ok(!(await rpc(app.gateway, 'tools/list')).message.result.tools.some(x => x.name === 'gateway__emit_synthetic'));
  const read = await rpc(app.gateway, 'tools/call', { name: 'llm__GetDateTime', arguments: {} }); assert.equal(read.message.result._meta.public, 'preserved');
  const history = await rpc(app.gateway, 'tools/call', { name: 'ha_history__query', arguments: { from: '2026-10-07T00:00:00Z', to: '2026-10-07T01:00:00Z', entityIds: [selected[2]] } });
  assert.equal(history.message.result.structuredContent.items.length, 1); assert.ok(!JSON.stringify(history).includes('excluded'));
  assert.equal(calls.find(x => x.method === 'GET').entityIds, selected[2]);
  const params = { name: 'pet__food_low', arguments: { deviceIds: [bindings[2].deviceId], includeRecovery: true },
    delivery: { mode: 'webhook', url: 'https://connectors.api.openai.com/public-thin-fixture', secret } };
  const sub = (await rpc(app.gateway, 'events/subscribe', params)).message.result; assert.ok(sub.id);
  await app.start(); const ws = Socket.sockets.at(-1); ws.frame({ type: 'auth_ok' }); await flush();
  const commands = ws.sent.filter(x => x.type === 'subscribe_events'); assert.equal(commands.length, 4);
  for (const c of commands) ws.frame({ type: 'result', id: c.id, success: true }); await flush();
  assert.deepEqual(commands.map(x => x.event_type), contract.eventTypes);
  const r = bindings[2], current = Date.now(), stamp = new Date(current).toISOString();
  const envelope = { entityId: r.entityId, eventId: 'public-ha-incident:attention', occurredAt: stamp, expiresAt: new Date(current + 7200_000).toISOString(),
    data: { eventVersion: 1, source: 'ha_selected_entities', ruleId: r.ruleId, deviceId: r.deviceId, incidentId: 'public-ha-incident', phase: 'attention', severity: 'warning', observedAt: stamp, summary: 'Synthetic only' } };
  const command = commands.find(c => c.event_type === r.eventType); ws.frame({ type: 'event', id: command.id, event: { event_type: r.eventType, data: envelope } }); await flush();
  assert.equal(await app.store.pendingCount('public-owner'), 1); await app.tick(); assert.equal(delivered.at(-1).eventId, envelope.eventId);
  const { secret: ignored, ...destination } = params.delivery;
  assert.ok(!(await rpc(app.gateway, 'events/unsubscribe', { ...params, delivery: destination })).message.error);
  assert.equal(await app.store.pendingCount('public-owner'), 0);
  assert.ok(calls.every(c => c.method !== 'tools/call' || ['llm__GetDateTime'].includes(c.params.name)));
});
test('disabled thin connector performs no state/history request and opens no socket', async t => {
  const c = config(); c.events.enabled = false; c.haConnector.eventsEnabled = false; c.haConnector.historyEnabled = false; c.backends[0].enabled = false;
  const count = Socket.sockets.length;
  const app = await createThinAggregate(c, { env: { PUBLIC_SERVICE: service }, fetchImpl: () => assert.fail('No network'), openStore: () => assert.fail('No store'), WebSocketImpl: Socket });
  t.after(() => app.close()); await app.start(); assert.equal(Socket.sockets.length, count); assert.equal(app.history, undefined);
});
test('isolated HTTP listener serves authenticated MCP and closes without tunnel or production resources', async t => {
  const c = config(); c.events.enabled = false; c.haConnector.eventsEnabled = false; c.haConnector.historyEnabled = false; c.backends[0].enabled = false;
  const app = await createThinAggregate(c, { env: { PUBLIC_SERVICE: service } });
  const listener = await listenGateway(app.gateway); t.after(async () => { await app.stop(); await listener.close(); });
  const response = await fetch(listener.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', [SERVICE_SECRET_HEADER]: service },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
  assert.equal(response.status, 200); assert.ok((await response.text()).includes('tools'));
});
