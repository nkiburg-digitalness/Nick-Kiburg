// Voorraadbeheer dashboard – plain JS, no build step.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const nf = new Intl.NumberFormat('nl-NL');
const nf1 = new Intl.NumberFormat('nl-NL', { maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat('nl-NL', { maximumFractionDigits: 2 });
const dayFmt = new Intl.DateTimeFormat('nl-NL', { day: 'numeric', month: 'short' });
const longDayFmt = new Intl.DateTimeFormat('nl-NL', { weekday: 'short', day: 'numeric', month: 'short' });
const timeFmt = new Intl.DateTimeFormat('nl-NL', { hour: '2-digit', minute: '2-digit' });
const dateTimeFmt = new Intl.DateTimeFormat('nl-NL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

const CHANNELS = { bol: 'Bol.com', woocommerce: 'Webshop', manual: 'Handmatig' };
const ICONS = {
  ok: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.2 5 8.5l4.5-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  warning: '<svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M6 3.4V6l1.8 1.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  critical: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1.3 11 10.4H1L6 1.3Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M6 4.8v2.4M6 8.6v.1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  out: '<svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M4.2 4.2l3.6 3.6M7.8 4.2 4.2 7.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
};
const STATUS = {
  ok: { label: 'Op voorraad', rank: 3 },
  warning: { label: 'Binnenkort bestellen', rank: 2 },
  critical: { label: 'Nu bestellen', rank: 1 },
  out: { label: 'Uitverkocht', rank: 0 },
};
const MOVE_TYPES = { sale: 'Verkoop', sale_reversal: 'Annulering', receipt: 'Ontvangst', correction: 'Correctie' };

const ROLE_LEVEL = { kijker: 1, medewerker: 2, beheerder: 3 };
const ROLE_LABEL = { kijker: 'Alleen bekijken', medewerker: 'Medewerker', beheerder: 'Beheerder' };

const state = {
  me: null,
  data: null,
  shop: 'all', // selected tab: 'all' or a webshop id
  windowDays: 30,
  filter: 'all',
  search: '',
  sort: { key: 'status', asc: true },
  open: null, // { shop, sku } of the product shown in the drawer
  flash: new Set(),
};

const shopInfo = (id) => state.data?.shops.find((s) => s.id === id) ?? null;
const shopBase = (id) => `/api/shops/${encodeURIComponent(id)}`;
const productKey = (shop, sku) => `${shop}/${sku}`;

function shopTag(id) {
  const s = shopInfo(id);
  if (!s) return '';
  return `<span class="shop-tag c-${esc(s.color)}"><i class="shop-dot"></i>${esc(s.name)}</span>`;
}

function rememberShop() {
  try { localStorage.setItem('voorraad.shop', state.shop); } catch { /* ignore */ }
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    location.href = '/login';
    throw new Error('Sessie verlopen');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Fout ${res.status}`);
  return data;
}

function can(role) {
  return (ROLE_LEVEL[state.me?.user?.role] ?? 0) >= ROLE_LEVEL[role];
}

/** Hide controls the current user's role may not use (the server enforces this too). */
function applyRole(root = document) {
  for (const el of root.querySelectorAll('[data-min-role]')) el.hidden = !can(el.dataset.minRole);
}

function parseDay(day) {
  return new Date(`${day}T12:00:00Z`);
}

function relTime(iso) {
  if (!iso) return 'nog niet';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 10) return 'zojuist';
  if (s < 60) return `${s} s geleden`;
  if (s < 3600) return `${Math.round(s / 60)} min geleden`;
  if (s < 86400) return `${Math.round(s / 3600)} uur geleden`;
  return dateTimeFmt.format(new Date(iso));
}

function badge(status) {
  return `<span class="badge ${status}">${ICONS[status]}${STATUS[status].label}</span>`;
}

function daysText(days) {
  if (days === null) return 'geen verkopen';
  if (days < 1) return '< 1 dag';
  return `${nf1.format(days)} ${days === 1 ? 'dag' : 'dagen'}`;
}

/* ---------------------------------------------------------------- tooltip */
const tooltip = $('#tooltip');
function showTooltip(event, html) {
  // An open <dialog> sits in the top layer; the tooltip must live inside it to show on top.
  const host = document.querySelector('dialog[open]') ?? document.body;
  if (tooltip.parentNode !== host) host.append(tooltip);
  tooltip.innerHTML = html;
  tooltip.hidden = false;
  const { innerWidth } = window;
  const rect = tooltip.getBoundingClientRect();
  let x = event.clientX + 14;
  if (x + rect.width > innerWidth - 8) x = event.clientX - rect.width - 14;
  tooltip.style.left = `${Math.max(8, x)}px`;
  tooltip.style.top = `${Math.max(8, event.clientY - rect.height - 12)}px`;
}
function hideTooltip() {
  tooltip.hidden = true;
}

/* ---------------------------------------------------------------- data */
async function load() {
  let data;
  try {
    data = await api(`/api/overview?shop=${encodeURIComponent(state.shop)}&window=${state.windowDays}`);
  } catch (err) {
    if (state.shop === 'all') throw err;
    state.shop = 'all'; // webshop removed or no longer accessible
    return load();
  }
  // With a single webshop there is no "all" view: show that webshop directly.
  if (data.shops.length === 1 && state.shop !== data.shops[0].id) {
    state.shop = data.shops[0].id;
    return load();
  }
  state.data = data;
  render();
  // Refresh an open product, but never while the user is typing in one of its forms.
  const typing = detail.contains(document.activeElement) && document.activeElement.matches('input, select');
  if (state.open && !typing) renderDetail(state.open, { keepScroll: true });
}

function selectShop(id) {
  if (state.shop === id) return;
  state.shop = id;
  state.filter = 'all';
  $$('#status-filter button').forEach((b) => b.classList.toggle('active', b.dataset.filter === 'all'));
  rememberShop();
  load().catch(console.error);
  loadActivity().catch(console.error);
}

let reloadTimer = null;
function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => load().catch(console.error), 250);
}

/* ---------------------------------------------------------------- render */
function render() {
  const { data } = state;
  const all = state.shop === 'all';
  const none = data.shops.length === 0;
  $('#demo-banner').hidden = !data.demoMode;
  $('#no-shops').hidden = !none;
  $('#no-shops-viewer').hidden = can('beheerder');
  $('#kpis').hidden = none;
  $('#products-panel').hidden = none;
  $('#shop-cards').hidden = !all || none;
  $('#products-head').hidden = !all;
  $$('.shop-col').forEach((el) => { el.hidden = !all; });
  const current = shopInfo(state.shop);
  $('#brand-sub').textContent = all ? `${data.shops.length} webshops` : `${current?.name ?? ''} · ${current?.hasBol ? 'webshop + Bol.com' : 'webshop'}`;
  renderTabs();
  renderChannels();
  renderKpis();
  if (all) renderShopCards();
  renderRows();
}

function actionCount(s) {
  return s.summary.warning + s.summary.critical + s.summary.out;
}

function renderTabs() {
  const { shops } = state.data;
  const nav = $('#shop-tabs');
  nav.hidden = shops.length < 2;
  if (nav.hidden) return;
  const tab = (id, label, color, count) => `<button role="tab" data-shop="${esc(id)}" class="${color ? `c-${esc(color)}` : ''}" aria-selected="${state.shop === id}">
    ${color ? '<i class="shop-dot"></i>' : ''}${esc(label)}${count ? `<span class="tab-count" title="${count} product(en) bijna of al uitverkocht">${count}</span>` : ''}</button>`;
  const total = shops.reduce((n, s) => n + actionCount(s), 0);
  nav.innerHTML = tab('all', 'Alle webshops', null, total) + shops.map((s) => tab(s.id, s.name, s.color, actionCount(s))).join('');
}

function channelLine(s) {
  const parts = [];
  for (const c of s.channels) {
    if (c.name === 'bol' && !c.connected && !s.hasBol) continue;
    let text;
    if (state.data.demoMode) text = c.connected ? 'demo' : 'niet gekoppeld';
    else if (!c.connected) text = 'niet gekoppeld';
    else if (c.lastError) text = '<span class="err">storing</span>';
    else text = `gecontroleerd ${relTime(c.lastPollAt)}`;
    parts.push(`<span title="${esc(c.lastError ?? '')}"><i class="swatch ${c.name}"></i>${c.label}: ${text}</span>`);
  }
  return parts.join('');
}

function renderShopCards() {
  $('#shop-cards').innerHTML = state.data.shops.map((s) => {
    const sm = s.summary;
    const statuses = [
      sm.out ? `${badge('out')} ${sm.out}` : '',
      sm.critical ? `${badge('critical')} ${sm.critical}` : '',
      sm.warning ? `${badge('warning')} ${sm.warning}` : '',
    ].filter(Boolean).join(' ') || badge('ok');
    return `<button class="shop-card c-${esc(s.color)}" data-shop="${esc(s.id)}">
      <h3><i class="shop-dot"></i>${esc(s.name)}</h3>
      <div class="figures">
        <div><b>${nf.format(sm.products)}</b><span>producten</span></div>
        <div><b>${nf.format(sm.stock)}</b><span>stuks voorraad</span></div>
        <div><b>${nf.format(sm.soldToday.bol + sm.soldToday.woocommerce)}</b><span>verkocht vandaag</span></div>
      </div>
      <div class="statuses">${statuses}</div>
      <div class="conn">${channelLine(s)}</div>
    </button>`;
  }).join('');
}

function renderChannels() {
  const s = state.shop === 'all' ? null : shopInfo(state.shop);
  const box = $('#channels');
  box.hidden = !s;
  if (!s) return;
  box.innerHTML = s.channels.filter((c) => c.connected || c.name === 'woocommerce' || s.hasBol).map((c) => {
    let text;
    if (state.data.demoMode) text = 'demo';
    else if (!c.connected) text = 'niet gekoppeld';
    else if (c.lastError) text = '<span style="color:var(--critical-ink)">storing</span>';
    else text = `gecontroleerd ${relTime(c.lastPollAt)}`;
    return `<span class="channel-pill" title="${esc(c.lastError ?? '')}"><i class="swatch ${c.name}"></i><b>${c.label}</b>${text}</span>`;
  }).join('');
}

function renderKpis() {
  const shops = state.shop === 'all' ? state.data.shops : state.data.shops.filter((s) => s.id === state.shop);
  const sum = (fn) => shops.reduce((n, s) => n + fn(s.summary), 0);
  const productCount = sum((m) => m.products);
  const totalStock = sum((m) => m.stock);
  const today = { bol: sum((m) => m.soldToday.bol), woocommerce: sum((m) => m.soldToday.woocommerce) };
  const critical = sum((m) => m.critical);
  const action = { length: critical + sum((m) => m.warning) };
  const out = sum((m) => m.out);
  $('#kpis').innerHTML = `
    <div class="kpi"><div class="label">Producten</div><div class="value">${nf.format(productCount)}</div>
      <div class="sub">${nf.format(totalStock)} stuks op voorraad${state.shop === 'all' ? ` · ${shops.length} webshops` : ''}</div></div>
    <div class="kpi"><div class="label">Verkocht vandaag</div><div class="value">${nf.format(today.bol + today.woocommerce)}</div>
      <div class="sub"><span><i class="swatch bol"></i>Bol.com ${nf.format(today.bol)}</span><span><i class="swatch woocommerce"></i>Webshop ${nf.format(today.woocommerce)}</span></div></div>
    <button class="kpi" data-filter="action"><div class="label">Actie nodig</div><div class="value">${nf.format(action.length)}</div>
      <div class="sub">${critical ? `${badge('critical')} ${critical}` : 'binnen levertijd + marge uitverkocht'}</div></button>
    <button class="kpi" data-filter="out"><div class="label">Uitverkocht</div><div class="value">${nf.format(out)}</div>
      <div class="sub">${out ? 'wordt als 0 naar alle kanalen gestuurd' : 'alles leverbaar'}</div></button>
  `;
}

function sortValue(p, key) {
  const f = p.forecast;
  switch (key) {
    case 'name': return p.name.toLowerCase();
    case 'shop': return (shopInfo(p.shop)?.name ?? '').toLowerCase();
    case 'stock': return p.stock;
    case 'avg': return f.avgPerDay;
    case 'daysLeft': return f.daysLeft ?? Infinity;
    case 'orderBy': return f.orderByDate ?? '9999';
    case 'advice': return f.orderAdvice;
    case 'status': return STATUS[f.status].rank * 1e6 + (f.daysLeft ?? 1e5);
    default: return 0;
  }
}

function visibleProducts() {
  const q = state.search.trim().toLowerCase();
  let list = state.data.products.filter((p) => {
    if (state.filter === 'action' && !['warning', 'critical'].includes(p.forecast.status)) return false;
    if (state.filter === 'out' && p.forecast.status !== 'out') return false;
    if (!q) return true;
    return [p.name, p.sku, p.ean].some((v) => v && String(v).toLowerCase().includes(q));
  });
  const { key, asc } = state.sort;
  list = list.sort((a, b) => {
    const va = sortValue(a, key);
    const vb = sortValue(b, key);
    return (va < vb ? -1 : va > vb ? 1 : 0) * (asc ? 1 : -1);
  });
  return list;
}

function syncCell(p) {
  const s = shopInfo(p.shop);
  // Webshops (or products) not on Bol.com show only the webshop line.
  const names = ['woocommerce', 'bol'].filter((c) => c === 'woocommerce' || (s?.hasBol && p.bol_offer_id) || p.pendingSync.bol);
  return `<div class="sync">${names.map((c) => {
    const ch = s.channels.find((x) => x.name === c);
    const pend = p.pendingSync[c];
    const pushed = p.channelStock[c];
    let st;
    const linked = c === 'bol' ? p.bol_offer_id : p.woo_product_id;
    if (!state.data.demoMode && (!ch.connected || !linked)) st = '<span class="state">niet gekoppeld</span>';
    else if (pend?.lastError) st = `<span class="state error" title="${esc(pend.lastError)}">mislukt, opnieuw…</span>`;
    else if (pend) st = '<span class="state pending">bijwerken…</span>';
    else if (pushed) st = `<span class="state">${nf.format(pushed.stock)} ${pushed.stock === Math.max(0, p.stock) ? '✓' : ''}</span>`;
    else st = '<span class="state">–</span>';
    return `<span><i class="swatch ${c}"></i>${st}</span>`;
  }).join('')}</div>`;
}

function sparkline(values, days) {
  const w = 120;
  const h = 28;
  const n = values.length;
  const max = Math.max(1, ...values);
  const bw = w / n;
  const bars = values.map((v, i) => {
    const bh = v > 0 ? Math.max(2, (v / max) * (h - 2)) : 0;
    return bh ? `<rect x="${(i * bw + 0.5).toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${Math.max(1, bw - 1).toFixed(1)}" height="${bh.toFixed(1)}" rx="1" fill="var(--text-3)"/>` : '';
  }).join('');
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" data-values="${values.join(',')}" data-days="${days}" role="img" aria-label="Verkoop per dag, laatste ${n} dagen, maximaal ${max} per dag"><line x1="0" x2="${w}" y1="${h - 0.5}" y2="${h - 0.5}" stroke="var(--grid)"/>${bars}</svg>`;
}

function runway(f, p) {
  if (f.daysLeft === null) return '';
  const horizon = Math.max(60, (p.lead_time_days + p.safety_days) * 2);
  const pct = Math.min(1, f.daysLeft / horizon) * 100;
  const mark = Math.min(1, (p.lead_time_days + p.safety_days) / horizon) * 100;
  const cls = f.status === 'critical' || f.status === 'out' ? 'critical' : f.status === 'warning' ? 'warning' : '';
  return `<div class="runway" title="Streep = levertijd + veiligheidsmarge (${p.lead_time_days + p.safety_days} dagen)"><i class="${cls}" style="width:${pct}%"></i><em style="left:${mark}%"></em></div>`;
}

function renderRows() {
  const list = visibleProducts();
  $('#empty').hidden = list.length > 0;
  $('#empty').textContent = state.shop === 'all' && !state.search
    ? 'Alles op voorraad – in geen enkele webshop is nu actie nodig.'
    : 'Geen producten gevonden.';
  const sparkDays = Math.min(30, state.windowDays);
  $('#rows').innerHTML = list.map((p) => {
    const f = p.forecast;
    const trend = f.trendPct === null ? '' : `<span class="trend">${f.trendPct >= 0 ? '▲' : '▼'} ${Math.abs(f.trendPct)}% laatste 7 d</span>`;
    const lastDays = p.salesPerDay.slice(-sparkDays);
    return `<tr data-shop="${esc(p.shop)}" data-sku="${esc(p.sku)}" class="${state.flash.has(productKey(p.shop, p.sku)) ? 'flash' : ''}">
      <td><div class="pname">${esc(p.name)}</div><div class="psku">${esc(p.sku)}</div></td>
      ${state.shop === 'all' ? `<td>${shopTag(p.shop)}</td>` : ''}
      <td class="num"><span class="stock ${p.stock < 0 ? 'neg' : ''}">${nf.format(p.stock)}</span></td>
      <td class="hide-sm">${syncCell(p)}</td>
      <td class="num hide-xs">${nf2.format(f.avgPerDay)}${trend}</td>
      <td class="hide-sm">${sparkline(lastDays, sparkDays)}</td>
      <td class="num days"><b>${f.status === 'out' ? '0 dagen' : daysText(f.daysLeft)}</b>${f.soldOutDate && f.status !== 'out' ? `<div class="muted small">± ${dayFmt.format(parseDay(f.soldOutDate))}</div>` : ''}${runway(f, p)}</td>
      <td class="hide-sm">${f.orderByDate ? orderByText(f.orderByDate) : '<span class="muted">–</span>'}</td>
      <td class="num hide-sm">${f.orderAdvice ? nf.format(f.orderAdvice) : '<span class="muted">–</span>'}</td>
      <td>${badge(f.status)}</td>
    </tr>`;
  }).join('');
  $$('th[data-sort]').forEach((th) => {
    th.classList.toggle('sorted', th.dataset.sort === state.sort.key);
    th.classList.toggle('asc', th.dataset.sort === state.sort.key && state.sort.asc);
  });
}

function orderByText(day) {
  const d = parseDay(day);
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const diff = Math.round((d - today) / 86400000);
  if (diff < 0) return `<span style="color:var(--serious-ink);font-weight:600">${dayFmt.format(d)}</span><div class="muted small">${-diff} d geleden</div>`;
  if (diff === 0) return '<b>vandaag</b>';
  return `${dayFmt.format(d)}<div class="muted small">over ${diff} d</div>`;
}

/* ---------------------------------------------------------------- detail */
const detail = $('#detail');

async function openDetail(shop, sku) {
  state.open = { shop, sku };
  $('#detail-body').innerHTML = '<p class="muted">Laden…</p>';
  if (!detail.open) detail.showModal();
  await renderDetail(state.open);
}

async function renderDetail({ shop, sku }, { keepScroll = false } = {}) {
  const p = state.data.products.find((x) => x.shop === shop && x.sku === sku);
  if (!p) {
    detail.close();
    return;
  }
  const base = `${shopBase(shop)}/products/${encodeURIComponent(sku)}`;
  const historyWindow = Math.max(60, state.windowDays);
  const [history, moves] = await Promise.all([
    api(`${base}/history?window=${historyWindow}`),
    api(`${base}/movements`),
  ]);
  if (state.open?.shop !== shop || state.open?.sku !== sku) return;
  const shopHasBol = shopInfo(shop)?.hasBol || Boolean(p.bol_offer_id);
  const scroll = detail.scrollTop;
  const f = p.forecast;
  const body = $('#detail-body');
  const channelSplit = ['bol', 'woocommerce'].map((c) => p.channelSplit[c] ?? 0);
  const splitTotal = channelSplit[0] + channelSplit[1];

  body.innerHTML = `
    <div class="drawer-head">
      <div class="grow">
        <h2>${esc(p.name)}</h2>
        <div class="psku">${esc(p.sku)}${p.ean ? ` · EAN ${esc(p.ean)}` : ''}</div>
        ${state.data.shops.length > 1 ? `<div style="margin-top:4px">${shopTag(shop)}</div>` : ''}
      </div>
      ${badge(f.status)}
      <button class="close" data-close aria-label="Sluiten">×</button>
    </div>

    <div class="stats">
      <div class="stat"><div class="label">Voorraad</div><div class="value">${nf.format(p.stock)}</div><div class="hint">centraal, leidend voor alle kanalen</div></div>
      <div class="stat"><div class="label">Gem. verkoop / dag</div><div class="value">${nf2.format(f.avgPerDay)}</div><div class="hint">${f.unitsSold} stuks in ${f.sellingDays} verkoopdagen</div></div>
      <div class="stat"><div class="label">Uitverkocht over</div><div class="value">${f.status === 'out' ? '0' : f.daysLeft === null ? '–' : nf1.format(f.daysLeft)}</div><div class="hint">${f.soldOutDate && f.status !== 'out' ? `dagen · rond ${longDayFmt.format(parseDay(f.soldOutDate))}` : f.daysLeft === null ? 'geen verkopen in periode' : 'dagen'}</div></div>
      <div class="stat"><div class="label">Bestellen vóór</div><div class="value">${f.orderByDate ? dayFmt.format(parseDay(f.orderByDate)) : '–'}</div><div class="hint">levertijd ${p.lead_time_days} d + marge ${p.safety_days} d</div></div>
      <div class="stat"><div class="label">Besteladvies</div><div class="value">${nf.format(f.orderAdvice)}</div><div class="hint">bestelpunt ${nf.format(f.reorderPoint)} stuks</div></div>
    </div>

    <p class="explain">
      Berekening: in de afgelopen ${f.windowDays} dagen zijn ${f.unitsSold} stuks verkocht${splitTotal ? ` (Bol.com ${Math.round((channelSplit[0] / splitTotal) * 100)}%, webshop ${Math.round((channelSplit[1] / splitTotal) * 100)}%)` : ''}
      over ${f.sellingDays} verkoopdagen${f.outOfStockDays ? ` (${f.outOfStockDays} dag(en) uitverkocht niet meegeteld)` : ''} = <b>${nf2.format(f.avgPerDay)} per dag</b>.
      ${f.daysLeft !== null && f.status !== 'out' ? `${nf.format(p.stock)} op voorraad ÷ ${nf2.format(f.avgPerDay)} per dag = <b>${nf1.format(f.daysLeft)} dagen</b>.` : ''}
      ${f.trendPct !== null ? ` De laatste 7 dagen ligt de verkoop ${Math.abs(f.trendPct)}% ${f.trendPct >= 0 ? 'hoger' : 'lager'} dan dit gemiddelde.` : ''}
    </p>

    <div class="chart-card">
      <h3>Voorraadverloop en prognose</h3>
      <div class="legend">
        <span><i class="line"></i>Voorraad</span>
        <span><i class="line dashed"></i>Prognose bij huidig tempo</span>
        <span><i class="line ref"></i>Bestelpunt</span>
      </div>
      <div id="stock-chart"></div>
    </div>

    <div class="chart-card">
      <h3>Verkopen per dag</h3>
      <div class="legend">
        <span><i class="swatch bol"></i>Bol.com</span>
        <span><i class="swatch woocommerce"></i>Webshop</span>
        ${f.avgPerDay > 0 ? `<span><i class="line dashed"></i>Gemiddeld ${nf2.format(f.avgPerDay)} per dag (${f.windowDays} d)</span>` : ''}
      </div>
      <div id="sales-chart"></div>
    </div>

    <div class="chart-card">
      <h3>Kanalen</h3>
      <div class="channel-rows">
        ${['woocommerce', 'bol'].filter((c) => c === 'woocommerce' || shopHasBol).map((c) => {
          const pushed = p.channelStock[c];
          const pend = p.pendingSync[c];
          const linked = c === 'bol' ? p.bol_offer_id : p.woo_product_id;
          return `<div class="channel-row"><i class="swatch ${c}"></i><b>${CHANNELS[c]}</b>
            <span class="grow muted">${linked ? `gekoppeld (${c === 'bol' ? `offer ${esc(p.bol_offer_id)}` : `product #${esc(p.woo_product_id)}${p.woo_variation_id ? `/${esc(p.woo_variation_id)}` : ''}`})` : 'niet gekoppeld'}</span>
            <span>${pend?.lastError ? `<span style="color:var(--critical-ink)" title="${esc(pend.lastError)}">mislukt – wordt opnieuw geprobeerd</span>` : pend ? 'bijwerken…' : pushed ? `${nf.format(pushed.stock)} · ${relTime(pushed.syncedAt)}` : '–'}</span>
          </div>`;
        }).join('')}
      </div>
      <div class="actions" data-min-role="medewerker"><button data-action="resync">Voorraad opnieuw naar kanalen sturen</button></div>
    </div>

    <div class="forms" data-min-role="medewerker">
      <form class="mini-form" data-form="receipt">
        <h3>Levering ontvangen</h3>
        <div class="row"><input name="delta" type="number" min="1" placeholder="Aantal" required><button class="primary">Boeken</button></div>
        <input name="note" placeholder="Notitie (bijv. pakbon)">
      </form>
      <form class="mini-form" data-form="count">
        <h3>Voorraadtelling</h3>
        <div class="row"><input name="count" type="number" min="0" placeholder="Geteld" required><button>Opslaan</button></div>
        <span class="muted small">Verschil wordt als correctie geboekt.</span>
      </form>
    </div>

    <form class="mini-form" data-form="settings" data-min-role="medewerker">
      <h3>Productinstellingen</h3>
      <div class="form-grid" style="padding:0;width:auto">
        <label>Naam<input name="name" value="${esc(p.name)}" required></label>
        <label>EAN<input name="ean" value="${esc(p.ean ?? '')}"></label>
        <label>Levertijd leverancier (dagen)<input name="lead_time_days" type="number" min="0" value="${p.lead_time_days}"></label>
        <label>Veiligheidsmarge (dagen)<input name="safety_days" type="number" min="0" value="${p.safety_days}"></label>
        <label>WooCommerce product-ID<input name="woo_product_id" value="${esc(p.woo_product_id ?? '')}"></label>
        <label>WooCommerce variatie-ID<input name="woo_variation_id" value="${esc(p.woo_variation_id ?? '')}"></label>
        ${shopHasBol ? `<label class="span-2">Bol.com offer-ID<input name="bol_offer_id" value="${esc(p.bol_offer_id ?? '')}"></label>` : ''}
        <div class="actions span-2"><button type="button" class="danger" data-action="delete" data-min-role="beheerder">Product verwijderen</button><button class="primary">Opslaan</button></div>
      </div>
    </form>

    <div class="chart-card">
      <h3>Mutaties</h3>
      <div class="table-wrap">
        <table class="moves">
          <thead><tr><th>Datum</th><th>Soort</th><th>Kanaal</th><th class="num">Aantal</th><th class="num">Voorraad</th><th>Omschrijving</th></tr></thead>
          <tbody>${moves.map((m) => `<tr class="${m.applied ? '' : 'history'}">
            <td>${dateTimeFmt.format(new Date(m.created_at))}</td>
            <td>${MOVE_TYPES[m.type]}${m.applied ? '' : ' <span class="muted small">(historie)</span>'}</td>
            <td>${CHANNELS[m.channel] ?? esc(m.channel)}</td>
            <td class="num ${m.delta > 0 ? 'plus' : 'minus'}">${m.delta > 0 ? '+' : ''}${nf.format(m.delta)}</td>
            <td class="num">${m.stock_after ?? '–'}</td>
            <td class="muted">${esc([m.note, m.user_name].filter(Boolean).join(' · '))}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>
    </div>
  `;

  applyRole(body);
  stockChart($('#stock-chart'), history, p);
  salesChart($('#sales-chart'), history, f);
  if (keepScroll) detail.scrollTop = scroll;
}

/* ---------------------------------------------------------------- charts */
const DAY = 86400000;

/** Round the axis maximum up so that `ticks` gridlines fall on whole, readable numbers. */
function niceMax(max, ticks = 4) {
  const raw = max / ticks;
  if (raw <= 1) return ticks;
  const pow = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    const step = m * pow;
    if (step >= raw && Number.isInteger(step)) return step * ticks;
  }
  return 10 * pow * ticks;
}

function chartFrame(width, height, pad, yMax, ticks = 4) {
  const lines = [];
  for (let i = 0; i <= ticks; i++) {
    const v = (yMax / ticks) * i;
    const y = height - pad.b - (v / yMax) * (height - pad.t - pad.b);
    lines.push(`<line class="gridline" x1="${pad.l}" x2="${width - pad.r}" y1="${y}" y2="${y}"/>`);
    lines.push(`<text class="axis" x="${pad.l - 6}" y="${y + 4}" text-anchor="end">${nf.format(Math.round(v))}</text>`);
  }
  return lines.join('');
}

function xLabels(days, x, height, pad, every) {
  return days.map((d, i) => (i % every === 0
    ? `<text class="axis" x="${x(i)}" y="${height - pad.b + 16}" text-anchor="middle">${dayFmt.format(parseDay(d))}</text>`
    : '')).join('');
}

function stockChart(el, history, p) {
  const f = p.forecast;
  const width = 700;
  const height = 240;
  const pad = { l: 40, r: 16, t: 12, b: 26 };
  const hist = history.days.map((d, i) => ({ day: d, stock: history.stockEnd[i], future: false }));
  // Projection: from today's stock down to 0 at the current sales pace.
  const futureDays = f.daysLeft === null ? 14 : Math.min(90, Math.max(7, Math.ceil(f.daysLeft) + 3));
  const today = parseDay(history.days[history.days.length - 1]);
  const future = [];
  for (let i = 1; i <= futureDays; i++) {
    const stock = f.avgPerDay > 0 ? Math.max(0, p.stock - f.avgPerDay * i) : Math.max(0, p.stock);
    future.push({ day: new Date(today.getTime() + i * DAY).toISOString().slice(0, 10), stock, future: true });
  }
  const points = [...hist, ...future];
  const n = points.length;
  const yMax = niceMax(Math.max(1, f.reorderPoint, ...points.map((pt) => pt.stock ?? 0)) * 1.1);
  const x = (i) => pad.l + (i / (n - 1)) * (width - pad.l - pad.r);
  const y = (v) => height - pad.b - (v / yMax) * (height - pad.t - pad.b);
  const todayIdx = hist.length - 1;

  const histPath = hist.map((pt, i) => (pt.stock === null ? null : `${x(i)},${y(pt.stock)}`)).filter(Boolean);
  const projPath = [`${x(todayIdx)},${y(Math.max(0, p.stock))}`, ...future.map((pt, j) => `${x(todayIdx + j + 1)},${y(pt.stock)}`)];
  const every = Math.ceil(n / 7);
  const reorderY = y(f.reorderPoint);

  el.innerHTML = `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Voorraadverloop van ${esc(p.name)} met prognose">
    ${chartFrame(width, height, pad, yMax)}
    ${xLabels(points.map((pt) => pt.day), x, height, pad, every)}
    ${f.reorderPoint > 0 ? `<line class="reorder" x1="${pad.l}" x2="${width - pad.r}" y1="${reorderY}" y2="${reorderY}"/><text class="reorder-label" x="${width - pad.r}" y="${reorderY - 5}" text-anchor="end">bestelpunt ${nf.format(f.reorderPoint)}</text>` : ''}
    <line class="today" x1="${x(todayIdx)}" x2="${x(todayIdx)}" y1="${pad.t}" y2="${height - pad.b}"/>
    <text class="axis" x="${x(todayIdx) + 4}" y="${pad.t + 10}">vandaag</text>
    ${histPath.length > 1 ? `<polyline class="stock-line" points="${histPath.join(' ')}"/>` : ''}
    ${f.avgPerDay > 0 && p.stock > 0 ? `<polyline class="projection" points="${projPath.join(' ')}"/>` : ''}
    <line class="crosshair" x1="0" x2="0" y1="${pad.t}" y2="${height - pad.b}" visibility="hidden"/>
    <circle class="hover-dot" r="4" visibility="hidden"/>
    <rect class="hit" x="${pad.l}" y="0" width="${width - pad.l - pad.r}" height="${height}"/>
  </svg>`;

  const svg = $('svg', el);
  const cross = $('.crosshair', svg);
  const dot = $('.hover-dot', svg);
  $('.hit', svg).addEventListener('pointermove', (e) => {
    const box = svg.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * width;
    const i = Math.max(0, Math.min(n - 1, Math.round(((px - pad.l) / (width - pad.l - pad.r)) * (n - 1))));
    const pt = points[i];
    if (pt.stock === null) return hideTooltip();
    cross.setAttribute('x1', x(i));
    cross.setAttribute('x2', x(i));
    cross.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', x(i));
    dot.setAttribute('cy', y(pt.stock));
    dot.setAttribute('visibility', 'visible');
    showTooltip(e, `<div class="t-title">${longDayFmt.format(parseDay(pt.day))}</div>
      <div class="t-row"><span>${pt.future ? 'Verwachte voorraad' : 'Voorraad (eind van de dag)'}</span><b>${nf.format(Math.round(pt.stock))}</b></div>`);
  });
  $('.hit', svg).addEventListener('pointerleave', () => {
    cross.setAttribute('visibility', 'hidden');
    dot.setAttribute('visibility', 'hidden');
    hideTooltip();
  });
}

function salesChart(el, history, f) {
  const width = 700;
  const height = 200;
  const pad = { l: 40, r: 16, t: 12, b: 26 };
  const n = history.days.length;
  const totals = history.days.map((_, i) => history.sales.bol[i] + history.sales.woocommerce[i]);
  const yMax = niceMax(Math.max(1, ...totals) * 1.1);
  const slot = (width - pad.l - pad.r) / n;
  const bw = Math.max(2, slot - 2);
  const y = (v) => height - pad.b - (v / yMax) * (height - pad.t - pad.b);
  const x = (i) => pad.l + i * slot + slot / 2;
  const bars = history.days.map((_, i) => {
    const bol = Math.max(0, history.sales.bol[i]);
    const woo = Math.max(0, history.sales.woocommerce[i]);
    let out = '';
    const x0 = pad.l + i * slot + (slot - bw) / 2;
    if (bol) out += `<rect class="bar-bol" x="${x0}" y="${y(bol)}" width="${bw}" height="${y(0) - y(bol)}" rx="1"/>`;
    if (woo) {
      const top = y(bol + woo);
      const h = y(bol) - top - (bol ? 2 : 0); // 2px surface gap between stacked segments
      if (h > 0) out += `<rect class="bar-woo" x="${x0}" y="${top}" width="${bw}" height="${h}" rx="1"/>`;
    }
    return out;
  }).join('');
  const avgY = y(f.avgPerDay);

  el.innerHTML = `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Verkopen per dag per kanaal">
    ${chartFrame(width, height, pad, yMax)}
    ${xLabels(history.days, x, height, pad, Math.ceil(n / 7))}
    ${bars}
    ${f.avgPerDay > 0 ? `<line class="reorder" style="stroke:var(--text-2)" x1="${pad.l}" x2="${width - pad.r}" y1="${avgY}" y2="${avgY}"/>` : ''}
    <rect class="hit" x="${pad.l}" y="0" width="${width - pad.l - pad.r}" height="${height}"/>
  </svg>`;

  const svg = $('svg', el);
  $('.hit', svg).addEventListener('pointermove', (e) => {
    const box = svg.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * width;
    const i = Math.max(0, Math.min(n - 1, Math.floor((px - pad.l) / slot)));
    showTooltip(e, `<div class="t-title">${longDayFmt.format(parseDay(history.days[i]))}</div>
      <div class="t-row"><span><i class="swatch bol"></i>Bol.com</span><b>${nf.format(history.sales.bol[i])}</b></div>
      <div class="t-row"><span><i class="swatch woocommerce"></i>Webshop</span><b>${nf.format(history.sales.woocommerce[i])}</b></div>
      <div class="t-row"><span>Totaal</span><b>${nf.format(totals[i])}</b></div>`);
  });
  $('.hit', svg).addEventListener('pointerleave', hideTooltip);
}

/* ---------------------------------------------------------------- activity */
function activityItem(row, isNew = false) {
  const li = document.createElement('li');
  li.className = `${row.level}${isNew ? ' new' : ''}`;
  const tag = state.shop === 'all' && row.shop ? `${shopTag(row.shop)} · ` : '';
  li.innerHTML = `<time datetime="${row.created_at}" title="${dateTimeFmt.format(new Date(row.created_at))}">${timeFmt.format(new Date(row.created_at))}</time>
    <i class="marker ${row.channel ?? ''}"></i><span class="msg">${tag}${esc(row.message)}</span>`;
  return li;
}

async function loadActivity() {
  const rows = await api(`/api/log?shop=${encodeURIComponent(state.shop)}`);
  const list = $('#activity');
  list.replaceChildren(...rows.map((r) => activityItem(r)));
}

/* ---------------------------------------------------------------- live */
function connectEvents() {
  const live = $('#live');
  const label = $('#live-label');
  const source = new EventSource('/api/events');
  source.onopen = () => {
    live.className = 'live on';
    label.textContent = 'Live';
  };
  source.onerror = () => {
    live.className = 'live off';
    label.textContent = 'Verbinding verbroken – opnieuw verbinden…';
  };
  source.onmessage = (msg) => {
    const event = JSON.parse(msg.data);
    if (event.type === 'shops') {
      // Webshops were added, changed or removed.
      scheduleReload();
      return;
    }
    const relevant = state.shop === 'all' || event.shop === state.shop;
    if (event.type === 'log') {
      if (!relevant || (state.shop !== 'all' && !event.shop)) return;
      const list = $('#activity');
      list.prepend(activityItem(event.payload, true));
      while (list.children.length > 150) list.lastChild.remove();
      return;
    }
    if (event.type === 'poll') {
      // A routine order check: only the channel status changes, no need to reload all products.
      const channel = shopInfo(event.shop)?.channels.find((c) => c.name === event.payload.channel);
      if (channel) {
        channel.lastPollAt = event.payload.lastRunAt ?? channel.lastPollAt;
        channel.lastError = event.payload.lastError;
        renderChannels();
        if (state.shop === 'all') renderShopCards();
      }
      return;
    }
    if (!relevant) return; // another webshop: its tab refreshes when opened
    const sku = event.payload?.sku;
    if (sku && event.type === 'product') {
      const key = productKey(event.shop, sku);
      state.flash.add(key);
      setTimeout(() => {
        state.flash.delete(key);
        $(`tr[data-shop="${CSS.escape(event.shop)}"][data-sku="${CSS.escape(sku)}"]`)?.classList.remove('flash');
      }, 1500);
    }
    scheduleReload();
  };
}

/* ---------------------------------------------------------------- events */
function bindUi() {
  $('#search').addEventListener('input', (e) => {
    state.search = e.target.value;
    renderRows();
  });
  $('#window').addEventListener('change', (e) => {
    state.windowDays = Number(e.target.value);
    try { localStorage.setItem('voorraad.window', e.target.value); } catch { /* ignore */ }
    load();
  });
  const setFilter = (filter) => {
    state.filter = filter;
    $$('#status-filter button').forEach((b) => b.classList.toggle('active', b.dataset.filter === filter));
    renderRows();
  };
  $('#status-filter').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-filter]');
    if (btn) setFilter(btn.dataset.filter);
  });
  $('#kpis').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-filter]');
    if (btn) setFilter(state.filter === btn.dataset.filter ? 'all' : btn.dataset.filter);
  });
  $$('th[data-sort]').forEach((th) => th.addEventListener('click', () => {
    const key = th.dataset.sort;
    state.sort = { key, asc: state.sort.key === key ? !state.sort.asc : key !== 'avg' && key !== 'advice' && key !== 'stock' };
    renderRows();
  }));
  $('#rows').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-sku]');
    if (tr) openDetail(tr.dataset.shop, tr.dataset.sku);
  });
  $('#shop-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-shop]');
    if (btn) selectShop(btn.dataset.shop);
  });
  $('#shop-cards').addEventListener('click', (e) => {
    const card = e.target.closest('[data-shop]');
    if (card) selectShop(card.dataset.shop);
  });
  $('#add-first-shop').addEventListener('click', () => openShops({ add: true }));
  $('#rows').addEventListener('pointermove', (e) => {
    const svg = e.target.closest('svg.spark');
    if (!svg) return hideTooltip();
    const values = svg.dataset.values.split(',').map(Number);
    const box = svg.getBoundingClientRect();
    const i = Math.max(0, Math.min(values.length - 1, Math.floor(((e.clientX - box.left) / box.width) * values.length)));
    const day = new Date(Date.now() - (values.length - 1 - i) * DAY);
    showTooltip(e, `<div class="t-title">${longDayFmt.format(day)}</div><div class="t-row"><span>Verkocht</span><b>${nf.format(values[i])}</b></div>`);
  });
  $('#rows').addEventListener('pointerleave', hideTooltip);

  detail.addEventListener('click', async (e) => {
    if (e.target === detail || e.target.closest('[data-close]')) {
      detail.close();
      return;
    }
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (!state.open) return;
    const { shop, sku } = state.open;
    const base = `${shopBase(shop)}/products/${encodeURIComponent(sku)}`;
    if (action === 'resync') {
      await api(`${base}/resync`, { method: 'POST' });
    } else if (action === 'delete') {
      if (confirm(`Product ${sku} en alle historie verwijderen? De voorraad op Bol.com en de webshop blijft staan.`)) {
        await api(base, { method: 'DELETE' });
        detail.close();
        load();
      }
    }
  });
  detail.addEventListener('close', () => {
    state.open = null;
    hideTooltip();
  });
  detail.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    if (!state.open) return;
    const { shop, sku } = state.open;
    const base = `${shopBase(shop)}/products`;
    const values = Object.fromEntries(new FormData(form));
    try {
      if (form.dataset.form === 'receipt') {
        await api(`${base}/${encodeURIComponent(sku)}/adjust`, { method: 'POST', body: { delta: Number(values.delta), type: 'receipt', note: values.note || 'Levering' } });
      } else if (form.dataset.form === 'count') {
        await api(`${base}/${encodeURIComponent(sku)}/count`, { method: 'POST', body: { count: Number(values.count) } });
      } else if (form.dataset.form === 'settings') {
        for (const k of ['lead_time_days', 'safety_days']) values[k] = Number(values[k]);
        await api(base, { method: 'POST', body: { sku, ...values } });
      }
      form.reset();
      await load();
    } catch (err) {
      alert(err.message);
    }
  });

  const dialog = $('#product-dialog');
  $('#add-product').addEventListener('click', () => {
    $('#product-form').reset();
    fillShopSelect($('#product-shop'));
    $('#product-shop-label').hidden = state.data.shops.length < 2;
    $('.form-error', dialog).hidden = true;
    dialog.showModal();
  });
  dialog.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]') || e.target === dialog) dialog.close();
  });
  $('#product-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const { shop, ...values } = Object.fromEntries(new FormData(e.target));
    for (const k of ['stock', 'lead_time_days', 'safety_days']) values[k] = Number(values[k] || 0);
    try {
      await api(`${shopBase(shop)}/products`, { method: 'POST', body: { ...values, create: true } });
      dialog.close();
      await load();
    } catch (err) {
      const box = $('.form-error', dialog);
      box.textContent = err.message;
      box.hidden = false;
    }
  });
}

/** Webshop picker for dialogs: defaults to the selected tab (or the first webshop). */
function fillShopSelect(select) {
  const current = state.shop !== 'all' ? state.shop : state.data.shops[0]?.id;
  select.innerHTML = state.data.shops.map((s) => `<option value="${esc(s.id)}" ${s.id === current ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
}

/* ---------------------------------------------------------------- users & account */
function renderUserMenu() {
  const { user } = state.me;
  const initials = user.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  $('#avatar').textContent = initials;
  $('#user-name').textContent = user.name;
  $('#menu-name').textContent = user.name;
  $('#menu-role').textContent = `${ROLE_LABEL[user.role]} · ${user.email}`;
  applyRole();
}

function bindUserMenu() {
  const button = $('#user-button');
  const menu = $('#user-dropdown');
  const toggle = (open) => {
    menu.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
  };
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    toggle(menu.hidden);
  });
  document.addEventListener('click', () => toggle(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggle(false); });
  menu.addEventListener('click', async (e) => {
    const action = e.target.closest('[data-menu]')?.dataset.menu;
    if (action === 'logout') {
      await api('/api/logout', { method: 'POST' }).catch(() => {});
      location.href = '/login';
    } else if (action === 'users') {
      openUsers();
    } else if (action === 'shops') {
      openShops();
    } else if (action === 'import') {
      if (!state.data.shops.length) return alert('Voeg eerst een webshop toe.');
      $('#import-result').hidden = true;
      $('#import-error').hidden = true;
      fillShopSelect($('#import-shop'));
      $('#import-shop-label').hidden = state.data.shops.length < 2;
      updateExportLink();
      $('#import-dialog').showModal();
    } else if (action === 'account') {
      const dialog = $('#account-dialog');
      $('#account-form').reset();
      $('.form-error', dialog).hidden = true;
      $('#account-ok').hidden = true;
      $('#account-info').textContent = `${state.me.user.name} · ${state.me.user.email} · ${ROLE_LABEL[state.me.user.role]}`;
      dialog.showModal();
    }
  });

  const account = $('#account-dialog');
  account.addEventListener('click', (e) => {
    if (e.target === account || e.target.closest('[data-close]')) account.close();
  });
  $('#account-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const err = $('.form-error', account);
    err.hidden = true;
    if (form.password.value !== form.repeat.value) {
      err.textContent = 'De nieuwe wachtwoorden zijn niet gelijk.';
      err.hidden = false;
      return;
    }
    try {
      await api('/api/me/password', { method: 'POST', body: { current: form.current.value, password: form.password.value } });
      form.reset();
      $('#account-ok').hidden = false;
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    }
  });

  const importDialog = $('#import-dialog');
  const importShop = () => $('#import-shop').value;
  $('#import-shop').addEventListener('change', updateExportLink);
  const showImport = (html, isError = false) => {
    $('#import-result').hidden = isError;
    $('#import-error').hidden = !isError;
    $(isError ? '#import-error' : '#import-result').innerHTML = html;
  };
  const summary = (r) => `${r.created} nieuw, ${r.updated} bijgewerkt.${r.skipped.length
    ? `<br>Overgeslagen (${r.skipped.length}):<br>${r.skipped.slice(0, 20).map(esc).join('<br>')}${r.skipped.length > 20 ? '<br>…' : ''}` : ''}`;
  const runImport = async (button, fn) => {
    button.disabled = true;
    showImport('Bezig…');
    try {
      showImport(await fn());
      await load();
    } catch (ex) {
      showImport(esc(ex.message), true);
    } finally {
      button.disabled = false;
    }
  };
  importDialog.addEventListener('click', (e) => {
    if (e.target === importDialog || e.target.closest('[data-close]')) return importDialog.close();
    const button = e.target.closest('[data-import]');
    if (!button) return;
    if (button.dataset.import === 'woocommerce') {
      runImport(button, async () => `Producten uit de webshop: ${summary(await api(`${shopBase(importShop())}/import/woocommerce`, { method: 'POST' }))}`);
    } else if (button.dataset.import === 'backfill') {
      runImport(button, async () => {
        const r = await api(`${shopBase(importShop())}/backfill`, { method: 'POST', body: { days: 90 } });
        const parts = Object.entries(r.orderLines).map(([c, n]) => `${CHANNELS[c] ?? c}: ${n} orderregels`);
        return `Verkoophistorie van ${r.days} dagen ingelezen. ${parts.join(', ')}.`;
      });
    }
  });
  $('#csv-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const label = e.target.closest('label');
    label.style.pointerEvents = 'none';
    showImport('Bezig…');
    try {
      // Excel saves "CSV" as Windows-1252 unless "CSV UTF-8" is chosen; handle both.
      const bytes = await file.arrayBuffer();
      let csv = new TextDecoder('utf-8').decode(bytes);
      if (csv.includes('\uFFFD')) csv = new TextDecoder('windows-1252').decode(bytes);
      const r = await api(`${shopBase(importShop())}/import/csv`, { method: 'POST', body: { csv } });
      showImport(`${esc(file.name)}: ${summary(r)}`);
      await load();
    } catch (ex) {
      showImport(esc(ex.message), true);
    } finally {
      label.style.pointerEvents = '';
    }
  });

  const users = $('#users-dialog');
  users.addEventListener('click', async (e) => {
    if (e.target === users || e.target.closest('[data-close]')) return users.close();
    const btn = e.target.closest('[data-user-action]');
    if (!btn) return;
    const id = Number(btn.closest('tr').dataset.id);
    const name = btn.closest('tr').dataset.name;
    await usersAction(async () => {
      if (btn.dataset.userAction === 'password') {
        if (!confirm(`Nieuw wachtwoord instellen voor ${name}? Het huidige wachtwoord werkt dan niet meer.`)) return;
        const { password } = await api(`/api/users/${id}/password`, { method: 'POST' });
        showNewPassword(name, password);
      } else if (btn.dataset.userAction === 'toggle') {
        await api(`/api/users/${id}`, { method: 'PATCH', body: { disabled: btn.dataset.disabled !== '1' } });
      } else if (btn.dataset.userAction === 'delete') {
        if (!confirm(`${name} verwijderen? Eerder geboekte mutaties blijven bewaard.`)) return;
        await api(`/api/users/${id}`, { method: 'DELETE' });
      }
    });
  });
  users.addEventListener('change', async (e) => {
    if (e.target.matches('select[data-role-for]')) {
      await usersAction(() => api(`/api/users/${e.target.dataset.roleFor}`, { method: 'PATCH', body: { role: e.target.value } }));
    } else if (e.target.matches('[data-access-for] input')) {
      const box = e.target.closest('[data-access-for]');
      const allBox = $('input[value="*"]', box);
      if (e.target === allBox) $$('input:not([value="*"])', box).forEach((i) => { i.checked = allBox.checked; });
      const picked = $$('input:not([value="*"]):checked', box).map((i) => i.value);
      const total = $$('input:not([value="*"])', box).length;
      const shops = allBox.checked && e.target === allBox ? null : (picked.length === total ? null : picked);
      if (shops && !shops.length) {
        $('#users-error').textContent = 'Kies minstens één webshop (of blokkeer de gebruiker).';
        $('#users-error').hidden = false;
        return renderUsers();
      }
      await usersAction(() => api(`/api/users/${box.dataset.accessFor}`, { method: 'PATCH', body: { shops } }));
    }
  });
  $('#user-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const values = Object.fromEntries(new FormData(e.target));
    await usersAction(async () => {
      const { user, password } = await api('/api/users', { method: 'POST', body: values });
      e.target.reset();
      showNewPassword(user.name, password, user.email);
    });
  });
}

