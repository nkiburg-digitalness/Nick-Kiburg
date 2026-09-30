import { EventEmitter } from 'node:events';

/**
 * Small event bus used to stream changes to the dashboard (Server-Sent Events)
 * and to persist a readable activity log.
 */
export class EventBus extends EventEmitter {
  constructor(db) {
    super();
    this.db = db;
    this.setMaxListeners(100);
  }

  /** Publish a change to all connected dashboards. */
  publish(type, payload) {
    this.emit('event', { type, payload, at: new Date().toISOString() });
  }

  /** Write to the activity log and publish it. level: info | warn | error */
  log(level, message, { channel = null, sku = null } = {}) {
    const row = this.db
      .prepare('INSERT INTO event_log (level, channel, sku, message) VALUES (?, ?, ?, ?) RETURNING *')
      .get(level, channel, sku, message);
    const line = `[${row.created_at}] ${level.toUpperCase()}${channel ? ` ${channel}` : ''}: ${message}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
    this.publish('log', row);
    return row;
  }

  recentLog(limit = 100) {
    return this.db.prepare('SELECT * FROM event_log ORDER BY id DESC LIMIT ?').all(limit);
  }
}
