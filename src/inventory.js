import { transaction } from './db.js';

export const CHANNEL_LABELS = {
  bol: 'Bol.com',
  woocommerce: 'Webshop',
  manual: 'Handmatig',
};

const PRODUCT_FIELDS = [
  'name', 'ean', 'unit', 'lead_time_days', 'safety_days', 'woo_product_id', 'woo_variation_id', 'bol_offer_id',
];

function by(userName) {
  return userName ? ` (door ${userName})` : '';
}

function emptyToNull(value) {
  return value === '' || value === undefined ? null : value;
}

/**
 * The central stock ledger. The stock in this database is the single source of
 * truth; every sales channel mirrors it. Any change enqueues a push of the new
 * absolute stock to all connected channels (see sync.js).
 */
export class Inventory {
  /**
   * @param {object} opts
   * @param {import('node:sqlite').DatabaseSync} opts.db
   * @param {import('./events.js').EventBus} opts.bus
   * @param {string[]} opts.channels names of the channels stock is pushed to
   */
  constructor({ db, bus, channels = [], goLiveAt = null }) {
    this.db = db;
    this.bus = bus;
    this.channels = channels;
    // Orders placed before this moment are already reflected in the stock that was
    // entered at go-live; they are only kept as sales history for the forecast.
    this.goLiveAt = goLiveAt;
  }

  listProducts() {
    return this.db.prepare('SELECT * FROM products ORDER BY name COLLATE NOCASE').all();
  }

  getProduct(sku) {
    return this.db.prepare('SELECT * FROM products WHERE sku = ?').get(sku) ?? null;
  }

  /**
   * Find the product an order line refers to. Tries the most specific identifiers
   * first: channel ids, then SKU, then EAN.
   */
  findProduct({ sku, ean, wooProductId, wooVariationId, bolOfferId } = {}) {
    const q = (sql, ...args) => this.db.prepare(sql).get(...args) ?? null;
    if (wooVariationId) {
      const p = q('SELECT * FROM products WHERE woo_variation_id = ?', wooVariationId);
      if (p) return p;
    }
    if (wooProductId && !wooVariationId) {
      const p = q('SELECT * FROM products WHERE woo_product_id = ? AND woo_variation_id IS NULL', wooProductId);
      if (p) return p;
    }
    if (bolOfferId) {
      const p = q('SELECT * FROM products WHERE bol_offer_id = ?', String(bolOfferId));
      if (p) return p;
    }
    if (sku) {
      const p = q('SELECT * FROM products WHERE sku = ?', String(sku));
      if (p) return p;
    }
    if (ean) {
      const p = q('SELECT * FROM products WHERE ean = ?', String(ean));
      if (p) return p;
    }
    return null;
  }

  /**
   * Create or update a product. When `stock` is given for a new product it is booked
   * as the opening stock; for an existing product use setStock()/adjustStock().
   */
  upsertProduct(input, { userName = null } = {}) {
    const sku = String(input.sku ?? '').trim();
    if (!sku) throw new ValidationError('SKU is verplicht');
    const existing = this.getProduct(sku);

    if (!existing) {
      if (!input.name) throw new ValidationError('Naam is verplicht');
      const stock = Number.parseInt(input.stock ?? 0, 10) || 0;
      // stock_confirmed: false = stock not known yet; nothing is pushed until it is counted.
      const confirmed = input.stock_confirmed === false ? 0 : 1;
      transaction(this.db, () => {
        this.db.prepare(`
          INSERT INTO products (sku, name, ean, unit, stock, lead_time_days, safety_days, woo_product_id, woo_variation_id, bol_offer_id, stock_confirmed)
          VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
        `).run(
          sku, input.name, emptyToNull(input.ean), String(input.unit || 'stuks').trim() || 'stuks',
          input.lead_time_days ?? 14, input.safety_days ?? 7,
          emptyToNull(input.woo_product_id), emptyToNull(input.woo_variation_id), emptyToNull(input.bol_offer_id),
          confirmed,
        );
        if (stock !== 0) this.#move({ sku, delta: stock, type: 'correction', channel: 'manual', note: 'Beginvoorraad', userName });
      });
      this.bus.log('info', `Product ${sku} aangemaakt (${confirmed ? `voorraad ${stock}` : 'voorraad nog niet geteld'})${by(userName)}`, { sku });
      this.enqueueSync(sku);
    } else {
      const sets = [];
      const values = [];
      for (const field of PRODUCT_FIELDS) {
        if (field in input) {
          sets.push(`${field} = ?`);
          values.push(emptyToNull(input[field]));
        }
      }
      if (sets.length) {
        this.db.prepare(`UPDATE products SET ${sets.join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE sku = ?`)
          .run(...values, sku);
        // A new channel link means that channel should receive the current stock.
        if (['woo_product_id', 'woo_variation_id', 'bol_offer_id'].some((f) => f in input && input[f] !== existing[f])) {
          this.enqueueSync(sku);
        }
      }
    }
    const product = this.getProduct(sku);
    this.bus.publish('product', product);
    return product;
  }

