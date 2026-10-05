import { mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Daily copy of the database (SQLite VACUUM INTO: a consistent snapshot while the
 * app keeps running). Keeps the most recent `keep` backups.
 */
export class Backups {
  constructor({ db, bus, dir, keep = 14, prefix = 'voorraad' }) {
    this.db = db;
    this.prefix = prefix;
    this.bus = bus;
    this.dir = dir;
    this.keep = keep;
    this.timer = null;
  }

  start() {
    this.runIfDue();
    this.timer = setInterval(() => this.runIfDue(), 60 * 60 * 1000);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
  }

  /** Make today's backup if it doesn't exist yet. */
  runIfDue(now = new Date()) {
    const file = join(this.dir, `${this.prefix}-${now.toISOString().slice(0, 10)}.db`);
    if (existsSync(file)) return null;
    try {
      mkdirSync(this.dir, { recursive: true });
      this.db.prepare('VACUUM INTO ?').run(file);
      this.#prune();
      this.bus.log('info', `Back-up gemaakt: ${file}`);
      return file;
    } catch (err) {
      this.bus.log('error', `Back-up mislukt: ${err.message}`);
      return null;
    }
  }

  #prune() {
    const pattern = new RegExp(`^${this.prefix.replace(/[^a-z0-9-]/gi, '')}-\\d{4}-\\d{2}-\\d{2}\\.db$`);
    const files = readdirSync(this.dir).filter((f) => pattern.test(f)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - this.keep))) rmSync(join(this.dir, f));
  }
}
