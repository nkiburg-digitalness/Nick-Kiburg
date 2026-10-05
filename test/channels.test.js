import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { BolChannel, daysBetween } from '../src/channels/bol.js';
import { WooCommerceChannel } from '../src/channels/woocommerce.js';
import { SyncWorker } from '../src/sync.js';
import { SkipSync } from '../src/channels/errors.js';
import { setKv } from '../src/db.js';
import { config } from '../src/config.js';
import { setup, mockFetch } from './helpers.js';

const bolConfig = { ...config.bol, clientId: 'id', clientSecret: 'secret', fulfilmentMethod: 'FBR' };
const wooConfig = { ...config.woo, baseUrl: 'https://shop.test', consumerKey: 'ck', consumerSecret: 'cs', webhookSecret: 'whsec' };

function bolOrder(id, items) {
  return {
    orderId: id,
    orderPlacedDateTime: '2026-09-30T10:00:00+02:00',
    orderItems: items.map(([orderItemId, ean, quantity, quantityCancelled = 0]) => ({
      orderItemId, ean, quantity, quantityCancelled, fulfilmentMethod: 'FBR',
    })),
  };
}

test('Bol: polls orders, books sales by EAN and auto-links the offer id', async () => {
  const { db, inventory } = setup();
  inventory.upsertProduct({ sku: 'TS-1', name: 'Tochtstrip', ean: '8720000000001', stock: 20 });
  setKv(db, 'bol:last_poll', new Date(Date.now() - 60_000).toISOString());

  const { fetchImpl, calls } = mockFetch([
    ['POST', /login\.bol\.com\/token/, () => ({ body: { access_token: 'tok', expires_in: 299 } })],
    ['GET', /\/retailer\/orders\?/, () => ({ body: { orders: [bolOrder('A1', [['item-1', '8720000000001', 2]])] } })],
    ['GET', /\/retailer\/orders\/A1$/, () => ({
      body: { orderId: 'A1', orderItems: [{ orderItemId: 'item-1', offer: { offerId: 'offer-xyz', reference: 'TS-1' }, product: { ean: '8720000000001' } }] },
    })],
  ]);
  const bol = new BolChannel({ config: bolConfig, db, bus: inventory.bus, fetchImpl });

  assert.equal(await bol.poll(inventory), 1);
  assert.equal(inventory.getProduct('TS-1').stock, 18);
  assert.equal(inventory.getProduct('TS-1').bol_offer_id, 'offer-xyz');

  const list = calls.find((c) => c.url.includes('/retailer/orders?'));
  assert.match(list.url, /status=ALL/);
  assert.match(list.url, /change-interval-minute=/);
  assert.match(list.url, /fulfilment-method=FBR/);
  assert.equal(list.headers.Accept, 'application/vnd.retailer.v10+json');
  assert.equal(list.headers.Authorization, 'Bearer tok');

  // Polling again with the same order changes nothing.
  assert.equal(await bol.poll(inventory), 0);
  assert.equal(inventory.getProduct('TS-1').stock, 18);
});

test('Bol: a cancelled order item is restocked', async () => {
  const { db, inventory } = setup();
  inventory.upsertProduct({ sku: 'TS-1', name: 'Tochtstrip', ean: '871', stock: 10, bol_offer_id: 'o1' });
  let cancelled = 0;
  const { fetchImpl } = mockFetch([
    ['POST', /token/, () => ({ body: { access_token: 't', expires_in: 299 } })],
    ['GET', /\/retailer\/orders\?/, () => ({ body: { orders: [bolOrder('B1', [['i1', '871', 3, cancelled]])] } })],
  ]);
  const bol = new BolChannel({ config: bolConfig, db, bus: inventory.bus, fetchImpl });
  await bol.poll(inventory);
  assert.equal(inventory.getProduct('TS-1').stock, 7);
  cancelled = 3;
  await bol.poll(inventory);
  assert.equal(inventory.getProduct('TS-1').stock, 10);
});

