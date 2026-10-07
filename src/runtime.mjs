// Active thin gateway entry point: HA owns business event conditions.
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createThinAggregate } from './aggregate.mjs';
import { listenGateway } from './listener.mjs';
import { tunnelCommand, tunnelEnvironment } from './tunnel.mjs';

export async function runThin(input, { launch = spawn, dependencies, registerSignals = true } = {}) {
  const app = await createThinAggregate(input, dependencies); let listener, child, timer, stopped = false, attempts = 0;
  const close = async () => {
    if (stopped) return; stopped = true; clearTimeout(timer);
    if (child) { const running = child; await new Promise(resolve => {
      const timeout = setTimeout(() => { running.kill('SIGKILL'); resolve(); }, 3000);
      running.once('exit', () => { clearTimeout(timeout); resolve(); }); running.kill('SIGTERM');
    }); }
    await app.stop(); if (listener) await listener.close(); else await app.gateway.close(); app.store?.close();
    if (registerSignals) for (const signal of ['SIGINT', 'SIGTERM']) process.removeListener(signal, onSignal);
  };
  const onSignal = () => void close();
  const startTunnel = () => {
    if (stopped) return;
    const cfg = app.config;
    const forwardedEnv = Object.fromEntries([cfg.tunnel.secretRef, cfg.identity.secretRef].map(n => cfg.secrets[n].env).filter(Boolean).map(n => [n, process.env[n]]));
    child = launch('/usr/bin/tunnel-client', tunnelCommand(cfg, listener.url),
      { env: { ...tunnelEnvironment(), ...forwardedEnv }, stdio: ['ignore', 'ignore', 'ignore'] });
    child.once('error', () => { process.exitCode = 1; void close(); });
    child.once('exit', () => { child = undefined; if (stopped) return;
      if (++attempts > 5) { process.exitCode = 1; void close(); return; }
      timer = setTimeout(startTunnel, Math.min(500 * 2 ** (attempts - 1), 8000));
    });
  };
  try {
    listener = await listenGateway(app.gateway, { port: app.config.gatewayPort });
    if (registerSignals) for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, onSignal);
    if (app.config.tunnel) startTunnel(); await app.start();
    return { app, url: listener.url, close };
  } catch (error) { await close(); throw error; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const path = process.env.GATEWAY_CONFIG_FILE;
    if (!path) throw new Error('Thin gateway requires explicit configuration');
    await runThin(JSON.parse(await readFile(path, 'utf8')));
    process.stdout.write('{"event":"thin_gateway_ready"}\n');
  } catch { process.stdout.write('{"event":"thin_gateway_rejected"}\n'); process.exitCode = 1; }
}
