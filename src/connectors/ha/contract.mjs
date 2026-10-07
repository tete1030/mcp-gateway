import { readFileSync, openSync, closeSync, fstatSync, readSync, constants } from 'node:fs';
import { z } from 'zod/v4';

// Fixed resource/field mapping, deliberately no predicates, timers or business DSL.
const examples = [
  ['vacuum_fault', 'vacuum_example', 'vacuum.example_robot', 'mcp_ha_vacuum_fault', 'vacuum__fault'],
  ['water_low', 'water_example', 'binary_sensor.example_water_low', 'mcp_ha_water_low', 'pet__water_low'],
  ['food_hopper1', 'feeder_example_channel1', 'binary_sensor.example_food_channel_1_low', 'mcp_ha_food_low', 'pet__food_low'],
  ['food_hopper2', 'feeder_example_channel2', 'binary_sensor.example_food_channel_2_low', 'mcp_ha_food_low', 'pet__food_low'],
  ['litter_full', 'bin_example', 'binary_sensor.example_bin_full', 'mcp_ha_litter_full', 'pet__litter_full'],
].map(([ruleId, deviceId, entityId, eventType, name]) => Object.freeze({ ruleId, deviceId, entityId, eventType, name }));
const templates = JSON.parse(readFileSync(new URL('../../../config/ha-events.contract.json', import.meta.url), 'utf8'));
const rules = examples.map(r => r.ruleId), names = new Map(examples.map(r => [r.ruleId, r.name]));
export const selectedEntity = z.string().regex(/^(vacuum|binary_sensor)\.[a-z0-9_]{1,200}(?![\s\S])/);
export const contractPath = z.string().regex(/^\/run\/config\/[a-z][a-z0-9_-]{0,63}\.json(?![\s\S])/);
const bindingSchema = z.object({ resources: z.array(z.object({
  ruleId: z.enum(rules), deviceId: z.string().regex(/^[a-z][a-z0-9_]{0,47}(?![\s\S])/),
  entityId: selectedEntity, eventType: z.string().max(64).regex(/^[a-z][a-z0-9_]*_ha_(vacuum_fault|water_low|food_low|litter_full)(?![\s\S])/),
}).strict()).length(5) }).strict().superRefine(({ resources: rows }, ctx) => {
  const fail = () => ctx.addIssue({ code: 'custom', message: 'Invalid fixed HA resource mapping' });
  for (const field of ['ruleId', 'deviceId', 'entityId']) if (new Set(rows.map(r => r[field])).size !== 5) fail();
  for (const r of rows) {
    const domain = r.ruleId === 'vacuum_fault' ? 'vacuum.' : 'binary_sensor.';
    const suffix = r.ruleId.startsWith('food_hopper') ? 'food_low' : r.ruleId;
    if (!r.entityId.startsWith(domain) || !r.eventType.endsWith(`_ha_${suffix}`)) fail();
  }
  const food = rows.filter(r => r.ruleId.startsWith('food_hopper'));
  if (food.length !== 2 || food[0].eventType !== food[1].eventType || new Set(rows.map(r => r.eventType)).size !== 4) fail();
});
const date = z.string().datetime({ offset: true });
function envelopeSchema(ids) { return z.object({
  entityId: z.enum(ids), eventId: z.string().min(1).max(160), occurredAt: date, expiresAt: date,
  data: z.object({ eventVersion: z.literal(1), source: z.literal('ha_selected_entities'),
    ruleId: z.string().max(48), deviceId: z.string().max(48), incidentId: z.string().min(1).max(128),
    phase: z.enum(['attention', 'recovered']), severity: z.enum(['warning', 'info']), observedAt: date,
    summary: z.string().max(200) }).strict(),
}).strict(); }

// Bind only the five established resources. No predicates, extra events or schema overrides.
export function createHaContract(input = { resources: examples.map(({ name, ...r }) => r) }) {
  const parsed = bindingSchema.parse(input);
  const resources = rules.map(rule => Object.freeze({ ...parsed.resources.find(r => r.ruleId === rule), name: names.get(rule) }));
  const entityIds = resources.map(r => r.entityId), definitions = structuredClone(templates);
  for (const d of definitions) {
    const aliases = resources.filter(r => r.name === d.name).map(r => r.deviceId);
    if (!aliases.length) continue;
    d.inputSchema.properties.deviceIds.items.enum = aliases;
    d.payloadSchema.properties.deviceId.enum = [...aliases];
  }
  return { resources, entityIds, eventTypes: [...new Set(resources.map(r => r.eventType))],
    eventDefinitions: definitions, haEnvelope: envelopeSchema(entityIds) };
}

export function readHaContractFile(path) {
  contractPath.parse(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW), max = 16 * 1024;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > max || (stat.mode & 0o077) || stat.uid !== process.getuid()) throw new Error('HA contract file must be private and owned by runtime UID');
    const buffer = Buffer.alloc(max + 1); let count = 0, n;
    while (count < buffer.length && (n = readSync(fd, buffer, count, buffer.length - count, null))) count += n;
    if (count > max) throw new Error('HA contract file too large');
    return buffer.subarray(0, count).toString('utf8');
  } finally { closeSync(fd); }
}
export function loadHaContract(connector, read = readHaContractFile) {
  const contract = connector.contractFile ? createHaContract(JSON.parse(read(contractPath.parse(connector.contractFile)))) : defaultContract;
  if (connector.entityIds.some(id => !contract.entityIds.includes(id))) throw new Error('Selected entity outside fixed HA resource contract');
  return contract;
}
export const defaultContract = createHaContract();
export const { resources, entityIds, eventTypes, eventDefinitions, haEnvelope } = defaultContract;

export function mapHaEvent(type, input, allowed = entityIds, now = Date.now(), contract = defaultContract) {
  const envelope = contract.haEnvelope.parse(input), resource = contract.resources.find(r => r.entityId === envelope.entityId);
  if (!allowed.includes(envelope.entityId) || type !== resource.eventType ||
      envelope.data.ruleId !== resource.ruleId || envelope.data.deviceId !== resource.deviceId ||
      envelope.data.severity !== (envelope.data.phase === 'attention' ? 'warning' : 'info')) throw new Error('HA event mapping rejected');
  const occurrence = Date.parse(envelope.occurredAt), expiry = Date.parse(envelope.expiresAt);
  if (occurrence > now + 60_000 || expiry <= occurrence || expiry - occurrence > 86_400_000) throw new Error('HA event time rejected');
  return { name: resource.name, ...envelope };
}
