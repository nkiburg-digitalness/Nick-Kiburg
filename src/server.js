import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forecastAll, productHistory } from './forecast.js';
import { hasRole, parseCookies, generatePassword, canAccessShop, ROLES, SESSION_COOKIE, AuthError } from './auth.js';
import { CHANNEL_LABELS } from './inventory.js';
import { getKv } from './db.js';
import { SHOP_COLORS } from './shops.js';
import { parseCsv, productsToCsv, importRows, importFromWooCommerce, linkBolOffers } from './importer.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
// [file, content type, needs login]
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8', true],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8', true],
  '/login': ['login.html', 'text/html; charset=utf-8', false],
  '/login.js': ['login.js', 'text/javascript; charset=utf-8', false],
  '/style.css': ['style.css', 'text/css; charset=utf-8', false],
};
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
};
const MAX_BODY = 2 * 1024 * 1024;

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  let payload = Buffer.from(isJson ? JSON.stringify(body) : body);
  const extra = {};
  // Compress larger responses: keeps hosting bandwidth (and mobile data) low.
  if (res.acceptsGzip && payload.length > 1024) {
    payload = gzipSync(payload);
    extra['Content-Encoding'] = 'gzip';
    extra.Vary = 'Accept-Encoding';
  }
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
    ...headers,
    ...extra,
  });
  res.end(payload);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
  res.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Body te groot'), { status: 413 }));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw.length) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw Object.assign(new Error('Ongeldige JSON'), { status: 400 });
  }
}

function isHttps(req, config) {
  return Boolean(req.socket.encrypted) || (config.trustProxy && req.headers['x-forwarded-proto'] === 'https');
}

