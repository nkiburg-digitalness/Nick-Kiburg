import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeForecast, forecastAll } from '../src/forecast.js';
import { setup } from './helpers.js';

const NOW = new Date('2026-09-30T12:00:00Z');

test('days until sold out = stock / average sales per day', () => {
  const f = computeForecast({
    stock: 60, dailySales: new Array(30).fill(2), trackedDays: 100, leadTimeDays: 14, safetyDays: 7, now: NOW,
  });
  assert.equal(f.avgPerDay, 2);
  assert.equal(f.daysLeft, 30);
  assert.equal(f.soldOutDate, '2026-10-30');
  assert.equal(f.orderByDate, '2026-10-09'); // 30 − 14 − 7 = 9 days from now
  assert.equal(f.reorderPoint, 42);
  assert.equal(f.orderAdvice, 2 * (21 + 60) - 60);
  assert.equal(f.status, 'ok');
});

test('status follows lead time and safety margin', () => {
  const base = { dailySales: new Array(30).fill(1), trackedDays: 100, leadTimeDays: 10, safetyDays: 5, now: NOW };
  assert.equal(computeForecast({ ...base, stock: 20 }).status, 'ok');
  assert.equal(computeForecast({ ...base, stock: 14 }).status, 'warning');
  assert.equal(computeForecast({ ...base, stock: 9 }).status, 'critical');
  assert.equal(computeForecast({ ...base, stock: 0 }).status, 'out');
});

test('no sales means no sell-out date', () => {
  const f = computeForecast({ stock: 5, dailySales: new Array(30).fill(0), trackedDays: 100, leadTimeDays: 14, safetyDays: 7 });
  assert.equal(f.daysLeft, null);
  assert.equal(f.soldOutDate, null);
  assert.equal(f.status, 'ok');
});

test('new products are averaged over their tracked days (with a minimum)', () => {
  const sales = [...new Array(20).fill(0), ...new Array(10).fill(3)];
  const f = computeForecast({ stock: 30, dailySales: sales, trackedDays: 10, leadTimeDays: 14, safetyDays: 7 });
  assert.equal(f.sellingDays, 10);
  assert.equal(f.avgPerDay, 3);
  const early = computeForecast({ stock: 30, dailySales: [0, 0, 0, 0, 0, 0, 4], trackedDays: 1, leadTimeDays: 14, safetyDays: 7 });
  assert.equal(early.sellingDays, 7); // minTrackedDays
});

test('days on which the product was sold out do not dilute the average', () => {
  const sales = [...new Array(20).fill(2), ...new Array(10).fill(0)];
  const outOfStock = [...new Array(20).fill(false), ...new Array(10).fill(true)];
  const f = computeForecast({ stock: 0, dailySales: sales, outOfStockDays: outOfStock, trackedDays: 100, leadTimeDays: 14, safetyDays: 7 });
  assert.equal(f.sellingDays, 20);
  assert.equal(f.avgPerDay, 2);
});

test('forecastAll reads the ledger, including history-only sales', () => {
  const { db, inventory } = setup();
  inventory.upsertProduct({ sku: 'A', name: 'A', stock: 50 });
  db.prepare("UPDATE products SET created_at = '2026-06-01T00:00:00.000Z'").run();
  db.prepare("UPDATE stock_movements SET created_at = '2026-06-01T00:00:00.000Z'").run(); // opening stock
  for (let d = 0; d < 10; d++) {
    const day = new Date(NOW.getTime() - d * 86400000).toISOString();
    inventory.recordSale({ channel: d % 2 ? 'bol' : 'woocommerce', lineRef: `l${d}`, sku: 'A', quantity: 3, occurredAt: day, applyToStock: d > 4 });
  }
  const [a] = forecastAll(db, { windowDays: 30, now: NOW });
  assert.equal(a.forecast.unitsSold, 30);
  assert.equal(a.forecast.avgPerDay, 1);
  assert.equal(a.stock, 50 - 15);
  assert.equal(a.channelSplit.bol + a.channelSplit.woocommerce, 30);
});

test('CSV import parses semicolons and quoted fields', async () => {
  const { parseCsv } = await import('../scripts/import-csv.js');
  const rows = parseCsv('sku;name;stock\r\nA;"Strip; wit ""extra""";5\nB;Borstel;\n');
  assert.deepEqual(rows, [
    { sku: 'A', name: 'Strip; wit "extra"', stock: '5' },
    { sku: 'B', name: 'Borstel', stock: '' },
  ]);
});
