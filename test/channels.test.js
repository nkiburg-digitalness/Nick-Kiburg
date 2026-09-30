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
