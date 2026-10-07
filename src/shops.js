import { randomBytes } from 'node:crypto';
import { existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, getKv, setKv } from './db.js';
import { EventBus } from './events.js';
import { Inventory } from './inventory.js';
import { SyncWorker } from './sync.js';
import { Poller } from './pollers.js';
import { Backups } from './backup.js';
import { BolChannel } from './channels/bol.js';
import { WooCommerceChannel } from './channels/woocommerce.js';
import { DemoChannel, startDemoSales } from './channels/demo.js';
import { AuthError } from './auth.js';

/** Identity colours for webshops (names map to CSS tokens with light/dark variants). */
export const SHOP_COLORS = ['aqua', 'violet', 'magenta', 'yellow', 'green', 'red'];

const SECRET_FIELDS = ['woo_consumer_key', 'woo_consumer_secret', 'woo_webhook_secret', 'bol_client_id', 'bol_client_secret'];
const PLAIN_FIELDS = ['name', 'color', 'woo_base_url', 'bol_fulfilment_method'];

function slugify(name) {
  return String(name).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/https?:\/\//, '').replace(/^www\./, '').replace(/\.(nl|be|com|eu|de|shop)(\/.*)?$/, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'webshop';
}

function normalizeUrl(url) {
  const value = String(url ?? '').trim();
  if (!value) return null;
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const u = new URL(withScheme);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    throw new AuthError('Ongeldig webadres van de webshop');
  }
}

/**
 * Name of the webshop (among `peers`) that sells this Bol.com offer / EAN, if any.
 * Used when several webshops share one Bol.com account: an order or offer of the
 * other webshop is not "unknown", and an offer is never linked to two webshops.
 */
function ownerAmong(peers, { offerId, ean } = {}) {
  for (const rt of peers) {
    const inv = rt.inventory;
    const hit = (offerId && (inv.findListing({ bolOfferId: offerId }) || inv.findProduct({ bolOfferId: offerId })))
      || (ean && (inv.findListing({ ean }) || inv.findProduct({ ean })));
    if (hit) return rt.shop.name;
  }
  return null;
}

/**
 * Everything one webshop needs at runtime: its own database, activity log, stock
 * ledger, channels (WooCommerce + optional Bol.com), pollers, sync worker and
 * backups. Webshops share nothing, so they can never get in each other's way.
 */
export function createShopRuntime({ shop, config, hub, fetchImpl = fetch, dbFile, bolPeers = () => [] }) {
  const db = openDb(dbFile);
  const bus = new EventBus(db, { shopId: shop.id, hub });

  let goLiveAt = getKv(db, 'go_live_at');
  if (!goLiveAt) {
    goLiveAt = new Date().toISOString();
    setKv(db, 'go_live_at', goLiveAt);
  }

  const hasWoo = Boolean(shop.woo_base_url && shop.woo_consumer_key && shop.woo_consumer_secret);
  const hasBol = Boolean(shop.bol_client_id && shop.bol_client_secret);
  const channels = [];
  if (config.demoMode) {
    channels.push(new DemoChannel('woocommerce'));
    if (hasBol) channels.push(new DemoChannel('bol'));
  } else {
    if (hasWoo) {
      channels.push(new WooCommerceChannel({
        config: {
          ...config.woo,
          baseUrl: shop.woo_base_url,
          consumerKey: shop.woo_consumer_key,
          consumerSecret: shop.woo_consumer_secret,
          webhookSecret: shop.woo_webhook_secret,
        },
        db, bus, fetchImpl,
      }));
    }
    if (hasBol) {
      channels.push(new BolChannel({
        config: {
          ...config.bol,
          clientId: shop.bol_client_id,
          clientSecret: shop.bol_client_secret,
          fulfilmentMethod: shop.bol_fulfilment_method || 'FBR',
        },
        db, bus, fetchImpl,
        knownElsewhere: (ids) => ownerAmong(bolPeers(), ids),
      }));
    }
  }
  const byName = Object.fromEntries(channels.map((c) => [c.name, c]));
  const inventory = new Inventory({ db, bus, channels: channels.map((c) => c.name), goLiveAt });
  const worker = new SyncWorker({
    db, bus, channels, intervalMs: config.sync.workerIntervalMs, maxBackoffSeconds: config.sync.maxBackoffSeconds,
    isPaused: () => Boolean(shop.sync_paused),
  });
  const pollers = [];
  if (!config.demoMode) {
    if (byName.bol) pollers.push(new Poller({ channel: byName.bol, inventory, bus, intervalSeconds: config.bol.pollIntervalSeconds }));
    if (byName.woocommerce) pollers.push(new Poller({ channel: byName.woocommerce, inventory, bus, intervalSeconds: config.woo.pollIntervalSeconds }));
  }
  const backups = config.backupDir
    ? new Backups({ db, bus, dir: config.backupDir, keep: config.backupKeepDays, prefix: `webshop-${shop.id}` })
    : null;

  let stopDemo = null;
  let running = false;
  return {
    id: shop.id,
    shop,
    db,
    bus,
    inventory,
    channels: byName,
    pollers,
    worker,
    goLiveAt,
    hasBol,
    hasWoo,
    // Webshops with the same Bol.com API credentials share one Bol.com account.
    bolAccount: hasBol ? shop.bol_client_id : null,
    syncPaused: Boolean(shop.sync_paused),
    start() {
      if (running) return;
      running = true;
      worker.start();
      for (const p of pollers) p.start();
      backups?.start();
      if (config.demoMode) stopDemo = startDemoSales(inventory, { hasBol });
    },
    stop() {
      running = false;
      worker.stop();
      for (const p of pollers) p.stop();
      backups?.stop();
      stopDemo?.();
    },
    close() {
      this.stop();
      db.close();
    },
  };
}

