import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forecastAll, productHistory } from './forecast.js';
import { hasRole, parseCookies, generatePassword, ROLES, SESSION_COOKIE, AuthError } from './auth.js';
import { CHANNEL_LABELS } from './inventory.js';
import { getKv } from './db.js';

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
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
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
  const { config, inventory, bus, channels, pollers, db, auth } = app;

  function overview(windowDays) {
    const products = forecastAll(db, {
      windowDays,
      minTrackedDays: config.forecast.minTrackedDays,
      coverDays: config.forecast.reorderCoverDays,
    });
    return {
      generatedAt: new Date().toISOString(),
      windowDays,
      demoMode: config.demoMode,
      goLiveAt: app.goLiveAt,
      channels: ['bol', 'woocommerce'].map((name) => {
        const poller = pollers.find((p) => p.channel.name === name);
        return {
          name,
          label: CHANNEL_LABELS[name],
          connected: Boolean(channels[name]),
          lastPollAt: poller?.lastRunAt ?? getKv(db, `${name}:last_poll`),
          lastError: poller?.lastError ?? null,
        };
      }),
      products,
    };
  }

  const routes = [
    ['GET', /^\/api\/overview$/, 'kijker', (req, res, _m, url) => {
      const w = Number.parseInt(url.searchParams.get('window') ?? '', 10);
      const windowDays = [7, 14, 30, 60, 90].includes(w) ? w : config.forecast.windowDays;
      send(res, 200, overview(windowDays));
    }],
    ['GET', /^\/api\/products\/([^/]+)\/movements$/, 'kijker', (req, res, m) => {
      send(res, 200, inventory.movements(decodeURIComponent(m[1]), 200));
    }],
    ['GET', /^\/api\/products\/([^/]+)\/history$/, 'kijker', (req, res, m, url) => {
      const w = Number.parseInt(url.searchParams.get('window') ?? '', 10);
      const history = productHistory(db, decodeURIComponent(m[1]), { windowDays: Math.min(365, Math.max(7, w || 60)) });
      if (!history) return send(res, 404, { error: 'Onbekend product' });
      send(res, 200, history);
    }],
    ['POST', /^\/api\/products$/, 'medewerker', async (req, res, _m, _u, user) => {
      send(res, 200, inventory.upsertProduct(await readJson(req), { userName: user.name }));
    }],
    ['DELETE', /^\/api\/products\/([^/]+)$/, 'beheerder', (req, res, m, _u, user) => {
      inventory.deleteProduct(decodeURIComponent(m[1]), { userName: user.name });
      send(res, 200, { ok: true });
    }],
    ['POST', /^\/api\/products\/([^/]+)\/adjust$/, 'medewerker', async (req, res, m, _u, user) => {
      const body = await readJson(req);
      send(res, 200, inventory.adjustStock({
        sku: decodeURIComponent(m[1]), delta: body.delta, type: body.type, note: body.note || null, userName: user.name,
      }));
    }],
    ['POST', /^\/api\/products\/([^/]+)\/count$/, 'medewerker', async (req, res, m, _u, user) => {
      const body = await readJson(req);
      send(res, 200, { movement: inventory.setStock({ sku: decodeURIComponent(m[1]), count: body.count, userName: user.name }) });
    }],
    ['POST', /^\/api\/products\/([^/]+)\/resync$/, 'medewerker', (req, res, m) => {
      inventory.enqueueSync(decodeURIComponent(m[1]));
      send(res, 200, { ok: true });
    }],
    ['POST', /^\/api\/poll\/(bol|woocommerce)$/, 'medewerker', async (req, res, m) => {
      const poller = pollers.find((p) => p.channel.name === m[1]);
      if (!poller) return send(res, 404, { error: 'Kanaal niet gekoppeld' });
      await poller.run();
      send(res, 200, poller.status());
    }],
    ['GET', /^\/api\/log$/, 'kijker', (req, res) => send(res, 200, bus.recentLog(150))],

    // --- own account
    ['GET', /^\/api\/me$/, 'kijker', (req, res, _m, _u, user) => {
      send(res, 200, { user, roles: ROLES, demoMode: config.demoMode });
    }],
    ['POST', /^\/api\/logout$/, 'kijker', (req, res, _m, _u, _user, token) => {
      auth.logout(token);
      send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, config, '', 0) });
    }],
    ['POST', /^\/api\/me\/password$/, 'kijker', async (req, res, _m, _u, user, token) => {
      const body = await readJson(req);
      await auth.changeOwnPassword(user.id, body.current, body.password, token);
      send(res, 200, { ok: true });
    }],

    // --- user management (beheerder)
    ['GET', /^\/api\/users$/, 'beheerder', (req, res) => send(res, 200, auth.listUsers())],
    ['POST', /^\/api\/users$/, 'beheerder', async (req, res, _m, _u, user) => {
      const body = await readJson(req);
      const password = body.password || generatePassword();
      const created = await auth.createUser({ ...body, password });
      bus.log('info', `Gebruiker ${created.name} (${ROLES[created.role].label}) toegevoegd door ${user.name}`);
      send(res, 200, { user: created, password: body.password ? undefined : password });
    }],
    ['PATCH', /^\/api\/users\/(\d+)$/, 'beheerder', async (req, res, m, _u, user) => {
      const id = Number(m[1]);
      const body = await readJson(req);
      if (id === user.id && (body.disabled || (body.role && body.role !== user.role))) {
        throw new AuthError('U kunt uw eigen rol niet wijzigen of uzelf blokkeren');
      }
      send(res, 200, auth.updateUser(id, body));
    }],
    ['POST', /^\/api\/users\/(\d+)\/password$/, 'beheerder', async (req, res, m, _u, user) => {
      const password = generatePassword();
      await auth.setPassword(Number(m[1]), password);
      const target = auth.getUser(Number(m[1]));
      bus.log('info', `Nieuw wachtwoord ingesteld voor ${target.name} door ${user.name}`);
      send(res, 200, { password });
    }],
    ['DELETE', /^\/api\/users\/(\d+)$/, 'beheerder', (req, res, m, _u, user) => {
      const id = Number(m[1]);
      if (id === user.id) throw new AuthError('U kunt uw eigen account niet verwijderen');
      const target = auth.getUser(id);
      auth.deleteUser(id);
      bus.log('info', `Gebruiker ${target?.name ?? id} verwijderd door ${user.name}`);
      send(res, 200, { ok: true });
    }],

    ['GET', /^\/api\/events$/, 'kijker', (req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        ...SECURITY_HEADERS,
      });
      res.write('retry: 3000\n\n');
      const listener = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
      bus.on('event', listener);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => {
        clearInterval(ping);
        bus.off('event', listener);
      });
    }],
  ];

  async function wooWebhook(req, res) {
    const raw = await readBody(req);
    const woo = channels.woocommerce;
    if (!woo) return send(res, 503, { error: 'WooCommerce is niet geconfigureerd' });
    // WooCommerce sends a form-encoded "webhook_id=…" ping when a webhook is saved.
    if (!req.headers['x-wc-webhook-topic']) return send(res, 200, { ok: true });
    if (!woo.verifySignature(raw, req.headers['x-wc-webhook-signature'])) {
      bus.log('warn', 'Webhook met ongeldige handtekening geweigerd', { channel: 'woocommerce' });
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
      woo.bookOrder(inventory, order);
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
    try {
      if (url.pathname === '/health') return send(res, 200, { ok: true });
      if (req.method === 'POST' && url.pathname === '/webhooks/woocommerce') return await wooWebhook(req, res);

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

      for (const [method, pattern, role, handler] of routes) {
        const match = req.method === method && url.pathname.match(pattern);
        if (!match) continue;
        if (!hasRole(user, role)) throw forbidden();
        return await handler(req, res, match, url, user, token);
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
