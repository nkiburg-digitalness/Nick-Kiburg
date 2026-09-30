import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS products (
  sku              TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  ean              TEXT UNIQUE,
  stock            INTEGER NOT NULL DEFAULT 0,
  lead_time_days   INTEGER NOT NULL DEFAULT 14,
  safety_days      INTEGER NOT NULL DEFAULT 7,
  woo_product_id   INTEGER,
  woo_variation_id INTEGER,
  bol_offer_id     TEXT,
  created_at       TEXT NOT NULL DEFAULT (${NOW}),
  updated_at       TEXT NOT NULL DEFAULT (${NOW})
);

-- Every stock change is a movement. Sales carry a line_ref (one order line on one
-- channel) so repeated webhooks/polls for the same order never double count.
-- applied = 0 marks historical sales imported for forecasting only (no stock effect).
CREATE TABLE IF NOT EXISTS stock_movements (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sku         TEXT NOT NULL REFERENCES products(sku) ON UPDATE CASCADE ON DELETE CASCADE,
  delta       INTEGER NOT NULL,
  stock_after INTEGER,
  type        TEXT NOT NULL CHECK (type IN ('sale', 'sale_reversal', 'receipt', 'correction')),
  channel     TEXT NOT NULL,
  line_ref    TEXT,
  applied     INTEGER NOT NULL DEFAULT 1,
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (${NOW})
);
CREATE INDEX IF NOT EXISTS idx_movements_sku_time ON stock_movements (sku, created_at);
CREATE INDEX IF NOT EXISTS idx_movements_line_ref ON stock_movements (line_ref);

-- Outbox: which channel still needs the latest stock for which SKU.
-- One row per (sku, channel), so a burst of sales results in a single push.
CREATE TABLE IF NOT EXISTS sync_queue (
  sku             TEXT NOT NULL REFERENCES products(sku) ON UPDATE CASCADE ON DELETE CASCADE,
  channel         TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT (${NOW}),
  last_error      TEXT,
  PRIMARY KEY (sku, channel)
);

-- Last successfully pushed stock per channel, shown on the dashboard.
CREATE TABLE IF NOT EXISTS channel_stock (
  sku       TEXT NOT NULL REFERENCES products(sku) ON UPDATE CASCADE ON DELETE CASCADE,
  channel   TEXT NOT NULL,
  stock     INTEGER NOT NULL,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (sku, channel)
);

CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS event_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (${NOW}),
  level      TEXT NOT NULL,
  channel    TEXT,
  sku        TEXT,
  message    TEXT NOT NULL
);
`;

export function openDb(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}

/** Run fn inside a write transaction; rolls back on error. */
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function getKv(db, key) {
  return db.prepare('SELECT value FROM kv WHERE key = ?').get(key)?.value ?? null;
}

export function setKv(db, key, value) {
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}
