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

/**
 * Take over all webshop products (incl. variations) and link them by SKU. New products
 * start with the current webshop stock; existing products keep their stock.
 */
export async function importFromWooCommerce(inventory, woo, { userName = null } = {}) {
  const result = { created: 0, updated: 0, skipped: [], uncounted: 0 };
  for (const p of await woo.listProducts()) {
    if (!p.sku) {
      result.skipped.push(`${p.name} (#${p.woo_product_id}): geen SKU in de webshop`);
      continue;
    }
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
