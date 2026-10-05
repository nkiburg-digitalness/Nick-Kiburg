/**
 * Product import/export, shared by the command line scripts and the dashboard.
 */

export const CSV_COLUMNS = ['sku', 'name', 'ean', 'stock', 'lead_time_days', 'safety_days', 'woo_product_id', 'woo_variation_id', 'bol_offer_id'];
const LINK_FIELDS = CSV_COLUMNS.filter((c) => !['sku', 'stock'].includes(c));

export function parseCsv(text) {
  text = String(text ?? '').replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0];
  const sep = (firstLine.match(/;/g) ?? []).length > (firstLine.match(/,/g) ?? []).length ? ';' : ',';
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((v) => v.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((v) => v.trim() !== '')) rows.push(row);
  if (!rows.length) return [];
  const [header, ...data] = rows;
  const keys = header.map((h) => h.trim().toLowerCase());
  return data.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}

/** Semicolon-separated with BOM, so it opens correctly in Dutch Excel. */
export function productsToCsv(products) {
  const cell = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [CSV_COLUMNS.join(';'), ...products.map((p) => CSV_COLUMNS.map((c) => cell(p[c])).join(';'))];
  return `﻿${lines.join('\r\n')}\r\n`;
}

/**
 * Create or update products from CSV rows. A filled "stock" on an existing product
 * is booked as a stocktake.
 */
export function importRows(inventory, rows, { userName = null } = {}) {
  const result = { created: 0, updated: 0, skipped: [] };
  if (rows.length && !('sku' in rows[0])) throw Object.assign(new Error('Kolom "sku" ontbreekt in het bestand'), { status: 400 });
  for (const [i, row] of rows.entries()) {
    if (!row.sku) continue;
    const fields = { sku: row.sku };
    for (const key of LINK_FIELDS) {
      if (row[key] !== undefined && row[key] !== '') fields[key] = row[key];
    }
    try {
      if (!inventory.getProduct(row.sku)) {
        if (!fields.name) throw new Error('naam ontbreekt');
        const counted = row.stock !== undefined && row.stock !== '';
        inventory.upsertProduct({ ...fields, stock: counted ? row.stock : 0, stock_confirmed: counted }, { userName });
        result.created++;
      } else {
        inventory.upsertProduct(fields, { userName });
        if (row.stock !== undefined && row.stock !== '') {
          inventory.setStock({ sku: row.sku, count: row.stock, note: 'Import', userName });
        }
        result.updated++;
      }
    } catch (err) {
      result.skipped.push(`regel ${i + 2} (${row.sku}): ${err.message}`);
    }
  }
  return result;
}

/**
 * Link the Bol.com offers of a webshop to its products – by offer id, EAN, or the
 * offer reference (often your SKU) – so stock is synced to Bol.com from now on,
 * without waiting for the first Bol.com order. FBB offers (stock kept by Bol.com)
 * are left alone. Offers without a matching product are listed, or created when
 * `createMissing` is set (products sold only on Bol.com).
 */
export async function linkBolOffers(inventory, bol, { createMissing = false, userName = null } = {}) {
  const offers = await bol.exportOffers();
  const result = { offers: offers.length, linked: 0, alreadyLinked: 0, created: 0, fbb: 0, unmatched: [] };
  for (const o of offers) {
    if (o.fulfilment === 'FBB') {
      result.fbb++;
      continue;
    }
    const listing = inventory.findListing({ bolOfferId: o.offerId }) ?? (o.ean ? inventory.findListing({ ean: o.ean }) : null);
    if (listing) {
      if (listing.bol_offer_id === o.offerId) result.alreadyLinked++;
      else {
        inventory.linkListingOffer(listing.id, o.offerId);
        result.linked++;
      }
      continue;
    }
    const product = inventory.findProduct({ bolOfferId: o.offerId })
      ?? (o.ean ? inventory.findProduct({ ean: o.ean }) : null)
      ?? (o.reference ? inventory.getProduct(o.reference) : null);
    if (product) {
      if (product.bol_offer_id === o.offerId) {
        result.alreadyLinked++;
        continue;
      }
      const fields = { sku: product.sku, bol_offer_id: o.offerId };
      if (!product.ean && o.ean && !inventory.findProduct({ ean: o.ean })) fields.ean = o.ean;
      inventory.upsertProduct(fields, { userName });
      result.linked++;
    } else if (createMissing) {
      const sku = o.reference && !inventory.getProduct(o.reference) ? o.reference : `BOL-${o.ean || o.offerId}`;
      inventory.upsertProduct({
        sku,
        name: `Bol.com-product ${o.ean || o.offerId}`,
        ean: o.ean && !inventory.findProduct({ ean: o.ean }) ? o.ean : null,
        bol_offer_id: o.offerId,
        stock: Number.isFinite(o.stock) ? o.stock : 0,
      }, { userName });
      result.created++;
    } else {
      result.unmatched.push({ ean: o.ean, reference: o.reference, stock: Number.isFinite(o.stock) ? o.stock : null });
    }
  }
  return result;
}

