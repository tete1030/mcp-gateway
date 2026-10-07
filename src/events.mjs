import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Webhook } from 'standardwebhooks';
import { z } from 'zod/v4';
import { ProtocolError, fromJsonSchema } from '@modelcontextprotocol/server';
import { callbackUrl, CallbackTransportError } from './callback.mjs';
import { createSubscriptionDiagnostic, subscriptionErrorCategory } from './event-diagnostics.mjs';
export { MemorySubscriptionStore } from './store.mjs';

export const EVENT_NAME = 'poc__synthetic';
export const eventArguments = z.object({ kind: z.enum(['warning', 'cat']) }).strict();
export const eventPayload = z.object({
  kind: z.enum(['warning', 'cat']), source: z.literal('synthetic_poc'), message: z.string().max(300),
}).strict();
const baseParams = { name: z.literal(EVENT_NAME), arguments: eventArguments };
const deliveryBase = { mode: z.literal('webhook'), url: z.string().max(2048) };
export const subscribeParams = z.object({
  ...baseParams, delivery: z.object({ ...deliveryBase, secret: z.string().max(100) }).strict(),
  cursor: z.null().optional(), ttlMs: z.number().int().min(1).max(86_400_000).nullable().optional(),
}).strict();
export const unsubscribeParams = z.object({
  ...baseParams, delivery: z.object(deliveryBase).strict(),
}).strict();

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function subscriptionId(principal, params) {
  return `sub_${createHash('sha256').update(canonical({
    principal, url: callbackUrl(params.delivery.url).href, name: params.name, arguments: params.arguments,
  })).digest('hex')}`;
}

function validateSecret(secret) {
  if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) throw new ProtocolError(-32602, 'Invalid webhook secret');
  const bytes = Buffer.from(secret.slice(6), 'base64');
  if (bytes.length < 24 || bytes.length > 64 || bytes.toString('base64') !== secret.slice(6)) {
    throw new ProtocolError(-32602, 'Invalid webhook secret');
  }
}

function signed(secret, id, sub, body, now, previousSecret) {
  const signature = new Webhook(secret).sign(id, now, body);
  return {
    'Content-Type': 'application/json', 'webhook-id': id,
    'webhook-timestamp': String(Math.floor(now.getTime() / 1000)),
    'webhook-signature': previousSecret ? `${signature} ${new Webhook(previousSecret).sign(id, now, body)}` : signature,
    'X-MCP-Subscription-Id': sub,
  };
}

