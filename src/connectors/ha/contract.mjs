import { readFileSync } from 'node:fs';
import { z } from 'zod/v4';

// Fixed resource/field mapping, deliberately no predicates, timers or business DSL.
export const resources = [
  ['vacuum_fault', 'vacuum_example', 'vacuum.example_robot', 'mcp_ha_vacuum_fault', 'vacuum__fault'],
  ['water_low', 'water_example', 'binary_sensor.example_water_low', 'mcp_ha_water_low', 'pet__water_low'],
  ['food_hopper1', 'feeder_example_channel1', 'binary_sensor.example_food_channel_1_low', 'mcp_ha_food_low', 'pet__food_low'],
  ['food_hopper2', 'feeder_example_channel2', 'binary_sensor.example_food_channel_2_low', 'mcp_ha_food_low', 'pet__food_low'],
  ['litter_full', 'bin_example', 'binary_sensor.example_bin_full', 'mcp_ha_litter_full', 'pet__litter_full'],
].map(([ruleId, deviceId, entityId, eventType, name]) => Object.freeze({ ruleId, deviceId, entityId, eventType, name }));
export const entityIds = resources.map(r => r.entityId);
export const eventDefinitions = JSON.parse(readFileSync(new URL('../../../config/ha-events.contract.json', import.meta.url), 'utf8'));
export const eventTypes = [...new Set(resources.map(r => r.eventType))];
const date = z.string().datetime({ offset: true });
export const haEnvelope = z.object({
  entityId: z.enum(entityIds), eventId: z.string().min(1).max(160), occurredAt: date, expiresAt: date,
  data: z.object({ eventVersion: z.literal(1), source: z.literal('ha_selected_entities'),
    ruleId: z.string().max(48), deviceId: z.string().max(48), incidentId: z.string().min(1).max(128),
    phase: z.enum(['attention', 'recovered']), severity: z.enum(['warning', 'info']), observedAt: date,
    summary: z.string().max(200) }).strict(),
}).strict();

export function mapHaEvent(type, input, allowed = entityIds, now = Date.now()) {
  const envelope = haEnvelope.parse(input), resource = resources.find(r => r.entityId === envelope.entityId);
  if (!allowed.includes(envelope.entityId) || type !== resource.eventType ||
      envelope.data.ruleId !== resource.ruleId || envelope.data.deviceId !== resource.deviceId ||
      envelope.data.severity !== (envelope.data.phase === 'attention' ? 'warning' : 'info')) throw new Error('HA event mapping rejected');
  const occurrence = Date.parse(envelope.occurredAt), expiry = Date.parse(envelope.expiresAt);
  if (occurrence > now + 60_000 || expiry <= occurrence || expiry - occurrence > 86_400_000) throw new Error('HA event time rejected');
  return { name: resource.name, ...envelope };
}
