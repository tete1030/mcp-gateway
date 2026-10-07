import { readFile } from 'node:fs/promises';
try {
  const config = JSON.parse(await readFile(process.env.GATEWAY_CONFIG_FILE ?? '/run/config/gateway.json', 'utf8'));
  const probe = async url => {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000), redirect: 'error' });
    if (!response.ok) throw new Error('Unready');
  };
  await probe(`http://127.0.0.1:${config.gatewayPort ?? 8787}/healthz`);
  if (config.tunnel) await probe(`http://127.0.0.1:${config.tunnelHealthPort ?? 8788}/readyz`);
} catch { process.exitCode = 1; }
