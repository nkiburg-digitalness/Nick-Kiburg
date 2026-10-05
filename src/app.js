import { EventEmitter } from 'node:events';
import { dirname, join } from 'node:path';
import { openCoreDb } from './db.js';
import { Auth } from './auth.js';
import { Backups } from './backup.js';
import { EventBus } from './events.js';
import { SecretBox, loadSecret } from './secrets.js';
import { ShopRegistry } from './shops.js';

/**
 * Wire up the core (users, sessions, webshop settings) and one runtime per webshop.
 * Nothing is started until start() is called, which keeps this usable from scripts.
 */
export function createApp(config, { fetchImpl = fetch } = {}) {
  const coreDb = openCoreDb(config.dbFile);
  const hub = new EventEmitter();
  hub.setMaxListeners(200);
  const coreBus = new EventBus(coreDb, { shopId: null, hub });
  const auth = new Auth(coreDb);
  // Demo and tests contain no real API keys, so a fixed key is fine there.
  const secret = config.secretKey || (config.dbFile === ':memory:' || config.demoMode
    ? 'demo-or-test-secret'
    : loadSecret({ envSecret: '', keyFile: join(dirname(config.dbFile), 'secret.key') }));
  const secrets = new SecretBox(secret);
  const shops = new ShopRegistry({ coreDb, config, hub, secrets, fetchImpl, coreBus });

  // Upgrade path from a single-webshop setup configured with WOO_*/BOL_* variables.
  if (!coreDb.prepare('SELECT 1 FROM shops').get() && config.legacyShop) {
    shops.create(config.legacyShop);
  }
  shops.load();

  const coreBackups = config.backupDir
    ? new Backups({ db: coreDb, bus: coreBus, dir: config.backupDir, keep: config.backupKeepDays, prefix: 'kern' })
    : null;

  return {
    config,
    coreDb,
    coreBus,
    hub,
    auth,
    shops,
    demoLogin: null,
    /** Create the first beheerder from ADMIN_EMAIL / ADMIN_PASSWORD if there are no users yet. */
    async bootstrapAdmin() {
      if (auth.hasUsers() || !config.adminEmail || !config.adminPassword) return null;
      const user = await auth.createUser({
        email: config.adminEmail, name: config.adminName, role: 'beheerder', password: config.adminPassword,
      });
      coreBus.log('info', `Eerste beheerder ${user.name} (${user.email}) aangemaakt`);
      return user;
    },
    start() {
      shops.startAll();
      coreBackups?.start();
    },
    stop() {
      coreBackups?.stop();
      shops.stopAll();
      coreDb.close();
    },
  };
}
