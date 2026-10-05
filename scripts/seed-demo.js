/**
 * Fills a fresh demo database with four example webshops, each with its own products
 * and ~90 days of sales history, so the dashboard and forecasts can be explored
 * without any API keys.
 *   npm run demo        (seed + start in demo mode)
 */
import { rmSync } from 'node:fs';
import { config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { setKv } from '../src/db.js';
import { DEMO_LOGIN } from '../src/demo-login.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY_DAYS = 90;

// [sku, name, ean, stock, sales/day Bol (0 = not on Bol), sales/day webshop, lead time, safety]
const SHOPS = [
  {
    id: 'tochtstripdeur', name: 'Tochtstripdeur.nl', color: 'aqua', url: 'https://tochtstripdeur.nl', bol: true,
    products: [
      ['TSD-BOR-093-WIT', 'Tochtstrip deur borstel 93 cm wit', '8720618400011', 46, 2.1, 1.3, 14, 7],
      ['TSD-BOR-093-BRN', 'Tochtstrip deur borstel 93 cm bruin', '8720618400028', 118, 0.9, 0.6, 14, 7],
      ['TSD-VAL-083-ALU', 'Valdorpel automatisch 83 cm aluminium', '8720618400035', 12, 0.8, 0.7, 21, 7],
      ['TSD-VAL-098-ALU', 'Valdorpel automatisch 98 cm aluminium', '8720618400042', 64, 0, 0.6, 21, 7],
      ['TSD-RUB-P10-ZWT', 'Tochtstrip rubber P-profiel zelfklevend 10 m zwart', '8720618400059', 310, 3.4, 2.2, 10, 5],
      ['TSD-RUB-E06-WIT', 'Kierdichting E-profiel 6 m wit', '8720618400066', 0, 1.2, 0.8, 10, 5],
      ['TSD-BRV-BOR-RVS', 'Brievenbus tochtborstel RVS', '8720618400073', 85, 0, 1.1, 14, 7],
      ['TSD-ONK-100-ZLV', 'Onderdeur tochtstrip 100 cm zilver met rubber lip', '8720618400080', 29, 0.7, 0.5, 14, 7],
    ],
  },
  {
    id: 'deurbeslag', name: 'Voorbeeldshop Deurbeslag', color: 'violet', url: 'https://deurbeslag.example', bol: false,
    products: [
      ['DB-KRUK-RVS-01', 'Deurkruk op rozet RVS', '8720618401018', 74, 0, 2.4, 21, 7],
      ['DB-KRUK-ZWT-01', 'Deurkruk op rozet mat zwart', '8720618401025', 22, 0, 2.9, 21, 7],
      ['DB-SLOT-CIL-30', 'Veiligheidscilinder SKG** 30/30', '8720618401032', 140, 0, 1.6, 14, 7],
      ['DB-SCHA-90-RVS', 'Deurscharnier 89 mm RVS (3 st.)', '8720618401049', 31, 0, 1.1, 14, 7],
      ['DB-DRANG-EN3', 'Deurdranger EN 2-4 zilver', '8720618401056', 9, 0, 0.5, 28, 7],
      ['DB-STOP-VLOER', 'Deurstopper vloer RVS', '8720618401063', 260, 0, 1.9, 14, 7],
    ],
  },
  {
    id: 'raamdecoratie', name: 'Voorbeeldshop Raamdecoratie', color: 'magenta', url: 'https://raamdecoratie.example', bol: true,
    products: [
      ['RD-ROL-090-WIT', 'Rolgordijn verduisterend 90 cm wit', '8720618402015', 58, 1.4, 1.0, 21, 7],
      ['RD-ROL-120-GRS', 'Rolgordijn verduisterend 120 cm grijs', '8720618402022', 17, 1.1, 0.7, 21, 7],
      ['RD-JAL-060-ALU', 'Jaloezie aluminium 60 cm', '8720618402039', 96, 0, 0.9, 14, 7],
      ['RD-HOR-PLI-100', 'Plissé hordeur 100 x 220 cm', '8720618402046', 6, 0.6, 0.4, 28, 7],
      ['RD-FOL-STAT-90', 'Statische raamfolie mat 90 cm', '8720618402053', 210, 2.2, 1.1, 10, 5],
    ],
  },
  {
    id: 'tuin', name: 'Voorbeeldshop Tuin', color: 'yellow', url: 'https://tuin.example', bol: false,
    products: [
      ['TN-SLANG-25', 'Tuinslang 25 m met haspel', '8720618403012', 48, 0, 0.8, 21, 7],
      ['TN-SPROEI-OSC', 'Zwenksproeier oscillerend', '8720618403029', 75, 0, 0.6, 14, 7],
      ['TN-HANDS-L', 'Tuinhandschoenen maat L', '8720618403036', 160, 0, 1.4, 10, 5],
      ['TN-SNOEI-PRO', 'Snoeischaar professioneel', '8720618403043', 14, 0, 0.9, 21, 7],
      ['TN-ZAAD-GRAS', 'Graszaad sport & spel 1 kg', '8720618403050', 0, 0, 0.7, 14, 7],
    ],
  },
];

if (!config.demoMode || !config.dbFile.endsWith('demo.db') || !config.shopsDir.endsWith('demo-webshops')) {
  console.error('Weigering: de demo-seed wist de database en werkt alleen op een demo.db met DEMO_MODE=true (npm run demo).');
  process.exit(1);
}

for (const suffix of ['', '-wal', '-shm']) rmSync(`${config.dbFile}${suffix}`, { force: true });
rmSync(config.shopsDir, { recursive: true, force: true });

const log = console.log;
console.log = () => {}; // keep the per-sale activity log quiet while seeding
const app = createApp({ ...config, demoMode: true, legacyShop: null });
const now = Date.now();
const start = now - HISTORY_DAYS * DAY_MS;

// Poisson-distributed daily sales with a gentle upward trend.
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

let line = 0;
for (const def of SHOPS) {
  app.shops.create({
    id: def.id, name: def.name, color: def.color, woo_base_url: def.url,
    woo_consumer_key: 'demo', woo_consumer_secret: 'demo',
    ...(def.bol ? { bol_client_id: 'demo', bol_client_secret: 'demo' } : {}),
  });
  const { db, inventory } = app.shops.get(def.id);
  setKv(db, 'go_live_at', new Date(start).toISOString());
  inventory.goLiveAt = new Date(start).toISOString();
  const setTime = (movement, at) => db.prepare('UPDATE stock_movements SET created_at = ? WHERE id = ?').run(at, movement.id);

  def.products.forEach(([sku, name, ean, finalStock, bolRate, wooRate, lead, safety], index) => {
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

    // 2. Opening stock and one goods receipt halfway, so today's stock = finalStock.
    const receiptAt = start + 45 * DAY_MS;
    const soldAfter = orders.filter((o) => o.at >= receiptAt).reduce((n, o) => n + o.quantity, 0);
    const soldTotal = orders.reduce((n, o) => n + o.quantity, 0);
    const receipt = Math.max(0, Math.floor((0.8 * (finalStock + soldAfter)) / 10) * 10);
    const opening = finalStock + soldTotal - receipt;

    inventory.upsertProduct({
      sku, name, ean, stock: opening, lead_time_days: lead, safety_days: safety,
      woo_product_id: 1000 + index, bol_offer_id: def.bol && bolRate > 0 ? `demo-${sku.toLowerCase()}` : null,
    });
    const openedAt = new Date(start - DAY_MS).toISOString();
    db.prepare('UPDATE products SET created_at = ? WHERE sku = ?').run(openedAt, sku);
    db.prepare('UPDATE stock_movements SET created_at = ? WHERE sku = ?').run(openedAt, sku);

    // 3. Replay the orders (and the receipt) through the ledger in chronological order.
    let received = receipt === 0;
    const bookReceipt = () => setTime(inventory.adjustStock({ sku, delta: receipt, type: 'receipt', note: 'Levering leverancier' }), new Date(receiptAt).toISOString());
    for (const order of orders) {
      if (!received && order.at >= receiptAt) {
        bookReceipt();
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
    if (!received) bookReceipt();
  });

  db.exec('DELETE FROM sync_queue; DELETE FROM event_log;');
  for (const p of inventory.listProducts()) {
    for (const channel of ['woocommerce', ...(p.bol_offer_id ? ['bol'] : [])]) {
      db.prepare('INSERT OR REPLACE INTO channel_stock (sku, channel, stock, synced_at) VALUES (?, ?, ?, ?)')
        .run(p.sku, channel, p.stock, new Date().toISOString());
    }
  }
}

await app.auth.createUser({ ...DEMO_LOGIN, role: 'beheerder' });
await app.auth.createUser({ email: 'magazijn@tochtstripdeur.nl', name: 'Sanne (magazijn)', role: 'medewerker', password: 'demo-wachtwoord' });
await app.auth.createUser({ email: 'raamdecoratie@tochtstripdeur.nl', name: 'Lisa (raamdecoratie)', role: 'medewerker', password: 'demo-wachtwoord', shops: ['raamdecoratie'] });
await app.auth.createUser({ email: 'boekhouding@tochtstripdeur.nl', name: 'Joost (boekhouding)', role: 'kijker', password: 'demo-wachtwoord' });
app.coreDb.exec('DELETE FROM event_log');
app.coreBus.log('info', `Demo gevuld met ${SHOPS.length} webshops en ${HISTORY_DAYS} dagen verkoophistorie`);
app.stop();
console.log = log;
console.log(`Demo-data geschreven naar ${config.dbFile} en ${config.shopsDir}`);
