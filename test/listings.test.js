import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WooCommerceChannel } from '../src/channels/woocommerce.js';
import { BolChannel } from '../src/channels/bol.js';
import { SyncWorker } from '../src/sync.js';
import { config } from '../src/config.js';
import { setup, mockFetch } from './helpers.js';

const wooConfig = { ...config.woo, baseUrl: 'https://shop.test', consumerKey: 'ck', consumerSecret: 'cs', webhookSecret: 'whsec' };
const bolConfig = { ...config.bol, clientId: 'id', clientSecret: 'secret', fulfilmentMethod: 'FBR' };

function wooOrder(id, status, lines) {
  return {
    id, number: String(id), status, date_created_gmt: '2099-01-01T10:00:00',
    line_items: lines.map(([lineId, productId, variationId, quantity]) => ({ id: lineId, product_id: productId, variation_id: variationId, quantity, sku: '', name: 'x' })),
  };
}

/** Stock items + listings like tochtstripdeur.nl: packs of 2/4, tape per metre, packages. */
function shop() {
  const ctx = setup();
  const { inventory } = ctx;
  inventory.upsertProduct({ sku: 'STRIP-WIT', name: 'Tochtstrip wit', stock: 100, woo_product_id: 10, woo_variation_id: 11 }); // "1 stuk" variation
  inventory.upsertProduct({ sku: 'BAND-WIT', name: 'Tochtband wit', unit: 'meter', stock: 2000 });
  inventory.saveListing({ name: 'Tochtstrip wit – 2 stuks', woo_product_id: 10, woo_variation_id: 12, components: [{ item_sku: 'STRIP-WIT', quantity: 2 }] });
  inventory.saveListing({ name: 'Tochtstrip wit – 4 stuks', woo_product_id: 10, woo_variation_id: 14, components: [{ item_sku: 'STRIP-WIT', quantity: 4 }] });
  for (const m of [5, 10, 15]) {
    inventory.saveListing({ name: `Tochtband wit ${m} m`, woo_product_id: 20, woo_variation_id: 20 + m, components: [{ item_sku: 'BAND-WIT', quantity: m }] });
  }
  inventory.saveListing({ name: 'Tochtband wit 10 m (Bol)', ean: '8720000000010', components: [{ item_sku: 'BAND-WIT', quantity: 10 }] });
  inventory.saveListing({ name: 'Tochtvrij pakket wit', woo_product_id: 30, components: [{ item_sku: 'STRIP-WIT', quantity: 1 }, { item_sku: 'BAND-WIT', quantity: 5 }] });
  ctx.db.exec('DELETE FROM sync_queue; DELETE FROM listing_sync_queue;');
  return ctx;
}

test('a sold pack of 2 or 4 lowers the stock item by 2 or 4 per pack', () => {
  const { db, inventory } = shop();
  const woo = new WooCommerceChannel({ config: wooConfig, db, bus: inventory.bus });
  woo.bookOrder(inventory, wooOrder(1, 'processing', [[501, 10, 12, 1], [502, 10, 14, 2], [503, 10, 11, 3]]));
  assert.equal(inventory.getProduct('STRIP-WIT').stock, 100 - 2 - 8 - 3);
  // Cancelling gives it all back.
  woo.bookOrder(inventory, wooOrder(1, 'cancelled', [[501, 10, 12, 1], [502, 10, 14, 2], [503, 10, 11, 3]]));
  assert.equal(inventory.getProduct('STRIP-WIT').stock, 100);
});

test('tape is kept in metres: 5/10/15 m variations and the Bol.com 10 m offer', async () => {
  const { db, inventory } = shop();
  const woo = new WooCommerceChannel({ config: wooConfig, db, bus: inventory.bus });
  woo.bookOrder(inventory, wooOrder(2, 'processing', [[601, 20, 25, 1], [602, 20, 35, 2]])); // 5 m + 2 × 15 m
  assert.equal(inventory.getProduct('BAND-WIT').stock, 2000 - 5 - 30);

  const { fetchImpl } = mockFetch([
    ['POST', /token/, () => ({ body: { access_token: 't', expires_in: 299 } })],
    ['GET', /\/retailer\/orders\?/, () => ({ body: { orders: [{ orderId: 'B1', orderPlacedDateTime: '2099-01-01T10:00:00Z', orderItems: [{ orderItemId: 'bi1', ean: '8720000000010', quantity: 3, quantityCancelled: 0, fulfilmentMethod: 'FBR' }] }] } })],
    ['GET', /\/retailer\/orders\/B1$/, () => ({ body: { orderItems: [{ orderItemId: 'bi1', offer: { offerId: 'offer-band-10' } }] } })],
  ]);
  const bol = new BolChannel({ config: bolConfig, db, bus: inventory.bus, fetchImpl });
  await bol.poll(inventory);
  assert.equal(inventory.getProduct('BAND-WIT').stock, 1965 - 30, '3 × 10 m via Bol.com');
  assert.equal(inventory.findListing({ ean: '8720000000010' }).bol_offer_id, 'offer-band-10', 'offer linked from the order');
});