function updateExportLink() {
  $('#export-link').href = `${shopBase($('#import-shop').value)}/export/products.csv`;
}

function showNewPassword(name, password, email) {
  const box = $('#new-password');
  box.innerHTML = `Tijdelijk wachtwoord voor <b>${esc(name)}</b>${email ? ` (${esc(email)})` : ''}:
    <span class="password-box">${esc(password)}</span><br>
    Geef dit persoonlijk of telefonisch door – het wordt maar één keer getoond. Inloggen via ${esc(location.origin)}; daarna kan het wachtwoord worden gewijzigd via <i>Mijn account</i>.`;
  box.hidden = false;
}

async function usersAction(fn) {
  const err = $('#users-error');
  err.hidden = true;
  try {
    await fn();
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  }
  await renderUsers();
}

async function openUsers() {
  $('#new-password').hidden = true;
  $('#users-error').hidden = true;
  await renderUsers();
  $('#users-dialog').showModal();
}

function accessCell(u) {
  if (u.role === 'beheerder') return '<span class="muted small">alle (beheerder)</span>';
  const shops = state.data.shops;
  const all = u.shops === null;
  const label = all ? 'Alle webshops' : u.shops.map((id) => shopInfo(id)?.name ?? id).join(', ') || 'geen';
  return `<details class="access"><summary>${esc(label)}</summary>
    <div class="access-list" data-access-for="${u.id}">
      <label><input type="checkbox" value="*" ${all ? 'checked' : ''}> <b>Alle webshops</b> <span class="muted small">(ook nieuwe)</span></label>
      ${shops.map((s) => `<label class="c-${esc(s.color)}"><input type="checkbox" value="${esc(s.id)}" ${all || u.shops.includes(s.id) ? 'checked' : ''}><i class="shop-dot"></i>${esc(s.name)}</label>`).join('')}
    </div></details>`;
}

