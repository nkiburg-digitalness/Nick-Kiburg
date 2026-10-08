const DAY_MS = 24 * 60 * 60 * 1000;

function dayKey(date) {
  return date.toISOString().slice(0, 10);
}

function sum(values) {
  return values.reduce((a, b) => a + b, 0);
}

/**
 * Pure forecast calculation for one product.
 *
 *   average sales per day = units sold in the window / selling days in the window
 *   days until sold out   = stock / average sales per day
 *   reorder point         = average sales per day × (lead time + safety days)
 *   latest order date     = sold-out date − lead time − safety days
 *   order advice          = enough to cover lead time + safety + `coverDays`, minus stock
 *
 * "Selling days" are the days in the window on which the product could be sold:
 * days before the product was tracked and days on which it was out of stock (and
 * nothing was sold) are left out, so a stock-out doesn't make the product look
 * slower than it is. Products tracked for only a few days are averaged over at least
 * `minTrackedDays`, so one early sale doesn't produce an unrealistic average.
 *
 * @param {object} p
 * @param {number} p.stock current stock
 * @param {number[]} p.dailySales units sold per day, oldest first, last element = today
 * @param {boolean[]} [p.outOfStockDays] per day: true if the product was sold out all day
 * @param {number} p.trackedDays days since this product has data
 * @param {number} p.leadTimeDays supplier lead time
 * @param {number} p.safetyDays extra buffer
 * @param {number} [p.minTrackedDays=7]
 * @param {number} [p.coverDays=60]
 * @param {Date} [p.now]
 */
export function computeForecast({
  stock, dailySales, outOfStockDays = [], trackedDays, leadTimeDays, safetyDays,
  minTrackedDays = 7, coverDays = 60, now = new Date(),
}) {
  const windowDays = dailySales.length;
  const trackedInWindow = Math.max(1, Math.min(windowDays, Math.max(trackedDays, minTrackedDays)));
  const from = windowDays - trackedInWindow;
  const unitsSold = sum(dailySales.slice(from));
  const outOfStock = outOfStockDays.slice(from).filter(Boolean).length;
  const sellingDays = Math.max(1, trackedInWindow - outOfStock);
  const avgPerDay = unitsSold / sellingDays;

  // Trend: last 7 days compared to the whole window (only meaningful with a longer window).
  const shortDays = Math.min(7, trackedInWindow);
  const shortSelling = Math.max(1, shortDays - outOfStockDays.slice(-shortDays).filter(Boolean).length);
  const shortAvg = sum(dailySales.slice(-shortDays)) / shortSelling;
  const trendPct = avgPerDay > 0 && trackedInWindow > shortDays ? ((shortAvg - avgPerDay) / avgPerDay) * 100 : null;

  const leadAndSafety = leadTimeDays + safetyDays;
  const daysLeft = avgPerDay > 0 ? Math.max(0, stock) / avgPerDay : null; // null = no sales → never
  const soldOutDate = daysLeft === null ? null : new Date(now.getTime() + daysLeft * DAY_MS);
  const orderByDate = soldOutDate === null ? null : new Date(soldOutDate.getTime() - leadAndSafety * DAY_MS);
  const reorderPoint = Math.ceil(avgPerDay * leadAndSafety);
  const orderAdvice = avgPerDay > 0 ? Math.max(0, Math.ceil(avgPerDay * (leadAndSafety + coverDays)) - Math.max(0, stock)) : 0;

  let status;
  if (stock <= 0) status = 'out';
  else if (daysLeft === null) status = 'ok';
  else if (daysLeft <= leadTimeDays) status = 'critical';
  else if (daysLeft <= leadAndSafety) status = 'warning';
  else status = 'ok';

  return {
    windowDays,
    sellingDays,
    outOfStockDays: outOfStock,
    unitsSold,
    avgPerDay: round(avgPerDay, 2),
    trendPct: trendPct === null ? null : Math.round(trendPct),
    daysLeft: daysLeft === null ? null : round(daysLeft, 1),
    soldOutDate: soldOutDate ? dayKey(soldOutDate) : null,
    orderByDate: orderByDate ? dayKey(orderByDate) : null,
    reorderPoint,
    orderAdvice,
    status,
  };
}

