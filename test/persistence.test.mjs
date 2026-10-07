import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile, stat, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SQLiteEventStore } from '../src/store.mjs';
import { SyntheticEvents, EVENT_NAME } from '../src/events.mjs';
import { Webhook } from 'standardwebhooks';

const key = () => Buffer.alloc(32, 7); // Public test fixture, not an external credential.
const secret = `whsec_${Buffer.alloc(32, 1).toString('base64')}`;
const args = () => ({ name: EVENT_NAME, arguments: { kind: 'cat' }, ttlMs: 600_000,
  delivery: { mode: 'webhook', url: 'https://callback.example/persist', secret } });
const stopArgs = () => ({ name: EVENT_NAME, arguments: { kind: 'cat' }, delivery: { mode: 'webhook', url: args().delivery.url } });
const data = { kind: 'cat', source: 'synthetic_poc', message: 'encrypted event body fixture' };
const deferred = () => {
  let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve };
};
const verify = packet => ({ status: 200, body: JSON.stringify({ challenge: JSON.parse(packet.body).challenge }) });
async function fixture(t, limits) {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-gateway-persistent-test-'));
  const file = join(dir, 'events.sqlite'); const opened = [];
  const reopen = async () => { const store = await SQLiteEventStore.open({ file, key: key(), ...limits }); opened.push(store); return store; };
  t.after(async () => { for (const store of opened) store.close(); await rm(dir, { recursive: true, force: true }); });
  return { file, dir, reopen, store: await reopen() };
}
function engine(store, { send, now, authorize = async () => true } = {}) {
  return new SyntheticEvents({ store, authorize, ...(now ? { now } : {}),
    send: send ?? (async (_url, packet) => JSON.parse(packet.body).type === 'verification' ? verify(packet) : { status: 204 }) });
}

test('encrypted subscriptions and queued events survive close/reopen with owner scope', async t => {
  const f = await fixture(t); const first = engine(f.store);
  const a = await first.subscribe('Alice-visible-owner', args());
  await first.subscribe('Bob-visible-owner', args());
  const published = await first.publish('Alice-visible-owner', data);
  assert.equal(published.queued.length, 1);
  assert.equal(await f.store.pendingCount('Bob-visible-owner'), 0);
  assert.equal(await f.store.getSubscription('Bob-visible-owner', a.id), undefined);
  await first.unsubscribe('Bob-visible-owner', stopArgs());
  assert.equal((await f.store.listSubscriptions('Alice-visible-owner')).length, 1);
  f.store.close();
  const bytes = await readFile(f.file);
  for (const value of [secret, args().delivery.url, data.message, 'Alice-visible-owner', 'Bob-visible-owner']) {
    assert.equal(bytes.includes(Buffer.from(value)), false);
  }
  assert.equal((await stat(f.file)).mode & 0o777, 0o600);
  const restored = await f.reopen(); const packets = [];
  const second = engine(restored, { send: async (_url, packet) => { packets.push(packet); return { status: 204 }; } });
  assert.equal((await restored.listSubscriptions('Alice-visible-owner'))[0].id, a.id);
  assert.equal((await second.drainOne()).outcome, 'delivered');
  assert.equal(JSON.parse(packets[0].body).eventId, published.eventId);
  new Webhook(secret).verify(packets[0].body, packets[0].headers);
  assert.equal(await restored.pendingCount('Alice-visible-owner'), 0);
});

test('a SIGKILL after queue commit or lease commit retains delivery and stable event ID', async t => {
  for (const phase of ['queued', 'leased']) {
    const f = await fixture(t); f.store.close();
    const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/crash.mjs', import.meta.url)), f.file, phase],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.resume();
    const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
    assert.equal(result.signal, 'SIGKILL');
    const original = JSON.parse(output);
    const store = await f.reopen(); const packets = [];
    const worker = engine(store, { now: () => new Date(Date.now() + 20_000),
      send: async (_url, packet) => { packets.push(packet); return { status: 204 }; } });
    assert.equal((await worker.drainOne()).outcome, 'delivered');
    assert.equal(JSON.parse(packets[0].body).eventId, original.eventId);
    assert.equal(await store.pendingCount('crash-test-owner'), 0);
  }
});

test('two store connections cannot claim one lease and stale completions cannot overwrite a new worker', async t => {
  const f = await fixture(t); const first = engine(f.store);
  await first.subscribe('A', args()); await first.publish('A', data);
  const other = await f.reopen(); const now = Date.now();
  const oldClaim = await f.store.claimDue(now, { leaseMs: 100 });
  assert.equal(await other.claimDue(now), undefined);
  const newClaim = await other.claimDue(now + 101);
  assert.ok(newClaim); assert.notEqual(newClaim.lease, oldClaim.lease);
  assert.equal(await f.store.settle(oldClaim, { retryAt: now + 1000 }), false);
  assert.ok(await other.delivery(newClaim, now + 101));
  assert.equal(await other.settle(newClaim), true);
  assert.equal(await other.pendingCount('A'), 0);
});

