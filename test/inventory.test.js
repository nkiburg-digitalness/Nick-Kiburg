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
