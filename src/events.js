import { EventEmitter } from 'node:events';

/**
 * Event bus of one webshop (or of the core, shopId = null). Events are used locally
 * (e.g. the sync worker listens for 'sync_requested') and forwarded to the shared
 * `hub`, tagged with the shop, from where they stream to the dashboards (SSE).
 * Log lines are also stored in the database's activity log.
 */
export class EventBus extends EventEmitter {
  constructor(db, { shopId = null, hub = null } = {}) {
    super();
    this.db = db;
    this.shopId = shopId;
    this.hub = hub;
    this.setMaxListeners(100);
  }

  /** Publish a change to all connected dashboards. */
  publish(type, payload) {
    const event = { type, payload, shop: this.shopId, at: new Date().toISOString() };
    this.emit('event', event);
    this.hub?.emit('event', event);
  }

  /** Write to the activity log and publish it. level: info | warn | error */
  log(level, message, { channel = null, sku = null } = {}) {
    const row = this.db
      .prepare('INSERT INTO event_log (level, channel, sku, message) VALUES (?, ?, ?, ?) RETURNING *')
      .get(level, channel, sku, message);
    const prefix = [this.shopId, channel].filter(Boolean).join('/');
    const line = `[${row.created_at}] ${level.toUpperCase()}${prefix ? ` ${prefix}` : ''}: ${message}`;
    if (!process.env.NODE_TEST_CONTEXT) { // keep `npm test` output readable
      if (level === 'error') console.error(line);
      else if (level === 'warn') console.warn(line);
      else console.log(line);
    }
    this.publish('log', { ...row, shop: this.shopId });
    return row;
  }

  recentLog(limit = 100) {
    return this.db.prepare('SELECT * FROM event_log ORDER BY id DESC LIMIT ?').all(limit)
      .map((row) => ({ ...row, shop: this.shopId }));
  }
}
