import { createHmac, timingSafeEqual } from 'node:crypto';
import { getKv, setKv } from '../db.js';
import { requestJson } from '../http.js';
import { SkipSync } from './errors.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * WooCommerce connector (own webshop).
 *
 * - Orders arrive in real time via webhooks (order.created / order.updated) that are
 *   verified with the webhook secret. A periodic poll of recently modified orders
 *   catches anything a webhook missed.
 * - Stock: PUT /wp-json/wc/v3/products/{id} (or …/variations/{id}) with stock_quantity.
 */
export class WooCommerceChannel {
  name = 'woocommerce';

  constructor({ config, db, bus, fetchImpl = fetch }) {
    this.config = config;
    this.db = db;
    this.bus = bus;
    this.fetchImpl = fetchImpl;
  }

  #headers() {
    const basic = Buffer.from(`${this.config.consumerKey}:${this.config.consumerSecret}`).toString('base64');
    return { Authorization: `Basic ${basic}`, Accept: 'application/json', 'Content-Type': 'application/json' };
  }

  async #api(path, { method = 'GET', body } = {}) {
    return requestJson(`${this.config.baseUrl}/wp-json/wc/v3${path}`, {
      method, body, headers: this.#headers(), fetchImpl: this.fetchImpl,
    });
  }

  /** Check the API keys; returns a short description for the dashboard. */
  async testConnection() {
    const { headers } = await this.#api('/products?per_page=1');
    const total = headers.get('x-wp-total');
    return total ? `verbonden – ${total} producten in de webshop` : 'verbonden';
  }

  async pushStock(product, quantity) {
    if (!product.woo_product_id) throw new SkipSync('geen WooCommerce product-ID gekoppeld');
    const path = product.woo_variation_id
      ? `/products/${product.woo_product_id}/variations/${product.woo_variation_id}`
      : `/products/${product.woo_product_id}`;
    const stock = Math.max(0, quantity);
    await this.#api(path, { method: 'PUT', body: { manage_stock: true, stock_quantity: stock } });
    return stock;
  }

  /** Verify the X-WC-Webhook-Signature header (base64 HMAC-SHA256 of the raw body). */
  verifySignature(rawBody, signature) {
    if (!this.config.webhookSecret || !signature) return false;
    const expected = createHmac('sha256', this.config.webhookSecret).update(rawBody).digest();
    let given;
    try {
      given = Buffer.from(signature, 'base64');
    } catch {
      return false;
    }
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  /**
   * Book one WooCommerce order. Lines count as sold while the order is in a
   * "count" status (processing/on-hold/completed) and are released again when the
   * order moves to a "release" status (cancelled/failed/pending). Other statuses
   * (e.g. refunded, unless configured) leave the booked quantity untouched.
   */
  bookOrder(inventory, order, { applyToStock } = {}) {
    let target;
    if (this.config.countStatuses.includes(order.status)) target = 'count';
    else if (this.config.releaseStatuses.includes(order.status)) target = 'release';
    else return 0;

    const occurredAt = order.date_created_gmt ? toIsoUtc(order.date_created_gmt) : undefined;
    let booked = 0;
    for (const line of order.line_items ?? []) {
      const lineRef = `woocommerce:order-item:${line.id}`;
      const note = `Webshop-order #${order.number ?? order.id}`;
      // A sales listing (e.g. "2 stuks", "10 m", or a package) takes precedence.
      const listing = inventory.findListing({ wooProductId: line.product_id || undefined, wooVariationId: line.variation_id || undefined });
      if (listing) {
        booked += inventory.recordListingSale({
          channel: this.name, lineRef, listing, quantity: target === 'count' ? line.quantity : 0, occurredAt, note, applyToStock,
        });
        continue;
      }
      const product = inventory.findProduct({
        sku: line.sku || undefined,
        wooProductId: line.product_id || undefined,
        wooVariationId: line.variation_id || undefined,
      });
      if (!product) {
        if (target === 'count') {
          this.bus.log('warn', `Onbekend product in webshop-order #${order.number ?? order.id}: "${line.name}" (SKU ${line.sku || '–'})`, { channel: this.name });
        }
        continue;
      }
      // Remember the WooCommerce ids so stock can be pushed back to this product.
      if (!product.woo_product_id && line.product_id) {
        inventory.upsertProduct({ sku: product.sku, woo_product_id: line.product_id, woo_variation_id: line.variation_id || null });
      }
      const movement = inventory.recordSale({
        channel: this.name,
        lineRef,
        sku: product.sku,
        quantity: target === 'count' ? line.quantity : 0,
        occurredAt,
        note,
        applyToStock,
      });
      if (movement) booked++;
    }
    return booked;
  }

  async #ordersSince(after, { field = 'modified_after' } = {}) {
    const orders = [];
    for (let page = 1; page <= 200; page++) {
      const params = new URLSearchParams({
        [field]: after.toISOString(),
        dates_are_gmt: 'true',
        per_page: '100',
        page: String(page),
        orderby: 'date',
        order: 'asc',
      });
      const { data, headers } = await this.#api(`/orders?${params}`);
      orders.push(...(data ?? []));
      const totalPages = Number.parseInt(headers.get('x-wp-totalpages') ?? '1', 10);
      if (page >= totalPages || !data?.length) break;
    }
    return orders;
  }

  /** Safety net for missed webhooks: re-read orders modified since the last poll. */
  async poll(inventory, now = new Date()) {
    const last = getKv(this.db, 'woocommerce:last_poll');
    // Small overlap so orders modified during the previous request aren't missed.
    const since = last ? new Date(new Date(last).getTime() - 2 * 60 * 1000) : now;
    const orders = last ? await this.#ordersSince(since) : [];
    let booked = 0;
    for (const order of orders) booked += this.bookOrder(inventory, order);
    setKv(this.db, 'woocommerce:last_poll', now.toISOString());
    return booked;
  }

  /** Import historical orders for the forecast without touching stock. */
  async backfill(inventory, days = 90, now = new Date()) {
    const orders = await this.#ordersSince(new Date(now.getTime() - days * DAY_MS), { field: 'after' });
    let booked = 0;
    for (const order of orders) booked += this.bookOrder(inventory, order, { applyToStock: false });
    return booked;
  }

  /** List all webshop products (incl. variations) – used to link products by SKU. */
  async listProducts() {
    const result = [];
    for (let page = 1; page <= 100; page++) {
      const { data, headers } = await this.#api(`/products?per_page=100&page=${page}`);
      for (const p of data ?? []) {
        if (p.type === 'variable') {
          const { data: variations } = await this.#api(`/products/${p.id}/variations?per_page=100`);
          for (const v of variations ?? []) {
            result.push({ woo_product_id: p.id, woo_variation_id: v.id, sku: v.sku, name: `${p.name} – ${(v.attributes ?? []).map((a) => a.option).join(', ')}`, stock: v.manage_stock === true ? v.stock_quantity : null, ean: eanOf(v) });
          }
        } else {
          result.push({ woo_product_id: p.id, woo_variation_id: null, sku: p.sku, name: p.name, stock: p.manage_stock ? p.stock_quantity : null, ean: eanOf(p) });
        }
      }
      const totalPages = Number.parseInt(headers.get('x-wp-totalpages') ?? '1', 10);
      if (page >= totalPages || !data?.length) break;
    }
    return result;
  }
}

/**
 * EAN of a WooCommerce product: the standard "GTIN, UPC, EAN or ISBN" field
 * (WooCommerce 9.2+), or a field of a popular EAN/barcode plugin.
 */
export function eanOf(product) {
  const valid = (v) => (/^\d{8,14}$/.test(String(v ?? '').trim()) ? String(v).trim() : null);
  if (valid(product.global_unique_id)) return valid(product.global_unique_id);
  for (const meta of product.meta_data ?? []) {
    if (/ean|gtin|barcode/i.test(meta.key) && valid(meta.value)) return valid(meta.value);
  }
  return null;
}

/** WooCommerce *_gmt fields have no timezone suffix. */
function toIsoUtc(value) {
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`).toISOString();
}
