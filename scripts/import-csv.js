/**
 * Import or update products (the same can be done in the dashboard: menu → Importeren).
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
import { config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { parseCsv, importRows, importFromWooCommerce } from '../src/importer.js';

const arg = process.argv[2];
if (!arg) {
  console.error('Gebruik: npm run import -- producten.csv  |  npm run import -- --woocommerce');
  process.exit(1);
}

const app = createApp(config);
try {
  let result;
  if (arg === '--woocommerce') {
    const woo = app.channels.woocommerce;
    if (!woo) throw new Error('WooCommerce is niet geconfigureerd (WOO_CONSUMER_KEY/SECRET in .env)');
    result = await importFromWooCommerce(app.inventory, woo);
  } else {
    result = importRows(app.inventory, parseCsv(readFileSync(arg, 'utf8')));
  }
  for (const line of result.skipped) console.warn(`Overgeslagen: ${line}`);
  console.log(`${result.created} product(en) aangemaakt, ${result.updated} bijgewerkt.`);
  console.log('Start de server (npm start) om de voorraad naar Bol.com en de webshop te sturen.');
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  app.stop();
}
