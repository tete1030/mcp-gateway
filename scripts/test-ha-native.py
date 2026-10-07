"""Isolated HA native triggers/scripts with synthetic states only.

Uses the installed HA libraries, an empty temporary config directory, a private
in-process event bus, and two in-memory helper service handlers. It does not load
any real config, connect to HA, register HTTP, or invoke any device service.
Native for/timeout durations are shortened only in the test copy (0.1 seconds).
"""
import asyncio
import base64
import copy
import json
import pathlib
import sys
import tempfile
import yaml
from datetime import datetime, timezone, timedelta
from homeassistant.core import HomeAssistant, Context
from homeassistant.const import __version__
from homeassistant.components.automation.config import PLATFORM_SCHEMA
from homeassistant.helpers.script import Script, async_validate_actions_config
from homeassistant.helpers.trigger import async_initialize_triggers, async_validate_trigger_config, async_setup as setup_triggers
from homeassistant.loader import async_setup as setup_loader

raw = base64.b64decode(globals()['DATA_B64']).decode() if 'DATA_B64' in globals() else pathlib.Path(sys.argv[1]).read_text()
original = yaml.safe_load(raw)
expected = {'vacuum_fault': (60, 120), 'water_low': (300, 300), 'food_hopper1': (600, 300),
            'food_hopper2': (600, 300), 'litter_full': (300, 300)}
for rule, (attention, recovery) in expected.items():
    a = next(x for x in original['automation'] if x['id'] == 'mcp_gateway_' + rule + '_attention')
    r = next(x for x in original['automation'] if x['id'] == 'mcp_gateway_' + rule + '_recovered')
    assert a['triggers'][0]['for']['seconds'] == attention
    assert r['triggers'][0]['for']['seconds'] == recovery
candidate = copy.deepcopy(original)

def accelerate(value):
    if isinstance(value, dict):
        for key in ('for', 'timeout'):
            if key in value: value[key] = {'seconds': 0.1}
        for child in value.values(): accelerate(child)
    elif isinstance(value, list):
        for child in value: accelerate(child)

accelerate(candidate)

