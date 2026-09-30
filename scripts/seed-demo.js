/**
 * Fills a fresh demo database with example products and ~90 days of sales history,
 * so the dashboard and forecasts can be explored without any API keys.
 *   npm run demo        (seed + start in demo mode)
 */
import { rmSync } from 'node:fs';
import { config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { setKv } from '../src/db.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY_DAYS = 90;

// [sku, name, ean, stock, sales/day Bol, sales/day webshop, lead time, safety]
const PRODUCTS = [
  ['TSD-BOR-093-WIT', 'Tochtstrip deur borstel 93 cm wit', '8720618400011', 46, 2.1, 1.3, 14, 7],
  ['TSD-BOR-093-BRN', 'Tochtstrip deur borstel 93 cm bruin', '8720618400028', 118, 0.9, 0.6, 14, 7],
  ['TSD-VAL-083-ALU', 'Valdorpel automatisch 83 cm aluminium', '8720618400035', 12, 0.8, 0.7, 21, 7],
  ['TSD-VAL-098-ALU', 'Valdorpel automatisch 98 cm aluminium', '8720618400042', 64, 0.5, 0.4, 21, 7],
  ['TSD-RUB-P10-ZWT', 'Tochtstrip rubber P-profiel zelfklevend 10 m zwart', '8720618400059', 310, 3.4, 2.2, 10, 5],
  ['TSD-RUB-E06-WIT', 'Kierdichting E-profiel 6 m wit', '8720618400066', 0, 1.2, 0.8, 10, 5],
  ['TSD-BRV-BOR-RVS', 'Brievenbus tochtborstel RVS', '8720618400073', 85, 0.6, 0.9, 14, 7],
  ['TSD-ONK-100-ZLV', 'Onderdeur tochtstrip 100 cm zilver met rubber lip', '8720618400080', 29, 0.7, 0.5, 14, 7],
];

if (!config.demoMode || !config.dbFile.endsWith('demo.db')) {
  console.error('Weigering: de demo-seed wist de database en werkt alleen op een demo.db met DEMO_MODE=true (npm run demo).');
  process.exit(1);
}

rmSync(config.dbFile, { force: true });
rmSync(`${config.dbFile}-wal`, { force: true });
rmSync(`${config.dbFile}-shm`, { force: true });

const log = console.log;
console.log = () => {}; // keep the per-sale activity log quiet while seeding
const app = createApp({ ...config, demoMode: true });
const { db, inventory } = app;
const now = Date.now();
const start = now - HISTORY_DAYS * DAY_MS;
setKv(db, 'go_live_at', new Date(start).toISOString());
inventory.goLiveAt = new Date(start).toISOString();

// Poisson-distributed daily sales with a gentle upward trend (autumn: draught season).
function poisson(lambda) {
  const l = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= Math.random();
  } while (p > l);
  return k - 1;
}

const setTime = (movement, at) => db.prepare('UPDATE stock_movements SET created_at = ? WHERE id = ?').run(at, movement.id);

let line = 0;
PRODUCTS.forEach(([sku, name, ean, finalStock, bolRate, wooRate, lead, safety], index) => {
  // 1. Simulate the orders of the past 90 days.
  const orders = [];
  for (let d = 0; d < HISTORY_DAYS; d++) {
    const trend = 0.75 + 0.5 * (d / HISTORY_DAYS);
    const weekday = new Date(start + d * DAY_MS).getUTCDay();
    const weekend = weekday === 0 || weekday === 6 ? 0.7 : 1.1;
    for (const [channel, rate] of [['bol', bolRate], ['woocommerce', wooRate]]) {
      for (let o = poisson(rate * trend * weekend); o > 0; o--) {
        const at = start + d * DAY_MS + Math.random() * DAY_MS;
        if (at < now) orders.push({ channel, at, quantity: Math.random() < 0.85 ? 1 : 2 });
      }
    }
  }
  orders.sort((a, b) => a.at - b.at);

  // 2. Work out opening stock and one goods receipt halfway, so today's stock = finalStock.
  const receiptAt = start + 45 * DAY_MS;
  const soldAfter = orders.filter((o) => o.at >= receiptAt).reduce((n, o) => n + o.quantity, 0);
  const soldTotal = orders.reduce((n, o) => n + o.quantity, 0);
  const receipt = Math.max(0, Math.floor((0.8 * (finalStock + soldAfter)) / 10) * 10);
  const opening = finalStock + soldTotal - receipt;

  inventory.upsertProduct({
    sku, name, ean, stock: opening, lead_time_days: lead, safety_days: safety,
    woo_product_id: 1000 + index, bol_offer_id: `demo-${sku.toLowerCase()}`,
  });
  const openedAt = new Date(start - DAY_MS).toISOString();
  db.prepare('UPDATE products SET created_at = ? WHERE sku = ?').run(openedAt, sku);
  db.prepare('UPDATE stock_movements SET created_at = ? WHERE sku = ?').run(openedAt, sku);

  // 3. Replay the orders (and the receipt) through the ledger in chronological order.
  let received = receipt === 0;
  for (const order of orders) {
    if (!received && order.at >= receiptAt) {
      setTime(inventory.adjustStock({ sku, delta: receipt, type: 'receipt', note: 'Levering leverancier' }), new Date(receiptAt).toISOString());
      received = true;
    }
    line++;
    inventory.recordSale({
      channel: order.channel,
      lineRef: `demo-history:${line}`,
      sku,
      quantity: order.quantity,
      occurredAt: new Date(order.at).toISOString(),
      note: order.channel === 'bol' ? `Bol-order H${line}` : `Webshop-order #H${line}`,
    });
  }
  if (!received) setTime(inventory.adjustStock({ sku, delta: receipt, type: 'receipt', note: 'Levering leverancier' }), new Date(receiptAt).toISOString());
});

db.exec('DELETE FROM sync_queue; DELETE FROM event_log;');
for (const p of inventory.listProducts()) {
  for (const channel of ['bol', 'woocommerce']) {
    db.prepare('INSERT OR REPLACE INTO channel_stock (sku, channel, stock, synced_at) VALUES (?, ?, ?, ?)')
      .run(p.sku, channel, p.stock, new Date().toISOString());
  }
}
app.bus.log('info', `Demo-database gevuld met ${PRODUCTS.length} producten en ${HISTORY_DAYS} dagen verkoophistorie`);
app.stop();
console.log = log;
console.log(`Demo-data geschreven naar ${config.dbFile}`);
