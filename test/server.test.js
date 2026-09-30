import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createApp } from '../src/app.js';
import { createHttpServer } from '../src/server.js';
import { config } from '../src/config.js';

async function start(overrides = {}) {
  const app = createApp({
    ...config,
    dbFile: ':memory:',
    demoMode: false,
    adminPassword: 'geheim',
    bol: { ...config.bol, enabled: false },
    woo: { ...config.woo, enabled: true, consumerKey: 'ck', consumerSecret: 'cs', webhookSecret: 'whsec' },
    ...overrides,
  }, { fetchImpl: async () => new Response('{}') });
  app.bus.log = () => {};
  const server = createHttpServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { app, base, close: () => { server.close(); app.stop(); } };
}

const auth = { Authorization: `Basic ${Buffer.from('admin:geheim').toString('base64')}` };

test('dashboard API requires a login', async () => {
  const { base, close } = await start();
  try {
    assert.equal((await fetch(`${base}/api/overview`)).status, 401);
    const res = await fetch(`${base}/api/overview`, { headers: auth });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).products, []);
  } finally {
    close();
  }
});

test('WooCommerce webhook updates stock and is rejected without a valid signature', async () => {
  const { app, base, close } = await start();
  try {
    app.inventory.upsertProduct({ sku: 'TS-1', name: 'Tochtstrip', stock: 5 });
    const body = JSON.stringify({
      id: 1, number: '1001', status: 'processing', date_created_gmt: '2099-01-01T10:00:00',
      line_items: [{ id: 10, product_id: 3, variation_id: 0, sku: 'TS-1', quantity: 2, name: 'Tochtstrip' }],
    });
    const headers = { 'Content-Type': 'application/json', 'X-WC-Webhook-Topic': 'order.created' };

    const bad = await fetch(`${base}/webhooks/woocommerce`, { method: 'POST', headers: { ...headers, 'X-WC-Webhook-Signature': 'nope' }, body });
    assert.equal(bad.status, 401);
    assert.equal(app.inventory.getProduct('TS-1').stock, 5);

    const signature = createHmac('sha256', 'whsec').update(body).digest('base64');
    const ok = await fetch(`${base}/webhooks/woocommerce`, { method: 'POST', headers: { ...headers, 'X-WC-Webhook-Signature': signature }, body });
    assert.equal(ok.status, 200);
    assert.equal(app.inventory.getProduct('TS-1').stock, 3);

    const overview = await (await fetch(`${base}/api/overview?window=7`, { headers: auth })).json();
    assert.equal(overview.products[0].forecast.unitsSold, 0, 'order dated in the future falls outside the window');
  } finally {
    close();
  }
});

test('stock can be received and counted through the API', async () => {
  const { base, close } = await start();
  try {
    const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post('/api/products', { sku: 'X', name: 'X', stock: 4 })).status, 200);
    assert.equal((await post('/api/products/X/adjust', { delta: 6, type: 'receipt' })).status, 200);
    assert.equal((await post('/api/products/X/count', { count: 9 })).status, 200);
    assert.equal((await post('/api/products/X/adjust', { delta: 0 })).status, 400);
    const moves = await (await fetch(`${base}/api/products/X/movements`, { headers: auth })).json();
    assert.deepEqual(moves.map((m) => m.delta), [-1, 6, 4]);
  } finally {
    close();
  }
});