test('a package lowers both the strip and the tape', () => {
  const { db, inventory } = shop();
  const woo = new WooCommerceChannel({ config: wooConfig, db, bus: inventory.bus });
  woo.bookOrder(inventory, wooOrder(3, 'completed', [[701, 30, 0, 2]]));
  assert.equal(inventory.getProduct('STRIP-WIT').stock, 98);
  assert.equal(inventory.getProduct('BAND-WIT').stock, 1990);
});

test('availability per listing is pushed: stock ÷ amount, lowest component, Bol.com capped at 999', async () => {
  const { db, bus, inventory } = shop();
  const pushed = {};
  const record = (name) => async (target, q) => {
    const key = target.sku ?? target.name;
    pushed[`${name}:${key}`] = q;
    return name === 'bol' ? Math.min(999, q) : q;
  };
  const worker = new SyncWorker({ db, bus, channels: [{ name: 'woocommerce', pushStock: record('woocommerce') }, { name: 'bol', pushStock: record('bol') }] });
  inventory.linkListingOffer(inventory.findListing({ ean: '8720000000010' }).id, 'offer-band-10');
  inventory.setStock({ sku: 'BAND-WIT', count: 12345 });
  inventory.setStock({ sku: 'STRIP-WIT', count: 7 });
  await worker.runOnce();
  assert.equal(pushed['woocommerce:Tochtband wit 5 m'], 2469);
  assert.equal(pushed['woocommerce:Tochtband wit 15 m'], 823);
  assert.equal(pushed['bol:Tochtband wit 10 m (Bol)'], 1234, 'the channel caps it');
  assert.equal(db.prepare("SELECT stock FROM listing_stock ls JOIN listings l ON l.id = ls.listing_id WHERE l.name = 'Tochtband wit 10 m (Bol)'").get().stock, 999);
  assert.equal(pushed['woocommerce:Tochtstrip wit – 2 stuks'], 3);
  assert.equal(pushed['woocommerce:Tochtstrip wit – 4 stuks'], 1);
  assert.equal(pushed['woocommerce:Tochtvrij pakket wit'], 7, 'lowest of 7 strips and 2469 × 5 m');
  assert.equal(pushed['woocommerce:STRIP-WIT'], 7, 'the "1 stuk" variation is the stock item itself');
});

test('Bol.com stock push never exceeds 999', async () => {
  const { db, inventory } = setup();
  const { fetchImpl, calls } = mockFetch([
    ['POST', /token/, () => ({ body: { access_token: 't', expires_in: 299 } })],
    ['PUT', /\/stock$/, () => ({ status: 202, body: {} })],
  ]);
  const bol = new BolChannel({ config: bolConfig, db, bus: inventory.bus, fetchImpl });
  assert.equal(await bol.pushStock({ bol_offer_id: 'x' }, 2500), 999);
  assert.equal(calls.find((c) => c.method === 'PUT').body.amount, 999);
});

test('converting an imported variation product into a listing', () => {
  const { inventory } = setup();
  inventory.upsertProduct({ sku: 'BAND-ZWART', name: 'Tochtband zwart', unit: 'meter', stock: 500 });
  inventory.upsertProduct({ sku: 'TB-Z-10', name: 'Tochtband zwart – 10 m', stock: 0, woo_product_id: 40, woo_variation_id: 41, ean: '871', stock_confirmed: false });
  assert.throws(() => inventory.saveListing({ name: 'x', woo_product_id: 40, woo_variation_id: 41, components: [{ item_sku: 'BAND-ZWART', quantity: 10 }] }), /al gekoppeld aan voorraadartikel TB-Z-10/);
  const listing = inventory.saveListing({
    name: 'Tochtband zwart – 10 m', sku: 'TB-Z-10', ean: '871', woo_product_id: 40, woo_variation_id: 41,
    components: [{ item_sku: 'BAND-ZWART', quantity: 10 }], replace_product: 'TB-Z-10',
  });
  assert.equal(inventory.getProduct('TB-Z-10'), null, 'the variation is no longer a stock item');
  assert.equal(inventory.findListing({ wooProductId: 40, wooVariationId: 41 }).id, listing.id);
  assert.deepEqual(inventory.availableFor(listing), { quantity: 50, known: true });
});

