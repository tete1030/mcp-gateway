import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { lstat, open, constants } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

// SQLite transactions contain no awaits or network calls. Private single-owner
// POC limits are deliberate; this is not a multi-tenant hosted storage service.
export class SQLiteEventStore {
  #db;
  #key;
  #namespace;
  #closed = false;
  durable;
  constructor(file, key, { maxSubscriptions = 100, maxOutbox = 1000, encryptionNamespace = 'mcp-gateway-events-v1' } = {}) {
    if (!(key instanceof Uint8Array) || key.length !== 32) throw new Error('Storage requires an externally supplied 32-byte key');
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(encryptionNamespace)) throw new Error('Invalid storage encryption namespace');
    this.#key = Buffer.from(key);
    this.#namespace = encryptionNamespace;
    this.durable = file !== ':memory:';
    this.maxSubscriptions = maxSubscriptions;
    this.maxOutbox = maxOutbox;
    this.#db = new DatabaseSync(file, { timeout: 500, allowExtension: false });
    try {
      this.#db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;');
      const version = this.#db.prepare('PRAGMA user_version').get().user_version;
      if (![0, 1, 2].includes(version)) throw new Error('Unsupported storage schema');
      this.#tx(() => {
        this.#db.exec(`
          CREATE TABLE IF NOT EXISTS metadata (id TEXT PRIMARY KEY, data BLOB NOT NULL) STRICT;
          CREATE TABLE IF NOT EXISTS subscriptions (
            owner TEXT NOT NULL, id TEXT NOT NULL, active INTEGER NOT NULL,
            revision INTEGER NOT NULL, generation INTEGER NOT NULL,
            expires INTEGER NOT NULL, data BLOB,
            PRIMARY KEY(owner,id)
          ) STRICT;
          CREATE TABLE IF NOT EXISTS outbox (
            id TEXT PRIMARY KEY, owner TEXT NOT NULL, subscription TEXT NOT NULL,
            generation INTEGER NOT NULL, event TEXT NOT NULL, data BLOB NOT NULL,
            attempts INTEGER NOT NULL, due INTEGER NOT NULL,
            lease TEXT, lease_until INTEGER NOT NULL
          ) STRICT;
          CREATE INDEX IF NOT EXISTS due_jobs ON outbox(due,lease_until);
          CREATE INDEX IF NOT EXISTS subscription_jobs ON outbox(owner,subscription);
          -- Retained only for storage/rollback compatibility; no business writer exists.
          CREATE TABLE IF NOT EXISTS business (
            owner TEXT NOT NULL, key TEXT NOT NULL, updated INTEGER NOT NULL, data BLOB NOT NULL,
            PRIMARY KEY(owner,key)
          ) STRICT;
          CREATE TABLE IF NOT EXISTS receipts (
            owner TEXT NOT NULL, id TEXT NOT NULL, expires INTEGER NOT NULL, data BLOB NOT NULL,
            PRIMARY KEY(owner,id)
          ) STRICT;
          PRAGMA user_version=2;
        `);
        const marker = this.#db.prepare('SELECT data FROM metadata WHERE id=?').get('key-check');
        if (marker) this.#unseal('metadata', marker.data);
        else this.#db.prepare('INSERT INTO metadata VALUES (?,?)').run('key-check', this.#seal('metadata', { format: 1 }));
      });
    } catch {
      this.#db.close(); this.#key.fill(0);
      throw new Error('Event storage initialization failed');
    }
  }

  static async open({ file, key, ...limits }) {
    file = resolve(file);
    const dir = await lstat(dirname(file));
    if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid() || (dir.mode & 0o077)) {
      throw new Error('Storage directory must be owned by the runtime user and private');
    }
    try {
      const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.close();
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077)) {
      throw new Error('Storage file must be a private regular file owned by the runtime user');
    }
    return new SQLiteEventStore(file, key, limits);
  }
  #owner(principal) {
    if (typeof principal !== 'string' || !principal || principal.length > 256) throw new Error('Invalid storage owner');
    return createHmac('sha256', this.#key).update(`owner:${principal}`).digest('hex');
  }
  #seal(context, value) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, nonce);
    cipher.setAAD(Buffer.from(`${this.#namespace}:${context}`));
    const body = Buffer.from(JSON.stringify(value));
    if (body.length > 256 * 1024) throw new Error('Storage record exceeds capacity');
    const encrypted = Buffer.concat([cipher.update(body), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
  }
  #unseal(context, bytes) {
    try {
      const blob = Buffer.from(bytes);
      const cipher = createDecipheriv('aes-256-gcm', this.#key, blob.subarray(0, 12));
      cipher.setAAD(Buffer.from(`${this.#namespace}:${context}`));
      cipher.setAuthTag(blob.subarray(12, 28));
      return JSON.parse(Buffer.concat([cipher.update(blob.subarray(28)), cipher.final()]).toString('utf8'));
    } catch { throw new Error('Event storage integrity check failed'); }
  }
  #tx(action) {
    this.#db.exec('BEGIN IMMEDIATE');
    try { const value = action(); this.#db.exec('COMMIT'); return value; }
    catch (error) { this.#db.exec('ROLLBACK'); throw error; }
  }
  #decode(row) {
    if (!row?.active || !row.data) return undefined;
    return this.#unseal(`subscription:${row.owner}:${row.id}`, row.data);
  }
  async beginSubscription(principal, id) {
    const owner = this.#owner(principal);
    return this.#tx(() => {
      if (this.#db.prepare('SELECT count(*) n FROM subscriptions').get().n >= this.maxSubscriptions &&
          !this.#db.prepare('SELECT 1 FROM subscriptions WHERE owner=? AND id=?').get(owner, id)) {
        throw new Error('Subscription capacity reached');
      }
      this.#db.prepare('INSERT OR IGNORE INTO subscriptions VALUES (?,?,0,0,0,0,NULL)').run(owner, id);
      const row = this.#db.prepare('SELECT * FROM subscriptions WHERE owner=? AND id=?').get(owner, id);
      return { revision: row.revision, existing: this.#decode(row) };
    });
  }
  async commitSubscription(principal, record, expectedRevision) {
    if (record.principal !== principal) throw new Error('Subscription owner mismatch');
    const owner = this.#owner(principal);
    return this.#tx(() => {
      const row = this.#db.prepare('SELECT * FROM subscriptions WHERE owner=? AND id=?').get(owner, record.id);
      if (!row || row.revision !== expectedRevision) return false;
      const generation = row.active ? row.generation : row.generation + 1;
      const value = { ...record, generation };
      this.#db.prepare('UPDATE subscriptions SET active=1,revision=revision+1,generation=?,expires=?,data=? WHERE owner=? AND id=?')
        .run(generation, record.expiresAt, this.#seal(`subscription:${owner}:${record.id}`, value), owner, record.id);
      return true;
    });
  }
  async getSubscription(principal, id) {
    return this.#decode(this.#db.prepare('SELECT * FROM subscriptions WHERE owner=? AND id=?').get(this.#owner(principal), id));
  }
  async listSubscriptions(principal) {
    return this.#db.prepare('SELECT * FROM subscriptions WHERE owner=? AND active=1').all(this.#owner(principal)).map(row => this.#decode(row));
  }
  async cancelSubscription(principal, id) {
    const owner = this.#owner(principal);
    this.#tx(() => {
      // Tombstones fence pending verification and old leased jobs after re-subscribe.
      this.#db.prepare('UPDATE subscriptions SET active=0,revision=revision+1,generation=generation+1,expires=0,data=NULL WHERE owner=? AND id=?').run(owner, id);
      this.#db.prepare('DELETE FROM outbox WHERE owner=? AND subscription=?').run(owner, id);
    });
  }
  async enqueue(principal, event, now) {
    const owner = this.#owner(principal);
    return this.#tx(() => this.#enqueue(principal, owner, event, now));
  }
  #enqueue(principal, owner, event, now) {
      const body = event.body;
      const rows = this.#db.prepare('SELECT * FROM subscriptions WHERE owner=? AND active=1 AND expires>?').all(owner, now);
      const matching = rows.filter(row => {
        const sub = this.#decode(row);
        if (event.name === undefined) return sub.arguments.kind === event.kind;
        if (sub.name !== event.name) return false;
        return Object.entries(sub.arguments).every(([key, value]) => {
          if (key === 'includeRecovery') return value || event.data.phase !== 'recovered';
          const actual = event.data[key === 'deviceIds' ? 'deviceId' : key];
          return Array.isArray(value) ? value.includes(actual) : value === actual;
        });
      });
      if (this.#db.prepare('SELECT count(*) n FROM outbox').get().n + matching.length > this.maxOutbox) throw new Error('Outbox capacity reached');
      const jobs = [];
      for (const row of matching) {
        const id = randomUUID();
        this.#db.prepare('INSERT INTO outbox VALUES (?,?,?,?,?,?,0,?,NULL,0)').run(id, owner, row.id, row.generation,
          event.eventId, this.#seal(`outbox:${owner}:${id}`, { principal, body, ...(event.meta ? { meta: event.meta } : {}) }), now);
        jobs.push({ id, subscriptionId: row.id });
      }
      return jobs;
  }
  #receiptKey(key) { return createHmac('sha256', this.#key).update(`business:${key}`).digest('hex'); }
  async wasDelivered(principal, incident, now) {
    const owner = this.#owner(principal), id = this.#receiptKey(incident);
    const row = this.#db.prepare('SELECT data FROM receipts WHERE owner=? AND id=? AND expires>?').get(owner,id,now);
    return row ? this.#unseal(`receipt:${owner}:${id}`,row.data).delivered : false;
  }
  // Delivery receipt pairing for HA-owned attention/recovery events.
  async cancelQueuedAttention(principal, incident) {
    const owner = this.#owner(principal);
    return this.#tx(() => {
      let cancelled = 0;
      for (const row of this.#db.prepare('SELECT id,data FROM outbox WHERE owner=?').all(owner)) {
        const packet = this.#unseal(`outbox:${owner}:${row.id}`, row.data);
        if (packet.meta?.phase === 'attention' && packet.meta.incidentId === incident) {
          this.#db.prepare('DELETE FROM outbox WHERE id=?').run(row.id); cancelled++;
        }
      }
      return cancelled;
    });
  }
  // Worker-only API. Not registered as a user-visible MCP tool.
  async claimDue(now, { leaseMs = 15_000 } = {}) {
    return this.#tx(() => {
      this.#db.prepare('DELETE FROM outbox WHERE attempts>=4 AND lease_until<=?').run(now);
      const job = this.#db.prepare('SELECT * FROM outbox WHERE due<=? AND lease_until<=? ORDER BY due,id LIMIT 1').get(now, now);
      if (!job) return undefined;
      const lease = randomUUID();
      this.#db.prepare('UPDATE outbox SET attempts=attempts+1,lease=?,lease_until=? WHERE id=?').run(lease, now + leaseMs, job.id);
      return { id: job.id, lease };
    });
  }
  async delivery(claim, now) {
    const row = this.#db.prepare('SELECT * FROM outbox WHERE id=? AND lease=? AND lease_until>?').get(claim.id, claim.lease, now);
    if (!row) return undefined;
    const sub = this.#db.prepare('SELECT * FROM subscriptions WHERE owner=? AND id=?').get(row.owner, row.subscription);
    if (!sub?.active || sub.generation !== row.generation || sub.expires <= now) return undefined;
    const packet = this.#unseal(`outbox:${row.owner}:${row.id}`, row.data);
    if (packet.meta?.expiresAt <= now) return undefined;
    return { ...packet, eventId: row.event, subscription: this.#decode(sub), attempts: row.attempts };
  }
  async settle(claim, { retryAt, delivered = false, deliveredAt = Date.now() } = {}) {
    return this.#tx(() => {
      const row = this.#db.prepare('SELECT * FROM outbox WHERE id=? AND lease=?').get(claim.id, claim.lease);
      if (!row) return false;
      if (delivered) {
        const packet = this.#unseal(`outbox:${row.owner}:${row.id}`,row.data);
        if (packet.meta?.phase === 'attention' && packet.meta.incidentId) {
          const id = this.#receiptKey(packet.meta.incidentId), now = deliveredAt;
          this.#db.prepare('DELETE FROM receipts WHERE expires<=?').run(now);
          if (this.#db.prepare('SELECT count(*) n FROM receipts').get().n >= 4096)
            this.#db.exec('DELETE FROM receipts WHERE rowid IN (SELECT rowid FROM receipts ORDER BY expires LIMIT 1)');
          this.#db.prepare('INSERT OR REPLACE INTO receipts VALUES (?,?,?,?)')
            .run(row.owner,id,now+7*86400_000,this.#seal(`receipt:${row.owner}:${id}`,{ delivered: true }));
        }
      }
      if (retryAt !== undefined && row.attempts < 4) {
        this.#db.prepare('UPDATE outbox SET due=?,lease=NULL,lease_until=0 WHERE id=? AND lease=?').run(retryAt, claim.id, claim.lease);
      } else this.#db.prepare('DELETE FROM outbox WHERE id=? AND lease=?').run(claim.id, claim.lease);
      return true;
    });
  }
  async pendingCount(principal) { return this.#db.prepare('SELECT count(*) n FROM outbox WHERE owner=?').get(this.#owner(principal)).n; }
  close() {
    if (this.#closed) return;
    this.#db.close(); this.#key.fill(0); this.#closed = true;
  }
}

export class MemorySubscriptionStore extends SQLiteEventStore {
  constructor(limits) { super(':memory:', Buffer.alloc(32, 0x4d), limits); }
}