async function renderUsers() {
  const list = await api('/api/users');
  const me = state.me.user.id;
  $('#users-rows').innerHTML = list.map((u) => `<tr data-id="${u.id}" data-name="${esc(u.name)}" class="${u.disabled ? 'disabled' : ''}">
    <td><div class="pname">${esc(u.name)}${u.id === me ? ' <span class="muted small">(u)</span>' : ''}</div><div class="psku">${esc(u.email)}</div></td>
    <td>${u.id === me ? ROLE_LABEL[u.role] : `<select data-role-for="${u.id}" aria-label="Rol van ${esc(u.name)}">
      ${Object.entries(ROLE_LABEL).map(([r, l]) => `<option value="${r}" ${r === u.role ? 'selected' : ''}>${l}</option>`).join('')}</select>`}
      ${u.disabled ? '<div class="muted small">geblokkeerd</div>' : ''}</td>
    <td>${accessCell(u)}</td>
    <td class="hide-sm muted">${u.lastLoginAt ? dateTimeFmt.format(new Date(u.lastLoginAt)) : 'nog nooit'}</td>
    <td>${u.id === me ? '' : `<div class="row-actions">
      <button data-user-action="password">Nieuw wachtwoord</button>
      <button data-user-action="toggle" data-disabled="${u.disabled ? 1 : 0}">${u.disabled ? 'Deblokkeren' : 'Blokkeren'}</button>
      <button data-user-action="delete" class="danger">Verwijderen</button></div>`}</td>
  </tr>`).join('');
}

