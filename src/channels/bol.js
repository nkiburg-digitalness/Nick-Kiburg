import { getKv, setKv } from '../db.js';
import { requestJson } from '../http.js';
import { SkipSync } from './errors.js';
import { parseCsv, matchByReference } from '../importer.js';

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

  constructor({ config, db, bus, fetchImpl = fetch, knownElsewhere = () => null }) {
    this.config = config;
    this.knownElsewhere = knownElsewhere; // ({ offerId, ean }) → name of another webshop on this Bol.com account
    this.db = db;
    this.bus = bus;
    this.fetchImpl = fetchImpl;
    this.token = null;
    this.tokenExpiresAt = 0;
    this.orderDetails = new Map(); // orderId → detail (or null when it could not be fetched)
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

  async #api(path, { method = 'GET', body, accept = this.mediaType, language, maxAttempts = 4 } = {}) {
    const token = await this.#accessToken();
    const headers = { Authorization: `Bearer ${token}`, Accept: accept };
    if (language) headers['Accept-Language'] = language;
    if (body !== undefined) headers['Content-Type'] = this.mediaType;
    for (let attempt = 1; ; attempt++) {
      try {
        return (await requestJson(`${this.config.apiBase}${path}`, { method, headers, body, fetchImpl: this.fetchImpl })).data;
      } catch (err) {
        if (err.status === 401) this.token = null; // force a fresh token next time
        // Too many requests: Bol.com says how long to wait (header, or "retry in 13 seconds"
        // in the message). Wait that long, plus a little, and try again.
        if (err.status === 429 && attempt < maxAttempts) {
          const said = err.retryAfterSeconds ?? Number((String(err.message).match(/retry in (\d+) sec/i) ?? [])[1]);
          const seconds = Number.isFinite(said) && said > 0 ? said + 1 : attempt * 5;
          const waitMs = Math.min(90, seconds) * 1000 * (this.config.retryScale ?? 1);
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          continue;
        }
        throw err;
      }
    }
  }

  /** Check the API credentials; returns a short description for the dashboard. */
  async testConnection() {
    this.token = null;
    const data = await this.#api(`/retailer/orders?${new URLSearchParams({ 'fulfilment-method': this.config.fulfilmentMethod, status: 'OPEN', page: '1' })}`);
    const open = data?.orders?.length ?? 0;
    return `verbonden – ${open}${open === 50 ? '+' : ''} openstaande order(s)`;
  }

  /**
   * Product title on Bol.com (catalog content), to recognise an offer by name.
   * Best effort: null when it cannot be fetched.
   */
  async productTitle(ean) {
    try {
      const data = await this.#api(`/retailer/content/catalog-products/${encodeURIComponent(ean)}`, { language: 'nl' });
      const attr = (data?.attributes ?? []).find((a) => String(a.id).toLowerCase() === 'title');
      return attr?.values?.[0]?.value ?? null;
    } catch {
      return null;
    }
  }

  /**
   * All offers of this Bol.com account (offer export: request → wait for the
   * process → download CSV). Returns [{ offerId, ean, reference, stock, fulfilment }].
   */
  async exportOffers({ pollMs = 3000, timeoutMs = 5 * 60 * 1000 } = {}) {
    const started = await this.#api('/retailer/offers/export', { method: 'POST', body: { format: 'CSV' } });
    let status = started;
    const deadline = Date.now() + timeoutMs;
    while (status?.status !== 'SUCCESS') {
      if (['FAILURE', 'TIMEOUT'].includes(status?.status)) {
        throw new Error(`Bol.com kon de aanbiedingenlijst niet maken: ${status.errorMessage || status.status}`);
      }
      if (Date.now() > deadline) throw new Error('Bol.com heeft de aanbiedingenlijst nog niet klaar; probeer het over een paar minuten opnieuw');
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      status = await this.#api(`/shared/process-status/${encodeURIComponent(started.processStatusId)}`);
    }
    const csv = await this.#api(`/retailer/offers/export/${encodeURIComponent(status.entityId)}`, {
      accept: `application/vnd.retailer.${this.config.apiVersion}+csv`,
    });
    const pick = (row, ...keys) => {
      for (const k of keys) if (row[k.toLowerCase()]) return row[k.toLowerCase()];
      return null;
    };
    return parseCsv(String(csv ?? '')).map((row) => ({
      offerId: pick(row, 'offerId', 'offer-id'),
      ean: pick(row, 'ean'),
      reference: pick(row, 'referenceCode', 'reference'),
      stock: Number.parseInt(pick(row, 'stockAmount', 'correctedStock') ?? '', 10),
      fulfilment: (pick(row, 'fulfilmentType', 'fulfilmentMethod', 'fulfilment') ?? '').toUpperCase(),
    })).filter((o) => o.offerId);
  }

  /** Push the central stock to the Bol offer. */
  async pushStock(product, quantity) {
    if (!product.bol_offer_id) throw new SkipSync('geen Bol offer-ID gekoppeld');
    const amount = Math.min(this.config.maxStock, Math.max(0, quantity));
    const started = await this.#api(`/retailer/offers/${encodeURIComponent(product.bol_offer_id)}/stock`, {
      method: 'PUT',
      body: { amount, managedByRetailer: true },
    });
    await this.#confirmProcess(started);
    return amount;
  }

  /**
   * Bol.com accepts a stock update first and processes it afterwards. Wait briefly for
   * the outcome so a refused update shows up as an error (and is retried) instead of
   * silently counting as sent. Still pending after the wait: assume it goes through.
   */
  async #confirmProcess(started) {
    if (!started?.processStatusId) return;
    const pollMs = this.config.processPollMs ?? 1500;
    const deadline = Date.now() + (this.config.processWaitMs ?? 8000);
    let status = started;
    for (;;) {
      if (status?.status === 'SUCCESS') return;
      if (['FAILURE', 'TIMEOUT'].includes(status?.status)) {
        throw new Error(`Bol.com heeft de voorraad niet verwerkt: ${status.errorMessage || status.status}`);
      }
      if (Date.now() >= deadline) return;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      try {
        status = await this.#api(`/shared/process-status/${encodeURIComponent(started.processStatusId)}`);
      } catch {
        return; // the update itself was accepted; only the status check failed
      }
    }
  }

  /** Dropshipping on Bol.com: the maximum when available, otherwise 0. */
  async pushAvailability(product, available) {
    await this.pushStock(product, available ? this.config.maxStock : 0);
    return available ? 1 : 0;
  }

  /** Fetch all pages of GET /retailer/orders for the given query. */
  async listOrders(query, { maxAttempts } = {}) {
    const orders = [];
    for (let page = 1; page <= 100; page++) {
      const params = new URLSearchParams({ ...query, 'fulfilment-method': this.config.fulfilmentMethod, page: String(page) });
      const data = await this.#api(`/retailer/orders?${params}`, { maxAttempts });
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
  /**
   * Import order history (no stock effect). Bol.com rate-limits the order list, so the
   * days are requested at a calm pace, a "too many requests" is waited out, and each
   * day is booked right away: if Bol.com keeps refusing, what was read stays.
   */
  async backfill(inventory, days = 90, now = new Date(), { onProgress = null } = {}) {
    const dayList = daysBetween(new Date(now.getTime() - days * DAY_MS), now, BOL_HISTORY_DAYS);
    const stats = { orders: 0, lines: 0, otherShop: 0, unknown: 0, unknownEans: [] };
    const seenOrders = new Set();
    let booked = 0;
    let daysRead = 0;
    for (const day of dayList) {
      let orders;
      try {
        orders = await this.listOrders({ status: 'ALL', 'latest-change-date': day }, { maxAttempts: 10 });
      } catch (err) {
        return { booked, days: daysRead, ...stats, error: `gestopt bij ${day}: ${err.message}` };
      }
      orders = orders.filter((o) => !seenOrders.has(o.orderId) && seenOrders.add(o.orderId));
      stats.orders += orders.length;
      booked += await this.bookOrders(inventory, orders, { applyToStock: false, stats });
      daysRead++;
      onProgress?.(daysRead, dayList.length);
      await new Promise((resolve) => setTimeout(resolve, this.config.historyPaceMs ?? 1200));
    }
    return { booked, days: daysRead, ...stats };
  }

  async bookOrders(inventory, orders, { applyToStock, stats = null } = {}) {
    let booked = 0;
    const seen = new Set();
    for (const order of orders) {
      for (const item of order.orderItems ?? []) {
        if (seen.has(item.orderItemId)) continue;
        seen.add(item.orderItemId);
        if (this.config.fulfilmentMethod !== 'ALL' && item.fulfilmentMethod && item.fulfilmentMethod !== this.config.fulfilmentMethod) continue;
        if (stats) stats.lines++;

        const lineRef = `bol:order-item:${item.orderItemId}`;
        const quantity = (item.quantity ?? 0) - (item.quantityCancelled ?? 0);
        const occurredAt = order.orderPlacedDateTime ? new Date(order.orderPlacedDateTime).toISOString() : undefined;

        // A sales listing (e.g. "Tochtband 10 m" = 10 m of the stock item) takes precedence.
        const listing = inventory.findListing({ ean: item.ean });
        if (listing) {
          if (!listing.bol_offer_id && !stats) {
            const detail = await this.#orderItemDetail(order.orderId, item.orderItemId);
            if (detail?.offer?.offerId) inventory.linkListingOffer(listing.id, String(detail.offer.offerId));
          }
          booked += inventory.recordListingSale({
            channel: this.name, lineRef, listing, quantity, occurredAt, note: `Bol-order ${order.orderId}`, applyToStock,
          });
          continue;
        }

        let product = inventory.findProduct({ ean: item.ean });
        // Sold by another webshop on the same Bol.com account: not ours, nothing to do.
        if (!product && this.knownElsewhere({ ean: item.ean })) {
          if (stats) stats.otherShop++;
          continue;
        }
        // Live orders: the order detail links the Bol offer. Not for history imports
        // (hundreds of extra requests and Bol.com rate limits); EAN matching suffices.
        if (!stats && (!product || !product.bol_offer_id)) {
          product = (await this.#linkFromOrderDetail(inventory, order.orderId, item.orderItemId)) ?? product;
        }
        if (!product) {
          if (stats) {
            stats.unknown++;
            if (item.ean && stats.unknownEans.length < 20 && !stats.unknownEans.includes(item.ean)) stats.unknownEans.push(item.ean);
            continue; // summarised in the result instead of one warning per line
          }
          this.bus.log('warn', `Onbekend product in Bol-order ${order.orderId} (EAN ${item.ean}) – voeg het product toe of vul de EAN in`, { channel: this.name });
          continue;
        }
        const movement = inventory.recordSale({
          channel: this.name,
          lineRef,
          sku: product.sku,
          quantity,
          occurredAt,
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
  /** One order line from the order detail (fetched once per order). */
  async #orderItemDetail(orderId, orderItemId) {
    if (!this.orderDetails.has(orderId)) {
      try {
        this.orderDetails.set(orderId, await this.#api(`/retailer/orders/${encodeURIComponent(orderId)}`));
      } catch (err) {
        this.bus.log('warn', `Orderdetail ${orderId} ophalen mislukt: ${err.message}`, { channel: this.name });
        this.orderDetails.set(orderId, null);
      }
      if (this.orderDetails.size > 500) this.orderDetails.delete(this.orderDetails.keys().next().value);
    }
    return this.orderDetails.get(orderId)?.orderItems?.find((i) => String(i.orderItemId) === String(orderItemId)) ?? null;
  }

  async #linkFromOrderDetail(inventory, orderId, orderItemId) {
    const item = await this.#orderItemDetail(orderId, orderItemId);
    if (!item) return null;
    const offerId = item.offer?.offerId;
    const ean = item.product?.ean;
    let product = inventory.findProduct({ bolOfferId: offerId }) ?? (ean ? inventory.findProduct({ ean }) : null);
    // The offer reference is free text (often a SKU): only trust it if the EAN does not say otherwise.
    if (!product && item.offer?.reference) product = matchByReference(inventory, item.offer.reference, ean);
    if (product && offerId && !product.bol_offer_id) {
      this.bus.log('info', `Bol-offer ${offerId} automatisch gekoppeld aan ${product.sku}`, { channel: this.name, sku: product.sku });
      return inventory.upsertProduct({ sku: product.sku, bol_offer_id: String(offerId) });
    }
    return product;
  }
}

/** YYYY-MM-DD dates from `from` to `to` inclusive (at most `maxDays`, most recent kept). */
/** Bol.com only returns orders of the last 3 months. */
export const BOL_HISTORY_DAYS = 90;

export function daysBetween(from, to, maxDays) {
  const days = [];
  const start = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  for (let t = start; t <= to.getTime(); t += DAY_MS) days.push(new Date(t).toISOString().slice(0, 10));
  return days.slice(-maxDays);
}
