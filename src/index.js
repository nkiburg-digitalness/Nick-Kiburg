import { config } from './config.js';
import { createApp } from './app.js';
import { createHttpServer } from './server.js';

const app = createApp(config);
const server = createHttpServer(app);

server.listen(config.port, () => {
  const connected = Object.keys(app.channels).join(', ') || 'geen';
  console.log(`Voorraadbeheer draait op http://localhost:${config.port} (kanalen: ${connected}${config.demoMode ? ', DEMO-modus' : ''})`);
  if (!config.adminPassword) console.warn('Let op: ADMIN_PASSWORD is niet ingesteld – het dashboard is zonder wachtwoord bereikbaar.');
  app.start();
});

function shutdown() {
  server.close();
  app.stop();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