  /**
   * Split off a product that wrongly took several webshop variations together (they
   * shared one SKU): give it its own SKU and name, mark the stock as "not counted
   * yet" and drop its imported order history so it can be read in again per variation.
   */
  repairMergedProduct(oldSku, { sku, name }, { userName = null } = {}) {
    if (this.getProduct(sku)) throw new ValidationError(`SKU ${sku} bestaat al`);
    transaction(this.db, () => {
      this.db.prepare(`UPDATE products SET sku = ?, name = ?, stock_confirmed = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE sku = ?`)
        .run(sku, name, oldSku);
      this.db.prepare(`DELETE FROM stock_movements WHERE sku = ? AND channel = 'woocommerce' AND type IN ('sale', 'sale_reversal') AND applied = 0`).run(sku);
    });
    this.bus.log('warn', `Product ${oldSku} bevatte meerdere webshopvariaties; nu ${sku} "${name}" – voorraad opnieuw tellen${by(userName)}`, { sku });
    this.bus.publish('product_deleted', { sku: oldSku });
    this.bus.publish('product', this.getProduct(sku));
  }

  /**
   * What can be cleaned up: products without a webshop link that are not part of a
   * sales listing either (e.g. added from Bol.com earlier; `fromBol` marks those), and
   * sales listings without components (`listingId` set).
   */
  unlinkedProducts() {
    const products = this.db.prepare(`
      SELECT sku, name, ean, stock, bol_offer_id, name LIKE 'Bol.com-product %' AS fromBol FROM products p
      WHERE woo_product_id IS NULL AND NOT EXISTS (SELECT 1 FROM listing_components c WHERE c.item_sku = p.sku)
      ORDER BY fromBol DESC, name COLLATE NOCASE
    `).all().map((p) => ({ ...p, fromBol: Boolean(p.fromBol), listingId: null }));
    // Sales listings whose stock item is gone: nothing can be booked for them.
    const orphans = this.db.prepare(`
      SELECT id, sku, name, ean, bol_offer_id FROM listings l
      WHERE NOT EXISTS (SELECT 1 FROM listing_components c WHERE c.listing_id = l.id)
      ORDER BY name COLLATE NOCASE
    `).all().map((l) => ({ sku: l.sku ?? '', name: l.name, ean: l.ean, stock: null, bol_offer_id: l.bol_offer_id, fromBol: false, listingId: l.id }));
    return [...orphans, ...products];
  }

  /** Names of the sales listings that use this stock item. */
  listingsUsing(sku) {
    return this.db.prepare(`
      SELECT l.name FROM listing_components c JOIN listings l ON l.id = c.listing_id WHERE c.item_sku = ? ORDER BY l.name
    `).all(sku).map((r) => r.name);
  }

