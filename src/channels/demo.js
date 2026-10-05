import { SkipSync } from './errors.js';

/**
 * Simulated channel for demo mode: accepts stock pushes without calling any API.
 */
export class DemoChannel {
  constructor(name) {
    this.name = name;
  }

  async testConnection() {
    return 'demo-modus (geen echte verbinding)';
  }

  async pushStock(product, quantity) {
    const linked = this.name === 'bol' ? product.bol_offer_id : product.woo_product_id;
    if (!linked) throw new SkipSync(`niet gekoppeld aan ${this.name}`);
    await new Promise((resolve) => setTimeout(resolve, 150 + Math.random() * 350));
    return Math.max(0, quantity);
  }
}

/**
 * Generates random orders so the dashboard shows real-time syncing. Bol.com orders
 * only for products that are offered on Bol.com.
 */
export function startDemoSales(inventory, { intervalMs = 12000, hasBol = true } = {}) {
  let counter = 0;
  const timer = setInterval(() => {
    const products = inventory.listProducts().filter((p) => p.stock > 0);
    if (!products.length) return;
    const product = products[Math.floor(Math.random() * products.length)];
    const channel = hasBol && product.bol_offer_id && Math.random() < 0.55 ? 'bol' : 'woocommerce';
    const quantity = Math.random() < 0.8 ? 1 : 2;
    counter++;
    inventory.recordSale({
      channel,
      lineRef: `demo:${Date.now()}:${counter}`,
      sku: product.sku,
      quantity,
      occurredAt: new Date().toISOString(),
      note: channel === 'bol' ? `Bol-order DEMO-${counter}` : `Webshop-order #D${counter}`,
    });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
