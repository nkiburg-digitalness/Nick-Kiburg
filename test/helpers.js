import { openDb } from '../src/db.js';
import { EventBus } from '../src/events.js';
import { Inventory } from '../src/inventory.js';

export function setup({ channels = ['bol', 'woocommerce'], goLiveAt = null } = {}) {
  const db = openDb(':memory:');
  const bus = new EventBus(db);
  const logs = [];
  bus.log = (level, message) => logs.push({ level, message }); // keep test output clean
  const inventory = new Inventory({ db, bus, channels, goLiveAt });
  return { db, bus, inventory, logs };
}

/**
 * Minimal fetch mock: routes are [method, RegExp, handler(url, init) => {status, body, headers}].
 * Every call is recorded in `calls`.
 */
export function mockFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ method, url: String(url), body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers });
    const route = routes.find(([m, re]) => m === method && re.test(String(url)));
    if (!route) return new Response(JSON.stringify({ detail: 'not mocked' }), { status: 404 });
    const { status = 200, body = {}, headers = {} } = (await route[2](String(url), init)) ?? {};
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  };
  return { fetchImpl, calls };
}
