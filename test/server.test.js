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
    bol: { ...config.bol, enabled: false },
    woo: { ...config.woo, enabled: true, consumerKey: 'ck', consumerSecret: 'cs', webhookSecret: 'whsec' },
  }, { fetchImpl: async () => new Response('{}') });
  app.bus.log = () => {};
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

  return { app, base, client, loggedIn, close: () => { server.close(); app.stop(); } };
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
  const { app, loggedIn, close } = await start();
  try {
    const admin = await loggedIn();
    const added = await admin('/api/users', { method: 'POST', body: { name: 'Sanne', email: 'sanne@example.nl', role: 'medewerker' } });
    assert.equal(added.status, 200);
    assert.ok(added.data.password.length >= 10, 'a temporary password is generated');
    const viewer = await admin('/api/users', { method: 'POST', body: { name: 'Joost', email: 'joost@example.nl', role: 'kijker' } });

    app.inventory.upsertProduct({ sku: 'TS-1', name: 'Tochtstrip', stock: 5 });

    const sanne = await loggedIn('sanne@example.nl', added.data.password);
    assert.equal((await sanne('/api/products/TS-1/adjust', { method: 'POST', body: { delta: 10, type: 'receipt' } })).status, 200);
    assert.equal((await sanne('/api/products/TS-1', { method: 'DELETE' })).status, 403, 'only a beheerder may delete');
    assert.equal((await sanne('/api/users')).status, 403);
    const moves = await sanne('/api/products/TS-1/movements');
    assert.equal(moves.data[0].user_name, 'Sanne', 'movement records who booked it');

    const joost = await loggedIn('joost@example.nl', viewer.data.password);
    assert.equal((await joost('/api/overview')).status, 200);
    assert.equal((await joost('/api/products/TS-1/count', { method: 'POST', body: { count: 1 } })).status, 403);

    // Blocking a colleague ends their session immediately.
    await admin(`/api/users/${added.data.user.id}`, { method: 'PATCH', body: { disabled: true } });
    assert.equal((await sanne('/api/overview')).status, 401);
  } finally {
    close();
  }
});

test('the last beheerder cannot be removed or demoted', async () => {
  const { app, loggedIn, close } = await start();
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
    const res = await request('/api/products', { method: 'POST', body: { sku: 'X', name: 'X' }, headers: { Origin: 'https://evil.example' } });
    assert.equal(res.status, 403);
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
  } finally {
    close();
  }
});

test('stock can be received and counted through the API', async () => {
  const { loggedIn, close } = await start();
  try {
    const request = await loggedIn();
    const post = (path, body) => request(path, { method: 'POST', body });
    assert.equal((await post('/api/products', { sku: 'X', name: 'X', stock: 4 })).status, 200);
    assert.equal((await post('/api/products/X/adjust', { delta: 6, type: 'receipt' })).status, 200);
    assert.equal((await post('/api/products/X/count', { count: 9 })).status, 200);
    assert.equal((await post('/api/products/X/adjust', { delta: 0 })).status, 400);
    const moves = (await request('/api/products/X/movements')).data;
    assert.deepEqual(moves.map((m) => m.delta), [-1, 6, 4]);
  } finally {
    close();
  }
});

test('products can be exported and imported as CSV from the dashboard', async () => {
  const { app, loggedIn, close } = await start();
  try {
    const admin = await loggedIn();
    app.inventory.upsertProduct({ sku: 'TS-1', name: 'Tochtstrip', stock: 5 });
    const exported = await admin('/api/export/products.csv');
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get('content-disposition'), /attachment; filename="producten-/);
    assert.match(exported.data, /^sku;name;ean;stock/); // fetch strips the BOM when decoding

    const csv = 'sku;name;ean;lead_time_days\nTS-1;Tochtstrip;8712345678901;21\nTS-2;Valdorpel;;14\n';
    const res = await admin('/api/import/csv', { method: 'POST', body: { csv } });
    assert.deepEqual(res.data, { created: 1, updated: 1, skipped: [] });
    assert.equal(app.inventory.getProduct('TS-1').ean, '8712345678901');
    assert.equal(app.inventory.getProduct('TS-1').lead_time_days, 21);

    // Importing is reserved for beheerders.
    const added = await admin('/api/users', { method: 'POST', body: { name: 'Sanne', email: 'sanne@example.nl', role: 'medewerker' } });
    const sanne = await loggedIn('sanne@example.nl', added.data.password);
    assert.equal((await sanne('/api/import/csv', { method: 'POST', body: { csv } })).status, 403);
    assert.equal((await sanne('/api/export/products.csv')).status, 200);
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
