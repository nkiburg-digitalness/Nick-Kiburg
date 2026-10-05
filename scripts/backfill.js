/**
 * Import past orders from Bol.com and the webshop as sales history, so the
 * "days until sold out" forecast is meaningful from day one. Stock is not changed.
 * (Also available in the dashboard: menu → Importeren / exporteren.)
 *
 *   npm run backfill -- <webshop-id>         (last 90 days)
 *   npm run backfill -- <webshop-id> 365     (last year; Bol.com gives at most 90 days)
 */
import { config } from '../src/config.js';
import { createApp } from '../src/app.js';

const [shopId, daysArg] = process.argv.slice(2);
const days = Math.min(365, Number.parseInt(daysArg ?? '90', 10) || 90);
const app = createApp(config);

try {
  const rt = app.shops.get(shopId);
  if (!rt) {
    console.error(`Gebruik: npm run backfill -- <webshop-id> [dagen]\nWebshops: ${app.shops.ids().join(', ') || '(nog geen)'}`);
    process.exitCode = 1;
  } else {
    for (const [name, channel] of Object.entries(rt.channels)) {
      if (typeof channel.backfill !== 'function') continue;
      process.stdout.write(`${rt.shop.name} – ${name}: orders van de afgelopen ${days} dagen ophalen… `);
      const booked = await channel.backfill(rt.inventory, days);
      console.log(`${booked} orderregel(s) als historie opgeslagen.`);
    }
  }
} catch (err) {
  console.error(`\nMislukt: ${err.message}`);
  process.exitCode = 1;
} finally {
  app.stop();
}
