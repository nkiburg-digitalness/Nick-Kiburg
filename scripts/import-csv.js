/**
 * Import or update the products of one webshop (the same can be done in the dashboard:
 * menu → Importeren / exporteren).
 *
 *   npm run import -- <webshop-id> producten.csv
 *       CSV (comma or semicolon) with a header row. Columns (only sku required):
 *       sku, name, ean, stock, lead_time_days, safety_days, woo_product_id, woo_variation_id, bol_offer_id
 *       A filled "stock" column sets the stock (booked as stocktake).
 *
 *   npm run import -- <webshop-id> --woocommerce
 *       Reads all products (incl. variations) from that webshop and creates/links them
 *       by SKU, taking over the current webshop stock for new products.
 */
import { readFileSync } from 'node:fs';
import { config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { parseCsv, importRows, importFromWooCommerce } from '../src/importer.js';

const [shopId, source] = process.argv.slice(2);
const app = createApp(config);
try {
  const rt = app.shops.get(shopId);
  if (!rt || !source) {
    console.error('Gebruik: npm run import -- <webshop-id> producten.csv  |  npm run import -- <webshop-id> --woocommerce');
    console.error(`Webshops: ${app.shops.ids().join(', ') || '(nog geen)'}`);
    process.exitCode = 1;
  } else {
    let result;
    if (source === '--woocommerce') {
      if (typeof rt.channels.woocommerce?.listProducts !== 'function') throw new Error('WooCommerce is voor deze webshop niet gekoppeld');
      result = await importFromWooCommerce(rt.inventory, rt.channels.woocommerce);
    } else {
      result = importRows(rt.inventory, parseCsv(readFileSync(source, 'utf8')));
    }
    for (const line of result.skipped) console.warn(`Overgeslagen: ${line}`);
    console.log(`${rt.shop.name}: ${result.created} product(en) aangemaakt, ${result.updated} bijgewerkt.`);
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  app.stop();
}
