import { parseThinConfig } from './config.mjs';
import { createSecretResolver } from './secrets.mjs';
import { createLocalServiceIdentity } from './identity.mjs';
import { DynamicBackend } from './upstream.mjs';
import { createAggregateGateway } from './aggregate-gateway.mjs';
import { SQLiteEventStore } from './store.mjs';
import { createCallbackTransport } from './callback.mjs';
import { OutboxWorker } from './worker.mjs';
import { HaMcpEvents } from './connectors/ha/events.mjs';
import { HaEventSocket } from './connectors/ha/socket.mjs';
import { HaHistory } from './connectors/ha/history.mjs';
import { loadHaContract } from './connectors/ha/contract.mjs';

export async function createThinAggregate(input, { env, readSecretFile, fetchImpl, openStore = options => SQLiteEventStore.open(options),
  WebSocketImpl, send, now = Date.now, schedule = setTimeout, cancel = clearTimeout, diagnostic, readHaContractFile } = {}) {
  const config = parseThinConfig(input), contract = loadHaContract(config.haConnector, readHaContractFile);
  const resolve = createSecretResolver(config.secrets, { ...(env ? { env } : {}), ...(readSecretFile ? { readSecretFile } : {}) });
  const service = await resolve(config.identity.secretRef); if (service.length < 32) throw new Error('Service credential too short');
  const backends = config.backends.filter(b => b.enabled).map(b => new DynamicBackend(b, { resolveSecret: resolve, ...(fetchImpl ? { fetchImpl } : {}) }));
  const ha = config.backends.find(b => b.id === config.haConnector.backendId), selected = config.haConnector.entityIds;
  let store, events, worker, socket, history, gateway, stopped = false;
  try {
    if (config.events.enabled) {
      const text = await resolve(config.events.state.keyRef), key = Buffer.from(text, 'base64');
      if (key.length !== 32 || key.toString('base64') !== text) throw new Error('Invalid external state key');
      try { store = await openStore({ file: config.events.state.databaseFile, key,
        encryptionNamespace: config.events.state.encryptionNamespace }); } finally { key.fill(0); }
      events = new HaMcpEvents({ store, owner: config.identity.ownerId, entityIds: selected, contract, retry: config.events.retry,
        now: () => new Date(now()), send: send ?? createCallbackTransport({ policy: config.events.callback }),
        authorize: async id => id === config.identity.ownerId, diagnostic });
      worker = new OutboxWorker(events, { schedule, cancel });
      if (config.haConnector.eventsEnabled) {
        await resolve(ha.auth.secretRef);
        const url = new URL('/api/websocket', ha.url); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        socket = new HaEventSocket({ url: url.href, secretRef: ha.auth.secretRef }, { resolveSecret: resolve, receive: (...a) => events.receive(...a), eventTypes: contract.eventTypes, now, schedule, cancel,
          ...(WebSocketImpl ? { WebSocketImpl } : {}) });
      }
    }
    if (config.haConnector.historyEnabled) {
      history = new HaHistory({ origin: new URL(ha.url).origin, entityIds: selected, resolveToken: () => resolve(ha.auth.secretRef),
        cursorSecret: service, owner: config.identity.ownerId, now, timeoutMs: ha.timeoutMs, ...(fetchImpl ? { fetchImpl } : {}) });
      backends.push(history.backend());
    }
    gateway = createAggregateGateway({ backends, events, collectorHealth: () => socket ? [socket.health()] : [],
      authenticate: createLocalServiceIdentity({ owner: config.identity.ownerId, scopes: ['tools:use'],
        header: config.identity.serviceSecretHeader, readServiceSecret: () => resolve(config.identity.secretRef) }) });
  } catch (error) { store?.close(); await Promise.all(backends.map(b => b.close())); throw error; }
  return { config, gateway, store, events, history, socket,
    async start() { if (stopped) return; socket?.start(); worker?.start(); },
    async tick() { return worker?.tick(); },
    async stop() { if (stopped) return; stopped = true; await socket?.stop(); await worker?.stop(); },
    async close() { await this.stop(); await gateway.close(); store?.close(); } };
}