/* ---------------------------------------------------------------- webshops (beheerder) */
const COLOR_LABEL = { aqua: 'Groenblauw', violet: 'Paars', magenta: 'Roze', yellow: 'Geel', green: 'Groen', red: 'Rood' };
let shopAdmin = { shops: [], colors: [], editing: null };

async function openShops({ add = false } = {}) {
  $('#shop-result').hidden = true;
  $('#shop-form').hidden = true;
  await renderShopList();
  if (!$('#shops-dialog').open) $('#shops-dialog').showModal();
  if (add) showShopForm(null);
}

async function renderShopList() {
  const { shops, colors } = await api('/api/shops');
  shopAdmin = { ...shopAdmin, shops, colors };
  $('#shop-list').innerHTML = shops.length ? shops.map((s) => `<div class="shop-row c-${esc(s.color)}" data-id="${esc(s.id)}">
      <i class="shop-dot"></i>
      <div class="grow"><b>${esc(s.name)}</b>
        <div class="meta">
          <span>${esc(s.woo_base_url ?? 'geen webadres ingevuld')}</span>
          <span class="${s.has_woo_keys ? 'ok' : 'missing'}">WooCommerce: ${s.has_woo_keys ? 'sleutels ingevuld' : 'sleutels ontbreken'}</span>
          <span class="${s.has_bol_keys ? 'ok' : ''}">Bol.com: ${s.has_bol_keys ? `gekoppeld (${esc(s.bol_client_id_hint)})` : 'niet gebruikt'}</span>
          <span>${nf.format(s.products)} producten</span>
        </div>
      </div>
      <div class="row-actions">
        <button data-shop-action="test">Verbinding testen</button>
        <button data-shop-action="webhook">Webhook-gegevens</button>
        <button data-shop-action="edit">Bewerken</button>
      </div>
      <div class="test-result" hidden></div>
    </div>`).join('') : '<p class="muted">Nog geen webshops. Voeg de eerste toe.</p>';
}