async def main():
    with tempfile.TemporaryDirectory(prefix='mcp-gateway-thin-native-mock-') as mock_dir:
        hass = HomeAssistant(mock_dir)
        setup_loader(hass)
        await setup_triggers(hass)
        events, detachers, scripts, named_scripts = [], [], [], {}
        def capture(event): events.append(event.data)
        for name in ['mcp_ha_vacuum_fault', 'mcp_ha_water_low', 'mcp_ha_food_low', 'mcp_ha_litter_full']:
            hass.bus.async_listen(name, capture)
        async def helper(call):
            ids = call.data.get('entity_id', [])
            if isinstance(ids, str): ids = [ids]
            for entity in ids:
                assert entity.startswith(('input_text.mcp_gateway_events_', 'input_datetime.mcp_gateway_events_'))
                value = call.data.get('value')
                if value is None: value = datetime.fromtimestamp(float(call.data['timestamp']), timezone.utc).strftime('%Y-%m-%d %H:%M:%S')
                hass.states.async_set(entity, str(value))
        hass.services.async_register('input_text', 'set_value', helper)
        hass.services.async_register('input_datetime', 'set_datetime', helper)
        hass.states.async_set('input_boolean.mcp_gateway_events_enabled', 'on')
        hass.states.async_set('input_datetime.mcp_gateway_events_started', (datetime.now(timezone.utc) - timedelta(seconds=5)).strftime('%Y-%m-%d %H:%M:%S'))
        for name in original['input_text']: hass.states.async_set('input_text.' + name, '')
        entities = {}
        for a in original['automation']:
            if not a['id'].endswith('_attention'): continue
            rule = a['id'][len('mcp_gateway_'):-len('_attention')]; entity = a['triggers'][0]['entity_id']; entities[rule] = entity
            hass.states.async_set(entity, 'docked' if rule == 'vacuum_fault' else 'off')

        async def attach(a):
            config = PLATFORM_SCHEMA(copy.deepcopy(a))
            config['triggers'] = await async_validate_trigger_config(hass, config['triggers'])
            config['actions'] = await async_validate_actions_config(hass, config['actions'])
            script = Script(hass, [*config.get('conditions', []), *config['actions']], config['alias'], 'automation', script_mode=config['mode'])
            scripts.append(script)
            named_scripts[a['id']] = script
            async def action(variables, context=None): await script.async_run(variables, context)
            def log_error(*args, **kwargs):
                if kwargs.get('exc_info'): raise kwargs['exc_info']
            detach = await async_initialize_triggers(hass, config['triggers'], action, 'automation', config['alias'], log_error)
            assert detach is not None
            detachers.append(detach)
            return detach

        for a in candidate['automation']: await attach(a)
        await hass.async_block_till_done()
        checks = []
        for rule, entity in entities.items():
            bad = 'error' if rule == 'vacuum_fault' else 'on'
            normal = 'docked' if rule == 'vacuum_fault' else 'off'
            before = len(events)
            hass.states.async_set(entity, bad); await asyncio.sleep(0.03)
            assert len(events) == before, rule + ': early attention'
            hass.states.async_set(entity, normal); await asyncio.sleep(0.13)
            assert len(events) == before, rule + ': short pulse attention'
            hass.states.async_set(entity, bad); await asyncio.sleep(0.15)
            assert len(events) == before + 1, rule + ': missing attention'
            episode = events[-1]['data']['incidentId']
            hass.states.async_set(entity, 'unknown'); await asyncio.sleep(0.13)
            assert len(events) == before + 1, rule + ': unknown recovery'
            hass.states.async_set(entity, normal)
            if rule == 'vacuum_fault':
                await asyncio.sleep(0.06); hass.states.async_set(entity, 'cleaning'); await asyncio.sleep(0.08)
            else: await asyncio.sleep(0.15)
            assert len(events) == before + 2, rule + ': missing recovery'
            assert events[-1]['data']['incidentId'] == episode
            assert events[-1]['data']['phase'] == 'recovered'
            checks.append(rule + ': sustained, pulse cancellation, unknown, paired stable recovery')

        # Reload cancels a pending native for timer; a new transition starts afresh.
        rule = 'food_hopper1'; entity = entities[rule]; before = len(events)
        hass.states.async_set(entity, 'on'); await asyncio.sleep(0.03)
        for detach in detachers: detach()
        detachers.clear()
        for script in scripts: await script.async_stop()
        scripts.clear()
        await asyncio.sleep(0.13); assert len(events) == before
        for a in candidate['automation']: await attach(a)
        hass.states.async_set(entity, 'off'); await asyncio.sleep(0.01)
        hass.states.async_set(entity, 'on'); await asyncio.sleep(0.15)
        assert len(events) == before + 1
        checks.append('reload resets for, without replay')
        # Startup recovery re-establishes its full native timeout for a seeded
        # restored incident; this does not infer a transition during downtime.
        entity = entities['litter_full']
        hass.states.async_set('input_text.mcp_gateway_events_litter_full_incident', 'public-restored-incident')
        before = len(events)
        task = asyncio.create_task(named_scripts['mcp_gateway_litter_full_recovered'].async_run({'trigger': {'id': 'startup'}}, context=Context()))
        await asyncio.sleep(0.03); assert len(events) == before
        await task; await hass.async_block_till_done()
        assert len(events) == before + 1
        assert events[-1]['data']['incidentId'] == 'public-restored-incident'
        checks.append('startup recovery re-establishes duration for a restored incident')
        # The opt-in switch blocks further events without touching a real device.
        hass.states.async_set('input_boolean.mcp_gateway_events_enabled', 'off')
        before = len(events); hass.states.async_set(entities['water_low'], 'on'); await asyncio.sleep(0.15)
        assert len(events) == before; checks.append('disabled YAML produces no notifications')
        for detach in detachers: detach()
        for script in scripts: await script.async_stop()
        await hass.async_block_till_done()
        print(json.dumps({'haVersion': __version__, 'nativeMockPass': True, 'checks': checks, 'originalThresholdsVerified': expected,
                          'acceleratedTestSeconds': 0.1, 'realConfigLoaded': False, 'realStatesRead': False,
                          'realDeviceActions': 0, 'httpListeners': 0, 'sourceReplay': False,
                          'syntheticEnvelopes': events}))

asyncio.run(main())
