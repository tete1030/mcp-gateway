import { z } from 'zod/v4';

// MCP request metadata belongs to the downstream protocol boundary. Accept
// vendor extensions as bounded JSON, never as backend arguments or authority.
// The HTTP entry separately validates the modern protocol envelope.
export const requestMetadataSchema = z.object({
  progressToken: z.union([z.string(), z.number().int()]).optional(),
}).catchall(z.unknown()).superRefine((metadata, ctx) => {
  const reject = () => ctx.addIssue({ code: 'custom', message: 'Request metadata exceeds bounded JSON limits' });
  if (Object.keys(metadata).length > 64) return reject();
  const pending = [{ value: metadata, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const { value, depth } = pending.pop();
    if (++nodes > 1024 || depth > 8) return reject();
    if (value === null || typeof value === 'string' || typeof value === 'boolean') continue;
    if (typeof value === 'number' && Number.isFinite(value)) continue;
    if (!value || typeof value !== 'object') return reject();
    if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return reject();
    const entries = Object.entries(value);
    if (entries.length > 1024 || entries.some(([key]) => key.length > 256)) return reject();
    for (const [, child] of entries) pending.push({ value: child, depth: depth + 1 });
  }
  if (Buffer.byteLength(JSON.stringify(metadata)) > 16 * 1024) reject();
});
