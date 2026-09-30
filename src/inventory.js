import { transaction } from './db.js';

export const CHANNEL_LABELS = {
  bol: 'Bol.com',
  woocommerce: 'Webshop',
  manual: 'Handmatig',
};

const PRODUCT_FIELDS = [
  'name', 'ean', 'lead_time_days', 'safety_days', 'woo_product_id', 'woo_variation_id', 'bol_offer_id',
];

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
  upsertProduct(input) {
    const sku = String(input.sku ?? '').trim();
    if (!sku) throw new ValidationError('SKU is verplicht');
    const existing = this.getProduct(sku);

    if (!existing) {
      if (!input.name) throw new ValidationError('Naam is verplicht');
      const stock = Number.parseInt(input.stock ?? 0, 10) || 0;
      transaction(this.db, () => {
        this.db.prepare(`
          INSERT INTO products (sku, name, ean, stock, lead_time_days, safety_days, woo_product_id, woo_variation_id, bol_offer_id)
          VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)
        `).run(
          sku, input.name, emptyToNull(input.ean),
          input.lead_time_days ?? 14, input.safety_days ?? 7,
          emptyToNull(input.woo_product_id), emptyToNull(input.woo_variation_id), emptyToNull(input.bol_offer_id),
        );
        if (stock !== 0) this.#move({ sku, delta: stock, type: 'correction', channel: 'manual', note: 'Beginvoorraad' });
      });
      this.bus.log('info', `Product ${sku} aangemaakt (voorraad ${stock})`, { sku });
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

  deleteProduct(sku) {
    this.db.prepare('DELETE FROM products WHERE sku = ?').run(sku);
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
  adjustStock({ sku, delta, type = 'correction', note = null }) {
    const d = Number.parseInt(delta, 10);
    if (!Number.isFinite(d) || d === 0) throw new ValidationError('Aantal moet een geheel getal ≠ 0 zijn');
    if (!['receipt', 'correction'].includes(type)) throw new ValidationError('Ongeldig type');
    if (!this.getProduct(sku)) throw new NotFoundError(`Onbekend product ${sku}`);
    const movement = transaction(this.db, () => this.#move({ sku, delta: d, type, channel: 'manual', note }));
    this.bus.log('info', `${type === 'receipt' ? 'Ontvangst' : 'Correctie'} ${d > 0 ? '+' : ''}${d} voor ${sku} → voorraad ${movement.stock_after}`, { sku });
    this.enqueueSync(sku);
    this.bus.publish('product', this.getProduct(sku));
    return movement;
  }

  /** Stocktake: set the counted stock; the difference is booked as a correction. */
  setStock({ sku, count, note = 'Voorraadtelling' }) {
    const n = Number.parseInt(count, 10);
    if (!Number.isFinite(n) || n < 0) throw new ValidationError('Telling moet 0 of hoger zijn');
    const product = this.getProduct(sku);
    if (!product) throw new NotFoundError(`Onbekend product ${sku}`);
    if (n === product.stock) {
      this.enqueueSync(sku); // still re-push, useful to repair a channel
      return null;
    }
    return this.adjustStock({ sku, delta: n - product.stock, type: 'correction', note });
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
    this.bus.emit('sync_requested');
  }

  #move({ sku, delta, type, channel, lineRef = null, note = null, applied = true, createdAt }) {
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
      INSERT INTO stock_movements (sku, delta, stock_after, type, channel, line_ref, applied, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ','now')))
      RETURNING *
    `).get(sku, delta, stockAfter, type, channel, lineRef, applied ? 1 : 0, note, createdAt ?? null);
  }
}

export class ValidationError extends Error {
  status = 400;
}

export class NotFoundError extends Error {
  status = 404;
}
