/**
 * Link overview of one webshop: every stock item and sales listing with its webshop
 * and Bol.com link and what needs attention, plus the Bol.com offers that could not
 * be linked at the last "link Bol.com offers". Downloaded as CSV for Excel.
 */

const COLUMNS = ['Soort', 'SKU', 'Naam', 'Eenheid', 'Voorraad', 'Geteld', 'EAN', 'Webshop', 'Bol.com', 'Bestaat uit', 'Let op'];

export function linkReport(inventory, { hasWoo = true, hasBol = false, bolUnmatched = [] } = {}) {
  const listings = inventory.listListings();
  const usedIn = new Map();
  for (const l of listings) {
    for (const c of l.components) usedIn.set(c.item_sku, [...(usedIn.get(c.item_sku) ?? []), l.name]);
  }
  const webshop = (x) => (x.woo_product_id ? `ja (#${x.woo_product_id}${x.woo_variation_id ? ` / variatie ${x.woo_variation_id}` : ''})` : 'nee');
  const bol = (x) => (x.bol_offer_id ? `ja (${x.bol_offer_id})` : 'nee');
  const rows = [];

  for (const p of inventory.listProducts()) {
    const notes = [];
    const parts = usedIn.get(p.sku);
    if (!p.stock_confirmed) notes.push('Nog niet geteld');
    if (hasWoo && !p.woo_product_id && !parts) notes.push('Niet in de webshop');
    if (hasBol && !p.bol_offer_id && !p.ean && p.woo_product_id) notes.push('Geen EAN: kan niet aan Bol.com gekoppeld worden (alleen nodig als het op Bol.com staat)');
    rows.push({
      Soort: 'Voorraadartikel',
      SKU: p.sku,
      Naam: p.name,
      Eenheid: p.unit === 'meter' ? 'meter' : 'stuks',
      Voorraad: p.stock_confirmed ? p.stock : '',
      Geteld: p.stock_confirmed ? 'ja' : 'nee',
      EAN: p.ean ?? '',
      Webshop: webshop(p),
      'Bol.com': hasBol ? bol(p) : '–',
      'Bestaat uit': parts ? `gebruikt in: ${parts.join(' | ')}` : '',
      'Let op': notes.join('; '),
    });
  }

  for (const l of listings) {
    const notes = [];
    if (!l.woo_product_id && !l.bol_offer_id && !l.ean) notes.push('Niet gekoppeld aan webshop of Bol.com');
    if (hasBol && !l.woo_product_id && l.ean && !l.bol_offer_id) notes.push('Bol-aanbieding nog niet gevonden: koppel de Bol.com-aanbiedingen opnieuw');
    if (!l.components.length) notes.push('Geen onderdelen: verkopen worden nergens van afgeboekt. Uit het assortiment? Verwijder het via Opruimen. Anders: Verpakkingen en meters herkennen');
    else if (!l.available.known) notes.push('Een onderdeel is nog niet geteld');
    rows.push({
      Soort: 'Verkoopartikel',
      SKU: l.sku ?? '',
      Naam: l.name,
      Eenheid: '',
      Voorraad: l.available.known ? l.available.quantity : '',
      Geteld: l.available.known ? 'ja' : 'nee',
      EAN: l.ean ?? '',
      Webshop: webshop(l),
      'Bol.com': hasBol ? bol(l) : '–',
      'Bestaat uit': l.components.map((c) => `${c.quantity}${c.unit === 'meter' ? ' m' : ' ×'} ${c.name} (${c.item_sku})`).join(' + '),
      'Let op': notes.join('; '),
    });
  }

  for (const o of bolUnmatched) {
    rows.push({
      Soort: 'Bol-aanbieding zonder product',
      SKU: o.reference ?? '',
      Naam: '',
      Eenheid: '',
      Voorraad: o.stock ?? '',
      Geteld: '',
      EAN: o.ean ?? '',
      Webshop: '',
      'Bol.com': 'ja',
      'Bestaat uit': '',
      'Let op': 'Niet gekoppeld: staat alleen op Bol.com, of de EAN ontbreekt/wijkt af in de webshop',
    });
  }
  return rows;
}

/** Semicolon-separated with BOM, so it opens correctly in Dutch Excel. */
export function reportToCsv(rows) {
  const cell = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [COLUMNS.join(';'), ...rows.map((r) => COLUMNS.map((c) => cell(r[c])).join(';'))];
  return `﻿${lines.join('\r\n')}\r\n`;
}
