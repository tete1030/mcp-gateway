import test from 'node:test';
import assert from 'node:assert/strict';
import { createHaContract, loadHaContract, defaultContract, contractPath, mapHaEvent } from '../src/connectors/ha/contract.mjs';
import { createThinAggregate } from '../src/aggregate.mjs';
import { parseThinConfig } from '../src/config.mjs';
import { readFile } from 'node:fs/promises';
const sample = () => ({ resources: defaultContract.resources.map(({ name, ...r }) => ({ ...r,
  entityId: r.entityId.replace('example_', 'deployment_example_'), deviceId: `sample_${r.deviceId}`,
  eventType: r.eventType.replace('mcp_ha_', 'sample_ha_') })) });
const config = JSON.parse(await readFile(new URL('../config/thin.example.json', import.meta.url)));

test('external fixed mapping preserves semantic schemas and rejects mismatched resource identity', () => {
  const c = createHaContract(sample());
  assert.equal(c.resources.length, 5); assert.equal(c.eventTypes.length, 4);
  assert.deepEqual(c.eventDefinitions.map(x => x.name), defaultContract.eventDefinitions.map(x => x.name));
  const r = c.resources[2], stamp = '2026-10-07T00:00:00Z';
  const input = { entityId: r.entityId, eventId: 'public-contract-event', occurredAt: stamp, expiresAt: '2026-10-07T01:00:00Z',
    data: { eventVersion: 1, source: 'ha_selected_entities', ruleId: r.ruleId, deviceId: r.deviceId,
      incidentId: 'public-contract-incident', phase: 'attention', severity: 'warning', observedAt: stamp, summary: 'Synthetic fixture' } };
  assert.equal(mapHaEvent(r.eventType, input, c.entityIds, Date.parse(stamp), c).name, r.name);
  assert.throws(() => mapHaEvent(defaultContract.resources[2].eventType, input, c.entityIds, Date.parse(stamp), c));
  assert.throws(() => mapHaEvent(r.eventType, input, [c.entityIds[0]], Date.parse(stamp), c));
  assert.throws(() => mapHaEvent(r.eventType, { ...input, data: { ...input.data, deviceId: defaultContract.resources[2].deviceId } }, c.entityIds, Date.parse(stamp), c));
  assert.deepEqual(c.eventDefinitions.slice(4), defaultContract.eventDefinitions.slice(4));
});
test('bindings cannot add a rule DSL, extra resource, broad event, arbitrary schema or conflicting identity', () => {
  for (const mutate of [
    c => c.rules = [], c => c.resources.push(c.resources[0]), c => c.resources[0].name = 'arbitrary__event',
    c => c.resources[0].predicate = 'any', c => c.resources[0].ruleId = 'invented',
    c => c.resources[1].entityId = c.resources[0].entityId,
    c => c.resources[1].deviceId = c.resources[0].deviceId,
    c => c.resources[1].ruleId = c.resources[0].ruleId,
    c => c.resources[0].entityId = 'switch.example', c => c.resources[0].entityId = 'binary_sensor.example',
    c => c.resources[1].entityId = 'vacuum.example', c => c.resources[1].eventType = 'state_changed',
    c => c.resources[1].eventType = c.resources[0].eventType,
    c => c.resources[3].eventType = 'other_ha_food_low',
    c => c.resources[0].eventType = 'x'.repeat(64) + '_ha_vacuum_fault',
  ]) { const c = sample(); mutate(c); assert.throws(() => createHaContract(c)); }
});
test('external path is a single bounded private JSON filename; selection must belong to loaded mapping', () => {
  for (const path of ['/tmp/map.json', '/run/config/../secrets/map.json', '/run/config/nested/map.json', '/run/config/a.json?x', '/run/config/a.json\n']) assert.equal(contractPath.safeParse(path).success, false);
  const c = createHaContract(sample());
  assert.equal(loadHaContract({ contractFile: '/run/config/ha-resources.json', entityIds: [c.entityIds[0]] }, () => JSON.stringify(sample())).entityIds.length, 5);
  assert.throws(() => loadHaContract({ contractFile: '/run/config/ha-resources.json', entityIds: defaultContract.entityIds }, () => JSON.stringify(sample())));
  assert.throws(() => loadHaContract({ entityIds: c.entityIds }));
  const cfg = structuredClone(config); cfg.haConnector.entityIds = c.entityIds;
  assert.throws(() => parseThinConfig(cfg)); cfg.haConnector.contractFile = '/run/config/ha-resources.json';
  assert.equal(parseThinConfig(cfg).haConnector.entityIds.length, 5);
});
test('invalid external selection fails before credentials, storage or network are touched', async () => {
  const c = structuredClone(config); c.haConnector.contractFile = '/run/config/ha-resources.json';
  await assert.rejects(createThinAggregate(c, { readHaContractFile: () => JSON.stringify(sample()),
    readSecretFile: () => assert.fail('No credential access'), fetchImpl: () => assert.fail('No network'), openStore: () => assert.fail('No storage') }), /outside fixed/);
});
