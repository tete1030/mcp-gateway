import test from 'node:test';
import assert from 'node:assert/strict';
import { parseThinConfig } from '../src/config.mjs';
import { entityIds } from '../src/connectors/ha/contract.mjs';
import { createSecretResolver } from '../src/secrets.mjs';
import { DynamicBackend } from '../src/upstream.mjs';
import { createAggregateGateway } from '../src/aggregate-gateway.mjs';

const sample = () => ({ configVersion: 2, mode: 'aggregate', identity: { ownerId: 'public-owner', secretRef: 'service' },
  secrets: { service: { env: 'PUBLIC_SERVICE_FIXTURE' }, backend: { file: '/run/secrets/public_fixture' } },
  events: { enabled: false, callback: { mode: 'exact_host_allowlist', allowedHosts: [] } },
  haConnector: { backendId: 'one', entityIds },
  backends: [{ id: 'one', enabled: true, transport: 'streamable_http', url: 'https://backend.example/mcp', auth: { type: 'bearer', secretRef: 'backend' } }] });
const tool = () => ({ name: 'NativeCase__Tool', description: 'Upstream description',
  inputSchema: { type: 'object', properties: { extra: { type: 'string' } } }, outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
  annotations: { readOnlyHint: false, idempotentHint: false }, _meta: { public: 'metadata' } });
