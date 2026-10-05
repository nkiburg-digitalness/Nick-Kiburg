import { config } from './config.js';
import { createApp } from './app.js';
import { createHttpServer } from './server.js';
import { DEMO_LOGIN } from './demo-login.js';

const app = createApp(config);
await app.bootstrapAdmin();
if (config.demoMode) app.demoLogin = DEMO_LOGIN;
const server = createHttpServer(app);

server.listen(config.port, () => {
  const shops = app.shops.all().map((rt) => `${rt.shop.name} (${Object.keys(rt.channels).join(', ') || 'niet gekoppeld'})`);
  console.log(`Voorraadbeheer draait op http://localhost:${config.port}${config.demoMode ? ' – DEMO-modus' : ''}`);
  console.log(`Webshops: ${shops.join('; ') || 'nog geen – voeg ze toe in het dashboard (Webshops beheren)'}`);
  if (config.demoMode) console.log(`Demo-login: ${DEMO_LOGIN.email} / ${DEMO_LOGIN.password}`);
  if (!app.auth.hasUsers()) {
    console.warn('Er zijn nog geen gebruikers. Zet ADMIN_EMAIL en ADMIN_PASSWORD in .env en herstart, of gebruik: npm run gebruiker -- toevoegen');
  }
  app.start();
});

function shutdown() {
  server.close();
  app.stop();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