test('transient retry survives restart with exact body bytes and fresh signing timestamp', async t => {
  const f = await fixture(t); const packets = []; let time = new Date();
  const first = engine(f.store, { now: () => time, send: async (_url, packet) => {
    if (JSON.parse(packet.body).type === 'verification') return verify(packet);
    packets.push(packet); return { status: 503 };
  } });
  await first.subscribe('A', args()); await first.publish('A', data);
  const retry = await first.drainOne(); assert.equal(retry.outcome, 'retry');
  f.store.close(); time = new Date(retry.retryAt + 1000);
  const next = engine(await f.reopen(), { now: () => time, send: async (_url, packet) => { packets.push(packet); return { status: 204 }; } });
  assert.equal((await next.drainOne()).outcome, 'delivered');
  assert.equal(packets[0].body, packets[1].body);
  assert.equal(packets[0].headers['webhook-id'], packets[1].headers['webhook-id']);
  assert.notEqual(packets[0].headers['webhook-signature'], packets[1].headers['webhook-signature']);
});

test('unsubscribe during verification fences activation, even through another engine', async t => {
  const f = await fixture(t); const started = deferred(); const finish = deferred();
  let challenge;
  const first = engine(f.store, { send: async (_url, packet) => {
    challenge = JSON.parse(packet.body).challenge; started.resolve(); return finish.promise;
  } });
  const subscription = first.subscribe('A', args()); await started.promise;
  await engine(await f.reopen()).unsubscribe('A', stopArgs());
  finish.resolve({ status: 200, body: JSON.stringify({ challenge }) });
  await assert.rejects(subscription, error => error.data?.reason === 'subscription_changed');
  assert.deepEqual(await f.store.listSubscriptions('A'), []);
  assert.deepEqual((await first.publish('A', data)).queued, []);
});

test('unsubscribe aborts in-flight work and late responses cannot affect a re-subscription', async t => {
  const f = await fixture(t); const started = deferred(); const finish = deferred();
  let signal; let sends = 0;
  const worker = engine(f.store, { send: async (_url, packet) => {
    if (JSON.parse(packet.body).type === 'verification') return verify(packet);
    sends++; signal = packet.signal;
    if (sends === 1) { started.resolve(); return finish.promise; }
    return { status: 204 };
  } });
  const original = await worker.subscribe('A', args()); await worker.publish('A', data);
  const pending = worker.drainOne(); await started.promise;
  await worker.unsubscribe('A', stopArgs()); assert.equal(signal.aborted, true);
  assert.equal(await f.store.pendingCount('A'), 0);
  assert.equal((await worker.subscribe('A', args())).id, original.id);
  await worker.publish('A', { ...data, message: 'new subscription event' });
  finish.resolve({ status: 204 });
  assert.equal((await pending).outcome, 'inactive_or_superseded');
  assert.equal(await f.store.pendingCount('A'), 1);
  assert.equal((await worker.drainOne()).outcome, 'delivered');
});

test('expiry and permission revocation suppress queued delivery after restart', async t => {
  for (const expired of [false, true]) {
    const f = await fixture(t); let time = new Date(); const before = engine(f.store, { now: () => time });
    await before.subscribe('A', { ...args(), ttlMs: 60_000 }); await before.publish('A', data); f.store.close();
    if (expired) time = new Date(time.getTime() + 60_001);
    let sends = 0;
    const after = engine(await f.reopen(), { now: () => time, authorize: async () => expired,
      send: async () => { sends++; return { status: 204 }; } });
    assert.equal((await after.drainOne()).outcome, expired ? 'inactive' : 'revoked');
    assert.equal(sends, 0);
  }
});

test('outbox capacity fails atomically and wrong keys/files fail closed', async t => {
  const f = await fixture(t, { maxOutbox: 1 }); const worker = engine(f.store);
  await worker.subscribe('A', args());
  await worker.subscribe('A', { ...args(), delivery: { ...args().delivery, url: 'https://callback.example/other' } });
  await assert.rejects(worker.publish('A', data), /capacity/);
  assert.equal(await f.store.pendingCount('A'), 0);
  f.store.close();
  await assert.rejects(SQLiteEventStore.open({ file: f.file, key: Buffer.alloc(32, 8) }), /initialization failed/);
  await chmod(f.file, 0o644);
  await assert.rejects(f.reopen(), /private regular/);
  await chmod(f.file, 0o600); await symlink(f.file, join(f.dir, 'linked.sqlite'));
  await assert.rejects(SQLiteEventStore.open({ file: join(f.dir, 'linked.sqlite'), key: key() }), /private regular/);
});