function clientIp(req, config) {
  if (config.trustProxy && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  return req.socket.remoteAddress ?? '';
}

function sessionCookie(req, config, token, maxAgeSeconds) {
  const parts = [`${SESSION_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`];
  if (isHttps(req, config)) parts.push('Secure');
  return parts.join('; ');
}

/** Block cross-site requests that try to change data with the user's cookie (CSRF). */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const host = req.headers['x-forwarded-host'] ?? req.headers.host;
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function forbidden() {
  return new AuthError('Hiervoor heeft u geen rechten', 403);
}

export function createHttpServer(app) {
  const { config, auth, shops, hub, coreBus } = app;

  function accessibleShops(user) {
    return shops.all().filter((rt) => canAccessShop(user, rt.id));
  }

  /** The runtime of a webshop the user may see, or a 404/403. */
  function shopFor(user, id) {
    const rt = shops.get(id);
    if (!rt) throw new AuthError('Onbekende webshop', 404);
    if (!canAccessShop(user, id)) throw new AuthError('U heeft geen toegang tot deze webshop', 403);
    return rt;
  }

  function windowFrom(url) {
    const w = Number.parseInt(url.searchParams.get('window') ?? '', 10);
    return [7, 14, 30, 60, 90].includes(w) ? w : config.forecast.windowDays;
  }

  function channelStatus(rt) {
    return ['woocommerce', 'bol'].map((name) => {
      const poller = rt.pollers.find((p) => p.channel.name === name);
      return {
        name,
        label: CHANNEL_LABELS[name],
        connected: Boolean(rt.channels[name]),
        lastPollAt: poller?.lastRunAt ?? getKv(rt.db, `${name}:last_poll`),
        lastError: poller?.lastError ?? null,
      };
    });
  }

  /**
   * Overview for the dashboard: a summary per webshop, plus the products of the selected
   * webshop – or, for "all", only the products that need attention in any webshop.
   */
  function overview(user, selected, windowDays) {
    const list = accessibleShops(user);
    const opts = { windowDays, minTrackedDays: config.forecast.minTrackedDays, coverDays: config.forecast.reorderCoverDays };
    const shopsOut = [];
    let products = [];
    for (const rt of list) {
      const items = forecastAll(rt.db, opts).map((p) => ({ ...p, shop: rt.id }));
      const soldToday = { bol: 0, woocommerce: 0 };
      for (const p of items) for (const c of Object.keys(soldToday)) soldToday[c] += p.soldToday?.[c] ?? 0;
      shopsOut.push({
        id: rt.id,
        name: rt.shop.name,
        color: rt.shop.color,
        hasBol: rt.hasBol,
        syncPaused: rt.syncPaused,
        channels: channelStatus(rt),
        summary: {
          products: items.length,
          stock: items.reduce((n, p) => n + Math.max(0, p.stock), 0),
          soldToday,
          warning: items.filter((p) => p.forecast.status === 'warning').length,
          critical: items.filter((p) => p.forecast.status === 'critical').length,
          out: items.filter((p) => p.forecast.status === 'out').length,
          uncounted: items.filter((p) => p.forecast.status === 'uncounted').length,
        },
      });
      if (selected === 'all') products.push(...items.filter((p) => p.forecast.status !== 'ok'));
      else if (selected === rt.id) products = items;
    }
    if (selected !== 'all' && !list.some((rt) => rt.id === selected)) shopFor(user, selected);
    return { generatedAt: new Date().toISOString(), windowDays, demoMode: config.demoMode, selected, shops: shopsOut, products };
  }

  const SHOP = '/api/shops/([a-z0-9-]+)';
  const sku = (m) => decodeURIComponent(m[2]);

  // [method, pattern, minimum role, handler, { shop: true } → ctx.rt is the webshop of m[1]]
  const routes = [
    ['GET', /^\/api\/overview$/, 'kijker', ({ res, url, user }) => {
      send(res, 200, overview(user, url.searchParams.get('shop') || 'all', windowFrom(url)));
    }],
    ['GET', /^\/api\/log$/, 'kijker', ({ res, url, user }) => {
      const selected = url.searchParams.get('shop') || 'all';
      const buses = selected === 'all'
        ? [...accessibleShops(user).map((rt) => rt.bus), ...(hasRole(user, 'beheerder') ? [coreBus] : [])]
        : [shopFor(user, selected).bus];
      const rows = buses.flatMap((b) => b.recentLog(150)).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      send(res, 200, rows.slice(0, 150));
    }],

    // --- products of one webshop
    ['GET', new RegExp(`^${SHOP}/products/([^/]+)/movements$`), 'kijker', ({ res, m, rt }) => {
      send(res, 200, rt.inventory.movements(sku(m), 200));
    }, { shop: true }],
    ['GET', new RegExp(`^${SHOP}/products/([^/]+)/history$`), 'kijker', ({ res, m, url, rt }) => {
      const w = Number.parseInt(url.searchParams.get('window') ?? '', 10);
      const history = productHistory(rt.db, sku(m), { windowDays: Math.min(365, Math.max(7, w || 60)) });
      if (!history) return send(res, 404, { error: 'Onbekend product' });
      send(res, 200, history);
    }, { shop: true }],
    ['POST', new RegExp(`^${SHOP}/products$`), 'medewerker', async ({ req, res, user, rt }) => {
      const { create, ...body } = await readJson(req);
      if (create && rt.inventory.getProduct(String(body.sku ?? '').trim())) {
        throw new AuthError('Er bestaat in deze webshop al een product met deze SKU', 400);
      }
      send(res, 200, rt.inventory.upsertProduct(body, { userName: user.name }));
    }, { shop: true }],
    ['DELETE', new RegExp(`^${SHOP}/products/([^/]+)$`), 'beheerder', ({ res, m, user, rt }) => {
      rt.inventory.deleteProduct(sku(m), { userName: user.name });
      send(res, 200, { ok: true });
    }, { shop: true }],
    ['POST', new RegExp(`^${SHOP}/products/([^/]+)/adjust$`), 'medewerker', async ({ req, res, m, user, rt }) => {
      const body = await readJson(req);
      send(res, 200, rt.inventory.adjustStock({
        sku: sku(m), delta: body.delta, type: body.type, note: body.note || null, userName: user.name,
      }));
    }, { shop: true }],
    ['POST', new RegExp(`^${SHOP}/products/([^/]+)/count$`), 'medewerker', async ({ req, res, m, user, rt }) => {
      const body = await readJson(req);
      send(res, 200, { movement: rt.inventory.setStock({ sku: sku(m), count: body.count, userName: user.name }) });
    }, { shop: true }],
    ['POST', new RegExp(`^${SHOP}/products/([^/]+)/resync$`), 'medewerker', ({ res, m, rt }) => {
      rt.inventory.enqueueSync(sku(m));
      send(res, 200, { ok: true });
    }, { shop: true }],
    ['POST', new RegExp(`^${SHOP}/poll/(bol|woocommerce)$`), 'medewerker', async ({ res, m, rt }) => {
      const poller = rt.pollers.find((p) => p.channel.name === m[2]);
      if (!poller) return send(res, 404, { error: 'Kanaal niet gekoppeld' });
      await poller.run();
      send(res, 200, poller.status());
    }, { shop: true }],

    // --- import / export (per webshop)
    ['GET', new RegExp(`^${SHOP}/export/products\\.csv$`), 'kijker', ({ res, rt }) => {
      send(res, 200, productsToCsv(rt.inventory.listProducts()), {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="producten-${rt.id}-${new Date().toISOString().slice(0, 10)}.csv"`,
      });
    }, { shop: true }],
    ['POST', new RegExp(`^${SHOP}/import/csv$`), 'beheerder', async ({ req, res, user, rt }) => {
      const { csv } = await readJson(req);
      const result = importRows(rt.inventory, parseCsv(csv), { userName: user.name });
      rt.bus.log('info', `CSV-import door ${user.name}: ${result.created} nieuw, ${result.updated} bijgewerkt`);
      send(res, 200, result);
    }, { shop: true }],
    ['POST', new RegExp(`^${SHOP}/import/woocommerce$`), 'beheerder', async ({ res, user, rt }) => {
      if (typeof rt.channels.woocommerce?.listProducts !== 'function') {
        throw new AuthError('WooCommerce is voor deze webshop nog niet gekoppeld: vul de sleutels in via Webshops beheren', 400);
      }
      const result = await importFromWooCommerce(rt.inventory, rt.channels.woocommerce, { userName: user.name });
      rt.bus.log('info', `Producten uit de webshop overgenomen door ${user.name}: ${result.created} nieuw, ${result.updated} bijgewerkt`);
      send(res, 200, result);
    }, { shop: true }],
    ['POST', new RegExp(`^${SHOP}/import/bol-offers$`), 'beheerder', async ({ req, res, user, rt }) => {
      if (typeof rt.channels.bol?.exportOffers !== 'function') {
        throw new AuthError('Bol.com is voor deze webshop niet gekoppeld: vul de sleutels in via Webshops beheren', 400);
      }
      const { createMissing } = await readJson(req);
      const result = await linkBolOffers(rt.inventory, rt.channels.bol, { createMissing: Boolean(createMissing), userName: user.name });
      rt.bus.log('info', `Bol.com-aanbiedingen gekoppeld door ${user.name}: ${result.linked} nieuw gekoppeld, ${result.alreadyLinked} al gekoppeld, ${result.created} toegevoegd, ${result.unmatched.length} zonder product`, { channel: 'bol' });
      send(res, 200, result);
    }, { shop: true }],
    ['POST', new RegExp(`^${SHOP}/backfill$`), 'beheerder', async ({ req, res, user, rt }) => {
      const days = Math.min(90, Math.max(1, Number.parseInt((await readJson(req)).days, 10) || 90));
      const result = {};
      for (const [name, channel] of Object.entries(rt.channels)) {
        if (typeof channel.backfill === 'function') result[name] = await channel.backfill(rt.inventory, days);
      }
      if (!Object.keys(result).length) {
        throw new AuthError('Deze webshop is nog niet gekoppeld: vul de sleutels in via Webshops beheren', 400);
      }
      rt.bus.log('info', `Verkoophistorie (${days} dagen) ingelezen door ${user.name}`);
      rt.bus.publish('product', null);
      send(res, 200, { days, orderLines: result });
    }, { shop: true }],

    // --- webshop management (beheerder)
    ['GET', /^\/api\/shops$/, 'beheerder', ({ res }) => {
      send(res, 200, { shops: shops.list({ includeWebhookSecret: true }), colors: SHOP_COLORS });
    }],
    ['POST', /^\/api\/shops$/, 'beheerder', async ({ req, res, user }) => {
      send(res, 200, shops.create(await readJson(req), { userName: user.name }));
    }],
    ['PATCH', /^\/api\/shops\/([a-z0-9-]+)$/, 'beheerder', async ({ req, res, m, user }) => {
      send(res, 200, shops.update(m[1], await readJson(req), { userName: user.name }));
    }],
    ['DELETE', /^\/api\/shops\/([a-z0-9-]+)$/, 'beheerder', ({ res, m, user }) => {
      shops.remove(m[1], { userName: user.name });
      send(res, 200, { ok: true });
    }],
    ['POST', /^\/api\/shops\/([a-z0-9-]+)\/test$/, 'beheerder', async ({ res, m }) => {
      send(res, 200, await shops.test(m[1]));
    }],

    // --- own account
    ['GET', /^\/api\/me$/, 'kijker', ({ res, user }) => {
      send(res, 200, { user, roles: ROLES, demoMode: config.demoMode });
    }],
    ['POST', /^\/api\/logout$/, 'kijker', ({ req, res, token }) => {
      auth.logout(token);
      send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, config, '', 0) });
    }],
    ['POST', /^\/api\/me\/password$/, 'kijker', async ({ req, res, user, token }) => {
      const body = await readJson(req);
      await auth.changeOwnPassword(user.id, body.current, body.password, token);
      send(res, 200, { ok: true });
    }],

    // --- user management (beheerder)
    ['GET', /^\/api\/users$/, 'beheerder', ({ res }) => send(res, 200, auth.listUsers())],
    ['POST', /^\/api\/users$/, 'beheerder', async ({ req, res, user }) => {
      const body = await readJson(req);
      const password = body.password || generatePassword();
      const created = await auth.createUser({ ...body, shops: validShops(body.shops), password });
      coreBus.log('info', `Gebruiker ${created.name} (${ROLES[created.role].label}) toegevoegd door ${user.name}`);
      send(res, 200, { user: created, password: body.password ? undefined : password });
    }],
    ['PATCH', /^\/api\/users\/(\d+)$/, 'beheerder', async ({ req, res, m, user }) => {
      const id = Number(m[1]);
      const body = await readJson(req);
      if (id === user.id && (body.disabled || (body.role && body.role !== user.role))) {
        throw new AuthError('U kunt uw eigen rol niet wijzigen of uzelf blokkeren');
      }
      if ('shops' in body) body.shops = validShops(body.shops);
      send(res, 200, auth.updateUser(id, body));
    }],
    ['POST', /^\/api\/users\/(\d+)\/password$/, 'beheerder', async ({ res, m, user }) => {
      const password = generatePassword();
      await auth.setPassword(Number(m[1]), password);
      const target = auth.getUser(Number(m[1]));
      coreBus.log('info', `Nieuw wachtwoord ingesteld voor ${target.name} door ${user.name}`);
      send(res, 200, { password });
    }],
    ['DELETE', /^\/api\/users\/(\d+)$/, 'beheerder', ({ res, m, user }) => {
      const id = Number(m[1]);
      if (id === user.id) throw new AuthError('U kunt uw eigen account niet verwijderen');
      const target = auth.getUser(id);
      auth.deleteUser(id);
      coreBus.log('info', `Gebruiker ${target?.name ?? id} verwijderd door ${user.name}`);
      send(res, 200, { ok: true });
    }],

    ['GET', /^\/api\/events$/, 'kijker', ({ req, res, user, token }) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        ...SECURITY_HEADERS,
      });
      res.write('retry: 3000\n\n');
      const listener = (event) => {
        // Re-check on every event, so changed access or a blocked account takes effect immediately.
        const current = auth.userForToken(token);
        if (!current) return res.end();
        if (event.shop ? !canAccessShop(current, event.shop) : event.type === 'log' && !hasRole(current, 'beheerder')) return;
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      };
      hub.on('event', listener);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => {
        clearInterval(ping);
        hub.off('event', listener);
      });
    }],
  ];

  /** null = all webshops; otherwise only ids of existing webshops. */
  function validShops(value) {
    if (value === null || value === undefined) return null;
    if (!Array.isArray(value)) throw new AuthError('Ongeldige webshopselectie');
    const unknown = value.filter((id) => !shops.get(id));
    if (unknown.length) throw new AuthError(`Onbekende webshop: ${unknown.join(', ')}`);
    return value;
  }

  async function wooWebhook(req, res, shopId) {
    const raw = await readBody(req);
    const rt = shops.get(shopId);
    const woo = rt?.channels.woocommerce;
    if (!woo || typeof woo.verifySignature !== 'function') return send(res, 404, { error: 'Onbekende of niet gekoppelde webshop' });
    // WooCommerce sends a form-encoded "webhook_id=…" ping when a webhook is saved.
    if (!req.headers['x-wc-webhook-topic']) return send(res, 200, { ok: true });
    if (!woo.verifySignature(raw, req.headers['x-wc-webhook-signature'])) {
      rt.bus.log('warn', 'Webhook met ongeldige handtekening geweigerd', { channel: 'woocommerce' });
      return send(res, 401, { error: 'Ongeldige handtekening' });
    }
    const topic = String(req.headers['x-wc-webhook-topic']);
    if (topic.startsWith('order.')) {
      let order;
      try {
        order = JSON.parse(raw.toString('utf8'));
      } catch {
        return send(res, 400, { error: 'Ongeldige JSON' });
      }
      woo.bookOrder(rt.inventory, order);
    }
    send(res, 200, { ok: true });
  }

  async function login(req, res) {
    const body = await readJson(req);
    const { token, user, maxAgeSeconds } = await auth.login(body.email, body.password, { ip: clientIp(req, config) });
    send(res, 200, { user }, { 'Set-Cookie': sessionCookie(req, config, token, maxAgeSeconds) });
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    res.acceptsGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
    try {
      if (url.pathname === '/health') return send(res, 200, { ok: true });
      const hook = req.method === 'POST' && url.pathname.match(/^\/webhooks\/woocommerce\/([a-z0-9-]+)$/);
      if (hook) return await wooWebhook(req, res, hook[1]);

      if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) {
        return send(res, 403, { error: 'Verzoek van een andere website geweigerd' });
      }
      if (req.method === 'POST' && url.pathname === '/api/login') return await login(req, res);
      if (req.method === 'GET' && url.pathname === '/api/login-info') {
        return send(res, 200, { demoMode: config.demoMode, hasUsers: auth.hasUsers(), demoLogin: config.demoMode ? app.demoLogin : null });
      }

      const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      const user = auth.userForToken(token);
      const page = STATIC[url.pathname];

      if (req.method === 'GET' && page) {
        const [file, type, needsLogin] = page;
        if (needsLogin && !user) return redirect(res, '/login');
        if (url.pathname === '/login' && user) return redirect(res, '/');
        return send(res, 200, await readFile(join(PUBLIC_DIR, file)), { 'Content-Type': type });
      }
      if (!user) return send(res, 401, { error: 'Inloggen vereist' });

      for (const [method, pattern, role, handler, opts] of routes) {
        const m = req.method === method && url.pathname.match(pattern);
        if (!m) continue;
        if (!hasRole(user, role)) throw forbidden();
        const rt = opts?.shop ? shopFor(user, m[1]) : null;
        return await handler({ req, res, m, url, user, token, rt });
      }
      send(res, 404, { error: 'Niet gevonden' });
    } catch (err) {
      const status = err.status && err.status < 500 ? err.status : 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'Er ging iets mis op de server' : err.message });
      else res.end();
    }
  });
}
