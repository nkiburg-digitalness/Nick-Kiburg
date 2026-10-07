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
    ['PUT', /\/retailer\/offers\/o-1\/stock$/, () => ({ status: 202, body: { processStatusId: '1', status: 'PENDING' } })],
    ['GET', /\/shared\/process-status\/1$/, () => ({ body: { processStatusId: '1', status: 'SUCCESS' } })],
    ['PUT', /\/retailer\/offers\/o-bad\/stock$/, () => ({ status: 202, body: { processStatusId: '2', status: 'PENDING' } })],
    ['GET', /\/shared\/process-status\/2$/, () => ({ body: { processStatusId: '2', status: 'FAILURE', errorMessage: 'Offer not found' } })],
  ]);
  const bol = new BolChannel({ config: { ...bolConfig, processPollMs: 1 }, db, bus: inventory.bus, fetchImpl });
  assert.equal(await bol.pushStock({ bol_offer_id: 'o-1' }, 1500), 999);
  const put = calls.find((c) => c.method === 'PUT');
  assert.deepEqual(put.body, { amount: 999, managedByRetailer: true });
  assert.ok(calls.some((c) => c.url.endsWith('/shared/process-status/1')), 'the outcome is checked');
  // A refused update is an error (retried and shown), not a silent success.
  await assert.rejects(bol.pushStock({ bol_offer_id: 'o-bad' }, 5), /niet verwerkt: Offer not found/);
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
  assert.deepEqual(result.unmatched, [{ offerId: 'o5', ean: '8720000000005', reference: 'ALLEEN-BOL', stock: 6, title: null, packSize: null }]);
  assert.equal(inventory.getProduct('TS-1').bol_offer_id, 'o1');
  assert.equal(inventory.getProduct('TS-2').bol_offer_id, 'o2');
  assert.equal(inventory.getProduct('TS-2').ean, '8720000000002', 'EAN taken over when matched on reference');
  assert.equal(calls.find((c) => c.url.includes('/export/r1')).headers.Accept, 'application/vnd.retailer.v10+csv');
  // Newly linked products are queued to receive the central stock on Bol.com.
  assert.ok(db.prepare("SELECT 1 FROM sync_queue WHERE sku = 'TS-1' AND channel = 'bol'").get());

  // Offers that are not in the webshop are never added as products.
  const again = await linkBolOffers(inventory, bol, { createMissing: true });
  assert.equal(again.unmatched.length, 1);
  assert.equal(inventory.getProduct('ALLEEN-BOL'), null);
  assert.equal(inventory.listProducts().length, 3);
});

