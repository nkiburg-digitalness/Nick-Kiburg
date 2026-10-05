import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

// One database per webshop: products, stock ledger and sync state.
const SHOP_SCHEMA = `
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

// The core database: user accounts, sessions and the configured webshops.
const CORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('beheerder', 'medewerker', 'kijker')),
  password_hash TEXT NOT NULL,
  disabled      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (${NOW}),
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (${NOW}),
  expires_at TEXT NOT NULL
);

-- Webshops. Credentials are stored encrypted (see secrets.js).
CREATE TABLE IF NOT EXISTS shops (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  color                 TEXT NOT NULL,
  position              INTEGER NOT NULL DEFAULT 0,
  woo_base_url          TEXT,
  woo_consumer_key      TEXT,
  woo_consumer_secret   TEXT,
  woo_webhook_secret    TEXT,
  bol_client_id         TEXT,
  bol_client_secret     TEXT,
  bol_fulfilment_method TEXT NOT NULL DEFAULT 'FBR',
  created_at            TEXT NOT NULL DEFAULT (${NOW}),
  updated_at            TEXT NOT NULL DEFAULT (${NOW})
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

function open(file, schema) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(schema);
  return db;
}

/** Open (and create/migrate) the database of one webshop. */
export function openDb(file) {
  const db = open(file, SHOP_SCHEMA);
  // Who booked a manual movement (receipt, stocktake, correction).
  ensureColumn(db, 'stock_movements', 'user_name', 'TEXT');
  // 0 = the stock is not known yet (e.g. "manage stock" was off in WooCommerce): such a
  // product is never pushed to the sales channels until it has been counted.
  if (ensureColumn(db, 'products', 'stock_confirmed', 'INTEGER NOT NULL DEFAULT 1')) {
    // Products imported with stock 0 that were never counted or received: unknown.
    db.exec(`UPDATE products SET stock_confirmed = 0 WHERE stock = 0 AND NOT EXISTS (
      SELECT 1 FROM stock_movements m WHERE m.sku = products.sku AND m.type IN ('receipt', 'correction'))`);
  }
  return db;
}

/** Open (and create/migrate) the core database with users and webshops. */
export function openCoreDb(file) {
  const db = open(file, CORE_SCHEMA);
  // Webshops a user may see (JSON array of shop ids); NULL = all webshops.
  ensureColumn(db, 'users', 'shops', 'TEXT');
  // 1 = do not send stock to the webshop/Bol.com yet (incoming orders are still booked).
  // Existing webshops start paused after this upgrade, as do all new webshops.
  ensureColumn(db, 'shops', 'sync_paused', 'INTEGER NOT NULL DEFAULT 1');
  return db;
}

function ensureColumn(db, table, column, definition) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return !exists;
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
