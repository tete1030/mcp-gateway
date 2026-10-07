import { McpEvents } from '../../events.mjs';
import { eventDefinitions, mapHaEvent } from './contract.mjs';

export class HaMcpEvents extends McpEvents {
  #seen = new Map();
  #tail = Promise.resolve();
  constructor(options) { super({ ...options, definitions: eventDefinitions }); this.allowedEntities = options.entityIds; this.owner = options.owner; }
  receive(type, input) {
    const task = this.#tail.then(() => this.#receive(type, input)); this.#tail = task.catch(() => {}); return task;
  }
  async #receive(type, input) {
    let message;
    try { message = mapHaEvent(type, input, this.allowedEntities, this.now().getTime()); }
    catch { return { outcome: 'rejected' }; }
    const now = this.now().getTime(), expiry = Date.parse(message.expiresAt);
    if (expiry <= now) return { outcome: 'expired' };
    for (const [id, until] of this.#seen) if (until <= now) this.#seen.delete(id);
    if (this.#seen.has(message.eventId)) return { outcome: 'duplicate' };
    const incident = message.data.incidentId;
    if (message.data.phase === 'recovered') {
      await this.store.cancelQueuedAttention(this.owner, incident);
      if (!await this.store.wasDelivered(this.owner, incident, now)) return { outcome: 'attention_not_delivered' };
    } else if (await this.store.wasDelivered(this.owner, incident, now)) return { outcome: 'duplicate' };
    const event = await this.prepare(this.owner, message.name, message.data,
      { incidentId: incident, phase: message.data.phase, expiresAt: expiry });
    const body = JSON.parse(event.body); body.eventId = message.eventId; body.timestamp = message.occurredAt;
    event.eventId = message.eventId; event.body = JSON.stringify(body);
    const queued = await this.store.enqueue(this.owner, event, now);
    if (this.#seen.size >= 1024) this.#seen.delete(this.#seen.keys().next().value);
    this.#seen.set(message.eventId, expiry);
    return { outcome: 'queued', queued: queued.length };
  }
}