test('Products not in the webshop can be listed for clean-up', () => {
  const { inventory } = setup();
  inventory.upsertProduct({ sku: 'WEB', name: 'Uit webshop', woo_product_id: 1, stock: 1 });
  inventory.upsertProduct({ sku: 'BOL-871', name: 'Bol.com-product 871', bol_offer_id: 'o9', stock: 4 });
  inventory.upsertProduct({ sku: 'EIGEN', name: 'Zelf aangemaakt', stock: 2 });
  inventory.upsertProduct({ sku: 'BAND-M', name: 'Tochtband (meter)', unit: 'meter', stock: 50 });
  inventory.saveListing({ name: 'Tochtband 10 m', woo_product_id: 2, woo_variation_id: 3, components: [{ item_sku: 'BAND-M', quantity: 10 }] });
  const list = inventory.unlinkedProducts();
  assert.deepEqual(list.map((p) => [p.sku, p.fromBol]), [['BOL-871', true], ['EIGEN', false]], 'webshop products and stock items of listings are left out');
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

test('WooCommerce import: variations without their own SKU each become a product', async () => {
  const { importFromWooCommerce } = await import('../src/importer.js');
  const { db, inventory } = setup();
  // State left by an earlier import: three colour variations reported the parent SKU
  // "TS" and ended up as one product, with order history from all three.
  inventory.upsertProduct({ sku: 'TS', name: 'Tochtstrip – Wit', woo_product_id: 10, woo_variation_id: 103, stock: 0, stock_confirmed: false });
  inventory.recordSale({ channel: 'woocommerce', lineRef: 'woocommerce:order-item:1', sku: 'TS', quantity: 2, applyToStock: false });

  const variation = (id, options, sku, parent = 'TS', pid = 10) => ({
    woo_product_id: pid, woo_variation_id: id, sku, parent_sku: parent, options,
    name: `${pid === 10 ? 'Tochtstrip' : 'Tochtband'} – ${options.join(', ')}`, stock: null,
  });
  const woo = { listProducts: async () => [
    variation(101, ['Wit'], 'TS'),
    variation(102, ['Zwart'], 'TS'),
    variation(103, ['Grijs'], 'TS'),
    variation(201, ['Zwart', '5 m'], '', '', 20),
    variation(202, ['Zwart', '10 m'], '', '', 20),
    variation(301, ['Grijs'], 'ROL-GRIJS', 'ROL', 30),
  ] };
  const result = await importFromWooCommerce(inventory, woo);

  assert.equal(inventory.getProduct('TS'), null, 'the merged product is split off');
  assert.deepEqual(result.repaired, ['Tochtstrip – Grijs']);
  const grijs = inventory.getProduct('TS-GRIJS');
  assert.equal(grijs.woo_variation_id, 103);
  assert.equal(grijs.name, 'Tochtstrip – Grijs');
  assert.equal(grijs.stock_confirmed, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM stock_movements WHERE type = 'sale'").get().n, 0, 'history is dropped so it can be read in again');
  assert.equal(inventory.getProduct('TS-WIT').woo_variation_id, 101);
  assert.equal(inventory.getProduct('TS-ZWART').woo_variation_id, 102);
  assert.equal(inventory.getProduct('WOO-20-ZWART-5-M').woo_variation_id, 201);
  assert.equal(inventory.getProduct('WOO-20-ZWART-10-M').woo_variation_id, 202);
  assert.equal(inventory.getProduct('ROL-GRIJS').woo_variation_id, 301, 'own SKUs are kept');
  assert.equal(result.generatedSkus, 5);
  assert.equal(result.skipped.length, 0);

  // A second import changes nothing, and an order line with the parent SKU is booked
  // on the right colour (by variation id).
  const again = await importFromWooCommerce(inventory, woo);
  assert.deepEqual([again.created, again.updated, again.repaired.length], [0, 6, 0]);
  assert.equal(inventory.findProduct({ sku: 'TS', wooProductId: 10, wooVariationId: 102 }).sku, 'TS-ZWART');
});

test('History import: a year from the webshop, at most 90 days from Bol.com', async () => {
  const { db, inventory } = setup();
  inventory.upsertProduct({ sku: 'A', name: 'A', woo_product_id: 1, stock: 10 });
  const now = new Date('2026-10-05T12:00:00Z');
  const { fetchImpl, calls } = mockFetch([
    ['POST', /token/, () => ({ body: { access_token: 't', expires_in: 299 } })],
    ['GET', /\/retailer\/orders/, () => ({ body: { orders: [] } })],
    ['GET', /\/wc\/v3\/orders/, () => ({ body: [], headers: { 'x-wp-totalpages': '1' } })],
  ]);
  const bol = new BolChannel({ config: bolConfig, db, bus: inventory.bus, fetchImpl });
  await bol.backfill(inventory, 365, now);
  assert.equal(calls.filter((c) => c.url.includes('/retailer/orders')).length, 90);

  const woo = new WooCommerceChannel({ config: wooConfig, db, bus: inventory.bus, fetchImpl });
  await woo.backfill(inventory, 365, now);
  const after = new URL(calls.find((c) => c.url.includes('/wc/v3/orders')).url).searchParams.get('after');
  assert.equal(after.slice(0, 10), '2025-10-05');
});

test('Shared Bol.com account: orders and offers of the other webshop are left alone', async () => {
  const { db, inventory, logs } = setup();
  // Tochtstripdeur: a tochtstrip with SKU "1st". Plakspiegels (same Bol account) sells EAN ...0099.
  inventory.upsertProduct({ sku: '1st', name: 'Tochtstrip wit – 1 stuk', ean: '8720000000001', stock: 50 });
  const knownElsewhere = ({ offerId, ean }) => (offerId === 'o-spiegel' || ean === '8720000000099' ? 'Plakspiegels.nl' : null);
  setKv(db, 'bol:last_poll', new Date(Date.now() - 60_000).toISOString());
  const csv = [
    'offerId,ean,conditionName,stockAmount,fulfilmentType,referenceCode',
    'o-strip,8720000000001,NEW,7,FBR,1st',
    'o-spiegel,8720000000099,NEW,3,FBR,1st', // same reference "1st", other webshop
    'o-new,8720000000098,NEW,3,FBR,1st', // reference "1st" but a different EAN: not the tochtstrip
  ].join('\n');
  let polls = 0;
  const { fetchImpl, calls } = mockFetch([
    ['POST', /token/, () => ({ body: { access_token: 't', expires_in: 299 } })],
    ['GET', /\/retailer\/orders\?/, () => ({ body: { orders: [bolOrder('B1', [['item-9', '8720000000099', 1]])] } })],
    ['POST', /\/retailer\/offers\/export$/, () => ({ status: 202, body: { processStatusId: 'p1', status: 'PENDING' } })],
    ['GET', /\/shared\/process-status\/p1$/, () => ({ body: polls++ ? { status: 'SUCCESS', entityId: 'r1' } : { status: 'PENDING' } })],
    ['GET', /\/retailer\/offers\/export\/r1$/, () => ({ body: csv })],
    ['GET', /\/retailer\/content\/catalog-products\/8720000000098$/, () => ({ body: { attributes: [{ id: 'Title', values: [{ value: 'Tochtstrip wit – set van 4' }] }] } })],
  ]);
  const bol = new BolChannel({ config: bolConfig, db, bus: inventory.bus, fetchImpl, knownElsewhere });
  bol.exportOffers = ((orig) => (opts) => orig.call(bol, { ...opts, pollMs: 1 }))(bol.exportOffers);

  // An order of the other webshop: no warning, no order-detail request, no stock change.
  assert.equal(await bol.poll(inventory), 0);
  assert.equal(logs.filter((l) => l.level === 'warn').length, 0);
  assert.equal(calls.some((c) => /\/retailer\/orders\/B1$/.test(c.url)), false);

  const { linkBolOffers } = await import('../src/importer.js');
  const result = await linkBolOffers(inventory, bol);
  assert.equal(inventory.getProduct('1st').bol_offer_id, 'o-strip');
  assert.deepEqual([result.linked, result.otherShop, result.otherShops], [1, 1, ['Plakspiegels.nl']]);
  assert.deepEqual(result.unmatched.map((u) => u.offerId), ['o-new'], 'a matching reference with another EAN is not linked');
  assert.deepEqual([result.unmatched[0].title, result.unmatched[0].packSize], ['Tochtstrip wit – set van 4', 4]);
  assert.equal(calls.find((c) => c.url.includes('catalog-products')).headers['Accept-Language'], 'nl');
});

test('Webshops with the same Bol.com credentials know each other', async () => {
  const { createApp } = await import('../src/app.js');
  const app = createApp({ ...config, dbFile: ':memory:', demoMode: false, secretKey: 'k', legacyShop: null, adminEmail: null }, { fetchImpl: async () => new Response('{}') });
  app.shops.create({ id: 'tsd', name: 'Tochtstripdeur.nl', bol_client_id: 'same', bol_client_secret: 's' });
  app.shops.create({ id: 'ps', name: 'Plakspiegels.nl', bol_client_id: 'same', bol_client_secret: 's' });
  app.shops.create({ id: 'other', name: 'Ander account', bol_client_id: 'different', bol_client_secret: 's' });
  app.shops.get('ps').inventory.upsertProduct({ sku: 'SP-1', name: 'Plakspiegel', ean: '8720000000099', stock: 3 });
  assert.deepEqual(app.shops.bolPeers('tsd').map((rt) => rt.id), ['ps']);
  assert.equal(app.shops.get('tsd').channels.bol.knownElsewhere({ ean: '8720000000099' }), 'Plakspiegels.nl');
  assert.equal(app.shops.get('other').channels.bol.knownElsewhere({ ean: '8720000000099' }), null);
  app.stop?.();
});

test('Pack size is read from a Bol.com title', async () => {
  const { packSizeFromTitle } = await import('../src/importer.js');
  assert.equal(packSizeFromTitle('Plakspiegel rond 30 cm - Set van 4'), 4);
  assert.equal(packSizeFromTitle('Spiegeltegels 6 stuks zelfklevend'), 6);
  assert.equal(packSizeFromTitle('Tochtstopper 2-pack grijs'), 2);
  assert.equal(packSizeFromTitle('Tochtstrip 100 x 4,5 cm'), null, 'dimensions are not a pack size');
  assert.equal(packSizeFromTitle('Plakspiegel 1 stuk'), null);
  assert.equal(packSizeFromTitle(null), null);
});

test('Bol history import reports what it found: new, already there, other webshop, unknown', async () => {
  const { db, inventory } = setup();
  inventory.upsertProduct({ sku: 'R20', name: 'Plakspiegel rond 20 – 1 stuk', stock: 84 });
  inventory.saveListing({ name: 'Rond 20 – set van 4', ean: '8720000000004', bol_offer_id: 'o4', components: [{ item_sku: 'R20', quantity: 4 }] });
  const now = new Date('2026-10-07T12:00:00Z');
  const order = bolOrder('C1', [['l1', '8720000000004', 2], ['l2', '8720000000099', 1], ['l3', '8719999999999', 1]]);
  order.orderPlacedDateTime = '2026-09-01T10:00:00Z';
  let served = false;
  const { fetchImpl } = mockFetch([
    ['POST', /token/, () => ({ body: { access_token: 't', expires_in: 299 } })],
    ['GET', /\/retailer\/orders\?/, () => {
      const orders = served ? [] : [order];
      served = true;
      return { body: { orders } };
    }],
  ]);
  const bol = new BolChannel({ config: bolConfig, db, bus: inventory.bus, fetchImpl, knownElsewhere: ({ ean }) => (ean === '8720000000099' ? 'Tochtstripdeur.nl' : null) });
  const r = await bol.backfill(inventory, 365, now);
  assert.deepEqual([r.orders, r.lines, r.booked, r.otherShop, r.unknown, r.unknownEans, r.days], [1, 3, 1, 1, 1, ['8719999999999'], 90]);
  // History of the set: 2 sets = 8 pieces, without touching the stock.
  const moves = db.prepare("SELECT delta, applied FROM stock_movements WHERE sku = 'R20' AND type = 'sale'").all();
  assert.deepEqual(moves.map((m) => [m.delta, m.applied]), [[-8, 0]]);
  assert.equal(inventory.getProduct('R20').stock, 84);

  served = false;
  const again = await bol.backfill(inventory, 365, now);
  assert.equal(again.booked, 0, 'already read in: nothing new');
  assert.equal(again.lines, 3);
});

test('Bol: a rate limit (429) is waited out and retried', async () => {
  const { db, inventory } = setup();
  let tries = 0;
  const { fetchImpl } = mockFetch([
    ['POST', /token/, () => ({ body: { access_token: 't', expires_in: 299 } })],
    ['GET', /\/retailer\/orders\?/, () => (++tries < 3 ? { status: 429, body: { detail: 'Too many requests' }, headers: { 'retry-after': '2' } } : { body: { orders: [] } })],
  ]);
  const bol = new BolChannel({ config: { ...bolConfig, retryScale: 0.001 }, db, bus: inventory.bus, fetchImpl });
  assert.deepEqual(await bol.listOrders({ status: 'ALL' }), []);
  assert.equal(tries, 3);
});