function showShopForm(shop) {
  const form = $('#shop-form');
  form.reset();
  shopAdmin.editing = shop?.id ?? null;
  $('#shop-form-title').textContent = shop ? `${shop.name} bewerken` : 'Webshop toevoegen';
  const used = new Set(shopAdmin.shops.map((s) => s.color));
  const color = shop?.color ?? shopAdmin.colors.find((c) => !used.has(c)) ?? shopAdmin.colors[0];
  $('#shop-colors').innerHTML = shopAdmin.colors.map((c) => `<label class="c-${c}"><input type="radio" name="color" value="${c}" ${c === color ? 'checked' : ''}><i class="shop-dot"></i>${COLOR_LABEL[c] ?? c}</label>`).join('');
  if (shop) {
    form.name.value = shop.name;
    form.woo_base_url.value = shop.woo_base_url ?? '';
    form.bol_fulfilment_method.value = shop.bol_fulfilment_method;
    for (const f of ['woo_consumer_key', 'woo_consumer_secret']) form[f].placeholder = shop.has_woo_keys ? '•••••• (opgeslagen)' : '';
    for (const f of ['bol_client_id', 'bol_client_secret']) form[f].placeholder = shop.has_bol_keys ? '•••••• (opgeslagen)' : 'optioneel';
  } else {
    for (const f of ['bol_client_id', 'bol_client_secret']) form[f].placeholder = 'optioneel';
  }
  $('#shop-keys-hint').hidden = !shop;
  $('#shop-delete').hidden = !shop;
  $('#shop-bol-off').hidden = !shop?.has_bol_keys;
  $('#shop-error').hidden = true;
  form.hidden = false;
  form.name.focus();
}