test('Bol: stock push uses the offer stock endpoint and caps at 999', async () => {
  const { db, inventory } = setup();
  const { fetchImpl, calls } = mockFetch([
    ['POST', /token/, () => ({ body: { access_token: 't', expires_in: 299 } })],
    ['PUT', /\/retailer\/offers\/o-1\/stock$/, () => ({ status: 202, body: { processStatusId: '1' } })],
  ]);
  const bol = new BolChannel({ config: bolConfig, db, bus: inventory.bus, fetchImpl });
  assert.equal(await bol.pushStock({ bol_offer_id: 'o-1' }, 1500), 999);
  const put = calls.find((c) => c.method === 'PUT');
  assert.deepEqual(put.body, { amount: 999, managedByRetailer: true });
  await assert.rejects(bol.pushStock({ bol_offer_id: null }, 5), SkipSync);
});

test('Bol: catch-up after downtime queries every missed day', () => {
  assert.deepEqual(
    daysBetween(new Date('2026-09-27T23:00:00Z'), new Date('2026-09-30T08:00:00Z'), 90),
    ['2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30'],
  );
});

test('WooCommerce: webhook signature is verified with HMAC-SHA256', () => {
  const { db, inventory } = setup();
  const woo = new WooCommerceChannel({ config: wooConfig, db, bus: inventory.bus });
  const body = Buffer.from('{"id":1}');
  const good = createHmac('sha256', 'whsec').update(body).digest('base64');
  assert.equal(woo.verifySignature(body, good), true);
  assert.equal(woo.verifySignature(body, createHmac('sha256', 'wrong').update(body).digest('base64')), false);
  assert.equal(woo.verifySignature(body, undefined), false);
});

test('WooCommerce: order statuses decide whether stock is taken or released', () => {
  const { db, inventory } = setup();
  inventory.upsertProduct({ sku: 'TS-1', name: 'Tochtstrip', stock: 10 });
  const woo = new WooCommerceChannel({ config: wooConfig, db, bus: inventory.bus });
  const order = (status) => ({
    id: 55, number: '1055', status, date_created_gmt: '2099-01-01T10:00:00',
    line_items: [{ id: 901, product_id: 77, variation_id: 0, sku: 'TS-1', quantity: 2, name: 'Tochtstrip' }],
  });

  woo.bookOrder(inventory, order('pending'));
  assert.equal(inventory.getProduct('TS-1').stock, 10, 'unpaid order does not take stock');
  woo.bookOrder(inventory, order('processing'));
  assert.equal(inventory.getProduct('TS-1').stock, 8);
  woo.bookOrder(inventory, order('completed'));
  assert.equal(inventory.getProduct('TS-1').stock, 8, 'status change within "sold" statuses does nothing');
  assert.equal(inventory.getProduct('TS-1').woo_product_id, 77, 'webshop product id is linked automatically');
  woo.bookOrder(inventory, order('cancelled'));
  assert.equal(inventory.getProduct('TS-1').stock, 10);
});

test('WooCommerce: stock push targets product or variation', async () => {
  const { db, inventory } = setup();
  const { fetchImpl, calls } = mockFetch([['PUT', /wp-json\/wc\/v3\/products/, () => ({ body: {} })]]);
  const woo = new WooCommerceChannel({ config: wooConfig, db, bus: inventory.bus, fetchImpl });
  await woo.pushStock({ woo_product_id: 5 }, 12);
  await woo.pushStock({ woo_product_id: 5, woo_variation_id: 6 }, -3);
  assert.equal(calls[0].url, 'https://shop.test/wp-json/wc/v3/products/5');
  assert.deepEqual(calls[0].body, { manage_stock: true, stock_quantity: 12 });
  assert.equal(calls[1].url, 'https://shop.test/wp-json/wc/v3/products/5/variations/6');
  assert.equal(calls[1].body.stock_quantity, 0);
});

