import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SyncWorker } from '../src/sync.js';
import { WooCommerceChannel } from '../src/channels/woocommerce.js';
import { forecastAll } from '../src/forecast.js';
import { config } from '../src/config.js';
import { setup, mockFetch } from './helpers.js';

const wooConfig = { ...config.woo, baseUrl: 'https://shop.test', consumerKey: 'ck', consumerSecret: 'cs', webhookSecret: 'whsec' };

test('Dropshipping: always "in stock" in the webshop, sales do not touch stock', async () => {
  const { db, bus, inventory } = setup({ channels: ['woocommerce'] });
  inventory.upsertProduct({ sku: 'PANEEL', name: 'Wandpaneel eiken', woo_product_id: 10, woo_variation_id: 11, stock: 0, stock_confirmed: false, supply: 'dropship' });
  const sale = inventory.recordSale({ channel: 'woocommerce', lineRef: 'w:1', sku: 'PANEEL', quantity: 3 });
  assert.equal(sale.applied, 0, 'history only');
  assert.equal(inventory.getProduct('PANEEL').stock, 0);

  const { fetchImpl, calls } = mockFetch([['PUT', /variations\/11$/, () => ({ body: {} })]]);
  const woo = new WooCommerceChannel({ config: wooConfig, db, bus, fetchImpl });
  const worker = new SyncWorker({ db, bus, channels: [woo], inventory });
  await worker.runOnce();
  assert.deepEqual(calls.at(-1).body, { manage_stock: false, stock_status: 'instock' }, 'pushed although never counted');

  inventory.upsertProduct({ sku: 'PANEEL', available: false });
  await worker.runOnce();
  assert.deepEqual(calls.at(-1).body, { manage_stock: false, stock_status: 'outofstock' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sync_queue').get().n, 0);

  const [f] = forecastAll(db);
  assert.equal(f.forecast.status, 'dropship');
});

test('Samples are cut from a tile: availability and automatic cutting', async () => {
  const { db, bus, inventory } = setup({ channels: ['woocommerce'] });
  inventory.upsertProduct({ sku: 'TEGEL', name: 'Plaktegel Marmer – Per tegel', woo_product_id: 20, woo_variation_id: 21, stock: 10 });
  inventory.upsertProduct({ sku: 'SAMPLE', name: 'Plaktegel Marmer – Sample bestellen', woo_product_id: 20, woo_variation_id: 23, stock: 0, cut_from: 'TEGEL', cut_yield: 4 });
  assert.deepEqual(inventory.availableStock(inventory.getProduct('SAMPLE')), { quantity: 40, known: true });

  // First sample: one tile is cut into 4; 3 loose samples remain.
  inventory.recordSale({ channel: 'woocommerce', lineRef: 'w:s1', sku: 'SAMPLE', quantity: 1 });
  assert.deepEqual([inventory.getProduct('TEGEL').stock, inventory.getProduct('SAMPLE').stock], [9, 3]);
  // Five more: 3 loose + 1 tile cut (4) → 2 loose left.
  inventory.recordSale({ channel: 'woocommerce', lineRef: 'w:s2', sku: 'SAMPLE', quantity: 5 });
  assert.deepEqual([inventory.getProduct('TEGEL').stock, inventory.getProduct('SAMPLE').stock], [8, 2]);
  assert.equal(inventory.availableStock(inventory.getProduct('SAMPLE')).quantity, 34);
  // A cancellation puts the samples back as loose samples.
  inventory.recordSale({ channel: 'woocommerce', lineRef: 'w:s2', sku: 'SAMPLE', quantity: 0 });
  assert.equal(inventory.getProduct('SAMPLE').stock, 7);

  // The webshop gets loose + what can still be cut; a tile sale updates the sample too.
  const { fetchImpl, calls } = mockFetch([['PUT', /variations\/2\d$/, () => ({ body: {} })]]);
  const woo = new WooCommerceChannel({ config: wooConfig, db, bus, fetchImpl });
  const worker = new SyncWorker({ db, bus, channels: [woo], inventory });
  await worker.runOnce();
  const sent = (vid) => calls.filter((c) => c.url.endsWith(`/variations/${vid}`)).at(-1)?.body.stock_quantity;
  assert.equal(sent(23), 7 + 8 * 4);
  inventory.recordSale({ channel: 'woocommerce', lineRef: 'w:t1', sku: 'TEGEL', quantity: 2 });
  await worker.runOnce();
  assert.equal(sent(21), 6);
  assert.equal(sent(23), 7 + 6 * 4);

  // Forecast uses what can be sold.
  const sample = forecastAll(db).find((p) => p.sku === 'SAMPLE');
  assert.equal(sample.sellable, 31);
});

test('Sample settings are validated', () => {
  const { inventory } = setup();
  inventory.upsertProduct({ sku: 'T', name: 'Tegel', stock: 1 });
  inventory.upsertProduct({ sku: 'S', name: 'Sample', stock: 0 });
  assert.throws(() => inventory.upsertProduct({ sku: 'S', cut_from: 'T', cut_yield: 0 }), /hoeveel samples/);
  assert.throws(() => inventory.upsertProduct({ sku: 'S', cut_from: 'S', cut_yield: 4 }), /van zichzelf/);
  assert.throws(() => inventory.upsertProduct({ sku: 'S', cut_from: 'X', cut_yield: 4 }), /Onbekend/);
  inventory.upsertProduct({ sku: 'S', cut_from: 'T', cut_yield: '3' });
  assert.equal(inventory.getProduct('S').cut_yield, 3);
  inventory.upsertProduct({ sku: 'S', cut_from: '' });
  assert.equal(inventory.getProduct('S').cut_from, null);
});

test('Dropshipping per category: samples keep their own stock', async () => {
  const { importFromWooCommerce } = await import('../src/importer.js');
  const { SAMPLE_PATTERN } = await import('../src/packs.js');
  const { inventory } = setup();
  const v = (pid, vid, sku, name, category) => ({ woo_product_id: pid, woo_variation_id: vid, sku, parent_sku: '', options: [], name, category, stock: null });
  await importFromWooCommerce(inventory, { listProducts: async () => [
    v(1, 11, 'WP-1', 'Wandpaneel Eiken – Per paneel', 'Wandpanelen'),
    v(1, 12, 'WP-S', 'Wandpaneel Eiken – Sample bestellen', 'Wandpanelen'),
    v(2, 21, 'PT-1', 'Plaktegel Marmer – Per tegel', 'Plaktegels'),
  ] });
  assert.deepEqual(inventory.categories().map((c) => [c.category, c.products]), [['Plaktegels', 1], ['Wandpanelen', 2]]);
  const r = inventory.setDropshipCategories(['Wandpanelen'], { samplePattern: SAMPLE_PATTERN });
  assert.equal(r.changed, 1);
  assert.deepEqual(['WP-1', 'WP-S', 'PT-1'].map((s) => inventory.getProduct(s).supply), ['dropship', 'stock', 'stock']);
  inventory.setDropshipCategories([], { samplePattern: SAMPLE_PATTERN });
  assert.equal(inventory.getProduct('WP-1').supply, 'stock', 'unchecking the category goes back to own stock');
});

test('Link overview shows dropshipping and samples', async () => {
  const { linkReport } = await import('../src/report.js');
  const { inventory } = setup();
  inventory.upsertProduct({ sku: 'WP', name: 'Wandpaneel – Per paneel', woo_product_id: 1, woo_variation_id: 2, stock: 0, stock_confirmed: false, supply: 'dropship', available: false });
  inventory.upsertProduct({ sku: 'T', name: 'Plaktegel – Per tegel', woo_product_id: 3, woo_variation_id: 4, stock: 10 });
  inventory.upsertProduct({ sku: 'S', name: 'Plaktegel – Sample bestellen', woo_product_id: 3, woo_variation_id: 5, stock: 1, cut_from: 'T', cut_yield: 4 });
  const rows = linkReport(inventory, { hasWoo: true });
  const by = (sku) => rows.find((r) => r.SKU === sku);
  assert.equal(by('WP')['Bestaat uit'], 'Dropshipping – tijdelijk niet leverbaar');
  assert.equal(by('WP')['Let op'], 'Tijdelijk niet leverbaar', 'no "Nog niet geteld" for dropshipping');
  assert.equal(by('S')['Bestaat uit'], 'Sample uit Plaktegel – Per tegel (4 per stuk); 1 los, 41 te verkopen');
});

test('Tile with box of 10 and 3 samples per tile: every sale updates all variations', () => {
  const { inventory } = setup({ channels: ['woocommerce'] });
  inventory.upsertProduct({ sku: 'TEGEL', name: 'Plaktegel – Per tegel', woo_product_id: 1, woo_variation_id: 11, stock: 100 });
  const doos = inventory.saveListing({ name: 'Plaktegel – Per doos van 10 tegels', woo_product_id: 1, woo_variation_id: 12, components: [{ item_sku: 'TEGEL', quantity: 10 }] });
  inventory.upsertProduct({ sku: 'SAMPLE', name: 'Plaktegel – Sample bestellen', woo_product_id: 1, woo_variation_id: 13, stock: 0, cut_from: 'TEGEL', cut_yield: 3 });
  const view = () => {
    const tegels = inventory.getProduct('TEGEL').stock;
    const sample = inventory.getProduct('SAMPLE');
    return [tegels, inventory.availableFor(inventory.getListing(doos.id)).quantity, sample.stock, inventory.availableStock(sample).quantity];
  };
  assert.deepEqual(view(), [100, 10, 0, 300]);
  inventory.recordSale({ channel: 'woocommerce', lineRef: 'o1', sku: 'TEGEL', quantity: 10 });
  assert.deepEqual(view(), [90, 9, 0, 270], '10 tiles sold: one box less');
  inventory.recordListingSale({ channel: 'woocommerce', lineRef: 'o2', listing: inventory.getListing(doos.id), quantity: 1 });
  assert.deepEqual(view(), [80, 8, 0, 240], 'a box takes 10 tiles');
  inventory.recordSale({ channel: 'woocommerce', lineRef: 'o3', sku: 'SAMPLE', quantity: 1 });
  assert.deepEqual(view(), [79, 7, 2, 239], 'a sample cuts one tile; 2 leftovers');
  inventory.recordSale({ channel: 'woocommerce', lineRef: 'o4', sku: 'SAMPLE', quantity: 2 });
  assert.deepEqual(view(), [79, 7, 0, 237], 'next samples come from the leftovers');
});