/**
 * The configured webshops (stored in the core database, credentials encrypted) and
 * their running instances.
 */
export class ShopRegistry {
  constructor({ coreDb, config, hub, secrets, fetchImpl = fetch, coreBus = null }) {
    this.db = coreDb;
    this.config = config;
    this.hub = hub;
    this.secrets = secrets;
    this.fetchImpl = fetchImpl;
    this.coreBus = coreBus;
    this.runtimes = new Map();
    this.running = false;
  }

  dbFileFor(id) {
    return this.config.dbFile === ':memory:' ? ':memory:' : join(this.config.shopsDir, `${id}.db`);
  }

  /** All shops with decrypted credentials (for internal use only). */
  #rows() {
    return this.db.prepare('SELECT * FROM shops ORDER BY position, name COLLATE NOCASE').all();
  }

  #decrypt(row) {
    const shop = { ...row };
    for (const f of SECRET_FIELDS) shop[f] = this.secrets.open(row[f]);
    return shop;
  }

  /** Load all shops and create their runtimes. */
  load() {
    for (const row of this.#rows()) {
      if (!this.runtimes.has(row.id)) this.runtimes.set(row.id, this.#createRuntime(this.#decrypt(row)));
    }
  }

  #createRuntime(shop) {
    return createShopRuntime({
      shop, config: this.config, hub: this.hub, fetchImpl: this.fetchImpl, dbFile: this.dbFileFor(shop.id),
      bolPeers: () => this.bolPeers(shop.id),
    });
  }

  /** The other webshops that use the same Bol.com account as this one. */
  bolPeers(id) {
    const account = this.get(id)?.bolAccount;
    return account ? this.all().filter((rt) => rt.id !== id && rt.bolAccount === account) : [];
  }

  startAll() {
    this.running = true;
    for (const rt of this.runtimes.values()) rt.start();
  }

  stopAll() {
    this.running = false;
    for (const rt of this.runtimes.values()) rt.close();
    this.runtimes.clear();
  }

  ids() {
    return [...this.runtimes.keys()];
  }

  get(id) {
    return this.runtimes.get(id) ?? null;
  }

  all() {
    return [...this.runtimes.values()];
  }

  /**
   * Shop settings as shown in the dashboard. Secrets are never sent back, only whether
   * they are set; the webhook secret is included for beheerders (it must be pasted
   * into WooCommerce).
   */
  describe(id, { includeWebhookSecret = false } = {}) {
    const row = this.db.prepare('SELECT * FROM shops WHERE id = ?').get(id);
    if (!row) return null;
    const rt = this.get(id);
    return {
      id: row.id,
      name: row.name,
      color: row.color,
      position: row.position,
      woo_base_url: row.woo_base_url,
      bol_fulfilment_method: row.bol_fulfilment_method,
      sync_paused: Boolean(row.sync_paused),
      has_woo_keys: Boolean(row.woo_consumer_key && row.woo_consumer_secret),
      has_bol_keys: Boolean(row.bol_client_id && row.bol_client_secret),
      bol_client_id_hint: row.bol_client_id ? `…${this.secrets.open(row.bol_client_id).slice(-4)}` : null,
      webhook_path: `/webhooks/woocommerce/${row.id}`,
      webhook_secret: includeWebhookSecret ? this.secrets.open(row.woo_webhook_secret) : undefined,
      products: rt ? rt.db.prepare('SELECT COUNT(*) AS n FROM products').get().n : 0,
    };
  }

  list(opts) {
    return this.#rows().map((r) => this.describe(r.id, opts));
  }

  create(input, { userName = null } = {}) {
    const name = String(input.name ?? '').trim();
    if (!name) throw new AuthError('Vul een naam in voor de webshop');
    let id = slugify(input.id || input.woo_base_url || name);
    for (let n = 2; this.db.prepare('SELECT 1 FROM shops WHERE id = ?').get(id) || (this.config.dbFile !== ':memory:' && existsSync(this.dbFileFor(id))); n++) {
      id = `${slugify(input.id || input.woo_base_url || name)}-${n}`;
    }
    const used = new Set(this.#rows().map((r) => r.color));
    const color = SHOP_COLORS.includes(input.color) ? input.color : (SHOP_COLORS.find((c) => !used.has(c)) ?? SHOP_COLORS[0]);
    const position = (this.db.prepare('SELECT MAX(position) AS m FROM shops').get().m ?? -1) + 1;
    this.db.prepare(`
      INSERT INTO shops (id, name, color, position, woo_base_url, woo_consumer_key, woo_consumer_secret, woo_webhook_secret,
                         bol_client_id, bol_client_secret, bol_fulfilment_method, sync_paused)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, name, color, position,
      normalizeUrl(input.woo_base_url),
      this.secrets.seal(input.woo_consumer_key?.trim()),
      this.secrets.seal(input.woo_consumer_secret?.trim()),
      this.secrets.seal(input.woo_webhook_secret || randomBytes(24).toString('base64url')),
      this.secrets.seal(input.bol_client_id?.trim()),
      this.secrets.seal(input.bol_client_secret?.trim()),
      input.bol_fulfilment_method === 'ALL' ? 'ALL' : 'FBR',
      // New webshops start paused: nothing is sent until the stock has been checked.
      input.sync_paused === false ? 0 : 1,
    );
    const rt = this.#createRuntime(this.#decrypt(this.db.prepare('SELECT * FROM shops WHERE id = ?').get(id)));
    this.runtimes.set(id, rt);
    if (this.running) rt.start();
    this.coreBus?.log('info', `Webshop ${name} toegevoegd${userName ? ` door ${userName}` : ''}`);
    this.hub.emit('event', { type: 'shops', payload: null, shop: null, at: new Date().toISOString() });
    return this.describe(id, { includeWebhookSecret: true });
  }

  /**
   * Change settings. For credentials: a non-empty value replaces the stored one,
   * an empty string keeps it, and `null` removes it (e.g. to disconnect Bol.com).
   */
  update(id, input, { userName = null } = {}) {
    const row = this.db.prepare('SELECT * FROM shops WHERE id = ?').get(id);
    if (!row) throw new AuthError('Onbekende webshop', 404);
    const next = { ...row };
    for (const f of PLAIN_FIELDS) {
      if (!(f in input)) continue;
      if (f === 'name') next.name = String(input.name ?? '').trim() || row.name;
      else if (f === 'color') next.color = SHOP_COLORS.includes(input.color) ? input.color : row.color;
      else if (f === 'woo_base_url') next.woo_base_url = normalizeUrl(input.woo_base_url);
      else if (f === 'bol_fulfilment_method') next.bol_fulfilment_method = input.bol_fulfilment_method === 'ALL' ? 'ALL' : 'FBR';
    }
    for (const f of SECRET_FIELDS) {
      if (!(f in input) || input[f] === '' || input[f] === undefined) continue;
      next[f] = input[f] === null ? null : this.secrets.seal(String(input[f]).trim());
    }
    if ('sync_paused' in input) next.sync_paused = input.sync_paused ? 1 : 0;
    if (input.regenerate_webhook_secret) next.woo_webhook_secret = this.secrets.seal(randomBytes(24).toString('base64url'));
    this.db.prepare(`
      UPDATE shops SET name = ?, color = ?, woo_base_url = ?, woo_consumer_key = ?, woo_consumer_secret = ?,
        woo_webhook_secret = ?, bol_client_id = ?, bol_client_secret = ?, bol_fulfilment_method = ?, sync_paused = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?
    `).run(next.name, next.color, next.woo_base_url, next.woo_consumer_key, next.woo_consumer_secret,
      next.woo_webhook_secret, next.bol_client_id, next.bol_client_secret, next.bol_fulfilment_method, next.sync_paused, id);

    // Restart this shop only, with the new settings; the other shops keep running.
    this.runtimes.get(id)?.close();
    const rt = this.#createRuntime(this.#decrypt(this.db.prepare('SELECT * FROM shops WHERE id = ?').get(id)));
    this.runtimes.set(id, rt);
    if (this.running) rt.start();
    const what = 'sync_paused' in input && Boolean(input.sync_paused) !== Boolean(row.sync_paused)
      ? (next.sync_paused ? 'Synchronisatie gepauzeerd' : 'Synchronisatie gestart') : 'Instellingen gewijzigd';
    this.coreBus?.log('info', `${what} voor webshop ${next.name}${userName ? ` door ${userName}` : ''}`);
    rt.bus.log('info', `${what}${userName ? ` door ${userName}` : ''}`);
    this.hub.emit('event', { type: 'shops', payload: null, shop: null, at: new Date().toISOString() });
    return this.describe(id, { includeWebhookSecret: true });
  }

  /** Remove a shop. Its database is kept as a renamed file, not deleted. */
  remove(id, { userName = null } = {}) {
    const row = this.db.prepare('SELECT * FROM shops WHERE id = ?').get(id);
    if (!row) throw new AuthError('Onbekende webshop', 404);
    this.runtimes.get(id)?.close();
    this.runtimes.delete(id);
    this.db.prepare('DELETE FROM shops WHERE id = ?').run(id);
    const file = this.dbFileFor(id);
    if (file !== ':memory:' && existsSync(file)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      for (const suffix of ['', '-wal', '-shm']) {
        if (existsSync(file + suffix)) renameSync(file + suffix, `${file.replace(/\.db$/, '')}.verwijderd-${stamp}.db${suffix}`);
      }
    }
    this.coreBus?.log('info', `Webshop ${row.name} verwijderd${userName ? ` door ${userName}` : ''}`);
    this.hub.emit('event', { type: 'shops', payload: null, shop: null, at: new Date().toISOString() });
  }

  /** Try the stored credentials against WooCommerce and Bol.com. */
  async test(id) {
    const rt = this.get(id);
    if (!rt) throw new AuthError('Onbekende webshop', 404);
    const run = async (channel, missing) => {
      if (!channel || typeof channel.testConnection !== 'function') return { ok: false, message: missing };
      try {
        return { ok: true, message: await channel.testConnection() };
      } catch (err) {
        return { ok: false, message: err.status === 401 || err.status === 403 ? 'sleutels worden geweigerd – controleer ze' : err.message };
      }
    };
    return {
      woocommerce: await run(rt.channels.woocommerce, 'sleutels nog niet ingevuld'),
      bol: rt.hasBol ? await run(rt.channels.bol, 'sleutels nog niet ingevuld') : { ok: null, message: 'niet gebruikt' },
    };
  }
}
