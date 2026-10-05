import { getKv, setKv } from '../db.js';
import { requestJson } from '../http.js';
import { SkipSync } from './errors.js';

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/**
 * Bol.com Retailer API connector.
 *
 * - Orders: Bol has no order webhooks, so orders are polled (default every 60 s) using
 *   `change-interval-minute` (new *and* changed orders, including cancellations).
 *   After downtime longer than an hour it catches up per day with `latest-change-date`.
 * - Stock: PUT /retailer/offers/{offerId}/stock with the central stock.
 */
export class BolChannel {
  name = 'bol';

  constructor({ config, db, bus, fetchImpl = fetch }) {
    this.config = config;
    this.db = db;
    this.bus = bus;
    this.fetchImpl = fetchImpl;
    this.token = null;
    this.tokenExpiresAt = 0;
    this.linkedOrders = new Set();
  }

  get mediaType() {
    return `application/vnd.retailer.${this.config.apiVersion}+json`;
  }

  async #accessToken() {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;
    const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64');
    const { data } = await requestJson(`${this.config.tokenUrl}?grant_type=client_credentials`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, Accept: 'application/json' },
      fetchImpl: this.fetchImpl,
    });
    this.token = data.access_token;
    this.tokenExpiresAt = Date.now() + Math.max(30, (data.expires_in ?? 299) - 30) * 1000;
    return this.token;
  }

  async #api(path, { method = 'GET', body } = {}) {
    const token = await this.#accessToken();
    const headers = { Authorization: `Bearer ${token}`, Accept: this.mediaType };
    if (body !== undefined) headers['Content-Type'] = this.mediaType;
    try {
      return (await requestJson(`${this.config.apiBase}${path}`, { method, headers, body, fetchImpl: this.fetchImpl })).data;
    } catch (err) {
      if (err.status === 401) this.token = null; // force a fresh token next time
      throw err;
    }
  }

  /** Check the API credentials; returns a short description for the dashboard. */
  async testConnection() {
    this.token = null;
    const data = await this.#api(`/retailer/orders?${new URLSearchParams({ 'fulfilment-method': this.config.fulfilmentMethod, status: 'OPEN', page: '1' })}`);
    const open = data?.orders?.length ?? 0;
    return `verbonden – ${open}${open === 50 ? '+' : ''} openstaande order(s)`;
  }

  /** Push the central stock to the Bol offer. */
  async pushStock(product, quantity) {
    if (!product.bol_offer_id) throw new SkipSync('geen Bol offer-ID gekoppeld');
    const amount = Math.min(this.config.maxStock, Math.max(0, quantity));
    await this.#api(`/retailer/offers/${encodeURIComponent(product.bol_offer_id)}/stock`, {
      method: 'PUT',
      body: { amount, managedByRetailer: true },
    });
    return amount;
  }

  /** Fetch all pages of GET /retailer/orders for the given query. */
  async listOrders(query) {
    const orders = [];
    for (let page = 1; page <= 100; page++) {
      const params = new URLSearchParams({ ...query, 'fulfilment-method': this.config.fulfilmentMethod, page: String(page) });
      const data = await this.#api(`/retailer/orders?${params}`);
      const batch = data?.orders ?? [];
      orders.push(...batch);
      if (batch.length < 50) break;
    }
    return orders;
  }

  /**
   * Poll for new/changed orders and book them. Returns the number of booked changes.
   */
  async poll(inventory, now = new Date()) {
    const last = getKv(this.db, 'bol:last_poll');
    const lastPoll = last ? new Date(last) : null;
    let orders;
    if (lastPoll && now - lastPoll < 55 * MINUTE_MS) {
      const minutes = Math.min(60, Math.ceil((now - lastPoll) / MINUTE_MS) + 2);
      orders = await this.listOrders({ status: 'ALL', 'change-interval-minute': String(minutes) });
    } else {
      // First run or catching up after downtime: open orders + everything changed per day.
      orders = await this.listOrders({ status: 'OPEN' });
      const from = lastPoll ?? now;
      for (const day of daysBetween(from, now, 90)) {
        orders.push(...await this.listOrders({ status: 'ALL', 'latest-change-date': day }));
      }
    }
    const booked = await this.bookOrders(inventory, orders);
    setKv(this.db, 'bol:last_poll', now.toISOString());
    return booked;
  }

  /** Import historical orders (up to 3 months) for the forecast without touching stock. */
  async backfill(inventory, days = 90, now = new Date()) {
    const orders = [];
    for (const day of daysBetween(new Date(now.getTime() - days * DAY_MS), now, 90)) {
      orders.push(...await this.listOrders({ status: 'ALL', 'latest-change-date': day }));
    }
    return this.bookOrders(inventory, orders, { applyToStock: false });
  }

  async bookOrders(inventory, orders, { applyToStock } = {}) {
    let booked = 0;
    const seen = new Set();
    for (const order of orders) {
      for (const item of order.orderItems ?? []) {
        if (seen.has(item.orderItemId)) continue;
        seen.add(item.orderItemId);
        if (this.config.fulfilmentMethod !== 'ALL' && item.fulfilmentMethod && item.fulfilmentMethod !== this.config.fulfilmentMethod) continue;

        let product = inventory.findProduct({ ean: item.ean });
        if (!product || !product.bol_offer_id) {
          product = (await this.#linkFromOrderDetail(inventory, order.orderId, item.orderItemId)) ?? product;
        }
        if (!product) {
          this.bus.log('warn', `Onbekend product in Bol-order ${order.orderId} (EAN ${item.ean}) – voeg het product toe of vul de EAN in`, { channel: this.name });
          continue;
        }
        const quantity = (item.quantity ?? 0) - (item.quantityCancelled ?? 0);
        const movement = inventory.recordSale({
          channel: this.name,
          lineRef: `bol:order-item:${item.orderItemId}`,
          sku: product.sku,
          quantity,
          occurredAt: order.orderPlacedDateTime ? new Date(order.orderPlacedDateTime).toISOString() : undefined,
          note: `Bol-order ${order.orderId}`,
          applyToStock,
        });
        if (movement) booked++;
      }
    }
    return booked;
  }

  /**
   * The order list only contains EANs; the order detail contains the offer id and the
   * offer reference (usually your SKU). Use it to link products to their Bol offer.
   */
  async #linkFromOrderDetail(inventory, orderId, orderItemId) {
    if (this.linkedOrders.has(orderId)) return null;
    this.linkedOrders.add(orderId);
    let detail;
    try {
      detail = await this.#api(`/retailer/orders/${encodeURIComponent(orderId)}`);
    } catch (err) {
      this.bus.log('warn', `Orderdetail ${orderId} ophalen mislukt: ${err.message}`, { channel: this.name });
      return null;
    }
    const item = detail?.orderItems?.find((i) => String(i.orderItemId) === String(orderItemId));
    if (!item) return null;
    const offerId = item.offer?.offerId;
    const product = inventory.findProduct({ bolOfferId: offerId, sku: item.offer?.reference, ean: item.product?.ean });
    if (product && offerId && !product.bol_offer_id) {
      this.bus.log('info', `Bol-offer ${offerId} automatisch gekoppeld aan ${product.sku}`, { channel: this.name, sku: product.sku });
      return inventory.upsertProduct({ sku: product.sku, bol_offer_id: String(offerId) });
    }
    return product;
  }
}

/** YYYY-MM-DD dates from `from` to `to` inclusive (at most `maxDays`, most recent kept). */
export function daysBetween(from, to, maxDays) {
  const days = [];
  const start = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  for (let t = start; t <= to.getTime(); t += DAY_MS) days.push(new Date(t).toISOString().slice(0, 10));
  return days.slice(-maxDays);
}
