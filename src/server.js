import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual, createHash } from 'node:crypto';
import { forecastAll, productHistory } from './forecast.js';
import { CHANNEL_LABELS } from './inventory.js';
import { getKv } from './db.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};
const MAX_BODY = 2 * 1024 * 1024;

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
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

function safeEqual(a, b) {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

function authorized(req, config) {
  if (!config.adminPassword) return true;
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Basic ')) return false;
  const [user, ...rest] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':');
  // Evaluate both comparisons (no short-circuit) to avoid leaking which one failed.
  const userOk = safeEqual(user, config.adminUser);
  const passOk = safeEqual(rest.join(':'), config.adminPassword);
  return userOk && passOk;
}

export function createHttpServer(app) {
  const { config, inventory, bus, channels, pollers, db } = app;

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
    ['GET', /^\/api\/overview$/, (req, res, _m, url) => {
      const w = Number.parseInt(url.searchParams.get('window') ?? '', 10);
      const windowDays = [7, 14, 30, 60, 90].includes(w) ? w : config.forecast.windowDays;
      send(res, 200, overview(windowDays));
    }],
    ['GET', /^\/api\/products\/([^/]+)\/movements$/, (req, res, m) => {
      send(res, 200, inventory.movements(decodeURIComponent(m[1]), 200));
    }],
    ['GET', /^\/api\/products\/([^/]+)\/history$/, (req, res, m, url) => {
      const w = Number.parseInt(url.searchParams.get('window') ?? '', 10);
      const history = productHistory(db, decodeURIComponent(m[1]), { windowDays: Math.min(365, Math.max(7, w || 60)) });
      if (!history) return send(res, 404, { error: 'Onbekend product' });
      send(res, 200, history);
    }],
    ['POST', /^\/api\/products$/, async (req, res) => {
      send(res, 200, inventory.upsertProduct(await readJson(req)));
    }],
    ['DELETE', /^\/api\/products\/([^/]+)$/, (req, res, m) => {
      inventory.deleteProduct(decodeURIComponent(m[1]));
      send(res, 200, { ok: true });
    }],
    ['POST', /^\/api\/products\/([^/]+)\/adjust$/, async (req, res, m) => {
      const body = await readJson(req);
      send(res, 200, inventory.adjustStock({ sku: decodeURIComponent(m[1]), delta: body.delta, type: body.type, note: body.note || null }));
    }],
    ['POST', /^\/api\/products\/([^/]+)\/count$/, async (req, res, m) => {
      const body = await readJson(req);
      send(res, 200, { movement: inventory.setStock({ sku: decodeURIComponent(m[1]), count: body.count }) });
    }],
    ['POST', /^\/api\/products\/([^/]+)\/resync$/, (req, res, m) => {
      inventory.enqueueSync(decodeURIComponent(m[1]));
      send(res, 200, { ok: true });
    }],
    ['POST', /^\/api\/poll\/(bol|woocommerce)$/, async (req, res, m) => {
      const poller = pollers.find((p) => p.channel.name === m[1]);
      if (!poller) return send(res, 404, { error: 'Kanaal niet gekoppeld' });
      await poller.run();
      send(res, 200, poller.status());
    }],
    ['GET', /^\/api\/log$/, (req, res) => send(res, 200, bus.recentLog(150))],
    ['GET', /^\/api\/events$/, (req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
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

  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/health') return send(res, 200, { ok: true });
      if (req.method === 'POST' && url.pathname === '/webhooks/woocommerce') return await wooWebhook(req, res);

      if (!authorized(req, config)) {
        return send(res, 401, 'Inloggen vereist', { 'WWW-Authenticate': 'Basic realm="Voorraadbeheer", charset="UTF-8"' });
      }

      if (req.method === 'GET' && STATIC[url.pathname]) {
        const [file, type] = STATIC[url.pathname];
        return send(res, 200, await readFile(join(PUBLIC_DIR, file)), { 'Content-Type': type });
      }
      for (const [method, pattern, handler] of routes) {
        const match = req.method === method && url.pathname.match(pattern);
        if (match) return await handler(req, res, match, url);
      }
      send(res, 404, { error: 'Niet gevonden' });
    } catch (err) {
      const status = err.status && err.status < 500 ? err.status : 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) send(res, status, { error: err.message });
      else res.end();
    }
  });
}
