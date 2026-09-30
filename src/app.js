import { openDb, getKv, setKv } from './db.js';
import { EventBus } from './events.js';
import { Inventory } from './inventory.js';
import { SyncWorker } from './sync.js';
import { Poller } from './pollers.js';
import { BolChannel } from './channels/bol.js';
import { WooCommerceChannel } from './channels/woocommerce.js';
import { DemoChannel, startDemoSales } from './channels/demo.js';

/**
 * Wire up database, channels, inventory, sync worker and pollers.
 * Nothing is started until start() is called, which keeps this usable from scripts.
 */
export function createApp(config, { fetchImpl = fetch } = {}) {
  const db = openDb(config.dbFile);
  const bus = new EventBus(db);

  let goLiveAt = process.env.GO_LIVE_AT ? new Date(process.env.GO_LIVE_AT).toISOString() : getKv(db, 'go_live_at');
  if (!goLiveAt) {
    goLiveAt = new Date().toISOString();
    setKv(db, 'go_live_at', goLiveAt);
  }

  const channels = [];
  const pollers = [];
  if (config.demoMode) {
    channels.push(new DemoChannel('bol'), new DemoChannel('woocommerce'));
  } else {
    if (config.bol.enabled) channels.push(new BolChannel({ config: config.bol, db, bus, fetchImpl }));
    if (config.woo.enabled) channels.push(new WooCommerceChannel({ config: config.woo, db, bus, fetchImpl }));
  }
  const byName = Object.fromEntries(channels.map((c) => [c.name, c]));

  const inventory = new Inventory({ db, bus, channels: channels.map((c) => c.name), goLiveAt });
  const worker = new SyncWorker({
    db, bus, channels, intervalMs: config.sync.workerIntervalMs, maxBackoffSeconds: config.sync.maxBackoffSeconds,
  });

  if (!config.demoMode) {
    if (byName.bol) pollers.push(new Poller({ channel: byName.bol, inventory, bus, intervalSeconds: config.bol.pollIntervalSeconds }));
    if (byName.woocommerce) pollers.push(new Poller({ channel: byName.woocommerce, inventory, bus, intervalSeconds: config.woo.pollIntervalSeconds }));
  }

  let stopDemo = null;
  return {
    config,
    db,
    bus,
    inventory,
    channels: byName,
    pollers,
    worker,
    goLiveAt,
    start() {
      worker.start();
      for (const p of pollers) p.start();
      if (config.demoMode) stopDemo = startDemoSales(inventory);
    },
    stop() {
      worker.stop();
      for (const p of pollers) p.stop();
      stopDemo?.();
      db.close();
    },
  };
}
