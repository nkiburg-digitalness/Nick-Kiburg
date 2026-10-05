import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';

function product(inventory, overrides = {}) {
  return inventory.upsertProduct({ sku: 'TS-1', name: 'Tochtstrip', ean: '871', stock: 10, ...overrides });
}

test('a sale lowers the central stock and queues a push to every channel', () => {
  const { db, inventory } = setup();
  product(inventory);
  db.exec('DELETE FROM sync_queue');

  inventory.recordSale({ channel: 'bol', lineRef: 'bol:1', sku: 'TS-1', quantity: 2 });

  assert.equal(inventory.getProduct('TS-1').stock, 8);
  const queued = db.prepare('SELECT channel FROM sync_queue ORDER BY channel').all().map((r) => r.channel);
  assert.deepEqual(queued, ['bol', 'woocommerce']);
});

test('receiving the same order line twice never double counts', () => {
  const { inventory } = setup();
  product(inventory);
  inventory.recordSale({ channel: 'woocommerce', lineRef: 'woo:5', sku: 'TS-1', quantity: 3 });
  const again = inventory.recordSale({ channel: 'woocommerce', lineRef: 'woo:5', sku: 'TS-1', quantity: 3 });
  assert.equal(again, null);
  assert.equal(inventory.getProduct('TS-1').stock, 7);
});

test('cancelling (quantity back to 0) puts the goods back in stock', () => {
  const { inventory } = setup();
  product(inventory);
  inventory.recordSale({ channel: 'bol', lineRef: 'bol:9', sku: 'TS-1', quantity: 3 });
  const reversal = inventory.recordSale({ channel: 'bol', lineRef: 'bol:9', sku: 'TS-1', quantity: 1 });
  assert.equal(reversal.type, 'sale_reversal');
  assert.equal(reversal.delta, 2);
  assert.equal(inventory.getProduct('TS-1').stock, 9);
  inventory.recordSale({ channel: 'bol', lineRef: 'bol:9', sku: 'TS-1', quantity: 0 });
  assert.equal(inventory.getProduct('TS-1').stock, 10);
});

test('history-only sales do not change stock, and are not counted again later', () => {
  const { inventory } = setup();
  product(inventory);
  inventory.recordSale({ channel: 'bol', lineRef: 'bol:old', sku: 'TS-1', quantity: 4, applyToStock: false });
  assert.equal(inventory.getProduct('TS-1').stock, 10);
  // The live poller sees the same order: nothing changes.
  assert.equal(inventory.recordSale({ channel: 'bol', lineRef: 'bol:old', sku: 'TS-1', quantity: 4 }), null);
  // A later cancellation of that historical order must not add stock that was never taken.
  inventory.recordSale({ channel: 'bol', lineRef: 'bol:old', sku: 'TS-1', quantity: 0 });
  assert.equal(inventory.getProduct('TS-1').stock, 10);
});

test('orders placed before go-live are kept as history only', () => {
  const { inventory } = setup({ goLiveAt: '2026-09-01T00:00:00.000Z' });
  product(inventory);
  inventory.recordSale({ channel: 'bol', lineRef: 'a', sku: 'TS-1', quantity: 1, occurredAt: '2026-08-31T12:00:00.000Z' });
  inventory.recordSale({ channel: 'bol', lineRef: 'b', sku: 'TS-1', quantity: 1, occurredAt: '2026-09-02T12:00:00.000Z' });
  assert.equal(inventory.getProduct('TS-1').stock, 9);
});

test('stocktake books the difference as a correction', () => {
  const { inventory } = setup();
  product(inventory);
  const m = inventory.setStock({ sku: 'TS-1', count: 6 });
  assert.equal(m.delta, -4);
  assert.equal(m.type, 'correction');
  assert.equal(inventory.getProduct('TS-1').stock, 6);
});

test('products are found by channel ids, SKU or EAN', () => {
  const { inventory } = setup();
  product(inventory, { woo_product_id: 11, bol_offer_id: 'offer-1' });
  inventory.upsertProduct({ sku: 'TS-2', name: 'Variant', woo_product_id: 11, woo_variation_id: 12 });
  assert.equal(inventory.findProduct({ ean: '871' }).sku, 'TS-1');
  assert.equal(inventory.findProduct({ bolOfferId: 'offer-1' }).sku, 'TS-1');
  assert.equal(inventory.findProduct({ wooProductId: 11 }).sku, 'TS-1');
  assert.equal(inventory.findProduct({ wooProductId: 11, wooVariationId: 12 }).sku, 'TS-2');
  assert.equal(inventory.findProduct({ sku: 'nope' }), null);
});

test('daily backup is a readable copy and old backups are pruned', async () => {
  const { mkdtempSync, readdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { Backups } = await import('../src/backup.js');
  const { openDb } = await import('../src/db.js');
  const { db, bus, inventory } = setup();
  inventory.upsertProduct({ sku: 'TS-1', name: 'Tochtstrip', stock: 7 });
  const dir = mkdtempSync(join(tmpdir(), 'voorraad-backup-'));
  for (const d of ['2026-01-01', '2026-01-02', '2026-01-03']) writeFileSync(join(dir, `voorraad-${d}.db`), '');

  const backups = new Backups({ db, bus, dir, keep: 2 });
  const file = backups.runIfDue(new Date('2026-09-30T08:00:00Z'));
  assert.equal(backups.runIfDue(new Date('2026-09-30T20:00:00Z')), null, 'only once per day');
  assert.deepEqual(readdirSync(dir).sort(), ['voorraad-2026-01-03.db', 'voorraad-2026-09-30.db']);
  const copy = openDb(file);
  assert.equal(copy.prepare('SELECT stock FROM products').get().stock, 7);
  copy.close();
});

test('upgrade: products imported with stock 0 and never counted become "unknown"', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { openDb } = await import('../src/db.js');
  const file = join(mkdtempSync(join(tmpdir(), 'voorraad-upgrade-')), 'shop.db');
  // An older database without the column.
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE products (sku TEXT PRIMARY KEY, name TEXT NOT NULL, ean TEXT UNIQUE, stock INTEGER NOT NULL DEFAULT 0,
    lead_time_days INTEGER NOT NULL DEFAULT 14, safety_days INTEGER NOT NULL DEFAULT 7, woo_product_id INTEGER, woo_variation_id INTEGER,
    bol_offer_id TEXT, created_at TEXT NOT NULL DEFAULT 'x', updated_at TEXT NOT NULL DEFAULT 'x');
    INSERT INTO products (sku, name, stock) VALUES ('NUL', 'a', 0), ('VIJF', 'b', 5);`);
  old.close();
  const db = openDb(file);
  const state = Object.fromEntries(db.prepare('SELECT sku, stock_confirmed FROM products').all().map((r) => [r.sku, r.stock_confirmed]));
  assert.deepEqual(state, { NUL: 0, VIJF: 1 });
  db.close();
});