function showWebhookInfo(shop, intro = '') {
  const url = `${location.origin}${shop.webhook_path}`;
  const box = $('#shop-result');
  box.innerHTML = `${intro}<b>Webhooks voor ${esc(shop.name)}</b> – maak in WooCommerce (Instellingen → Geavanceerd → Webhooks) twee webhooks aan:
    <i>Bestelling toegevoegd</i> en <i>Bestelling bijgewerkt</i> (Engels: Order created / Order updated), status Actief, API-versie v3, met:
    <div class="copy-row"><span class="muted small" style="width:90px">Aflever-URL</span><code>${esc(url)}</code><button data-copy="${esc(url)}">Kopiëren</button></div>
    <div class="copy-row"><span class="muted small" style="width:90px">Geheim</span><code>${esc(shop.webhook_secret)}</code><button data-copy="${esc(shop.webhook_secret)}">Kopiëren</button></div>`;
  box.hidden = false;
}

function bindShops() {
  const dialog = $('#shops-dialog');
  const form = $('#shop-form');
  dialog.addEventListener('click', async (e) => {
    if (e.target === dialog || e.target.closest('[data-close]')) return dialog.close();
    const copy = e.target.closest('[data-copy]');
    if (copy) {
      try {
        await navigator.clipboard.writeText(copy.dataset.copy);
        copy.textContent = 'Gekopieerd';
      } catch {
        copy.textContent = 'Selecteer en kopieer handmatig';
      }
      return;
    }
    if (e.target.closest('[data-cancel]')) {
      form.hidden = true;
      return;
    }
    const btn = e.target.closest('[data-shop-action]');
    if (!btn) return;
    const row = btn.closest('.shop-row');
    const shop = shopAdmin.shops.find((s) => s.id === row.dataset.id);
    if (btn.dataset.shopAction === 'edit') {
      showShopForm(shop);
    } else if (btn.dataset.shopAction === 'webhook') {
      showWebhookInfo(shop);
    } else if (btn.dataset.shopAction === 'test') {
      const out = $('.test-result', row);
      out.hidden = false;
      out.textContent = 'Testen…';
      btn.disabled = true;
      try {
        const r = await api(`/api/shops/${encodeURIComponent(shop.id)}/test`, { method: 'POST' });
        const line = (label, t) => `<span class="${t.ok ? 'ok' : t.ok === null ? 'muted' : 'missing'}">${t.ok ? '✓' : t.ok === null ? '–' : '✗'} ${label}: ${esc(t.message)}</span>`;
        out.innerHTML = line('WooCommerce', r.woocommerce) + line('Bol.com', r.bol);
      } catch (ex) {
        out.textContent = ex.message;
      } finally {
        btn.disabled = false;
      }
    }
  });
  $('#new-shop').addEventListener('click', () => showShopForm(null));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const values = Object.fromEntries(new FormData(form));
    const editing = shopAdmin.editing;
    try {
      const saved = editing
        ? await api(`/api/shops/${encodeURIComponent(editing)}`, { method: 'PATCH', body: values })
        : await api('/api/shops', { method: 'POST', body: values });
      form.hidden = true;
      await renderShopList();
      showWebhookInfo(saved, editing ? 'Opgeslagen. ' : 'Webshop toegevoegd. ');
      await load();
    } catch (ex) {
      $('#shop-error').textContent = ex.message;
      $('#shop-error').hidden = false;
    }
  });
  $('#shop-bol-off').addEventListener('click', async () => {
    const shop = shopAdmin.shops.find((s) => s.id === shopAdmin.editing);
    if (!shop || !confirm(`Bol.com loskoppelen van ${shop.name}? Er worden dan geen Bol-orders meer opgehaald en geen voorraad meer naar Bol.com gestuurd.`)) return;
    await api(`/api/shops/${encodeURIComponent(shop.id)}`, { method: 'PATCH', body: { bol_client_id: null, bol_client_secret: null } });
    form.hidden = true;
    await renderShopList();
    await load();
  });
  $('#shop-delete').addEventListener('click', async () => {
    const shop = shopAdmin.shops.find((s) => s.id === shopAdmin.editing);
    if (!shop) return;
    const answer = prompt(`Webshop ${shop.name} verwijderen? De synchronisatie stopt en de webshop verdwijnt uit het dashboard. De gegevens blijven als reservekopie op de server bewaard.\n\nTyp de naam van de webshop om te bevestigen:`);
    if (answer === null) return;
    if (answer.trim() !== shop.name) return alert('De naam komt niet overeen; er is niets verwijderd.');
    await api(`/api/shops/${encodeURIComponent(shop.id)}`, { method: 'DELETE' });
    form.hidden = true;
    $('#shop-result').hidden = true;
    await renderShopList();
    await load();
  });
}

/* ---------------------------------------------------------------- start */
try {
  const saved = localStorage.getItem('voorraad.window');
  if (saved) {
    state.windowDays = Number(saved);
    $('#window').value = saved;
  }
  state.shop = localStorage.getItem('voorraad.shop') || 'all';
} catch { /* storage unavailable */ }

state.me = await api('/api/me');
renderUserMenu();
bindUi();
bindUserMenu();
bindShops();
await Promise.all([load(), loadActivity()]);
connectEvents();
setInterval(() => {
  if (!state.data) return;
  renderChannels();
  if (state.shop === 'all') renderShopCards();
}, 15000);
