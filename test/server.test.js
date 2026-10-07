import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createApp } from '../src/app.js';
import { createHttpServer } from '../src/server.js';
import { config } from '../src/config.js';

const PASSWORD = 'correct-horse-battery';

async function start() {
  const app = createApp({
    ...config,
    dbFile: ':memory:',
    demoMode: false,
    adminEmail: 'Nick@Example.nl',
    adminName: 'Nick',
    adminPassword: PASSWORD,
    secretKey: 'test-secret-key',
    legacyShop: null,
  }, { fetchImpl: async () => new Response('{}') });
  // Two webshops; shop A is connected to WooCommerce.
  app.shops.create({ id: 'shop-a', name: 'Shop A', woo_base_url: 'https://a.example', woo_consumer_key: 'ck', woo_consumer_secret: 'cs', woo_webhook_secret: 'whsec' });
  app.shops.create({ id: 'shop-b', name: 'Shop B' });
  await app.bootstrapAdmin();
  const server = createHttpServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  /** A tiny browser: keeps the session cookie and sends JSON. */
  function client() {
    let cookie = '';
    return async function request(path, { method = 'GET', body, headers = {} } = {}) {
      const res = await fetch(`${base}${path}`, {
        method,
        redirect: 'manual',
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      const text = await res.text();
      let data = text;
      try { data = JSON.parse(text); } catch { /* not JSON */ }
      return { status: res.status, data, headers: res.headers };
    };
  }

  async function loggedIn(email = 'nick@example.nl', password = PASSWORD) {
    const request = client();
    const res = await request('/api/login', { method: 'POST', body: { email, password } });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    return request;
  }

  const inv = (id = 'shop-a') => app.shops.get(id).inventory;
  return { app, inv, base, client, loggedIn, close: () => { server.close(); app.stop(); } };
}

test('without a session the API is closed and the dashboard redirects to the login page', async () => {
  const { client, close } = await start();
  try {
    const anon = client();
    assert.equal((await anon('/api/overview')).status, 401);
    const page = await anon('/');
    assert.equal(page.status, 302);
    assert.equal(page.headers.get('location'), '/login');
    assert.equal((await anon('/login')).status, 200);
  } finally {
    close();
  }
});

test('login sets an HttpOnly session cookie; logout ends the session', async () => {
  const { client, loggedIn, close } = await start();
  try {
    const bad = await client()('/api/login', { method: 'POST', body: { email: 'nick@example.nl', password: 'fout-wachtwoord' } });
    assert.equal(bad.status, 401);

    const raw = client();
    const res = await raw('/api/login', { method: 'POST', body: { email: 'NICK@example.nl ', password: PASSWORD } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('set-cookie'), /HttpOnly/);
    assert.match(res.headers.get('set-cookie'), /SameSite=Lax/);

    const request = await loggedIn();
    assert.equal((await request('/api/me')).data.user.role, 'beheerder');
    assert.equal((await request('/api/logout', { method: 'POST' })).status, 200);
    assert.equal((await request('/api/me')).status, 401);
  } finally {
    close();
  }
});

test('repeated wrong passwords are throttled', async () => {
  const { client, close } = await start();
  try {
    const anon = client();
    let last;
    for (let i = 0; i < 9; i++) {
      last = await anon('/api/login', { method: 'POST', body: { email: 'nick@example.nl', password: `wrong-${i}-xxxxx` } });
    }
    assert.equal(last.status, 429);
  } finally {
    close();
  }
});

test('beheerder adds colleagues; roles limit what they can do', async () => {
  const { app, inv, loggedIn, close } = await start();
  try {
    const admin = await loggedIn();
    const added = await admin('/api/users', { method: 'POST', body: { name: 'Sanne', email: 'sanne@example.nl', role: 'medewerker' } });
    assert.equal(added.status, 200);
    assert.ok(added.data.password.length >= 10, 'a temporary password is generated');
    const viewer = await admin('/api/users', { method: 'POST', body: { name: 'Joost', email: 'joost@example.nl', role: 'kijker' } });

    inv().upsertProduct({ sku: 'TS-1', name: 'Tochtstrip', stock: 5 });

    const sanne = await loggedIn('sanne@example.nl', added.data.password);
    assert.equal((await sanne('/api/shops/shop-a/products/TS-1/adjust', { method: 'POST', body: { delta: 10, type: 'receipt' } })).status, 200);
    assert.equal((await sanne('/api/shops/shop-a/products/TS-1', { method: 'DELETE' })).status, 403, 'only a beheerder may delete');
    assert.equal((await sanne('/api/users')).status, 403);
    const moves = await sanne('/api/shops/shop-a/products/TS-1/movements');
    assert.equal(moves.data[0].user_name, 'Sanne', 'movement records who booked it');

    const joost = await loggedIn('joost@example.nl', viewer.data.password);
    assert.equal((await joost('/api/overview')).status, 200);
    assert.equal((await joost('/api/shops/shop-a/products/TS-1/count', { method: 'POST', body: { count: 1 } })).status, 403);

    // Blocking a colleague ends their session immediately.
    await admin(`/api/users/${added.data.user.id}`, { method: 'PATCH', body: { disabled: true } });
    assert.equal((await sanne('/api/overview')).status, 401);
  } finally {
    close();
  }
});

test('the last beheerder cannot be removed or demoted', async () => {
  const { app, inv, loggedIn, close } = await start();
  try {
    const admin = await loggedIn();
    const me = (await admin('/api/me')).data.user;
    assert.equal((await admin(`/api/users/${me.id}`, { method: 'PATCH', body: { role: 'kijker' } })).status, 400);
    assert.equal((await admin(`/api/users/${me.id}`, { method: 'DELETE' })).status, 400);
    assert.throws(() => app.auth.updateUser(me.id, { disabled: true }), /minstens één actieve beheerder/);
  } finally {
    close();
  }
});

test('users can change their own password', async () => {
  const { loggedIn, client, close } = await start();
  try {
    const request = await loggedIn();
    assert.equal((await request('/api/me/password', { method: 'POST', body: { current: 'wrong', password: 'nieuw-wachtwoord-123' } })).status, 403);
    assert.equal((await request('/api/me/password', { method: 'POST', body: { current: PASSWORD, password: 'kort' } })).status, 400);
    assert.equal((await request('/api/me/password', { method: 'POST', body: { current: PASSWORD, password: 'nieuw-wachtwoord-123' } })).status, 200);
    assert.equal((await request('/api/me')).status, 200, 'current session stays logged in');
    const old = await client()('/api/login', { method: 'POST', body: { email: 'nick@example.nl', password: PASSWORD } });
    assert.equal(old.status, 401);
  } finally {
    close();
  }
});

test('requests from another website are refused (CSRF)', async () => {
  const { loggedIn, close } = await start();
  try {
    const request = await loggedIn();
    const res = await request('/api/shops/shop-a/products', { method: 'POST', body: { sku: 'X', name: 'X' }, headers: { Origin: 'https://evil.example' } });
    assert.equal(res.status, 403);
  } finally {
    close();
  }
});

test('WooCommerce webhook updates stock and is rejected without a valid signature', async () => {
  const { app, inv, base, close } = await start();
  try {
    inv().upsertProduct({ sku: 'TS-1', name: 'Tochtstrip', stock: 5 });
    const body = JSON.stringify({
      id: 1, number: '1001', status: 'processing', date_created_gmt: '2099-01-01T10:00:00',
      line_items: [{ id: 10, product_id: 3, variation_id: 0, sku: 'TS-1', quantity: 2, name: 'Tochtstrip' }],
    });
    const headers = { 'Content-Type': 'application/json', 'X-WC-Webhook-Topic': 'order.created' };

    const bad = await fetch(`${base}/webhooks/woocommerce/shop-a`, { method: 'POST', headers: { ...headers, 'X-WC-Webhook-Signature': 'nope' }, body });
    assert.equal(bad.status, 401);
    assert.equal(inv().getProduct('TS-1').stock, 5);

    const signature = createHmac('sha256', 'whsec').update(body).digest('base64');
    const ok = await fetch(`${base}/webhooks/woocommerce/shop-a`, { method: 'POST', headers: { ...headers, 'X-WC-Webhook-Signature': signature }, body });
    assert.equal(ok.status, 200);
    assert.equal(inv().getProduct('TS-1').stock, 3);
  } finally {
    close();
  }
});

test('stock can be received and counted through the API', async () => {
  const { loggedIn, close } = await start();
  try {
    const request = await loggedIn();
    const post = (path, body) => request(path, { method: 'POST', body });
    assert.equal((await post('/api/shops/shop-a/products', { sku: 'X', name: 'X', stock: 4 })).status, 200);
    assert.equal((await post('/api/shops/shop-a/products/X/adjust', { delta: 6, type: 'receipt' })).status, 200);
    assert.equal((await post('/api/shops/shop-a/products/X/count', { count: 9 })).status, 200);
    assert.equal((await post('/api/shops/shop-a/products/X/adjust', { delta: 0 })).status, 400);
    const moves = (await request('/api/shops/shop-a/products/X/movements')).data;
    assert.deepEqual(moves.map((m) => m.delta), [-1, 6, 4]);
  } finally {
    close();
  }
});

test('products can be exported and imported as CSV from the dashboard', async () => {
  const { app, inv, loggedIn, close } = await start();
  try {
    const admin = await loggedIn();
    inv().upsertProduct({ sku: 'TS-1', name: 'Tochtstrip', stock: 5 });
    const exported = await admin('/api/shops/shop-a/export/products.csv');
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get('content-disposition'), /attachment; filename="producten-/);
    assert.match(exported.data, /^sku;name;ean;stock/); // fetch strips the BOM when decoding

    const csv = 'sku;name;ean;lead_time_days\nTS-1;Tochtstrip;8712345678901;21\nTS-2;Valdorpel;;14\n';
    const res = await admin('/api/shops/shop-a/import/csv', { method: 'POST', body: { csv } });
    assert.deepEqual(res.data, { created: 1, updated: 1, skipped: [] });
    assert.equal(inv().getProduct('TS-1').ean, '8712345678901');
    assert.equal(inv().getProduct('TS-1').lead_time_days, 21);

    // Importing is reserved for beheerders.
    const added = await admin('/api/users', { method: 'POST', body: { name: 'Sanne', email: 'sanne@example.nl', role: 'medewerker' } });
    const sanne = await loggedIn('sanne@example.nl', added.data.password);
    assert.equal((await sanne('/api/shops/shop-a/import/csv', { method: 'POST', body: { csv } })).status, 403);
    assert.equal((await sanne('/api/shops/shop-a/export/products.csv')).status, 200);
  } finally {
    close();
  }
});

test('larger responses are gzip-compressed to save bandwidth', async () => {
  const { base, close } = await start();
  try {
    const res = await fetch(`${base}/style.css`, { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(res.headers.get('content-encoding'), 'gzip');
    assert.match(await res.text(), /--surface/); // fetch decompresses transparently
    const plain = await fetch(`${base}/health`);
    assert.equal(plain.headers.get('content-encoding'), null, 'tiny responses stay uncompressed');
  } finally {
    close();
  }
});

test('webshops are fully separate: same SKU, separate stock, history and webhooks', async () => {
  const { app, inv, base, loggedIn, close } = await start();
  try {
    inv('shop-a').upsertProduct({ sku: 'X-1', name: 'Strip A', stock: 10 });
    inv('shop-b').upsertProduct({ sku: 'X-1', name: 'Borstel B', stock: 3 });
    const admin = await loggedIn();
    await admin('/api/shops/shop-a/products/X-1/adjust', { method: 'POST', body: { delta: 5, type: 'receipt' } });
    assert.equal(inv('shop-a').getProduct('X-1').stock, 15);
    assert.equal(inv('shop-b').getProduct('X-1').stock, 3);

    const a = (await admin('/api/overview?shop=shop-a')).data;
    assert.deepEqual(a.products.map((p) => [p.shop, p.name]), [['shop-a', 'Strip A']]);
    assert.deepEqual(a.shops.map((s) => s.id), ['shop-a', 'shop-b']);
    assert.equal(a.shops[1].summary.products, 1);

    // Shop B has no WooCommerce connection, so its webhook URL refuses orders.
    const hook = await fetch(`${base}/webhooks/woocommerce/shop-b`, { method: 'POST', headers: { 'X-WC-Webhook-Topic': 'order.created' }, body: '{}' });
    assert.equal(hook.status, 404);
    assert.equal(app.shops.get('shop-b').db.prepare('SELECT COUNT(*) AS n FROM stock_movements').get().n, 1);
  } finally {
    close();
  }
});

test('the "all webshops" overview lists only products that need attention', async () => {
  const { inv, loggedIn, close } = await start();
  try {
    inv('shop-a').upsertProduct({ sku: 'OK', name: 'Genoeg', stock: 50 });
    inv('shop-b').upsertProduct({ sku: 'LEEG', name: 'Op', stock: 0 });
    const admin = await loggedIn();
    const all = (await admin('/api/overview?shop=all')).data;
    assert.deepEqual(all.products.map((p) => `${p.shop}/${p.sku}`), ['shop-b/LEEG']);
    assert.equal(all.shops.find((s) => s.id === 'shop-b').summary.out, 1);
  } finally {
    close();
  }
});

test('colleagues can be limited to certain webshops', async () => {
  const { inv, loggedIn, close } = await start();
  try {
    inv('shop-a').upsertProduct({ sku: 'A', name: 'A', stock: 1 });
    inv('shop-b').upsertProduct({ sku: 'B', name: 'B', stock: 1 });
    const admin = await loggedIn();
    const added = await admin('/api/users', { method: 'POST', body: { name: 'Bram', email: 'bram@example.nl', role: 'medewerker', shops: ['shop-b'] } });
    assert.deepEqual(added.data.user.shops, ['shop-b']);
    assert.equal((await admin('/api/users', { method: 'POST', body: { name: 'X', email: 'x@example.nl', shops: ['bestaat-niet'] } })).status, 400);

    const bram = await loggedIn('bram@example.nl', added.data.password);
    const overview = (await bram('/api/overview?shop=all')).data;
    assert.deepEqual(overview.shops.map((s) => s.id), ['shop-b']);
    assert.equal((await bram('/api/overview?shop=shop-a')).status, 403);
    assert.equal((await bram('/api/shops/shop-a/products/A/movements')).status, 403);
    assert.equal((await bram('/api/shops/shop-a/products/A/adjust', { method: 'POST', body: { delta: 1, type: 'receipt' } })).status, 403);
    assert.equal((await bram('/api/shops/shop-b/products/B/adjust', { method: 'POST', body: { delta: 1, type: 'receipt' } })).status, 200);

    // Giving access to all webshops again.
    await admin(`/api/users/${added.data.user.id}`, { method: 'PATCH', body: { shops: null } });
    assert.equal((await bram('/api/overview?shop=shop-a')).status, 200);
  } finally {
    close();
  }
});

test('beheerders manage webshops; API keys are stored encrypted and never sent back', async () => {
  const { app, loggedIn, close } = await start();
  try {
    const admin = await loggedIn();
    const created = await admin('/api/shops', { method: 'POST', body: {
      name: 'Raamdecoratie Shop', woo_base_url: 'raamdecoratie.example/', woo_consumer_key: 'ck_geheim123', woo_consumer_secret: 'cs_geheim456',
    } });
    assert.equal(created.status, 200);
    const shop = created.data;
    assert.equal(shop.id, 'raamdecoratie-example');
    assert.equal(shop.woo_base_url, 'https://raamdecoratie.example');
    assert.equal(shop.has_woo_keys, true);
    assert.equal(shop.has_bol_keys, false);
    assert.ok(shop.webhook_secret.length > 20, 'a webhook secret is generated');
    assert.equal(JSON.stringify(shop).includes('geheim'), false, 'keys are not sent back');

    const stored = app.coreDb.prepare('SELECT woo_consumer_key FROM shops WHERE id = ?').get(shop.id).woo_consumer_key;
    assert.match(stored, /^v1:/);
    assert.equal(stored.includes('geheim'), false, 'encrypted at rest');
    assert.equal(app.shops.get(shop.id).shop.woo_consumer_key, 'ck_geheim123');

    // Adding Bol.com later restarts only this webshop, with the new connection.
    await admin(`/api/shops/${shop.id}`, { method: 'PATCH', body: { bol_client_id: 'bol-id', bol_client_secret: 'bol-secret', woo_consumer_key: '' } });
    const rt = app.shops.get(shop.id);
    assert.ok(rt.channels.bol, 'Bol.com connected');
    assert.equal(rt.shop.woo_consumer_key, 'ck_geheim123', 'empty value keeps the stored key');

    const medewerker = await admin('/api/users', { method: 'POST', body: { name: 'M', email: 'm@example.nl', role: 'medewerker' } });
    const m = await loggedIn('m@example.nl', medewerker.data.password);
    assert.equal((await m('/api/shops')).status, 403);

    assert.equal((await admin(`/api/shops/${shop.id}`, { method: 'DELETE' })).status, 200);
    assert.equal(app.shops.get(shop.id), null);
  } finally {
    close();
  }
});

test('new webshops start with syncing paused until a beheerder starts it', async () => {
  const { app, loggedIn, close } = await start();
  try {
    const admin = await loggedIn();
    const shop = (await admin('/api/shops', { method: 'POST', body: { name: 'Nieuw', woo_base_url: 'https://n.example', woo_consumer_key: 'k', woo_consumer_secret: 's' } })).data;
    assert.equal(shop.sync_paused, true);
    assert.equal(app.shops.get(shop.id).syncPaused, true);
    const started = (await admin(`/api/shops/${shop.id}`, { method: 'PATCH', body: { sync_paused: false } })).data;
    assert.equal(started.sync_paused, false);
    assert.equal(app.shops.get(shop.id).syncPaused, false);
    const overview = (await admin('/api/overview?shop=all')).data;
    assert.equal(overview.shops.find((s) => s.id === shop.id).syncPaused, false);
  } finally {
    close();
  }
});

test('history import runs in the background and reports per channel', async () => {
  const { app, loggedIn, close } = await start();
  try {
    const request = await loggedIn();
    // Fake a slow Bol.com history import on shop A.
    let release;
    app.shops.get('shop-a').channels.bol = { name: 'bol', backfill: () => new Promise((resolve) => { release = () => resolve({ booked: 3, orders: 2, lines: 5, otherShop: 1, unknown: 1, unknownEans: ['871'] }); }) };
    app.shops.get('shop-a').channels.woocommerce.backfill = async () => 7;
    const started = await request('/api/shops/shop-a/backfill', { method: 'POST', body: { days: 365 } });
    assert.equal(started.status, 202);
    assert.equal(started.data.running, true);
    // A second click while running does not start a second import.
    assert.equal((await request('/api/shops/shop-a/backfill', { method: 'POST', body: { days: 365 } })).data.startedAt, started.data.startedAt);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await request('/api/shops/shop-a/backfill')).data.current, 'bol');
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const done = (await request('/api/shops/shop-a/backfill')).data;
    assert.equal(done.running, false);
    assert.deepEqual(done.orderLines.woocommerce, { booked: 7 });
    assert.equal(done.orderLines.bol.booked, 3);
    assert.deepEqual(done.channelDays, { woocommerce: 365, bol: 90 });
    const log = app.shops.get('shop-a').bus.recentLog(10).map((l) => l.message).join('\n');
    assert.match(log, /Verkoophistorie Bol\.com: 2 orders, 5 orderregels – 3 nieuw, 1 van een andere webshop, 1 van niet-gekoppelde producten/);
  } finally {
    close();
  }
});

test('an interrupted history import resumes after a restart', async () => {
  const { app, close } = await start();
  try {
    const { setKv, getKv } = await import('../src/db.js');
    const { resumeHistoryImport } = await import('../src/history.js');
    const rt = app.shops.get('shop-a');
    rt.channels.woocommerce.backfill = async (inv, days, now, { onProgress }) => { onProgress(1, 1); return days; };
    setKv(rt.db, 'history_import:pending', JSON.stringify({ days: 365, startedBy: 'Nick' }));
    const job = resumeHistoryImport(rt);
    assert.equal(job.resumed, true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(rt.backfillJob.running, false);
    assert.deepEqual(rt.backfillJob.orderLines.woocommerce, { booked: 365 });
    assert.equal(getKv(rt.db, 'history_import:pending'), null, 'done: nothing left to resume');
    assert.equal(resumeHistoryImport(rt), null);
    assert.match(rt.bus.recentLog(5).map((l) => l.message).join('\n'), /hervat na een herstart/);
  } finally {
    close();
  }
});

test('a Bol.com offer that is exactly a webshop variation is linked to that product, not made a listing', async () => {
  const { app, loggedIn, close } = await start();
  try {
    const request = await loggedIn();
    const inv = app.shops.get('shop-a').inventory;
    inv.upsertProduct({ sku: 'KM-ROZE-L', name: 'Koelmat - Roze – L - 70 x 55 cm', woo_product_id: 1933, woo_variation_id: 1935, stock: 6 });
    const body = {
      name: 'Koelmat Hond & Kat | Roze L | 70x55 cm', ean: '6151043314365', bol_offer_id: 'a49cd656', woo_product_id: '1933', woo_variation_id: '1935',
      components: [{ item_sku: 'KM-ROZE-L', quantity: 1 }],
    };
    const res = await request('/api/shops/shop-a/listings', { method: 'POST', body });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.deepEqual(res.data.linkedProduct, { sku: 'KM-ROZE-L', name: 'Koelmat - Roze – L - 70 x 55 cm' });
    const p = inv.getProduct('KM-ROZE-L');
    assert.deepEqual([p.ean, p.bol_offer_id], ['6151043314365', 'a49cd656']);
    assert.equal(inv.listListings().length, 0, 'no listing created');

    // A set of 4 on the same webshop variation: a clear explanation instead.
    const set = await request('/api/shops/shop-a/listings', { method: 'POST', body: { ...body, ean: '6151043314999', bol_offer_id: 'other', components: [{ item_sku: 'KM-ROZE-L', quantity: 4 }] } });
    assert.equal(set.status, 400);
    assert.match(set.data.error, /Bol-set koppelt u niet aan de webshopvariatie/);
  } finally {
    close();
  }
});
