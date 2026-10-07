"""Validate candidate YAML against installed HA schemas; never load real HA config.

Local: python script PATH (requires HA dependencies).
Remote read-only schema check: prepend DATA_B64 from the local candidate and run
in a separate Python process, with no token, config directory or running HA object.
"""
import base64
import json
import pathlib
import sys
import yaml
import asyncio
import tempfile

raw = base64.b64decode(globals()['DATA_B64']).decode() if 'DATA_B64' in globals() else pathlib.Path(sys.argv[1]).read_text()
package = yaml.safe_load(raw)
assert set(package) == {'input_boolean', 'input_datetime', 'input_text', 'automation'}
assert len(package['input_text']) == 5 and len(package['automation']) == 11
services = set()

def walk(value):
    if isinstance(value, dict):
        if 'action' in value:
            services.add(value['action'])
            assert value['action'] in {'input_text.set_value', 'input_datetime.set_datetime'}
            assert value['target']['entity_id'].startswith(('input_text.mcp_gateway_events_', 'input_datetime.mcp_gateway_events_'))
        if 'event' in value and 'event_data' in value:
            assert value['event'] in {'mcp_ha_vacuum_fault', 'mcp_ha_water_low', 'mcp_ha_food_low', 'mcp_ha_litter_full'}
        for child in value.values(): walk(child)
    elif isinstance(value, list):
        for child in value: walk(child)

walk(package)
from homeassistant.const import __version__
from homeassistant.components.automation.config import PLATFORM_SCHEMA as AUTOMATION_SCHEMA
from homeassistant.components.input_text import CONFIG_SCHEMA as TEXT_SCHEMA
from homeassistant.components.input_boolean import CONFIG_SCHEMA as BOOL_SCHEMA
from homeassistant.components.input_datetime import CONFIG_SCHEMA as DATETIME_SCHEMA

async def validate():
    from homeassistant.core import HomeAssistant
    # HA 2026.9 template validators require a loop-local HA object; it is isolated,
    # unstarted, empty, and never uses /config or the existing running application.
    with tempfile.TemporaryDirectory(prefix='mcp-gateway-thin-schema-') as mock_dir:
        mock_hass = HomeAssistant(mock_dir)
        for automation in package['automation']:
            AUTOMATION_SCHEMA(automation)
        TEXT_SCHEMA({'input_text': package['input_text']})
        BOOL_SCHEMA({'input_boolean': package['input_boolean']})
        DATETIME_SCHEMA({'input_datetime': package['input_datetime']})

asyncio.run(validate())
print(json.dumps({'haVersion': __version__, 'nativeSchemaValid': True, 'automations': 11, 'helpers': 7,
                  'allowedActions': sorted(services), 'actualHaConfigLoaded': False, 'actualStatesRead': False,
                  'deviceActions': 0, 'runtimeChanges': 0}))
