import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod/v4';

const principalSchema = z.object({
  id: z.string().min(1).max(256), scopes: z.array(z.string().min(1).max(80)).max(32),
  kind: z.enum(['external_verifier', 'local_service', 'mock']).default('external_verifier'),
  allowedKinds: z.array(z.enum(['warning', 'cat'])).optional(),
}).strict();
export function validatedPrincipal(value) {
  const result = principalSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

// The injected verifier owns issuer/audience/signature/expiry/revocation checks.
// This boundary is NOT an implementation or claim of completed OAuth.
export function createBearerIdentity({ verifyToken }) {
  if (typeof verifyToken !== 'function') throw new Error('An approved token verifier is required');
  return async request => {
    const header = request.headers.get('Authorization') ?? '';
    if (header.length > 4096) return undefined;
    const match = /^Bearer ([^\s]+)$/i.exec(header);
    if (!match) return undefined;
    const principal = validatedPrincipal(await verifyToken(match[1]));
    return principal ? { ...principal, kind: 'external_verifier' } : undefined;
  };
}

export const SERVICE_SECRET_HEADER = 'x-mcp-gateway-service-secret';
// Candidate for an explicitly approved private SINGLE OWNER tunnel only.
// Maps service possession to one configured owner, not to a ChatGPT OAuth user.
export function createLocalServiceIdentity({ readServiceSecret, owner, scopes, header = SERVICE_SECRET_HEADER }) {
  const principal = validatedPrincipal({ id: owner, scopes, kind: 'local_service' });
  if (!principal || typeof readServiceSecret !== 'function' || !/^x-[a-z0-9-]{1,100}$/.test(header)) throw new Error('Explicit service identity policy required');
  return async request => {
    const supplied = request.headers.get(header) ?? '';
    if (!supplied || supplied.length > 4096) return undefined;
    const expected = await readServiceSecret();
    if (typeof expected !== 'string' || expected.length < 32 || expected.length > 4096) return undefined;
    const hash = value => createHash('sha256').update(value).digest();
    return timingSafeEqual(hash(supplied), hash(expected)) ? structuredClone(principal) : undefined;
  };
}

// Resolve fresh permission by stored owner ID on EVERY lifecycle operation.
// No access/refresh token is persisted inside a subscription.
export function createEventAuthorizer({ resolvePrincipal }) {
  return async (id, action, { arguments: args } = {}) => {
    const principal = validatedPrincipal(await resolvePrincipal(id));
    if (!principal || principal.id !== id) return false;
    const scope = ({ list: 'events:list', subscribe: 'events:subscribe', unsubscribe: 'events:subscribe',
      emit: 'events:emit', deliver: 'events:subscribe' })[action];
    return !!scope && principal.scopes.includes(scope) &&
      (!args?.kind || !principal.allowedKinds || principal.allowedKinds.includes(args.kind));
  };
}
