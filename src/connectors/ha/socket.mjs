import { eventTypes } from './contract.mjs';

// Realtime custom events only: no state rules, snapshot inference or replay.
export class HaEventSocket {
  #socket; #generation = 0; #sequence = 0; #running = false; #terminal = false;
  #queue = Promise.resolve(); #subscriptions = new Map(); #pending = new Set();
  #heartbeat; #reconnect; #attempt = 0; #lastReceived = 0; #state = 'stopped'; #gaps = 0;
  constructor({ url, secretRef }, { resolveSecret, receive, WebSocketImpl = WebSocket,
    schedule = setTimeout, cancel = clearTimeout, now = Date.now } = {}) {
    const u = new URL(url);
    if (!['ws:', 'wss:'].includes(u.protocol) || u.username || u.password || u.search || u.hash || u.pathname !== '/api/websocket') throw new Error('Invalid HA event endpoint');
    Object.assign(this, { url, secretRef, types: eventTypes, resolveSecret, receive, WebSocketImpl, schedule, cancel, now });
  }
  health() { return { id: 'ha', state: this.#state, subscribedEventTypes: this.#subscriptions.size,
    connectionGaps: this.#gaps, replay: false }; }
  #send(message) { if (this.#socket?.readyState === 1) this.#socket.send(JSON.stringify(message)); }
  #connect() {
    if (!this.#running || this.#terminal) return;
    const generation = ++this.#generation, socket = this.#socket = new this.WebSocketImpl(this.url);
    this.#sequence = 0; this.#subscriptions.clear(); this.#pending.clear(); this.#state = 'connecting'; this.#lastReceived = this.now();
    const beat = () => {
      if (!this.#running || generation !== this.#generation) return;
      if (this.now() - this.#lastReceived > 60_000) { socket.close(); return; }
      if (this.#state === 'connected') this.#send({ id: ++this.#sequence, type: 'ping' });
      this.#heartbeat = this.schedule(beat, 30_000);
    };
    this.#heartbeat = this.schedule(beat, 30_000);
    socket.addEventListener('message', message => {
      this.#queue = this.#queue.then(async () => {
        if (!this.#running || generation !== this.#generation) return;
        if (typeof message.data !== 'string' || Buffer.byteLength(message.data) > 64 * 1024) throw new Error('Invalid HA frame');
        const m = JSON.parse(message.data); this.#lastReceived = this.now();
        if (m.type === 'auth_required') {
          const token = await this.resolveSecret(this.secretRef);
          if (this.#running && generation === this.#generation) this.#send({ type: 'auth', access_token: token });
        } else if (m.type === 'auth_ok') {
          this.#state = 'subscribing';
          for (const type of this.types) {
            const id = ++this.#sequence; this.#subscriptions.set(id, type); this.#pending.add(id);
            this.#send({ id, type: 'subscribe_events', event_type: type });
          }
        } else if (m.type === 'auth_invalid' || (m.type === 'result' && this.#pending.has(m.id) && !m.success)) {
          this.#terminal = true; this.#state = 'permission_rejected'; socket.close();
        } else if (m.type === 'result' && this.#pending.delete(m.id)) {
          if (!this.#pending.size) { this.#state = 'connected'; this.#attempt = 0; }
        } else if (m.type === 'event' && this.#subscriptions.get(m.id) === m.event?.event_type) {
          // Rejected payloads do not log raw data or tear down an otherwise valid subscription.
          await this.receive(m.event.event_type, m.event.data);
        }
      }).catch(() => { if (generation === this.#generation) { this.#state = 'degraded'; socket.close(); } });
    });
    socket.addEventListener('error', () => { if (generation === this.#generation) { this.#state = 'degraded'; socket.close(); } });
    socket.addEventListener('close', () => {
      if (generation !== this.#generation) return;
      ++this.#generation; this.cancel(this.#heartbeat); this.#subscriptions.clear(); this.#pending.clear();
      if (!this.#running || this.#terminal) return;
      this.#gaps++; this.#state = 'reconnecting';
      this.#reconnect = this.schedule(() => this.#connect(), Math.min(60_000, 1000 * 2 ** Math.min(this.#attempt++, 6)));
    });
  }
  start() { if (this.#running) return; this.#running = true; this.#terminal = false; this.#connect(); }
  async stop() {
    this.#running = false; this.cancel(this.#heartbeat); this.cancel(this.#reconnect);
    for (const subscription of this.#subscriptions.keys()) this.#send({ id: ++this.#sequence, type: 'unsubscribe_events', subscription });
    ++this.#generation; this.#socket?.close(); this.#subscriptions.clear(); this.#pending.clear(); this.#state = 'stopped';
    await this.#queue;
  }
}
