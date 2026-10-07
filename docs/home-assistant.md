# Home Assistant example

`examples/home-assistant/mcp_gateway.package.yaml` is an uninstalled example. All five entities and device aliases are fictional. The package changes only its own helper state and fires custom events; it contains no vacuum or pet-device service calls.

| Resource | Example entity | Device alias | Attention / recovery |
| --- | --- | --- | --- |
| Robot fault | `vacuum.example_robot` | `vacuum_example` | 60 / 120 seconds |
| Water low | `binary_sensor.example_water_low` | `water_example` | 300 / 300 seconds |
| Food channel 1 low | `binary_sensor.example_food_channel_1_low` | `feeder_example_channel1` | 600 / 300 seconds |
| Food channel 2 low | `binary_sensor.example_food_channel_2_low` | `feeder_example_channel2` | 600 / 300 seconds |
| Bin full | `binary_sensor.example_bin_full` | `bin_example` | 300 / 300 seconds |

Attention requires a sustained transition after the observation baseline. Recovery requires a known normal state and a stored incident. Unknown and unavailable states do not indicate recovery. Native `for` timers reset on HA restart or automation reload. Startup recovery re-establishes its timer for a restored incident; it does not infer transitions that happened while HA was offline.

The opt-in helper `input_boolean.mcp_gateway_events_enabled` restores its prior state and defaults off on first creation. Enabling it establishes the observation baseline. A restored enabled state is not a fresh approval to connect a different deployment.

Before installing a private copy:

1. Create a private resource mapping and configure `haConnector.contractFile`. Replace fictional identifiers consistently in the private YAML and selected `entityIds`. Keep device aliases and rule IDs aligned; the gateway derives the event schemas without source edits.
2. Validate the YAML and native mocks in the intended HA Python environment. Check helper and automation name collisions in the destination.
3. Approve the selected entities and deployment credentials. Enable only the needed native read tools in the backend allowlist and HA exposure settings.
4. Install the private package through the destination's normal HA configuration workflow. Review any reload/restart impact separately.
5. Verify an actual client read, an approved isolated event receipt, subscription refresh and restart behavior. A local mock or HTTP probe alone does not establish client connectivity.

The YAML emits `mcp_ha_vacuum_fault`, `mcp_ha_water_low`, `mcp_ha_food_low` and `mcp_ha_litter_full`. The public subscription names retain the semantic contract `vacuum__fault`, `pet__water_low`, `pet__food_low` and `pet__litter_full`. The adapter validates entity, rule, alias, severity and timestamps before queueing a message.

An external mapping has this shape (all identifiers below are fictional):

```json
{
  "resources": [
    {"ruleId":"vacuum_fault","deviceId":"vacuum_example","entityId":"vacuum.example_robot","eventType":"mcp_ha_vacuum_fault"},
    {"ruleId":"water_low","deviceId":"water_example","entityId":"binary_sensor.example_water_low","eventType":"mcp_ha_water_low"},
    {"ruleId":"food_hopper1","deviceId":"feeder_example_channel1","entityId":"binary_sensor.example_food_channel_1_low","eventType":"mcp_ha_food_low"},
    {"ruleId":"food_hopper2","deviceId":"feeder_example_channel2","entityId":"binary_sensor.example_food_channel_2_low","eventType":"mcp_ha_food_low"},
    {"ruleId":"litter_full","deviceId":"bin_example","entityId":"binary_sensor.example_bin_full","eventType":"mcp_ha_litter_full"}
  ]
}
```

For example, use `"contractFile": "/run/config/ha-resources.json"` alongside `haConnector.entityIds`. The mapping file must be a regular file, mode `0600`, owned by the runtime UID, at most 16 KiB, and mounted read-only. Symlinks and nested paths are rejected. Validation requires exactly these five rule IDs, unique entities and aliases, one vacuum and four binary sensors. Custom event names use a deployment prefix plus `_ha_` and the established semantic suffix; both food channels share one event type. No extra events, predicates, timer controls or schema overrides can be supplied.

Existing deployments can retain their approved entities, aliases and custom event names through this mapping. Retain the original owner, secret header, encryption namespace and external state key as well. This does not require changing installed HA automations or client subscription names. Changing aliases or filters changes subscription identity and needs a separate migration review.

History reads the existing HA state-history endpoint, excludes attributes and filters out unselected entities. HA retention, exclusions and connection gaps may remove records. Pagination is best effort against a mutable source and cannot prove completeness.
