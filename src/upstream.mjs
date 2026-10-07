import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

export class UpstreamUnavailable extends Error { constructor() { super('Backend unavailable; action outcome may be unknown. No action was replayed.'); } }
export function toolAllowed(policy, name) {
  return !policy.deny.includes(name) && (policy.mode === 'passthrough' || policy.allow.includes(name));
}
export class DynamicBackend {
  #client; #connecting; #closed = false; #token; #tools = []; #state = 'idle';
  constructor(config, { resolveSecret, fetchImpl = fetch, changed = () => {} } = {}) {
    Object.assign(this, { config, id: config.id, resolveSecret, fetchImpl, changed });
    this.target = new URL(config.url);
  }
  health() { return { id: this.id, state: this.#state }; }
  #accept(tools) {
    if (tools.length > 500 || new Set(tools.map(t => t.name)).size !== tools.length) throw new UpstreamUnavailable();
    this.#tools = structuredClone(tools.filter(t => toolAllowed(this.config.tools, t.name)));
    this.#state = 'ready'; this.changed();
  }
  async #connect() {
    if (this.#closed) throw new UpstreamUnavailable();
    if (this.#client) return this.#client;
    if (this.#connecting) return this.#connecting;
    this.#connecting = (async () => {
      this.#token = this.config.auth.type === 'bearer' ? await this.resolveSecret(this.config.auth.secretRef) : undefined;
      const safeFetch = async (input, init) => {
        const request = new Request(input, init);
        if (request.url !== this.target.href) throw new UpstreamUnavailable();
        const headers = new Headers(request.headers); headers.delete('Authorization');
        if (this.#token) headers.set('Authorization', `Bearer ${this.#token}`);
        const response = await this.fetchImpl(new Request(request, { headers, redirect: 'error' }));
        if (!response.body) return response;
        const reader = response.body.getReader(); let bytes = 0;
        return new Response(new ReadableStream({ async pull(controller) {
          try { const next = await reader.read(); if (next.done) return controller.close();
            bytes += next.value.byteLength; if (bytes > 2 * 1024 * 1024) { await reader.cancel(); throw new UpstreamUnavailable(); }
            controller.enqueue(next.value);
          } catch { controller.error(new UpstreamUnavailable()); }
        }, cancel: reason => reader.cancel(reason) }), { status: response.status, headers: response.headers });
      };
      const client = new Client({ name: `mcp-gateway-${this.id}`, version: '0.7.0-preview.0' }, {
        versionNegotiation: { mode: this.config.protocolNegotiation }, listMaxPages: 8,
        listChanged: { tools: { onChanged: (error, tools) => { if (!error && this.#client === client) {
          try { this.#accept(tools); } catch { this.#state = 'degraded'; }
        } else if (error) this.#state = 'degraded'; } } },
      });
      client.onerror = () => { this.#state = 'degraded'; };
      client.onclose = () => { if (this.#client === client) { this.#client = undefined; this.#state = 'degraded'; } };
      try {
        await client.connect(new StreamableHTTPClientTransport(this.target, { fetch: safeFetch, requestInit: { redirect: 'error' } }), { timeout: this.config.timeoutMs });
        const listing = await client.listTools(undefined, { timeout: this.config.timeoutMs });
        this.#accept(listing.tools); this.#client = client; return client;
      } catch { await client.close().catch(() => {}); this.#state = 'degraded'; throw new UpstreamUnavailable(); }
    })();
    try { return await this.#connecting; } finally { this.#connecting = undefined; }
  }
  async listTools({ refresh = false } = {}) {
    try {
      const client = await this.#connect();
      if (refresh) this.#accept((await client.listTools(undefined, { timeout: this.config.timeoutMs })).tools);
      return structuredClone(this.#tools);
    } catch { this.#state = 'degraded'; if (this.#tools.length) return structuredClone(this.#tools); throw new UpstreamUnavailable(); }
  }
  async call(name, args) {
    if (!toolAllowed(this.config.tools, name)) throw new UpstreamUnavailable();
    try {
      const client = await this.#connect();
      if (!this.#tools.some(t => t.name === name)) throw new UpstreamUnavailable();
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: this.config.timeoutMs });
      if (Buffer.byteLength(JSON.stringify(result)) > 128 * 1024) throw new UpstreamUnavailable();
      const scrub = value => {
        if (typeof value === 'string') return this.#token ? value.replaceAll(this.#token, '[redacted]') : value;
        if (Array.isArray(value)) return value.map(scrub);
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,scrub(v)]));
        return value;
      };
      return scrub(result);
    } catch {
      const old = this.#client; this.#client = undefined; this.#state = 'degraded';
      await old?.close().catch(() => {}); throw new UpstreamUnavailable();
    }
  }
  async close() { this.#closed = true; await this.#connecting?.catch(() => {}); await this.#client?.close().catch(() => {}); this.#client = undefined; this.#token = undefined; }
}