test('Link overview lists stock items, listings and unlinked Bol.com offers', async () => {
  const { linkReport, reportToCsv } = await import('../src/report.js');
  const { inventory } = setup();
  inventory.upsertProduct({ sku: 'TS-WIT', name: 'Tochtstrip wit', woo_product_id: 1, woo_variation_id: 11, ean: '8710000000011', bol_offer_id: 'b1', stock: 20 });
  inventory.upsertProduct({ sku: 'TS-ZWART', name: 'Tochtstrip zwart', woo_product_id: 1, woo_variation_id: 12, stock: 0, stock_confirmed: false });
  inventory.upsertProduct({ sku: 'BAND-M', name: 'Tochtband (meter)', unit: 'meter', stock: 100 });
  inventory.saveListing({ name: 'Tochtband 10 m (Bol)', ean: '8710000000099', components: [{ item_sku: 'BAND-M', quantity: 10 }] });
  const rows = linkReport(inventory, { hasWoo: true, hasBol: true, bolUnmatched: [{ ean: '8719999999999', reference: 'X', stock: 4 }] });
  const by = (name) => rows.find((r) => r.Naam === name);
  assert.equal(by('Tochtstrip wit')['Let op'], '');
  assert.match(by('Tochtstrip zwart')['Let op'], /Nog niet geteld/);
  assert.match(by('Tochtstrip zwart')['Let op'], /Geen EAN/);
  assert.equal(by('Tochtband (meter)')['Let op'], '', 'a stock item used by a listing is not "missing from the webshop"');
  assert.equal(by('Tochtband 10 m (Bol)').Voorraad, 10);
  assert.match(by('Tochtband 10 m (Bol)')['Let op'], /Bol-aanbieding nog niet gevonden/);
  assert.equal(rows.at(-1).Soort, 'Bol-aanbieding zonder product');
  assert.match(reportToCsv(rows), /^﻿Soort;SKU;Naam/);
});

test('Link overview flags a set whose amount does not match its name', async () => {
  const { linkReport } = await import('../src/report.js');
  const { inventory } = setup();
  inventory.upsertProduct({ sku: 'ROND20', name: 'Plakspiegel rond 20 cm – 1 stuk', stock: 84 });
  inventory.saveListing({ name: 'Glazen Plakspiegels Rond 20 cm – Set van 4 – Echt Glas', ean: '8710000000001', components: [{ item_sku: 'ROND20', quantity: 1 }] });
  inventory.saveListing({ name: 'Plakspiegels Rond 20 cm – 2 stuks', ean: '8710000000002', components: [{ item_sku: 'ROND20', quantity: 2 }] });
  const rows = linkReport(inventory, { hasBol: true });
  assert.match(rows.find((r) => r.Naam.includes('Set van 4'))['Let op'], /de naam zegt 4 stuks, maar per verkoop gaat er 1 af/);
  assert.doesNotMatch(rows.find((r) => r.Naam.includes('2 stuks'))['Let op'], /Controleer het aantal/);
});

test('Bol.com title → suggested webshop product (colour and size must match)', async () => {
  const { bestMatch } = await import('../src/importer.js');
  const products = [
    'Koelmat Hond & Kat – Roze, L', 'Koelmat Hond & Kat – Roze, XL', 'Koelmat Hond & Kat – Blauw, L',
    'Koelmat Hond & Kat – Roze, M', 'Waterkoelmat Hond & Kat – Grijs, Large', 'Waterkoelmat Hond & Kat – Wit, Large',
  ].map((name, i) => ({ sku: `K${i}`, name }));
  const title = (t) => bestMatch(t, products)?.name ?? null;
  assert.equal(title('Koelmat Hond & Kat | Roze L | 70x55 cm | Verkoelingsmat Zonder Giftige Gel | Anti-Slip | Wasbaar'), 'Koelmat Hond & Kat – Roze, L');
  assert.equal(title('Koelmat Hond & Kat | Roze XL | 100x70 cm | Verkoelingsmat Zonder Giftige Gel'), 'Koelmat Hond & Kat – Roze, XL');
  assert.equal(title('Waterkoelmat Hond & Kat | Wit Large | 50x60 cm | Koelmat Met Water'), 'Waterkoelmat Hond & Kat – Wit, Large');
  assert.equal(title('Koelmat Hond & Kat | Antraciet XL | 100x70 cm'), null, 'no colour match: no suggestion');
  assert.equal(title(null), null);
});

test('Bol.com title "70x55" matches webshop variation "70 x 55 cm"', async () => {
  const { bestMatch } = await import('../src/importer.js');
  const products = ['Koelmat - Roze – L - 70 x 55 cm', 'Koelmat - Roze – XL - 100 x 70 cm', 'Koelmat - Blauw – L - 70 x 55 cm', 'Koelmat - Roze – M - 60 x 50 cm']
    .map((name, i) => ({ sku: `K${i}`, name }));
  assert.equal(bestMatch('Koelmat Hond & Kat | Roze L | 70x55 cm | Verkoelingsmat Zonder Giftige Gel | Anti-Slip | Wasbaar', products)?.name, 'Koelmat - Roze – L - 70 x 55 cm');
  assert.equal(bestMatch('Koelmat Hond & Kat | Roze XL | 100x70 cm | Verkoelingsmat', products)?.name, 'Koelmat - Roze – XL - 100 x 70 cm');
});