function fixture(config, { fail = false } = {}) {
  let tools = [tool()]; const wire = [];
  const b = new DynamicBackend(config, { resolveSecret: async () => 'PUBLIC_BACKEND_FIXTURE', fetchImpl: async request => {
    assert.equal(request.url, config.url); assert.equal(request.redirect, 'error');
    assert.equal(request.headers.get('authorization'), 'Bearer PUBLIC_BACKEND_FIXTURE');
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    const m = await request.json(); wire.push(m);
    if (!('id' in m)) return new Response(null, { status: 202 });
    let result;
    if (m.method === 'server/discover') return new Response('{}', { status: 404 });
    if (m.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'public-offline', version: '1' } };
    else if (m.method === 'tools/list') result = { tools };
    else if (m.method === 'tools/call') {
      if (fail) throw new Error('PUBLIC_BACKEND_FIXTURE must never escape');
      result = { content: [{ type: 'text', text: 'native result' }], structuredContent: { ok: true }, _meta: { custom: 'preserved' }, isError: true };
    } else assert.fail(m.method);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }), { headers: { 'Content-Type': 'application/json' } });
  } });
  return { backend: b, wire, setTools: t => { tools = t; } };
}
async function rpc(gateway, method, params = {}, headers = {}) {
  const r = await gateway.fetch(new Request('http://127.0.0.1/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }));
  const body = await r.text(); return r.headers.get('content-type')?.includes('text/event-stream') ? JSON.parse(body.split('\n').find(l => l.startsWith('data:')).slice(5)) : JSON.parse(body);
}
test('secret resolver uses exactly one file/env source and never silently falls back', async () => {
  const resolve = createSecretResolver({ a: { env: 'PUBLIC_A' }, b: { file: '/run/secrets/b' } }, { env: { PUBLIC_A: 'value' }, readSecretFile: async () => 'file-value' });
  assert.equal(await resolve('a'), 'value'); assert.equal(await resolve('b'), 'file-value');
  await assert.rejects(resolve('missing'));
  await assert.rejects(createSecretResolver({ a: { env: 'PUBLIC_A', file: '/run/secrets/a' } })('a'));
});
test('dynamic native catalog and results preserve schemas, metadata, case and error status', async t => {
  const f = fixture(parseThinConfig(sample()).backends[0]);
  const gateway = createAggregateGateway({ backends: [f.backend], authenticate: async () => ({ id: 'public-owner', scopes: ['tools:use'] }) });
  t.after(() => gateway.close());
  assert.deepEqual((await rpc(gateway, 'tools/list')).result.tools, [tool()]);
  const result = (await rpc(gateway, 'tools/call', { name: tool().name, arguments: { extra: 'unchanged' } })).result;
  assert.equal(result.isError, true); assert.deepEqual(result._meta, { custom: 'preserved' }); assert.equal(result.content[0].text, 'native result');
  const added = { name: 'NewTool', inputSchema: { type: 'object' } }; f.setTools([added]);
  assert.deepEqual(await gateway.refreshCatalog(), [added]);
  assert.ok((await rpc(gateway, 'tools/call', { name: tool().name })).error);
});
test('multiple backends use optional prefix; deny wins and unnamespaced collisions reject atomically', async t => {
  const c = parseThinConfig(sample()).backends[0];
  const a = fixture({ ...structuredClone(c), namespace: 'one__' }), b = fixture({ ...structuredClone(c), id: 'two', namespace: 'two__' });
  const gateway = createAggregateGateway({ backends: [a.backend, b.backend], authenticate: async () => ({ id: 'public-owner', scopes: ['tools:use'] }) }); t.after(() => gateway.close());
  assert.deepEqual((await gateway.refreshCatalog()).map(x => x.name), ['one__NativeCase__Tool', 'two__NativeCase__Tool']);
  a.backend.config.namespace = undefined; b.backend.config.namespace = undefined; await assert.rejects(gateway.refreshCatalog(), /collision/);
  b.backend.config.tools.deny = [tool().name]; assert.equal((await gateway.refreshCatalog()).length, 1);
  b.backend.config.tools = { mode: 'allowlist', allow: [tool().name], deny: [tool().name] }; assert.equal((await gateway.refreshCatalog()).length, 1);
});
test('failed action dispatch is attempted once, returns sanitized unknown outcome, reconnect has no replay', async t => {
  const f = fixture(parseThinConfig(sample()).backends[0], { fail: true });
  const g = createAggregateGateway({ backends: [f.backend], authenticate: async () => ({ id: 'public-owner', scopes: ['tools:use'] }) }); t.after(() => g.close());
  const r = await rpc(g, 'tools/call', { name: tool().name }); assert.equal(r.result.isError, true);
  assert.ok(!JSON.stringify(r).includes('PUBLIC_BACKEND_FIXTURE')); assert.equal(f.wire.filter(x => x.method === 'tools/call').length, 1);
  await rpc(g, 'tools/list'); assert.equal(f.wire.filter(x => x.method === 'tools/call').length, 1);
});

test('platform-style tools/call metadata reaches a native backend only as the original tool arguments', async t => {
  const f = fixture(parseThinConfig(sample()).backends[0]);
  const native = { ...tool(), name: 'homeassistant__GetLiveContext' }; f.setTools([native]);
  const g = createAggregateGateway({ backends: [f.backend], authenticate: async () => ({ id: 'public-owner', scopes: ['tools:use'] }) }); t.after(() => g.close());
  const metadata = { progressToken: 'public-progress', 'openai/locale': 'zh-CN',
    'openai/userLocation': { city: 'Fixture city', timezone: 'Etc/UTC' },
    'com.example/extension': { nested: [true, null, 1] } };
  assert.deepEqual((await rpc(g, 'tools/list', { _meta: metadata })).result.tools, [native]);
  const args = { domain: ['light'], area: 'Fixture room' };
  const r = await rpc(g, 'tools/call', { name: native.name, arguments: args, _meta: metadata });
  assert.equal(r.error, undefined); assert.equal(r.result.content[0].text, 'native result');
  const calls = f.wire.filter(m => m.method === 'tools/call'); assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, { name: native.name, arguments: args });
  assert.ok(!JSON.stringify(f.wire).includes('Fixture city'));
});

test('modern per-request MCP envelope plus vendor metadata works and is terminated before legacy HA', async t => {
  const f = fixture(parseThinConfig(sample()).backends[0]);
  const g = createAggregateGateway({ backends: [f.backend], authenticate: async () => ({ id: 'public-owner', scopes: ['tools:use'] }) }); t.after(() => g.close());
  const metadata = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': { name: 'platform-regression-fixture', version: '1' },
    'io.modelcontextprotocol/clientCapabilities': {}, 'openai/locale': 'zh-CN' };
  const headers = { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call', 'Mcp-Name': tool().name };
  const r = await rpc(g, 'tools/call', { name: tool().name, arguments: { extra: 'native argument' }, _meta: metadata }, headers);
  assert.equal(r.error, undefined); assert.equal(r.result.content[0].text, 'native result');
  assert.deepEqual(f.wire.find(m => m.method === 'tools/call').params, { name: tool().name, arguments: { extra: 'native argument' } });
  const listing = await rpc(g, 'tools/list', { _meta: metadata }, { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/list' });
  assert.equal(listing.error, undefined); assert.deepEqual(listing.result.tools, [tool()]);
});

test('malformed and excessive request metadata is rejected before backend dispatch', async t => {
  const f = fixture(parseThinConfig(sample()).backends[0]);
  const g = createAggregateGateway({ backends: [f.backend], authenticate: async () => ({ id: 'public-owner', scopes: ['tools:use'] }) }); t.after(() => g.close());
  let deep = 'leaf'; for (let i = 0; i < 9; i++) deep = { child: deep };
  const bad = [null, [], 'invalid', { progressToken: {} }, { progressToken: 1.5 },
    { extension: 'x'.repeat(16 * 1024) }, { extension: deep },
    Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`key${i}`, i])),
    { extension: Array.from({ length: 1024 }, () => 0) }, { ['k'.repeat(257)]: true }];
  for (const metadata of bad) {
    const r = await rpc(g, 'tools/call', { name: tool().name, _meta: metadata });
    // The SDK rejects malformed base envelopes (-32600); our method schema
    // rejects structurally valid envelopes that exceed limits (-32602).
    assert.ok([-32600, -32602].includes(r.error?.code));
  }
  assert.equal(f.wire.length, 0);
});