  #assertNotUsed(sku, action) {
    const used = this.listingsUsing(sku);
    if (used.length) {
      throw new ValidationError(`${sku} kan niet ${action}: het wordt gebruikt in ${used.map((n) => `"${n}"`).join(', ')}. Pas eerst die verkoopartikelen aan.`);
    }
  }

  deleteProduct(sku, { userName = null } = {}) {
    this.#assertNotUsed(sku, 'verwijderd worden');
    const { changes } = this.db.prepare('DELETE FROM products WHERE sku = ?').run(sku);
    if (changes) this.bus.log('info', `Product ${sku} verwijderd${by(userName)}`, { sku });
    this.bus.publish('product_deleted', { sku });
  }

  /**
   * Record the quantity sold on one order line (idempotent).
   *
   * `quantity` is the quantity that should currently count as sold for this line:
   * the ordered quantity, minus cancellations; 0 when the whole order is cancelled.
   * The ledger books only the difference with what was already booked for
   * `lineRef`, so receiving the same order again (webhook + poll, retries, status
   * updates) never double counts, and a cancellation automatically restocks.
   *
   * @param {object} opts
   * @param {'bol'|'woocommerce'} opts.channel
   * @param {string} opts.lineRef unique id of the order line, e.g. "bol:order-item:123"
   * @param {string} opts.sku
   * @param {number} opts.quantity
   * @param {string} [opts.occurredAt] ISO timestamp of the order (used for forecasting)
   * @param {boolean} [opts.applyToStock] false = history only (backfill). Defaults to
   *   true, except for orders placed before go-live.
   * @returns {object|null} the booked movement, or null when nothing changed
   */
  recordSale({ channel, lineRef, sku, quantity, occurredAt, note = null, applyToStock }) {
    if (applyToStock === undefined) {
      applyToStock = !(this.goLiveAt && occurredAt && occurredAt < this.goLiveAt);
    }
    const target = Math.max(0, Number.parseInt(quantity, 10) || 0);
    const movement = transaction(this.db, () => {
      const { booked, bookedApplied } = this.db.prepare(`
        SELECT -COALESCE(SUM(delta), 0) AS booked,
               -COALESCE(SUM(CASE WHEN applied = 1 THEN delta END), 0) AS bookedApplied
        FROM stock_movements WHERE line_ref = ? AND type IN ('sale', 'sale_reversal')
      `).get(lineRef);
      const diff = target - booked;
      if (diff === 0) return null;
      const base = { sku, channel, lineRef, note };
      if (diff > 0) {
        return this.#move({
          ...base, delta: -diff, type: 'sale', applied: applyToStock,
          createdAt: booked === 0 ? occurredAt : undefined,
        });
      }
      // Cancellation: only give back stock that was actually taken. Units booked as
      // history only (backfill) are reversed in the history as well, without stock effect.
      const returned = -diff;
      const restock = applyToStock ? Math.min(returned, bookedApplied) : 0;
      let last = null;
      if (returned - restock > 0) {
        last = this.#move({ ...base, delta: returned - restock, type: 'sale_reversal', applied: false });
      }
      if (restock > 0) {
        last = this.#move({ ...base, delta: restock, type: 'sale_reversal', applied: true });
      }
      return last;
    });

    if (movement?.applied) {
      const label = CHANNEL_LABELS[channel] ?? channel;
      const verb = movement.type === 'sale' ? 'verkocht' : 'terug op voorraad (annulering)';
      this.bus.log('info', `${Math.abs(movement.delta)}× ${sku} ${verb} via ${label} → voorraad ${movement.stock_after}`, { channel, sku });
      this.enqueueSync(sku);
      this.bus.publish('product', this.getProduct(sku));
    }
    return movement;
  }

  /** Add or remove stock, e.g. goods received (type 'receipt') or breakage ('correction'). */
  adjustStock({ sku, delta, type = 'correction', note = null, userName = null }) {
    const d = Number.parseInt(delta, 10);
    if (!Number.isFinite(d) || d === 0) throw new ValidationError('Aantal moet een geheel getal ≠ 0 zijn');
    if (!['receipt', 'correction'].includes(type)) throw new ValidationError('Ongeldig type');
    if (!this.getProduct(sku)) throw new NotFoundError(`Onbekend product ${sku}`);
    const movement = transaction(this.db, () => this.#move({ sku, delta: d, type, channel: 'manual', note, userName }));
    this.bus.log('info', `${type === 'receipt' ? 'Ontvangst' : 'Correctie'} ${d > 0 ? '+' : ''}${d} voor ${sku} → voorraad ${movement.stock_after}${by(userName)}`, { sku });
    this.enqueueSync(sku);
    this.bus.publish('product', this.getProduct(sku));
    return movement;
  }

  /** Stocktake: set the counted stock; the difference is booked as a correction. */
  setStock({ sku, count, note = 'Voorraadtelling', userName = null }) {
    const n = Number.parseInt(count, 10);
    if (!Number.isFinite(n) || n < 0) throw new ValidationError('Telling moet 0 of hoger zijn');
    const product = this.getProduct(sku);
    if (!product) throw new NotFoundError(`Onbekend product ${sku}`);
    // A stocktake makes the stock known: from now on it is synced to the channels.
    if (!product.stock_confirmed) this.db.prepare('UPDATE products SET stock_confirmed = 1 WHERE sku = ?').run(sku);
    if (n === product.stock) {
      if (!product.stock_confirmed) this.bus.log('info', `Voorraadtelling ${sku}: ${n}${by(userName)}`, { sku });
      this.bus.publish('product', this.getProduct(sku));
      this.enqueueSync(sku); // still re-push, useful to repair a channel
      return null;
    }
    return this.adjustStock({ sku, delta: n - product.stock, type: 'correction', note, userName });
  }

  movements(sku, limit = 100) {
    return this.db.prepare('SELECT * FROM stock_movements WHERE sku = ? ORDER BY created_at DESC, id DESC LIMIT ?').all(sku, limit);
  }

  /** Queue a push of the current stock of `sku` to every channel. */
  enqueueSync(sku, channels = this.channels) {
    const stmt = this.db.prepare(`
      INSERT INTO sync_queue (sku, channel, attempts, next_attempt_at, last_error)
      VALUES (?, ?, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL)
      ON CONFLICT(sku, channel) DO UPDATE SET attempts = 0, next_attempt_at = excluded.next_attempt_at
    `);
    for (const channel of channels) stmt.run(sku, channel);
    // Every sales listing that uses this item gets its availability recalculated too.
    const listings = this.db.prepare(`
      SELECT l.* FROM listings l JOIN listing_components c ON c.listing_id = l.id WHERE c.item_sku = ?
    `).all(sku);
    for (const listing of listings) this.enqueueListingSync(listing, channels, { notify: false });
    this.bus.emit('sync_requested');
  }

  /* ------------------------------------------------------------ sales listings */

  /** Queue a push of a listing's availability to the channels it is linked to. */
  enqueueListingSync(listing, channels = this.channels, { notify = true } = {}) {
    const stmt = this.db.prepare(`
      INSERT INTO listing_sync_queue (listing_id, channel, attempts, next_attempt_at, last_error)
      VALUES (?, ?, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL)
      ON CONFLICT(listing_id, channel) DO UPDATE SET attempts = 0, next_attempt_at = excluded.next_attempt_at
    `);
    for (const channel of channels) {
      if (channel === 'woocommerce' && !listing.woo_product_id) continue;
      if (channel === 'bol' && !listing.bol_offer_id && !listing.ean) continue;
      stmt.run(listing.id, channel);
    }
    if (notify) this.bus.emit('sync_requested');
  }

  getListing(id) {
    const listing = this.db.prepare('SELECT * FROM listings WHERE id = ?').get(id);
    if (!listing) return null;
    listing.components = this.db.prepare(`
      SELECT c.item_sku, c.quantity, p.name, p.unit FROM listing_components c JOIN products p ON p.sku = c.item_sku
      WHERE c.listing_id = ? ORDER BY p.name
    `).all(id);
    return listing;
  }

  /** All listings with components, what was last sent per channel and pending pushes. */
  listListings() {
    const stock = this.db.prepare('SELECT * FROM listing_stock').all();
    const pending = this.db.prepare('SELECT * FROM listing_sync_queue').all();
    return this.db.prepare('SELECT id FROM listings ORDER BY name COLLATE NOCASE').all().map(({ id }) => {
      const listing = this.getListing(id);
      listing.available = this.availableFor(listing);
      listing.channelStock = Object.fromEntries(stock.filter((s) => s.listing_id === id).map((s) => [s.channel, { stock: s.stock, syncedAt: s.synced_at }]));
      listing.pendingSync = Object.fromEntries(pending.filter((s) => s.listing_id === id).map((s) => [s.channel, { attempts: s.attempts, lastError: s.last_error }]));
      return listing;
    });
  }

  /** The listing an order line refers to (webshop ids, Bol.com offer, EAN or SKU), if any. */
  findListing({ wooProductId, wooVariationId, bolOfferId, ean, sku } = {}) {
    const q = (sql, ...args) => {
      const row = this.db.prepare(sql).get(...args);
      return row ? this.getListing(row.id) : null;
    };
    if (wooProductId) {
      const l = wooVariationId
        ? q('SELECT id FROM listings WHERE woo_product_id = ? AND woo_variation_id = ?', wooProductId, wooVariationId)
        : q('SELECT id FROM listings WHERE woo_product_id = ? AND woo_variation_id IS NULL', wooProductId);
      if (l) return l;
    }
    if (bolOfferId) {
      const l = q('SELECT id FROM listings WHERE bol_offer_id = ?', String(bolOfferId));
      if (l) return l;
    }
    if (ean) {
      const l = q('SELECT id FROM listings WHERE ean = ?', String(ean));
      if (l) return l;
    }
    if (sku) {
      const l = q('SELECT id FROM listings WHERE sku = ?', String(sku));
      if (l) return l;
    }
    return null;
  }

  /**
   * How many of a listing can be sold: the lowest of (stock ÷ quantity) over its
   * components. `known` is false while a component's stock has not been counted.
   */
  availableFor(listing) {
    let available = Infinity;
    let known = true;
    // Without components nothing can be booked or calculated: unknown, never pushed.
    if (!listing.components.length) return { quantity: 0, known: false };
    for (const c of listing.components) {
      const item = this.getProduct(c.item_sku);
      if (!item) continue;
      if (!item.stock_confirmed) known = false;
      available = Math.min(available, Math.floor(Math.max(0, item.stock) / c.quantity));
    }
    return { quantity: Number.isFinite(available) ? available : 0, known };
  }

  /** Book a sold listing: each component's stock goes down by quantity × its amount. */
  recordListingSale({ channel, lineRef, listing, quantity, occurredAt, note = null, applyToStock }) {
    let booked = 0;
    for (const c of listing.components) {
      const movement = this.recordSale({
        channel,
        lineRef: `${lineRef}#${c.item_sku}`,
        sku: c.item_sku,
        quantity: (Number.parseInt(quantity, 10) || 0) * c.quantity,
        occurredAt,
        note: [note, `${listing.name}${c.quantity > 1 ? ` (${c.quantity} ${c.unit === 'stuks' ? 'st.' : c.unit})` : ''}`].filter(Boolean).join(' – '),
        applyToStock,
      });
      if (movement) booked++;
    }
    return booked;
  }

  /**
   * Create or update a listing. `components` = [{ item_sku, quantity }]. With
   * `replace_product`, a product that was imported for this webshop variation/offer
   * is turned into this listing (the product is removed; its links move here).
   */
  saveListing(input, { userName = null } = {}) {
    const name = String(input.name ?? '').trim();
    if (!name) throw new ValidationError('Vul een naam in');
    const components = (input.components ?? []).filter((c) => c && c.item_sku);
    if (!components.length) throw new ValidationError('Kies minstens één voorraadartikel');
    const seen = new Set();
    for (const c of components) {
      c.quantity = Number(c.quantity);
      if (!Number.isInteger(c.quantity) || c.quantity < 1) throw new ValidationError('Aantal per verkoop moet een heel getal van 1 of meer zijn');
      if (!this.getProduct(c.item_sku)) throw new ValidationError(`Onbekend voorraadartikel ${c.item_sku}`);
      if (seen.has(c.item_sku)) throw new ValidationError('Elk voorraadartikel mag maar één keer voorkomen');
      seen.add(c.item_sku);
    }
    const fields = {
      name,
      sku: emptyToNull(String(input.sku ?? '').trim()),
      ean: emptyToNull(String(input.ean ?? '').trim()),
      woo_product_id: emptyToNull(input.woo_product_id) === null ? null : Number(input.woo_product_id),
      woo_variation_id: emptyToNull(input.woo_variation_id) === null ? null : Number(input.woo_variation_id),
      bol_offer_id: emptyToNull(String(input.bol_offer_id ?? '').trim()),
    };
    if (!fields.woo_product_id && !fields.bol_offer_id && !fields.ean) {
      throw new ValidationError('Koppel het verkoopartikel aan een webshopproduct of een Bol.com-aanbieding (EAN of offer-ID)');
    }
    const id = input.id ? Number(input.id) : null;
    const replace = input.replace_product ? String(input.replace_product) : null;
    if (replace && components.some((c) => c.item_sku === replace)) {
      throw new ValidationError('Een product kan niet worden omgezet naar een verkoopartikel van zichzelf');
    }
    if (replace) this.#assertNotUsed(replace, 'omgezet worden');

    // The same webshop variation / Bol offer may only be linked once.
    if (fields.woo_product_id) {
      const clash = this.db.prepare(`SELECT sku FROM products WHERE woo_product_id = ? AND woo_variation_id IS ? AND sku IS NOT ?`)
        .get(fields.woo_product_id, fields.woo_variation_id, replace);
      if (clash) throw new ValidationError(`Dit webshopproduct is al gekoppeld aan voorraadartikel ${clash.sku}. Zet dat product om naar een verkoopartikel.`);
      const other = this.db.prepare('SELECT name FROM listings WHERE woo_product_id = ? AND woo_variation_id IS ? AND id IS NOT ?')
        .get(fields.woo_product_id, fields.woo_variation_id, id);
      if (other) throw new ValidationError(`Dit webshopproduct is al gekoppeld aan verkoopartikel "${other.name}"`);
    }
    if (fields.bol_offer_id) {
      const clash = this.db.prepare('SELECT sku FROM products WHERE bol_offer_id = ? AND sku IS NOT ?').get(fields.bol_offer_id, replace);
      if (clash) throw new ValidationError(`Deze Bol.com-aanbieding is al gekoppeld aan voorraadartikel ${clash.sku}`);
      const other = this.db.prepare('SELECT name FROM listings WHERE bol_offer_id = ? AND id IS NOT ?').get(fields.bol_offer_id, id);
      if (other) throw new ValidationError(`Deze Bol.com-aanbieding is al gekoppeld aan verkoopartikel "${other.name}"`);
    }

    const savedId = transaction(this.db, () => {
      let listingId = id;
      if (listingId) {
        const { changes } = this.db.prepare(`
          UPDATE listings SET name = ?, sku = ?, ean = ?, woo_product_id = ?, woo_variation_id = ?, bol_offer_id = ? WHERE id = ?
        `).run(fields.name, fields.sku, fields.ean, fields.woo_product_id, fields.woo_variation_id, fields.bol_offer_id, listingId);
        if (!changes) throw new NotFoundError('Onbekend verkoopartikel');
        this.db.prepare('DELETE FROM listing_components WHERE listing_id = ?').run(listingId);
      } else {
        listingId = this.db.prepare(`
          INSERT INTO listings (name, sku, ean, woo_product_id, woo_variation_id, bol_offer_id) VALUES (?, ?, ?, ?, ?, ?) RETURNING id
        `).get(fields.name, fields.sku, fields.ean, fields.woo_product_id, fields.woo_variation_id, fields.bol_offer_id).id;
      }
      const add = this.db.prepare('INSERT INTO listing_components (listing_id, item_sku, quantity) VALUES (?, ?, ?)');
      for (const c of components) add.run(listingId, c.item_sku, c.quantity);
      if (replace) this.db.prepare('DELETE FROM products WHERE sku = ?').run(replace);
      return listingId;
    });
    const listing = this.getListing(savedId);
    const parts = listing.components.map((c) => `${c.quantity} × ${c.item_sku}`).join(' + ');
    this.bus.log('info', `Verkoopartikel "${listing.name}" ${id ? 'gewijzigd' : replace ? `gemaakt van product ${replace}` : 'toegevoegd'}: ${parts}${by(userName)}`);
    this.enqueueListingSync(listing);
    this.bus.publish('product', null);
    return listing;
  }

  /** Remember the Bol.com offer id of a listing (found via an order). */
  linkListingOffer(id, offerId) {
    this.db.prepare('UPDATE listings SET bol_offer_id = ? WHERE id = ?').run(offerId, id);
    const listing = this.getListing(id);
    this.bus.log('info', `Bol-offer ${offerId} automatisch gekoppeld aan verkoopartikel "${listing.name}"`, { channel: 'bol' });
    this.enqueueListingSync(listing, ['bol']);
  }

  deleteListing(id, { userName = null } = {}) {
    const listing = this.getListing(id);
    if (!listing) throw new NotFoundError('Onbekend verkoopartikel');
    this.db.prepare('DELETE FROM listings WHERE id = ?').run(id);
    this.bus.log('info', `Verkoopartikel "${listing.name}" verwijderd${by(userName)}`);
    this.bus.publish('product', null);
  }

  #move({ sku, delta, type, channel, lineRef = null, note = null, applied = true, createdAt, userName = null }) {
    let stockAfter = null;
    if (applied) {
      const row = this.db.prepare(`
        UPDATE products SET stock = stock + ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE sku = ? RETURNING stock
      `).get(delta, sku);
      if (!row) throw new NotFoundError(`Onbekend product ${sku}`);
      stockAfter = row.stock;
    }
    return this.db.prepare(`
      INSERT INTO stock_movements (sku, delta, stock_after, type, channel, line_ref, applied, note, user_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ','now')))
      RETURNING *
    `).get(sku, delta, stockAfter, type, channel, lineRef, applied ? 1 : 0, note, userName, createdAt ?? null);
  }
}

export class ValidationError extends Error {
  status = 400;
}

export class NotFoundError extends Error {
  status = 404;
}
