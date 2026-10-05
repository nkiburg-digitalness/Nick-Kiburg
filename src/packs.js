/**
 * Recognise webshop variations that are packs ("2 stuks", "4 st.", "set van 3") or
 * lengths ("5 m", "10 meter") of the same article, and propose to turn them into
 * sales listings of one stock item:
 *   - pieces: the "1 stuk" variation becomes the stock item (or a new one is created),
 *     the other variations use n × that item;
 *   - metres: a new stock item counted in metres; each variation uses n metres.
 * Centimetres ("305 cm", "610 cm") are deliberately not recognised: those are
 * different products. Variations are grouped per webshop product and per other
 * attributes (e.g. colour), so "Wit, 5 m" and "Zwart, 5 m" get separate stock items.
 */

const PIECE_PATTERNS = [
  /^(\d+)\s*(?:stuks?|st\.?|stk|x|pcs|pieces?)$/i, // "2 stuks", "4 st.", "3x"
  /^(?:set|pak|pack|doos|verpakking)\s*(?:van|a|à)?\s*(\d+)(?:\s*(?:stuks?|st\.?))?$/i, // "set van 3"
  /^(\d+)\s*-?\s*(?:pack|pak|set|delig)$/i, // "2-pack", "3 delig"
];
const METRE_PATTERN = /^(\d+)\s*(?:m|mtr\.?|meter|meters)$/i;

function parseOption(option) {
  const text = String(option ?? '').trim();
  const metres = text.match(METRE_PATTERN);
  if (metres) return { unit: 'meter', quantity: Number(metres[1]) };
  for (const pattern of PIECE_PATTERNS) {
    const m = text.match(pattern);
    if (m) return { unit: 'stuks', quantity: Number(m[1]) };
  }
  return null;
}

function slug(value) {
  return String(value).normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '').toUpperCase().slice(0, 30);
}

/** Proposed groups for the products of one webshop (nothing is changed). */
export function suggestPacks(inventory) {
  const groups = new Map();
  // Webshop variations that are still products, plus sales listings that lost their
  // stock item (e.g. it was deleted): those are set up again the same way.
  const orphans = inventory.listListings().filter((l) => !l.components.length)
    .map((l) => ({ sku: l.sku ?? '', name: l.name, woo_product_id: l.woo_product_id, woo_variation_id: l.woo_variation_id, stock: null, stock_confirmed: 0, listingId: l.id }));
  for (const p of [...inventory.listProducts(), ...orphans]) {
    if (!p.woo_product_id || !p.woo_variation_id) continue;
    const at = p.name.lastIndexOf(' – ');
    if (at < 0) continue;
    const baseName = p.name.slice(0, at);
    const options = p.name.slice(at + 3).split(',').map((o) => o.trim()).filter(Boolean);
    const parsed = options.map(parseOption);
    const hits = parsed.filter(Boolean);
    if (hits.length !== 1) continue; // exactly one "amount" attribute
    const amount = hits[0];
    const rest = options.filter((_, i) => !parsed[i]);
    const key = `${p.woo_product_id}|${amount.unit}|${rest.join(', ').toLowerCase()}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        title: [baseName, ...rest].join(', '),
        unit: amount.unit,
        wooProductId: p.woo_product_id,
        rest,
        variants: [],
      });
    }
    groups.get(key).variants.push({ sku: p.sku, name: p.name, quantity: amount.quantity, stock: p.stock, stockConfirmed: Boolean(p.stock_confirmed), listingId: p.listingId ?? null });
  }

  const result = [];
  for (const g of groups.values()) {
    g.variants.sort((a, b) => a.quantity - b.quantity);
    const single = g.unit === 'stuks' ? g.variants.find((v) => v.quantity === 1 && !v.listingId) : null;
    // A group only makes sense with at least two amounts, or one amount > 1 for metres.
    if (g.variants.length < 2 && !(g.unit === 'meter' && g.variants[0]?.quantity > 1)) continue;
    const suffix = g.rest.length ? `-${slug(g.rest.join('-'))}` : '';
    const base = single
      ? { sku: single.sku, name: single.name, existing: true }
      : {
        sku: `WOO-${g.wooProductId}${suffix}-${g.unit === 'meter' ? 'METER' : 'STUKS'}`,
        name: `${g.title} (${g.unit === 'meter' ? 'meter' : 'per stuk'})`,
        existing: false,
      };
    result.push({
      key: g.key,
      title: g.title,
      unit: g.unit,
      base,
      variants: g.variants.filter((v) => v.listingId || v.sku !== base.sku),
    });
  }
  return result.sort((a, b) => a.title.localeCompare(b.title, 'nl'));
}

/**
 * Apply the selected proposals (by key). New stock items start as "not counted yet";
 * the variations become listings (their webshop/Bol.com links move along).
 */
export function applyPacks(inventory, keys, { userName = null } = {}) {
  const wanted = new Set(keys);
  const out = { groups: 0, listings: 0, newItems: 0, errors: [] };
  for (const g of suggestPacks(inventory).filter((s) => wanted.has(s.key))) {
    try {
      if (!g.base.existing && !inventory.getProduct(g.base.sku)) {
        inventory.upsertProduct({ sku: g.base.sku, name: g.base.name, unit: g.unit, stock: 0, stock_confirmed: false }, { userName });
        out.newItems++;
      }
      for (const v of g.variants) {
        if (v.listingId) {
          // Existing listing without components: only its components are set.
          const listing = inventory.getListing(v.listingId);
          inventory.saveListing({ ...listing, components: [{ item_sku: g.base.sku, quantity: v.quantity }] }, { userName });
          out.listings++;
          continue;
        }
        const product = inventory.getProduct(v.sku);
        inventory.saveListing({
          name: product.name,
          sku: product.sku,
          ean: product.ean,
          woo_product_id: product.woo_product_id,
          woo_variation_id: product.woo_variation_id,
          bol_offer_id: product.bol_offer_id,
          components: [{ item_sku: g.base.sku, quantity: v.quantity }],
          replace_product: product.sku,
        }, { userName });
        out.listings++;
      }
      out.groups++;
    } catch (err) {
      out.errors.push(`${g.title}: ${err.message}`);
    }
  }
  return out;
}