function round(value, decimals) {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

function windowOf(windowDays, now) {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(today.getTime() - (windowDays - 1) * DAY_MS);
  const days = Array.from({ length: windowDays }, (_, i) => dayKey(new Date(start.getTime() + i * DAY_MS)));
  return { start, days, dayIndex: new Map(days.map((d, i) => [d, i])) };
}

/**
 * Read the ledger for the window: units sold per day and channel, and the stock at
 * the end of each day (reconstructed by walking back from the current stock).
 */
function loadDaily(db, products, { start, days, dayIndex }) {
  const n = days.length;
  const bySku = new Map(products.map((p) => [p.sku, {
    sold: new Array(n).fill(0),
    soldByChannel: {},
    appliedDelta: new Array(n).fill(0),
  }]));

  const rows = db.prepare(`
    SELECT sku, channel, substr(created_at, 1, 10) AS day,
           -SUM(CASE WHEN type IN ('sale', 'sale_reversal') THEN delta ELSE 0 END) AS units,
           SUM(CASE WHEN applied = 1 THEN delta ELSE 0 END) AS applied_delta
    FROM stock_movements
    WHERE created_at >= ?
    GROUP BY sku, channel, day
  `).all(start.toISOString());

  for (const row of rows) {
    const entry = bySku.get(row.sku);
    const i = dayIndex.get(row.day);
    if (!entry || i === undefined) continue;
    entry.sold[i] += row.units;
    entry.appliedDelta[i] += row.applied_delta;
    if (row.units) {
      entry.soldByChannel[row.channel] ??= new Array(n).fill(0);
      entry.soldByChannel[row.channel][i] += row.units;
    }
  }

  for (const p of products) {
    const entry = bySku.get(p.sku);
    const createdDay = p.created_at.slice(0, 10);
    entry.stockEnd = new Array(n).fill(null);
    let running = p.stock;
    for (let i = n - 1; i >= 0 && days[i] >= createdDay; i--) {
      entry.stockEnd[i] = running;
      running -= entry.appliedDelta[i];
    }
    entry.outOfStock = entry.stockEnd.map((s, i) => s !== null && s <= 0 && entry.sold[i] <= 0
      && (i === 0 || entry.stockEnd[i - 1] === null || entry.stockEnd[i - 1] <= 0));
  }
  return bySku;
}

/**
 * Compute forecasts for all products. Returns products enriched with `forecast`,
 * `salesPerDay`, `channelSplit`, `soldToday`, `channelStock` and `pendingSync`.
 */
export function forecastAll(db, { windowDays = 30, minTrackedDays = 7, coverDays = 60, now = new Date() } = {}) {
  const win = windowOf(windowDays, now);
  const products = db.prepare('SELECT * FROM products ORDER BY name COLLATE NOCASE').all();
  const daily = loadDaily(db, products, win);

  const firstSeen = new Map(db.prepare(`
    SELECT p.sku, MIN(p.created_at, COALESCE(MIN(m.created_at), p.created_at)) AS first
    FROM products p LEFT JOIN stock_movements m ON m.sku = p.sku
    GROUP BY p.sku
  `).all().map((r) => [r.sku, r.first]));

  const channelStock = new Map();
  for (const row of db.prepare('SELECT * FROM channel_stock').all()) {
    if (!channelStock.has(row.sku)) channelStock.set(row.sku, {});
    channelStock.get(row.sku)[row.channel] = { stock: row.stock, syncedAt: row.synced_at };
  }
  const pending = new Map();
  for (const row of db.prepare('SELECT * FROM sync_queue').all()) {
    if (!pending.has(row.sku)) pending.set(row.sku, {});
    pending.get(row.sku)[row.channel] = { attempts: row.attempts, lastError: row.last_error };
  }

  const bySku = new Map(products.map((p) => [p.sku, p]));
  return products.map((p) => {
    const { sold, soldByChannel, outOfStock } = daily.get(p.sku);
    // Samples cut from another item: what can be sold = loose samples + what can be cut.
    const parent = p.cut_from ? bySku.get(p.cut_from) : null;
    const sellable = parent ? Math.max(0, p.stock) + Math.max(0, parent.stock) * (p.cut_yield ?? 1) : p.stock;
    const first = new Date(firstSeen.get(p.sku) ?? p.created_at);
    const trackedDays = Math.floor((now.getTime() - first.getTime()) / DAY_MS) + 1;
    const forecast = computeForecast({
      stock: sellable,
      dailySales: sold,
      outOfStockDays: outOfStock,
      trackedDays,
      leadTimeDays: p.lead_time_days,
      safetyDays: p.safety_days,
      minTrackedDays,
      coverDays,
      now,
    });
    if (p.supply === 'dropship') {
      // The supplier delivers: no own stock, no sell-out prediction.
      Object.assign(forecast, { status: 'dropship', daysLeft: null, soldOutDate: null, orderByDate: null, orderAdvice: 0 });
    } else if (!p.stock_confirmed || (parent && !parent.stock_confirmed)) {
      // Stock unknown (never counted): no sell-out prediction possible yet.
      Object.assign(forecast, { status: 'uncounted', daysLeft: null, soldOutDate: null, orderByDate: null, orderAdvice: 0 });
    }
    return {
      ...p,
      sellable,
      forecast,
      salesPerDay: sold,
      channelSplit: Object.fromEntries(Object.entries(soldByChannel).map(([c, v]) => [c, sum(v)])),
      soldToday: Object.fromEntries(Object.entries(soldByChannel).map(([c, v]) => [c, v[v.length - 1]])),
      channelStock: channelStock.get(p.sku) ?? {},
      pendingSync: pending.get(p.sku) ?? {},
    };
  });
}

/** Daily history for one product: end-of-day stock and units sold per channel. */
export function productHistory(db, sku, { windowDays = 60, now = new Date() } = {}) {
  const product = db.prepare('SELECT * FROM products WHERE sku = ?').get(sku);
  if (!product) return null;
  const win = windowOf(windowDays, now);
  const entry = loadDaily(db, [product], win).get(sku);
  const zeros = () => new Array(windowDays).fill(0);
  return {
    sku,
    days: win.days,
    stockEnd: entry.stockEnd,
    sales: {
      bol: entry.soldByChannel.bol ?? zeros(),
      woocommerce: entry.soldByChannel.woocommerce ?? zeros(),
    },
  };
}
