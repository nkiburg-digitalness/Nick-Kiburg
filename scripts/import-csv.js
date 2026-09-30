/**
 * Import or update products.
 *
 *   npm run import -- producten.csv
 *       CSV (comma or semicolon) with a header row. Columns (only sku required):
 *       sku, name, ean, stock, lead_time_days, safety_days, woo_product_id, woo_variation_id, bol_offer_id
 *       A filled "stock" column sets the stock (booked as stocktake).
 *
 *   npm run import -- --woocommerce
 *       Reads all products (incl. variations) from the webshop and creates/links them
 *       by SKU, taking over the current webshop stock for new products.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { config } from '../src/config.js';
import { createApp } from '../src/app.js';

export function parseCsv(text) {
  const firstLine = text.split(/\r?\n/, 1)[0];
  const sep = (firstLine.match(/;/g) ?? []).length > (firstLine.match(/,/g) ?? []).length ? ';' : ',';
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((v) => v.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((v) => v.trim() !== '')) rows.push(row);
  const [header, ...data] = rows;
  const keys = header.map((h) => h.trim().toLowerCase());
  return data.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Gebruik: npm run import -- producten.csv  |  npm run import -- --woocommerce');
    process.exit(1);
  }
  const app = createApp(config);
  const { inventory } = app;
  let created = 0;
  let updated = 0;

  if (arg === '--woocommerce') {
    const woo = app.channels.woocommerce;
    if (!woo) throw new Error('WooCommerce is niet geconfigureerd (WOO_CONSUMER_KEY/SECRET in .env)');
    for (const p of await woo.listProducts()) {
      if (!p.sku) {
        console.warn(`Overgeslagen (geen SKU): ${p.name} [#${p.woo_product_id}]`);
        continue;
      }
      const exists = inventory.getProduct(p.sku);
      inventory.upsertProduct({
        sku: p.sku, name: exists?.name ?? p.name, woo_product_id: p.woo_product_id, woo_variation_id: p.woo_variation_id,
        ...(exists ? {} : { stock: p.stock ?? 0 }),
      });
      exists ? updated++ : created++;
    }
  } else {
    for (const row of parseCsv(readFileSync(arg, 'utf8'))) {
      if (!row.sku) continue;
      const exists = inventory.getProduct(row.sku);
      const fields = { sku: row.sku };
      for (const key of ['name', 'ean', 'lead_time_days', 'safety_days', 'woo_product_id', 'woo_variation_id', 'bol_offer_id']) {
        if (row[key] !== undefined && row[key] !== '') fields[key] = row[key];
      }
      if (!exists) {
        inventory.upsertProduct({ ...fields, stock: row.stock || 0 });
        created++;
      } else {
        inventory.upsertProduct(fields);
        if (row.stock !== undefined && row.stock !== '') inventory.setStock({ sku: row.sku, count: row.stock, note: 'CSV-import' });
        updated++;
      }
    }
  }
  console.log(`${created} product(en) aangemaakt, ${updated} bijgewerkt.`);
  console.log('Start de server (npm start) om de voorraad naar Bol.com en de webshop te sturen.');
  app.stop();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
