import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestPacks, applyPacks } from '../src/packs.js';
import { setup } from './helpers.js';

function importedShop() {
  const ctx = setup();
  const add = (sku, name, pid, vid, stock = 0, extra = {}) => ctx.inventory.upsertProduct({ sku, name, woo_product_id: pid, woo_variation_id: vid, stock, ...extra });
  add('TS-1', 'Tochtstrip wit – 1 stuk', 10, 11, 120);
  add('TS-2', 'Tochtstrip wit – 2 stuks', 10, 12, 5);
  add('TS-4', 'Tochtstrip wit – 4 st.', 10, 14, 3);
  add('TB-W5', 'Tochtband – Wit, 5 m', 20, 21);
  add('TB-W10', 'Tochtband – Wit, 10 m', 20, 22, 0, { ean: '8720000000010', bol_offer_id: 'bol-wit-10' });
  add('TB-Z5', 'Tochtband – Zwart, 5 meter', 20, 23);
  add('TB-Z15', 'Tochtband – Zwart, 15 m', 20, 24);
  add('GS-305', 'Garagestrip – 305 cm', 30, 31, 8);
  add('GS-610', 'Garagestrip – 610 cm', 30, 32, 4);
  add('STOP-2', 'Tochtstopper – 2-pack', 40, 41);
  add('STOP-4', 'Tochtstopper – Set van 4', 40, 42);
  return ctx;
}

test('recognises packs and metres per colour, and leaves centimetres alone', () => {
  const { inventory } = importedShop();
  const groups = suggestPacks(inventory);
  const byTitle = Object.fromEntries(groups.map((g) => [g.title, g]));
  assert.deepEqual(Object.keys(byTitle).sort(), ['Tochtband, Wit', 'Tochtband, Zwart', 'Tochtstopper', 'Tochtstrip wit']);
  assert.equal(byTitle['Tochtstrip wit'].base.sku, 'TS-1', 'the 1-piece variation is the stock item');
  assert.deepEqual(byTitle['Tochtstrip wit'].variants.map((v) => [v.sku, v.quantity]), [['TS-2', 2], ['TS-4', 4]]);
  assert.equal(byTitle['Tochtband, Wit'].unit, 'meter');
  assert.equal(byTitle['Tochtband, Wit'].base.existing, false);
  assert.deepEqual(byTitle['Tochtband, Zwart'].variants.map((v) => v.quantity), [5, 15]);
  assert.equal(byTitle.Tochtstopper.base.existing, false, 'no single piece sold: a new "per stuk" item');
  assert.ok(!groups.some((g) => g.title.startsWith('Garagestrip')), 'cm variations are separate products');
});

test('applying turns variations into listings of one stock item', () => {
  const { inventory } = importedShop();
  const groups = suggestPacks(inventory);
  const result = applyPacks(inventory, groups.map((g) => g.key));
  assert.equal(result.errors.length, 0, result.errors.join('; '));
  assert.equal(result.groups, 4);
  assert.equal(result.newItems, 3);

  assert.equal(inventory.getProduct('TS-2'), null);
  assert.equal(inventory.findListing({ wooProductId: 10, wooVariationId: 14 }).components[0].quantity, 4);
  const wit = groups.find((g) => g.title === 'Tochtband, Wit').base.sku;
  assert.equal(inventory.getProduct(wit).unit, 'meter');
  assert.equal(inventory.getProduct(wit).stock_confirmed, 0, 'new metre item must be counted first');
  const bolListing = inventory.findListing({ ean: '8720000000010' });
  assert.equal(bolListing.bol_offer_id, 'bol-wit-10', 'Bol.com link moves along');
  assert.deepEqual(bolListing.components.map((c) => [c.item_sku, c.quantity]), [[wit, 10]]);
  assert.ok(inventory.getProduct('GS-305') && inventory.getProduct('GS-610'), 'garage strips untouched');
  assert.equal(suggestPacks(inventory).length, 0, 'nothing left to suggest');
});
