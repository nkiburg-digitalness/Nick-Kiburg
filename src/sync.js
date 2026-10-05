import { SkipSync } from './channels/errors.js';
import { CHANNEL_LABELS } from './inventory.js';

/**
 * Outbox worker: pushes the current central stock to every channel that has a
 * pending entry in sync_queue. Failed pushes are retried with exponential backoff,
 * so a temporary Bol.com or webshop outage never loses a stock update.
 */
export class SyncWorker {
  constructor({ db, bus, channels, intervalMs = 2000, maxBackoffSeconds = 900, isPaused = () => false }) {
    this.isPaused = isPaused;
    this.db = db;
    this.bus = bus;
    this.channels = new Map(channels.map((c) => [c.name, c]));
    this.intervalMs = intervalMs;
    this.maxBackoffSeconds = maxBackoffSeconds;
    this.running = false;
    this.timer = null;
    this.onRequest = () => this.runSoon();
  }

  start() {
    this.bus.on('sync_requested', this.onRequest);
    this.timer = setInterval(() => this.runOnce(), this.intervalMs);
    this.timer.unref?.();
    this.runSoon();
  }

  stop() {
    this.bus.off('sync_requested', this.onRequest);
    clearInterval(this.timer);
  }

  runSoon() {
    setImmediate(() => this.runOnce());
  }

  /** Process all due queue entries. Safe to call concurrently (re-entrancy guarded). */
  async runOnce() {
    if (this.running) return;
    this.running = true;
    try {
      const due = this.db.prepare(`
        SELECT * FROM sync_queue WHERE next_attempt_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now')
        ORDER BY next_attempt_at LIMIT 50
      `).all();
      // Paused: keep the queue, push nothing. Resuming sends the latest stock.
      if (this.isPaused()) return;
      for (const job of due) await this.#process(job);
      const dueListings = this.db.prepare(`
        SELECT * FROM listing_sync_queue WHERE next_attempt_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now')
        ORDER BY next_attempt_at LIMIT 50
      `).all();
      for (const job of dueListings) await this.#processListing(job);
    } finally {
      this.running = false;
    }
  }

  async #process(job) {
    const channel = this.channels.get(job.channel);
    const product = this.db.prepare('SELECT * FROM products WHERE sku = ?').get(job.sku);
    const done = () => this.db.prepare('DELETE FROM sync_queue WHERE sku = ? AND channel = ?').run(job.sku, job.channel);
    if (!channel || !product) {
      done();
      return;
    }
    if (!product.stock_confirmed) {
      // Unknown stock (never counted): never push a guessed 0 to a sales channel.
      done();
      this.bus.publish('synced', { sku: job.sku, channel: job.channel, skipped: 'voorraad nog niet geteld' });
      return;
    }
    const label = CHANNEL_LABELS[job.channel] ?? job.channel;
    try {
      const pushed = await channel.pushStock(product, product.stock);
      const now = new Date().toISOString();
      this.db.prepare(`
        INSERT INTO channel_stock (sku, channel, stock, synced_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(sku, channel) DO UPDATE SET stock = excluded.stock, synced_at = excluded.synced_at
      `).run(job.sku, job.channel, pushed, now);
      // Only clear the job if no newer change was queued while we were pushing.
      const current = this.db.prepare('SELECT stock FROM products WHERE sku = ?').get(job.sku);
      if (current?.stock === product.stock) done();
      this.bus.publish('synced', { sku: job.sku, channel: job.channel, stock: pushed, syncedAt: now });
    } catch (err) {
      if (err instanceof SkipSync) {
        done();
        this.bus.publish('synced', { sku: job.sku, channel: job.channel, skipped: err.message });
        return;
      }
      const { attempts, backoff } = this.#retryLater(err, job.attempts, 'sync_queue', 'sku = ? AND channel = ?', [job.sku, job.channel]);
      this.bus.log(attempts >= 5 ? 'error' : 'warn',
        `Voorraad ${job.sku} naar ${label} sturen mislukt (poging ${attempts}, opnieuw over ${backoff}s): ${err.message}`,
        { channel: job.channel, sku: job.sku });
      this.bus.publish('sync_failed', { sku: job.sku, channel: job.channel, attempts, error: err.message });
    }
  }

  /** Availability of a listing: the lowest (stock ÷ quantity) over its components. */
  #listingAvailability(listingId) {
    const parts = this.db.prepare(`
      SELECT c.quantity, p.stock, p.stock_confirmed FROM listing_components c JOIN products p ON p.sku = c.item_sku
      WHERE c.listing_id = ?
    `).all(listingId);
    if (!parts.length) return null;
    return {
      known: parts.every((p) => p.stock_confirmed),
      quantity: Math.min(...parts.map((p) => Math.floor(Math.max(0, p.stock) / p.quantity))),
    };
  }

  async #processListing(job) {
    const channel = this.channels.get(job.channel);
    const listing = this.db.prepare('SELECT * FROM listings WHERE id = ?').get(job.listing_id);
    const done = () => this.db.prepare('DELETE FROM listing_sync_queue WHERE listing_id = ? AND channel = ?').run(job.listing_id, job.channel);
    const availability = listing ? this.#listingAvailability(listing.id) : null;
    if (!channel || !listing || !availability) {
      done();
      return;
    }
    if (!availability.known) {
      done();
      this.bus.publish('synced', { listing: listing.id, channel: job.channel, skipped: 'voorraad nog niet geteld' });
      return;
    }
    const label = CHANNEL_LABELS[job.channel] ?? job.channel;
    try {
      const pushed = await channel.pushStock(listing, availability.quantity);
      const now = new Date().toISOString();
      this.db.prepare(`
        INSERT INTO listing_stock (listing_id, channel, stock, synced_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(listing_id, channel) DO UPDATE SET stock = excluded.stock, synced_at = excluded.synced_at
      `).run(listing.id, job.channel, pushed, now);
      if (this.#listingAvailability(listing.id)?.quantity === availability.quantity) done();
      this.bus.publish('synced', { listing: listing.id, channel: job.channel, stock: pushed, syncedAt: now });
    } catch (err) {
      if (err instanceof SkipSync) {
        done();
        this.bus.publish('synced', { listing: listing.id, channel: job.channel, skipped: err.message });
        return;
      }
      const { attempts, backoff } = this.#retryLater(err, job.attempts, 'listing_sync_queue', 'listing_id = ? AND channel = ?', [job.listing_id, job.channel]);
      this.bus.log(attempts >= 5 ? 'error' : 'warn',
        `Beschikbaarheid "${listing.name}" naar ${label} sturen mislukt (poging ${attempts}, opnieuw over ${backoff}s): ${err.message}`,
        { channel: job.channel });
      this.bus.publish('sync_failed', { listing: listing.id, channel: job.channel, attempts, error: err.message });
    }
  }

  #retryLater(err, previousAttempts, table, where, args) {
    const attempts = previousAttempts + 1;
    const backoff = Math.min(this.maxBackoffSeconds, Math.max(err.retryAfterSeconds ?? 0, 5 * 2 ** (attempts - 1)));
    this.db.prepare(`
      UPDATE ${table} SET attempts = ?, last_error = ?, next_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)
      WHERE ${where}
    `).run(attempts, err.message.slice(0, 500), `+${backoff} seconds`, ...args);
    return { attempts, backoff };
  }
}