test('Sync worker: a Bol.com sale ends up in the webshop, failures are retried', async () => {
  const { db, bus, inventory } = setup();
  inventory.upsertProduct({ sku: 'TS-1', name: 'Tochtstrip', stock: 10, woo_product_id: 1, bol_offer_id: 'o' });
  const pushed = [];
  let wooDown = true;
  const channels = [
    { name: 'bol', pushStock: async (p, q) => { pushed.push(['bol', q]); return q; } },
    { name: 'woocommerce', pushStock: async (p, q) => { if (wooDown) throw new Error('503'); pushed.push(['woocommerce', q]); return q; } },
  ];
  const worker = new SyncWorker({ db, bus, channels });

  inventory.recordSale({ channel: 'bol', lineRef: 'x', sku: 'TS-1', quantity: 1 });
  await worker.runOnce();
  assert.deepEqual(pushed, [['bol', 9]]);
  const job = db.prepare("SELECT * FROM sync_queue WHERE channel = 'woocommerce'").get();
  assert.equal(job.attempts, 1);
  assert.match(job.last_error, /503/);

  wooDown = false;
  db.exec("UPDATE sync_queue SET next_attempt_at = '2000-01-01T00:00:00.000Z'");
  await worker.runOnce();
  assert.deepEqual(pushed.at(-1), ['woocommerce', 9]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sync_queue').get().n, 0);
  assert.equal(db.prepare("SELECT stock FROM channel_stock WHERE channel = 'woocommerce'").get().stock, 9);
});

test('WooCommerce import takes over EAN codes when available', async () => {
  const { eanOf } = await import('../src/channels/woocommerce.js');
  const { importFromWooCommerce } = await import('../src/importer.js');
  assert.equal(eanOf({ global_unique_id: '8720618400011' }), '8720618400011');
  assert.equal(eanOf({ global_unique_id: '', meta_data: [{ key: '_alg_ean', value: '8712345678906' }] }), '8712345678906');
  assert.equal(eanOf({ global_unique_id: 'geen-ean', meta_data: [{ key: 'kleur', value: '8712345678906' }] }), null);

  const { inventory } = setup();
  inventory.upsertProduct({ sku: 'B', name: 'Bestaand', ean: '1111111111111', stock: 1 });
  const woo = { listProducts: async () => [
    { sku: 'A', name: 'Nieuw', woo_product_id: 1, woo_variation_id: null, stock: 5, ean: '8720618400011' },
    { sku: 'B', name: 'Bestaand', woo_product_id: 2, woo_variation_id: null, stock: 9, ean: '2222222222222' },
    { sku: 'C', name: 'Dubbel', woo_product_id: 3, woo_variation_id: null, stock: 1, ean: '8720618400011' },
  ] };
  const result = await importFromWooCommerce(inventory, woo);
  assert.equal(inventory.getProduct('A').ean, '8720618400011');
  assert.equal(inventory.getProduct('B').ean, '1111111111111', 'a filled-in EAN is not overwritten');
  assert.equal(inventory.getProduct('C').ean, null, 'duplicate EAN is skipped');
  assert.equal(result.created, 2);
  assert.equal(result.skipped.length, 1);
});

test('Bol: offer export links offers to products by EAN or reference, skipping FBB', async () => {
  const { linkBolOffers } = await import('../src/importer.js');
  const { db, inventory } = setup();
  inventory.upsertProduct({ sku: 'TS-1', name: 'Strip', ean: '8720000000001', stock: 10 });
  inventory.upsertProduct({ sku: 'TS-2', name: 'Borstel', stock: 4 });
  inventory.upsertProduct({ sku: 'TS-3', name: 'Al gekoppeld', ean: '8720000000003', bol_offer_id: 'o3', stock: 1 });
  const csv = [
    'offerId,ean,conditionName,stockAmount,fulfilmentType,referenceCode',
    'o1,8720000000001,NEW,7,FBR,',
    'o2,8720000000002,NEW,3,FBR,TS-2',
    'o3,8720000000003,NEW,1,FBR,TS-3',
    'o4,8720000000004,NEW,12,FBB,',
    'o5,8720000000005,NEW,6,FBR,ALLEEN-BOL',
  ].join('\n');
  let polls = 0;
  const { fetchImpl, calls } = mockFetch([
    ['POST', /token/, () => ({ body: { access_token: 't', expires_in: 299 } })],
    ['POST', /\/retailer\/offers\/export$/, () => ({ status: 202, body: { processStatusId: 'p1', status: 'PENDING' } })],
    ['GET', /\/shared\/process-status\/p1$/, () => ({ body: polls++ ? { status: 'SUCCESS', entityId: 'r1' } : { status: 'PENDING' } })],
    ['GET', /\/retailer\/offers\/export\/r1$/, () => ({ body: csv })],
  ]);
  const bol = new BolChannel({ config: bolConfig, db, bus: inventory.bus, fetchImpl });
  bol.exportOffers = ((orig) => (opts) => orig.call(bol, { ...opts, pollMs: 1 }))(bol.exportOffers);

  const result = await linkBolOffers(inventory, bol);
  assert.deepEqual([result.offers, result.linked, result.alreadyLinked, result.fbb], [5, 2, 1, 1]);
  assert.deepEqual(result.unmatched, [{ ean: '8720000000005', reference: 'ALLEEN-BOL', stock: 6 }]);
  assert.equal(inventory.getProduct('TS-1').bol_offer_id, 'o1');
  assert.equal(inventory.getProduct('TS-2').bol_offer_id, 'o2');
  assert.equal(inventory.getProduct('TS-2').ean, '8720000000002', 'EAN taken over when matched on reference');
  assert.equal(calls.find((c) => c.url.includes('/export/r1')).headers.Accept, 'application/vnd.retailer.v10+csv');
  // Newly linked products are queued to receive the central stock on Bol.com.
  assert.ok(db.prepare("SELECT 1 FROM sync_queue WHERE sku = 'TS-1' AND channel = 'bol'").get());

  const again = await linkBolOffers(inventory, bol, { createMissing: true });
  assert.equal(again.created, 1);
  assert.equal(inventory.getProduct('ALLEEN-BOL').stock, 6);
  assert.equal(inventory.getProduct('ALLEEN-BOL').bol_offer_id, 'o5');
});

test('Safety: unknown stock is never pushed, and a paused webshop pushes nothing', async () => {
  const { db, bus, inventory } = setup();
  const pushed = [];
  const channel = { name: 'woocommerce', pushStock: async (p, q) => { pushed.push([p.sku, q]); return q; } };
  let paused = true;
  const worker = new SyncWorker({ db, bus, channels: [channel], isPaused: () => paused });

  // Imported from WooCommerce without "manage stock": unknown, not 0.
  inventory.upsertProduct({ sku: 'ONBEKEND', name: 'X', stock: 0, woo_product_id: 1, stock_confirmed: false });
  inventory.upsertProduct({ sku: 'GETELD', name: 'Y', stock: 5, woo_product_id: 2 });
  await worker.runOnce();
  assert.deepEqual(pushed, [], 'paused: nothing sent');

  paused = false;
  await worker.runOnce();
  assert.deepEqual(pushed, [['GETELD', 5]], 'unknown stock is skipped');

  inventory.setStock({ sku: 'ONBEKEND', count: 0 });
  assert.equal(inventory.getProduct('ONBEKEND').stock_confirmed, 1, 'a stocktake (even of 0) makes it known');
  await worker.runOnce();
  assert.deepEqual(pushed.at(-1), ['ONBEKEND', 0]);
});

test('WooCommerce import: products without "manage stock" get unknown stock', async () => {
  const { importFromWooCommerce } = await import('../src/importer.js');
  const { inventory } = setup();
  const woo = { listProducts: async () => [
    { sku: 'A', name: 'Beheerd', woo_product_id: 1, woo_variation_id: null, stock: 7 },
    { sku: 'B', name: 'Niet beheerd', woo_product_id: 2, woo_variation_id: null, stock: null },
  ] };
  const result = await importFromWooCommerce(inventory, woo);
  assert.equal(result.uncounted, 1);
  assert.equal(inventory.getProduct('A').stock_confirmed, 1);
  assert.equal(inventory.getProduct('B').stock_confirmed, 0);
});
