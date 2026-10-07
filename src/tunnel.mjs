import { SERVICE_SECRET_HEADER } from './identity.mjs';
// The tunnel and local listener use the same explicitly configured service header.
export function tunnelCommand(config, gatewayUrl) {
  const ref = name => { const value = config.secrets[name]; return value.file ? `file:${value.file}` : `env:${value.env}`; };
  const header = config.identity.serviceSecretHeader ?? SERVICE_SECRET_HEADER;
  return ['run', '--control-plane.api-key', ref(config.tunnel.secretRef), '--control-plane.tunnel-id', config.tunnel.id,
    '--control-plane.organization-id', config.tunnel.organizationId, '--control-plane.poll-channel', 'main', '--mcp.server-url', gatewayUrl,
    '--health.listen-addr', `127.0.0.1:${config.tunnelHealthPort}`, '--log.level', 'warn', '--log.format', 'json',
    '--mcp.extra-headers', `${header}: ${ref(config.identity.secretRef)}`,
    '--mcp.discovery-extra-headers', `${header}: ${ref(config.identity.secretRef)}`];
}
export function tunnelEnvironment(env = process.env) {
  return Object.fromEntries(['PATH', 'HOME', 'LANG', 'SSL_CERT_FILE'].filter(k => env[k]).map(k => [k, env[k]]));
}
