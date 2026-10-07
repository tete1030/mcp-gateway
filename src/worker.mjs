// Explicitly started by a future approved runtime, never on module import.
export class OutboxWorker {
  #running = false;
  #stopped = false;
  #tick;
  #timer;
  constructor(engine, { intervalMs = 500, batchSize = 8, schedule = setTimeout, cancel = clearTimeout } = {}) {
    if (batchSize < 1 || batchSize > 32 || intervalMs < 100) throw new Error('Invalid bounded worker configuration');
    Object.assign(this, { engine, intervalMs, batchSize, schedule, cancel });
  }
  async tick() {
    if (this.#stopped) return [];
    if (this.#tick) return this.#tick;
    this.#tick = (async () => {
      const outcomes = [];
      for (let i = 0; i < this.batchSize && !this.#stopped; i++) {
        const result = await this.engine.drainOne();
        if (!result) break;
        outcomes.push(result);
      }
      return outcomes;
    })();
    try { return await this.#tick; } finally { this.#tick = undefined; }
  }
  start() {
    if (this.#running || this.#stopped) return;
    this.#running = true;
    const iterate = async () => {
      if (this.#stopped) return;
      try { await this.tick(); } catch { /* Retain queue/leases; no raw storage or callback error logging. */ }
      if (!this.#stopped) this.#timer = this.schedule(iterate, this.intervalMs);
    };
    this.#timer = this.schedule(iterate, 0);
  }
  async stop() {
    this.#stopped = true;
    this.cancel(this.#timer);
    this.engine.stop();
    await this.#tick?.catch(() => {});
  }
}
