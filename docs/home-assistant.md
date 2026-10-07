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

1. Replace fictional entities consistently in `src/connectors/ha/contract.mjs`, the event schemas, configuration and YAML. Keep device aliases and rule IDs aligned.
2. Validate the YAML and native mocks in the intended HA Python environment. Check helper and automation name collisions in the destination.
3. Approve the selected entities and deployment credentials. Enable only the needed native read tools in the backend allowlist and HA exposure settings.
4. Install the private package through the destination's normal HA configuration workflow. Review any reload/restart impact separately.
5. Verify an actual client read, an approved isolated event receipt, subscription refresh and restart behavior. A local mock or HTTP probe alone does not establish client connectivity.

The YAML emits `mcp_ha_vacuum_fault`, `mcp_ha_water_low`, `mcp_ha_food_low` and `mcp_ha_litter_full`. The public subscription names retain the semantic contract `vacuum__fault`, `pet__water_low`, `pet__food_low` and `pet__litter_full`. The adapter validates entity, rule, alias, severity and timestamps before queueing a message.

History reads the existing HA state-history endpoint, excludes attributes and filters out unselected entities. HA retention, exclusions and connection gaps may remove records. Pagination is best effort against a mutable source and cannot prove completeness.
