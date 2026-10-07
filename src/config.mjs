import { z } from 'zod/v4';
import { entityIds } from './connectors/ha/contract.mjs';
import { isCanonicalDnsHostname } from './callback-host-policy.mjs';
import { SERVICE_SECRET_HEADER } from './identity.mjs';
const id = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/);
const name = z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/);
const endpoint = z.string().url().refine(value => {
  const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash;
});
const secret = z.union([
  z.object({ file: z.string().regex(/^\/run\/secrets\/[a-z][a-z0-9_]{0,63}$/) }).strict(),
  z.object({ env: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/) }).strict(),
]);
const auth = z.discriminatedUnion('type', [z.object({ type: z.literal('none') }).strict(),
  z.object({ type: z.literal('bearer'), secretRef: id }).strict()]);
export const thinConfigSchema = z.object({
  configVersion: z.literal(2), mode: z.literal('aggregate'),
  gatewayPort: z.number().int().min(1024).max(65535).default(8787),
  tunnelHealthPort: z.number().int().min(1024).max(65535).default(8788),
  identity: z.object({ ownerId: z.string().min(1).max(256), secretRef: id,
    serviceSecretHeader: z.string().regex(/^x-[a-z0-9-]{1,100}$/).default(SERVICE_SECRET_HEADER) }).strict(),
  secrets: z.record(id, secret),
  backends: z.array(z.object({ id, enabled: z.boolean().default(false), transport: z.literal('streamable_http'),
    url: endpoint, auth: auth.default({ type: 'none' }), protocolNegotiation: z.enum(['auto', 'legacy', 'modern']).default('auto'),
    namespace: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/).optional(),
    timeoutMs: z.number().int().min(1000).max(60000).default(10000),
    tools: z.object({ mode: z.enum(['passthrough', 'allowlist']).default('passthrough'),
      allow: z.array(name).max(500).optional(), deny: z.array(name).max(500).default([]) }).strict().default({ mode: 'passthrough', deny: [] }),
  }).strict()).max(16),
  tunnel: z.object({ id: z.string().regex(/^tunnel_[a-zA-Z0-9_]+$/), organizationId: z.string().regex(/^org-[a-zA-Z0-9]+$/), secretRef: id }).strict().optional(),
  events: z.object({ enabled: z.boolean().default(false),
    state: z.object({ databaseFile: z.string().regex(/^\/var\/lib\/[a-z][a-z0-9_/-]*\.sqlite$/), keyRef: id,
      encryptionNamespace: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/).default('mcp-gateway-events-v1') }).strict().optional(),
    callback: z.object({ mode: z.literal('exact_host_allowlist'),
      allowedHosts: z.array(z.string().refine(isCanonicalDnsHostname)).max(8) }).strict(),
    retry: z.object({ delaysSeconds: z.array(z.number().min(0.1).max(3600)).length(3).default([1, 5, 30]),
      jitter: z.boolean().default(true) }).strict().default({ delaysSeconds: [1, 5, 30], jitter: true }),
  }).strict(),
  haConnector: z.object({ backendId: id, eventsEnabled: z.boolean().default(false), historyEnabled: z.boolean().default(false),
    entityIds: z.array(z.enum(entityIds)).min(1).max(5),
  }).strict(),
}).strict().superRefine((c, ctx) => {
  const fail = message => ctx.addIssue({ code: 'custom', message });
  const ref = key => { if (!Object.hasOwn(c.secrets, key)) fail('Unknown secret reference'); };
  ref(c.identity.secretRef); if (c.tunnel) ref(c.tunnel.secretRef); if (c.events.state) ref(c.events.state.keyRef);
  if (c.gatewayPort === c.tunnelHealthPort) fail('Listeners require distinct ports');
  if (new Set(c.backends.map(b => b.id)).size !== c.backends.length) fail('Duplicate backend');
  for (const b of c.backends) {
    if (b.auth.type === 'bearer') ref(b.auth.secretRef);
    if (b.tools.mode === 'allowlist' && b.tools.allow === undefined) fail('Explicit tool allowlist required');
    if (b.tools.mode === 'passthrough' && b.tools.allow !== undefined) fail('Passthrough cannot specify allow');
  }
  if (new Set(c.haConnector.entityIds).size !== c.haConnector.entityIds.length) fail('Duplicate selected entity');
  if (new Set(c.events.callback.allowedHosts).size !== c.events.callback.allowedHosts.length) fail('Duplicate callback host');
  if (c.events.enabled && !c.events.state) fail('Events require persistent encrypted state');
  if (c.haConnector.eventsEnabled && !c.events.enabled) fail('HA event adapter requires MCP Events');
  const b = c.backends.find(b => b.id === c.haConnector.backendId);
  if (!b || ((c.haConnector.eventsEnabled || c.haConnector.historyEnabled) && (!b.enabled || b.auth.type !== 'bearer'))) fail('Enabled HA connector requires matching bearer backend');
});
export function parseThinConfig(input) { return thinConfigSchema.parse(input); }