test('metadata compatibility keeps unknown top-level request fields strict', async t => {
  const f = fixture(parseThinConfig(sample()).backends[0]);
  const g = createAggregateGateway({ backends: [f.backend], authenticate: async () => ({ id: 'public-owner', scopes: ['tools:use'] }) }); t.after(() => g.close());
  for (const [method, params] of [['tools/call', { name: tool().name, unexpected: true }], ['tools/list', { unexpected: true }]]) {
    assert.equal((await rpc(g, method, { ...params, _meta: { 'openai/locale': 'zh-CN' } })).error?.code, -32602);
  }
  assert.equal(f.wire.length, 0);
});

test('request metadata cannot grant tool authority or replace authenticated owner', async t => {
  const f = fixture(parseThinConfig(sample()).backends[0]);
  const g = createAggregateGateway({ backends: [f.backend], authenticate: async () => ({ id: 'public-owner', scopes: ['tools:read'] }) }); t.after(() => g.close());
  const r = await rpc(g, 'tools/call', { name: tool().name, _meta: {
    'com.example/principal': { id: 'other-owner', scopes: ['tools:use'] },
    'com.example/authorization': 'PUBLIC_FORGED_FIXTURE' } });
  assert.equal(r.error?.code, -32001); assert.equal(f.wire.length, 0);
});

test('the bounded metadata schema also accepts modern list envelopes with a fixture-only events engine', async t => {
  const owners = [];
  const g = createAggregateGateway({ backends: [], authenticate: async () => ({ id: 'public-owner', scopes: ['tools:use'] }),
    events: { list: async owner => { owners.push(owner); return { events: [] }; } } }); t.after(() => g.close());
  const metadata = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': { name: 'fixture-only', version: '1' },
    'io.modelcontextprotocol/clientCapabilities': {}, 'openai/locale': 'zh-CN' };
  const r = await rpc(g, 'events/list', { _meta: metadata }, { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'events/list' });
  assert.equal(r.error, undefined); assert.deepEqual(r.result.events, []); assert.deepEqual(owners, ['public-owner']);
});
