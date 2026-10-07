import test from 'node:test';
import assert from 'node:assert/strict';
import { HaHistory } from '../src/connectors/ha/history.mjs';
import { parseTime } from '../src/connectors/ha/time.mjs';
import { entityIds } from '../src/connectors/ha/contract.mjs';
test('time zones normalize offsets/local dates and reject invalid or ambiguous DST input', () => {
  assert.equal(parseTime('2026-10-07T08:00:00', 'Asia/Shanghai'), Date.parse('2026-10-07T00:00:00Z'));
  assert.equal(parseTime('2026-10-07T08:00:00+08:00', 'Etc/UTC'), Date.parse('2026-10-07T00:00:00Z'));
  assert.throws(() => parseTime('2026-02-30T00:00:00Z')); assert.throws(() => parseTime('2026-10-07T24:00:00Z'));
  assert.throws(() => parseTime('2026-11-01T01:30:00', 'America/New_York'), /Ambiguous/);
  assert.throws(() => parseTime('2026-03-08T02:30:00', 'America/New_York'), /Nonexistent/);
  assert.throws(() => parseTime('2026-10-07T08:00:00', 'Invalid/Timezone'));
});
function fixture({ owner = 'public-owner', fetchImpl } = {}) {
  const calls = [], provider = new HaHistory({ origin: 'http://ha.example.invalid:8123', entityIds, owner,
    resolveToken: async () => 'PUBLIC_HA_HISTORY_FIXTURE', cursorSecret: 'PUBLIC_SERVICE_FIXTURE_FOR_CURSOR_ONLY',
    fetchImpl: fetchImpl ?? (async (url, init) => {
      calls.push({ url: new URL(url), init }); const start = Date.parse(decodeURIComponent(new URL(url).pathname.split('/').at(-1)));
      return Response.json([[0, 10, 20].map(seconds => ({ entity_id: entityIds[2], state: seconds === 10 ? 'on' : 'off',
        last_changed: new Date(start + seconds * 1000).toISOString(), attributes: { secret_attribute: 'must not return' }, context: { user_id: 'must not return' } }))]);
    }) }); return { provider, calls };
}
const args = { from: '2026-10-07T00:00:00Z', to: '2026-10-07T00:01:00Z', timezone: 'Asia/Shanghai', entityIds: [entityIds[2]], limit: 2 };
test('History is filtered state-only, end-exclusive, baseline-aware and paginated without archive', async () => {
  const { provider, calls } = fixture(), first = await provider.query(args);
  assert.equal(first.items.length, 2); assert.equal(first.items[0].kind, 'baseline_or_boundary'); assert.equal(first.has_more, true);
  assert.equal(calls[0].url.searchParams.get('filter_entity_id'), entityIds[2]); assert.equal(calls[0].url.searchParams.get('no_attributes'), 'true');
  assert.equal(calls[0].init.redirect, 'error'); assert.equal(calls[0].init.headers.Authorization, 'Bearer PUBLIC_HA_HISTORY_FIXTURE');
  assert.ok(!JSON.stringify(first).includes('must not return')); assert.equal(first.coverage.completeness, 'not_verified');
  const second = await provider.query({ ...args, cursor: first.next_cursor }); assert.equal(second.items.length, 1); assert.equal(second.has_more, false);
  assert.equal(second.next_cursor, null); assert.equal(second.items[0].occurredAt, '2026-10-07T00:00:20.000Z');
});
test('arbitrary long windows progress in bounded chunks and missing data remains a source gap', async () => {
  let requests = 0; const { provider } = fixture({ fetchImpl: async () => { requests++; return Response.json([]); } });
  const result = await provider.query({ ...args, to: '2026-12-07T00:00:00Z' });
  assert.equal(requests, 16); assert.equal(result.items.length, 0); assert.equal(result.has_more, true); assert.equal(result.gaps.length, 16);
  assert.equal(result.gaps[0].reason, 'no_source_records');
});
test('history cursor is authenticated, owner/filter bound; unapproved entities trigger no request', async () => {
  const { provider, calls } = fixture(), first = await provider.query(args), count = calls.length;
  await assert.rejects(provider.query({ ...args, cursor: first.next_cursor + 'x' }));
  await assert.rejects(provider.query({ ...args, cursor: first.next_cursor, entityIds: [entityIds[1]] }));
  await assert.rejects(fixture({ owner: 'another-owner' }).provider.query({ ...args, cursor: first.next_cursor }));
  await assert.rejects(provider.query({ ...args, entityIds: ['device_tracker.private'] }));
  assert.equal(calls.length, count);
});
test('source HTTP errors and oversized bodies return sanitized MCP errors', async () => {
  for (const fetchImpl of [async () => new Response('PUBLIC_HA_HISTORY_FIXTURE', { status: 401 }),
    async () => new Response('x'.repeat(2 * 1024 * 1024 + 1))]) {
    const result = await fixture({ fetchImpl }).provider.backend().call('ha_history__query', args);
    assert.equal(result.isError, true); assert.ok(!JSON.stringify(result).includes('PUBLIC_HA_HISTORY_FIXTURE'));
  }
});