function skuPart(value) {
  return String(value).normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '').toUpperCase().slice(0, 40);
}

/**
 * WooCommerce reports the parent's SKU for a variation without its own SKU, so the
 * variations "Wit", "Zwart" and "Grijs" can all arrive with the same SKU. Every
 * webshop item must become its own product: items whose SKU is empty or shared get
 * a readable SKU of their own, e.g. "TS-100-ZWART-2-STUKS".
 */
function assignUniqueSkus(items) {
  const count = new Map();
  for (const p of items) if (p.sku) count.set(p.sku, (count.get(p.sku) ?? 0) + 1);
  const used = new Set([...count.keys()].filter((s) => count.get(s) === 1));
  for (const p of items) {
    p.originalSku = p.sku || '';
    if (p.sku && count.get(p.sku) === 1) continue;
    const base = p.parent_sku || p.sku || `WOO-${p.woo_product_id}`;
    const options = skuPart((p.options ?? []).join(' '));
    let sku = p.woo_variation_id ? `${base}-${options || p.woo_variation_id}` : base;
    if (used.has(sku)) sku = `${sku}-${p.woo_variation_id ?? p.woo_product_id}`;
    used.add(sku);
    p.sku = sku;
    p.generatedSku = true;
  }
}

function linkedProduct(inventory, p) {
  return p.woo_variation_id
    ? inventory.db.prepare('SELECT * FROM products WHERE woo_product_id = ? AND woo_variation_id = ?').get(p.woo_product_id, p.woo_variation_id) ?? null
    : inventory.db.prepare('SELECT * FROM products WHERE woo_product_id = ? AND woo_variation_id IS NULL').get(p.woo_product_id) ?? null;
}

/**
 * Products created by an earlier import that took several variations together under
 * one shared SKU are split off: the product becomes the variation it is linked to.
 */
function repairMergedVariations(inventory, items, { userName }) {
  const repaired = [];
  const shared = new Map();
  for (const p of items) {
    if (p.generatedSku && p.originalSku && p.woo_variation_id) {
      if (!shared.has(p.originalSku)) shared.set(p.originalSku, []);
      shared.get(p.originalSku).push(p);
    }
  }
  for (const [sku, group] of shared) {
    const product = inventory.getProduct(sku);
    if (!product || !group.some((p) => p.woo_product_id === product.woo_product_id)) continue;
    const target = group.find((p) => p.woo_variation_id === product.woo_variation_id) ?? group[0];
    try {
      inventory.repairMergedProduct(sku, { sku: target.sku, name: target.name }, { userName });
      repaired.push(target.name);
    } catch {
      // The new SKU is already in use: leave it as it is.
    }
  }
  return repaired;
}

/**
 * Take over all webshop products (incl. variations) and link them by SKU. New products
 * start with the current webshop stock; existing products keep their stock.
 */
export async function importFromWooCommerce(inventory, woo, { userName = null } = {}) {
  const result = { created: 0, updated: 0, skipped: [], uncounted: 0, listings: 0, generatedSkus: 0, repaired: [] };
  const items = await woo.listProducts();
  assignUniqueSkus(items);
  result.repaired = repairMergedVariations(inventory, items, { userName });
  for (const p of items) {
    // Already set up as a sales listing (e.g. "2 stuks" or a package): not a stock item.
    if (inventory.findListing({ wooProductId: p.woo_product_id, wooVariationId: p.woo_variation_id || undefined })) {
      result.listings++;
      continue;
    }
    if (p.generatedSku) result.generatedSkus++;
    // A product already linked to this exact webshop product/variation keeps its own SKU.
    const linked = linkedProduct(inventory, p);
    if (linked) p.sku = linked.sku;
    const exists = inventory.getProduct(p.sku);
    // Take over the EAN from the webshop (needed to recognise Bol.com orders), unless one
    // was already filled in here or another product already uses it.
    let ean;
    if (p.ean && !exists?.ean) {
      const owner = inventory.findProduct({ ean: p.ean });
      if (!owner || owner.sku === p.sku) ean = p.ean;
      else result.skipped.push(`${p.name}: EAN ${p.ean} wordt al gebruikt door ${owner.sku} (product wel overgenomen)`);
    }
    inventory.upsertProduct({
      sku: p.sku,
      name: exists?.name ?? p.name,
      woo_product_id: p.woo_product_id,
      woo_variation_id: p.woo_variation_id,
      ...(ean ? { ean } : {}),
      // Without "manage stock" WooCommerce has no quantity: the stock is unknown, not 0.
      ...(exists ? {} : { stock: p.stock ?? 0, stock_confirmed: p.stock !== null && p.stock !== undefined }),
    }, { userName });
    if (!exists && (p.stock === null || p.stock === undefined)) result.uncounted++;
    if (exists) result.updated++;
    else result.created++;
  }
  return result;
}
