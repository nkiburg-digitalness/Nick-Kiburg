import { getKv, setKv } from './db.js';
import { BOL_HISTORY_DAYS } from './channels/bol.js';

const PENDING_KEY = 'history_import:pending';

/**
 * Import the order history of one webshop in the background: a year of orders (plus
 * 90 days of Bol.com for the whole account, at a pace Bol.com accepts) can take many
 * minutes. Progress and the outcome go to the activity log; the dashboard polls the job.
 * The request is remembered, so a restart (e.g. a new version going live) resumes it:
 * orders already read in are never counted twice.
 */
export function startHistoryImport(rt, { days, userName = null, resumed = false }) {
  if (rt.backfillJob?.running) return rt.backfillJob;
  const channels = Object.entries(rt.channels).filter(([, c]) => typeof c.backfill === 'function');
  const job = {
    running: true, days, startedAt: new Date().toISOString(), startedBy: userName, resumed,
    orderLines: {}, channelDays: {}, current: null, progress: null,
  };
  rt.backfillJob = job;
  setKv(rt.db, PENDING_KEY, JSON.stringify({ days, startedBy: userName }));
  rt.bus.log('info', resumed
    ? `Verkoophistorie (${days} dagen) inlezen hervat na een herstart`
    : `Verkoophistorie (${days} dagen) inlezen gestart${userName ? ` door ${userName}` : ''}`);

  (async () => {
    for (const [name, channel] of channels) {
      const label = name === 'bol' ? 'Bol.com' : 'webshop';
      job.current = name;
      job.progress = null;
      job.channelDays[name] = name === 'bol' ? Math.min(days, BOL_HISTORY_DAYS) : days;
      const onProgress = (done, total) => {
        job.progress = { done, total };
        // A sign of life in the activity log every third of the way.
        if (total >= 9 && done < total && done % Math.ceil(total / 3) === 0) {
          rt.bus.log('info', `Verkoophistorie ${label}: ${done} van ${total} ${name === 'bol' ? 'dagen' : "pagina's"} gelezen…`, { channel: name });
        }
      };
      // One channel failing (e.g. Bol.com unreachable) does not lose the other's result.
      try {
        const r = await channel.backfill(rt.inventory, days, new Date(), { onProgress });
        const x = typeof r === 'number' ? { booked: r } : r;
        job.orderLines[name] = x;
        if (x.error) {
          rt.bus.log('error', `Verkoophistorie ${label} niet helemaal ingelezen (${x.days} dagen gelukt, ${x.booked} nieuwe orderregels): ${x.error}. Klik later nog eens op Verkoophistorie inlezen.`, { channel: name });
        } else {
          rt.bus.log('info', x.lines === undefined
            ? `Verkoophistorie ${label}: ${x.booked} nieuwe orderregels`
            : `Verkoophistorie ${label}: ${x.orders} orders, ${x.lines} orderregels – ${x.booked} nieuw, ${x.otherShop} van een andere webshop, ${x.unknown} van niet-gekoppelde producten`, { channel: name });
        }
      } catch (err) {
        job.orderLines[name] = { error: err.message };
        rt.bus.log('error', `Verkoophistorie ${label} inlezen mislukt: ${err.message}`, { channel: name });
      }
    }
    job.running = false;
    job.current = null;
    job.progress = null;
    job.finishedAt = new Date().toISOString();
    setKv(rt.db, PENDING_KEY, null);
    rt.bus.log('info', 'Verkoophistorie inlezen klaar');
    rt.bus.publish('product', null);
  })();
  return job;
}

/** Resume an import that was interrupted by a restart. */
export function resumeHistoryImport(rt) {
  let pending = null;
  try {
    pending = JSON.parse(getKv(rt.db, PENDING_KEY) ?? 'null');
  } catch { /* nothing to resume */ }
  if (!pending?.days) return null;
  return startHistoryImport(rt, { days: pending.days, userName: pending.startedBy, resumed: true });
}
