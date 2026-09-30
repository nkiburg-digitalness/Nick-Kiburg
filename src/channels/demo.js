/**
 * Simulated channel for demo mode: accepts stock pushes without calling any API.
 */
export class DemoChannel {
  constructor(name) {
    this.name = name;
  }

  async pushStock(product, quantity) {
    await new Promise((resolve) => setTimeout(resolve, 150 + Math.random() * 350));
    return Math.max(0, quantity);
  }
}

/**
 * Generates random orders on both channels so the dashboard shows real-time syncing.
 */
export function startDemoSales(inventory, { intervalMs = 12000 } = {}) {
  let counter = 0;
  const timer = setInterval(() => {
    const products = inventory.listProducts().filter((p) => p.stock > 0);
    if (!products.length) return;
    const product = products[Math.floor(Math.random() * products.length)];
    const channel = Math.random() < 0.55 ? 'bol' : 'woocommerce';
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