export class SyntheticEvents {
  #verified = new Map();
  #inflight = new Map();
  constructor({ store, authorize, send, now = () => new Date(), definitions, retry, random = Math.random, diagnostic }) {
    if (!store || !authorize || !send) throw new Error('Store, principal authorization and safe transport are required');
    Object.assign(this, { store, authorize, send, now, retry, random, diagnostic });
    this.definitions = definitions ?? [{ name: EVENT_NAME, title: 'Synthetic warning or cat event',
      description: 'Explicitly synthetic POC data. No cat device or robot action.',
      inputSchema: z.toJSONSchema(eventArguments), payloadSchema: z.toJSONSchema(eventPayload) }];
    this.schemas = new Map(this.definitions.map(d => [d.name, { input: fromJsonSchema(d.inputSchema), payload: fromJsonSchema(d.payloadSchema) }]));
  }
  async #validate(name, which, value) {
    const schema = this.schemas.get(name)?.[which];
    if (!schema) throw new ProtocolError(-32602, 'Unknown event definition');
    const verdict = await schema['~standard'].validate(value);
    if (verdict.issues) throw new ProtocolError(-32602, 'Event schema rejected input');
    return verdict.value;
  }
  async #auth(principal, action, args, name = EVENT_NAME) {
    if (!principal || !await this.authorize(principal, action, { name, arguments: args })) {
      throw new ProtocolError(-32001, 'Authenticated event permission required');
    }
  }
  async list(principal) {
    await this.#auth(principal, 'list');
    return { events: this.definitions.map(d => ({ ...structuredClone(d), delivery: ['webhook'] })) };
  }
  async subscribe(principal, input) {
    const diagnostic = createSubscriptionDiagnostic(this.diagnostic);
    let phase;
    const report = (next, details) => { phase = next; diagnostic(next, details); };
    report('subscribe_received');
    try {
      const result = await this.#subscribe(principal, input, report);
      report('subscribe_complete'); return result;
    } catch (error) {
      const errorCategory = ['destination_validated', 'state_committing'].includes(phase) && error?.code !== -32015
        ? 'storage_error' : subscriptionErrorCategory(error);
      report('subscribe_failed', { errorCategory }); throw error;
    }
  }
  async #subscribe(principal, input, report) {
    const params = z.object({ name: z.string().max(128), arguments: z.record(z.string(), z.unknown()),
      delivery: z.object({ ...deliveryBase, secret: z.string().max(100) }).strict(),
      cursor: z.null().optional(), ttlMs: z.number().int().min(1).max(86_400_000).nullable().optional() }).strict().parse(input);
    params.arguments = await this.#validate(params.name, 'input', params.arguments);
    report('params_validated');
    await this.#auth(principal, 'subscribe', params.arguments, params.name);
    report('authorized');
    let url;
    try { url = callbackUrl(params.delivery.url).href; validateSecret(params.delivery.secret); }
    catch (error) { if (error instanceof ProtocolError) throw error; throw new ProtocolError(-32602, 'Invalid callback URL'); }
    report('destination_validated');
    const id = subscriptionId(principal, params);
    const reservation = await this.store.beginSubscription(principal, id);
    report('state_reserved');
    const verificationKey = canonical({ principal, url,
      key: createHash('sha256').update(params.delivery.secret).digest('hex') });
    const challenge = randomBytes(32).toString('base64url');
    const body = JSON.stringify({ type: 'verification', challenge });
    if ((this.#verified.get(verificationKey) ?? 0) <= this.now().getTime()) try {
      report('challenge_started');
      const response = await this.send(url, { body, headers: signed(params.delivery.secret, randomUUID(), id, body, this.now()) });
      report('challenge_response', { httpStatus: response.status });
      if (response.status < 200 || response.status >= 300) throw new CallbackTransportError('challenge_http_error');
      let decoded;
      try { decoded = JSON.parse(response.body); } catch { throw new CallbackTransportError('challenge_invalid_json'); }
      if (typeof decoded?.challenge !== 'string') throw new CallbackTransportError('challenge_missing_value');
      const received = Buffer.from(decoded.challenge, 'utf8');
      const expected = Buffer.from(challenge);
      if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
        throw new CallbackTransportError('challenge_mismatch');
      }
      if (this.#verified.size >= 128) this.#verified.delete(this.#verified.keys().next().value);
      this.#verified.set(verificationKey, this.now().getTime() + 30_000);
      report('challenge_verified');
    } catch (error) {
      report('challenge_failed', { errorCategory: subscriptionErrorCategory(error) });
      throw new ProtocolError(-32015, 'CallbackEndpointError', { reason: 'challenge_failed' });
    } else report('challenge_cached');
    // Recheck permission after the network operation, before activating the subscription.
    await this.#auth(principal, 'subscribe', params.arguments, params.name);
    // Never grant indefinite subscriptions in this model, including ttlMs:null.
    const ttl = Math.max(60_000, params.ttlMs ?? 3_600_000);
    const start = this.now().getTime();
    const previous = reservation.existing;
    const record = { id, principal, name: params.name, arguments: params.arguments, url,
      secret: params.delivery.secret, expiresAt: start + ttl, refreshBefore: new Date(start + ttl).toISOString() };
    if (previous && previous.secret !== record.secret) {
      record.previousSecret = previous.secret;
      record.rotateUntil = start + 300_000;
    } else if (previous?.rotateUntil > start) {
      record.previousSecret = previous.previousSecret;
      record.rotateUntil = previous.rotateUntil;
    }
    report('state_committing');
    if (!await this.store.commitSubscription(principal, record, reservation.revision)) {
      const current = await this.store.getSubscription(principal, id);
      if (current?.secret === record.secret && current.expiresAt > start) {
        report('state_committed');
        return { id, refreshBefore: current.refreshBefore, cursor: null, truncated: false };
      }
      throw new ProtocolError(-32015, 'Subscription changed during verification', { reason: 'subscription_changed' });
    }
    report('state_committed');
    return { id, refreshBefore: record.refreshBefore, cursor: null, truncated: false };
  }
  async unsubscribe(principal, input) {
    const report = createSubscriptionDiagnostic(this.diagnostic);
    report('unsubscribe_received');
    try {
      const result = await this.#unsubscribe(principal, input);
      report('unsubscribe_complete'); return result;
    } catch (error) {
      report('unsubscribe_failed', { errorCategory: subscriptionErrorCategory(error) }); throw error;
    }
  }
  async #unsubscribe(principal, input) {
    const params = z.object({ name: z.string().max(128), arguments: z.record(z.string(), z.unknown()), delivery: z.object(deliveryBase).strict() }).strict().parse(input);
    params.arguments = await this.#validate(params.name, 'input', params.arguments);
    await this.#auth(principal, 'unsubscribe', params.arguments, params.name);
    const id = subscriptionId(principal, params);
    await this.store.cancelSubscription(principal, id);
    this.#abort(id);
    return {};
  }
  #abort(id) {
    for (const item of this.#inflight.values()) if (item.subscriptionId === id) item.controller.abort();
  }
  async prepare(principal, name, input, meta) {
    const data = await this.#validate(name, 'payload', input);
    await this.#auth(principal, 'emit', { kind: data.kind }, name);
    const event = { eventId: randomUUID(), name, timestamp: this.now().toISOString(), data, cursor: null };
    const body = JSON.stringify(event); // Serialize once; retry signatures cover these EXACT bytes.
    if (Buffer.byteLength(body) > 256 * 1024) throw new Error('Event payload too large');
    return { eventId: event.eventId, name, body, data, kind: data.kind, ...(meta ? { meta } : {}) };
  }
  async hasAudience(principal, name, data) {
    const now = this.now().getTime();
    return (await this.store.listSubscriptions(principal)).some(sub => sub.expiresAt > now && sub.name === name &&
      Object.entries(sub.arguments).every(([key,value]) => key === 'includeRecovery' ? value || data.phase !== 'recovered'
        : Array.isArray(value) ? value.includes(data[key === 'deviceIds' ? 'deviceId' : key]) : value === data[key]));
  }
  async publish(principal, input, { name = EVENT_NAME, meta } = {}) {
    const event = await this.prepare(principal, name, input, meta);
    const queued = await this.store.enqueue(principal, event, this.now().getTime());
    return { eventId: event.eventId, queued }; // Commit BEFORE any network send.
  }
  async drainOne(options) {
    const claim = await this.store.claimDue(this.now().getTime(), options);
    if (!claim) return undefined;
    let packet = await this.store.delivery(claim, this.now().getTime());
    if (!packet) { await this.store.settle(claim); return { outcome: 'inactive' }; }
    const subscriptionId = packet.subscription.id;
    try { await this.#auth(packet.principal, 'deliver', packet.subscription.arguments, packet.subscription.name); }
    catch { await this.store.settle(claim); return { subscriptionId, outcome: 'revoked' }; }
    const controller = new AbortController();
    this.#inflight.set(claim.id, { subscriptionId, controller });
    let response;
    try {
      // Last check after async authorization and before beginning network work.
      packet = await this.store.delivery(claim, this.now().getTime());
      if (!packet || controller.signal.aborted) { await this.store.settle(claim); return { subscriptionId, outcome: 'inactive' }; }
      const sub = packet.subscription;
      response = await this.send(sub.url, { body: packet.body, signal: controller.signal,
        headers: signed(sub.secret, packet.eventId, sub.id, packet.body, this.now(),
          sub.rotateUntil > this.now().getTime() ? sub.previousSecret : undefined) });
    } catch { response = { status: 0 }; }
    finally { this.#inflight.delete(claim.id); }
    if (!await this.store.delivery(claim, this.now().getTime())) {
      await this.store.settle(claim); return { subscriptionId, outcome: 'inactive_or_superseded' };
    }
    if (response.status >= 200 && response.status < 300) {
      await this.store.settle(claim, { delivered: true, deliveredAt: this.now().getTime() }); return { subscriptionId, outcome: 'delivered' };
    }
    if (response.status === 410) {
      await this.store.cancelSubscription(packet.principal, subscriptionId); this.#abort(subscriptionId);
      return { subscriptionId, outcome: 'terminal' };
    }
    if (response.status === 413 || (response.status >= 300 && response.status < 500 && response.status !== 429)) {
      await this.store.settle(claim); return { subscriptionId, outcome: 'terminal' };
    }
    if (packet.attempts >= 4) {
      await this.store.settle(claim); return { subscriptionId, outcome: 'failed' };
    }
    let delay = this.retry ? this.retry.delaysSeconds[packet.attempts - 1] * 1000 : 250 * 2 ** (packet.attempts - 1);
    if (this.retry?.jitter) delay *= 0.75 + this.random() * 0.5;
    const after = response.retryAfter;
    if (this.retry && after) {
      const milliseconds = /^\d+(\.\d+)?$/.test(after) ? Number(after) * 1000 : Date.parse(after) - this.now().getTime();
      if (Number.isFinite(milliseconds)) delay = Math.max(delay, Math.min(milliseconds, 3600_000));
    }
    const retryAt = this.now().getTime() + delay;
    if (packet.meta?.expiresAt && retryAt >= packet.meta.expiresAt) {
      await this.store.settle(claim); return { subscriptionId, outcome: 'expired' };
    }
    const current = await this.store.settle(claim, { retryAt });
    return { subscriptionId, outcome: current ? 'retry' : 'inactive_or_superseded', retryAt };
  }
  stop() {
    for (const item of this.#inflight.values()) item.controller.abort();
  }
}

export { SyntheticEvents as McpEvents };
