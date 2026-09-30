/**
 * Import past orders from Bol.com and the webshop as sales history, so the
 * "days until sold out" forecast is meaningful from day one. Stock is not changed.
 *
 *   npm run backfill            (last 90 days)
 *   npm run backfill -- 30      (last 30 days)
 */
import { config } from '../src/config.js';
import { createApp } from '../src/app.js';

const days = Math.min(90, Number.parseInt(process.argv[2] ?? '90', 10) || 90);
const app = createApp(config);

try {
  for (const [name, channel] of Object.entries(app.channels)) {
    if (typeof channel.backfill !== 'function') continue;
    process.stdout.write(`${name}: orders van de afgelopen ${days} dagen ophalen… `);
    const booked = await channel.backfill(app.inventory, days);
    console.log(`${booked} orderregel(s) als historie opgeslagen.`);
  }
} catch (err) {
  console.error(`\nMislukt: ${err.message}`);
  process.exitCode = 1;
} finally {
  app.stop();
}
