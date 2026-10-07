import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod/v4';
import { entityIds } from './contract.mjs';
import { parseTime, displayTime } from './time.mjs';
const schema = z.object({ from: z.string().max(48), to: z.string().max(48), timezone: z.string().max(80).default('Etc/UTC'),
  entityIds: z.array(z.enum(entityIds)).min(1).max(5), limit: z.number().int().min(1).max(500).default(100),
  cursor: z.string().max(4096).optional() }).strict();
const maxResponseBytes = 2 * 1024 * 1024, chunkMs = 24 * 3600_000;
export class HaHistory {
  constructor({ origin, entityIds: allowed, resolveToken, cursorSecret, owner, timeoutMs = 10_000, fetchImpl = fetch, now = Date.now }) {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid HA history origin');
    Object.assign(this, { origin: url.origin, allowed, resolveToken, cursorSecret, owner, timeoutMs, fetchImpl, now });
  }
  #sign(value) { return createHmac('sha256', this.cursorSecret).update(`${this.owner}:${value}`).digest('base64url'); }
  #cursor(value) { const body = Buffer.from(JSON.stringify(value)).toString('base64url'); return `${body}.${this.#sign(body)}`; }
  #decode(value) {
    const [body, signature, extra] = value.split('.'), expected = this.#sign(body ?? '');
    if (extra || !signature || signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new Error('Invalid history cursor');
    const state = JSON.parse(Buffer.from(body, 'base64url'));
    if (state.exp <= this.now()) throw new Error('History cursor expired; restart query');
    return state;
  }
  async #read(start, end, selected, deadline) {
    const url = new URL(`/api/history/period/${encodeURIComponent(new Date(start).toISOString())}`, this.origin);
    url.searchParams.set('filter_entity_id', selected.join(',')); url.searchParams.set('end_time', new Date(end).toISOString()); url.searchParams.set('no_attributes', 'true');
    const token = await this.resolveToken();
    const response = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error',
      signal: AbortSignal.timeout(Math.max(1, Math.min(this.timeoutMs, deadline - this.now()))) });
    if (!response.ok) throw new Error(`HA history HTTP ${response.status}`);
    const reader = response.body?.getReader(); if (!reader) throw new Error('HA history missing response');
    const chunks = []; let bytes = 0;
    while (true) { const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength;
      if (bytes > maxResponseBytes) { await reader.cancel(); throw new Error('HA history response too large; use a smaller interval'); } chunks.push(next.value); }
    const groups = JSON.parse(Buffer.concat(chunks)); if (!Array.isArray(groups)) throw new Error('Invalid HA history response');
    const records = [], seenEntities = new Set();
    for (const group of groups) {
      if (!Array.isArray(group) || !group.length) continue;
      const id = group[0].entity_id; if (!selected.includes(id)) continue; seenEntities.add(id);
      for (const row of group) {
        if (row.entity_id !== id || typeof row.state !== 'string' || row.state.length > 255) continue;
        const time = Date.parse(row.last_changed); if (!Number.isFinite(time) || time < start || time >= end) continue;
        records.push({ entityId: id, state: row.state, occurredAt: new Date(time).toISOString(),
          kind: time === start ? 'baseline_or_boundary' : 'state_record', origin: 'ha_history' });
      }
    }
    records.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.entityId.localeCompare(b.entityId));
    return { records, missing: selected.filter(id => !seenEntities.has(id)) };
  }
  async query(input) {
    const args = schema.parse(input), start = parseTime(args.from, args.timezone), end = parseTime(args.to, args.timezone);
    if (end <= start || new Set(args.entityIds).size !== args.entityIds.length || args.entityIds.some(id => !this.allowed.includes(id))) throw new Error('Invalid or unapproved history range/entities');
    const query = JSON.stringify({ start, end, timezone: args.timezone, entities: args.entityIds }), deadline = this.now() + 20_000;
    let chunkStart = start, offset = 0;
    if (args.cursor) { const state = this.#decode(args.cursor);
      if (state.query !== query || !Number.isSafeInteger(state.chunkStart) || state.chunkStart < start || state.chunkStart >= end || !Number.isSafeInteger(state.offset) || state.offset < 0) throw new Error('History cursor does not match query');
      chunkStart = state.chunkStart; offset = state.offset;
    }
    const items = [], gaps = [], queriedIntervals = []; let requests = 0;
    while (chunkStart < end && items.length < args.limit && requests++ < 16 && this.now() < deadline) {
      const chunkEnd = Math.min(end, chunkStart + chunkMs), { records, missing } = await this.#read(chunkStart, chunkEnd, args.entityIds, deadline);
      queriedIntervals.push({ from: new Date(chunkStart).toISOString(), to: new Date(chunkEnd).toISOString() });
      for (const entityId of missing) gaps.push({ entityId, from: new Date(chunkStart).toISOString(), to: new Date(chunkEnd).toISOString(), reason: 'no_source_records' });
      const count = Math.min(args.limit - items.length, Math.max(0, records.length - offset));
      items.push(...records.slice(offset, offset + count).map(row => ({ ...row, localTime: displayTime(Date.parse(row.occurredAt), args.timezone) })));
      offset += count;
      if (offset < records.length) break;
      chunkStart = chunkEnd; offset = 0;
    }
    const more = chunkStart < end;
    return { items, window: { from: new Date(start).toISOString(), to: new Date(end).toISOString(), timezone: args.timezone, endExclusive: true },
      next_cursor: more ? this.#cursor({ query, chunkStart, offset, exp: this.now() + 3600_000 }) : null, has_more: more,
      coverage: { origin: 'ha_history', queriedIntervals, completeness: 'not_verified', paginationConsistency: 'source_history_best_effort',
        note: 'HA retention/exclusions/offline gaps may remove records; this is state history, not business-event or notification history.' }, gaps };
  }
  backend() {
    const tool = { name: 'ha_history__query', description: 'Read only the explicitly approved five HA entities from existing History API. ISO from/to; offset or timezone for local times. No capture, backfill or device action.',
      inputSchema: z.toJSONSchema(schema), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } };
    return { id: 'ha_history', config: {}, health: () => ({ id: 'ha_history', state: 'ready' }), listTools: async () => [tool], close: async () => {},
      call: async (name, args) => {
        if (name !== tool.name) throw new Error('Unknown history tool');
        try { const result = await this.query(args);
          const text = JSON.stringify(result); if (Buffer.byteLength(text) > 128 * 1024) throw new Error('History result too large');
          return { content: [{ type: 'text', text }], structuredContent: result };
        } catch { return { isError: true, content: [{ type: 'text', text: 'History query rejected or unavailable. Check approved entities, time/offset, cursor, and use a smaller range if needed.' }] }; }
      } };
  }
}
