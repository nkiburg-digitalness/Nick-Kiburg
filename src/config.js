import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const envFile = resolve(process.cwd(), '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const env = process.env;

function bool(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'ja', 'on'].includes(String(value).toLowerCase());
}

function int(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function list(value, fallback) {
  if (!value) return fallback;
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

const demoMode = bool(env.DEMO_MODE);

export const config = {
  port: int(env.PORT, 3000),
  // The demo uses its own database, so it can never overwrite real stock data.
  dbFile: env.DB_FILE || resolve(process.cwd(), 'data', demoMode ? 'demo.db' : 'voorraad.db'),
  // First beheerder account, created on start-up when there are no users yet.
  // Colleagues are added afterwards via the dashboard (Gebruikers) or `npm run gebruiker`.
  adminEmail: env.ADMIN_EMAIL || '',
  adminName: env.ADMIN_NAME || 'Beheerder',
  adminPassword: env.ADMIN_PASSWORD || '',
  // Daily database backups (kept for BACKUP_KEEP_DAYS). Empty BACKUP_DIR disables them.
  backupDir: env.BACKUP_DIR ?? (demoMode ? '' : resolve(process.cwd(), 'data', 'backups')),
  backupKeepDays: int(env.BACKUP_KEEP_DAYS, 14),
  // Set to true when running behind a reverse proxy / hosting platform that terminates HTTPS.
  trustProxy: bool(env.TRUST_PROXY),
  // Demo mode: no real API calls; channel pushes are simulated.
  demoMode,

  forecast: {
    // Default sales window (days) used for "average sales per day".
    windowDays: int(env.FORECAST_WINDOW_DAYS, 30),
    // Products with fewer tracked days than this are averaged over this many days,
    // so one early sale doesn't create an absurd daily average.
    minTrackedDays: int(env.FORECAST_MIN_TRACKED_DAYS, 7),
    // How many days of sales an order advice should cover (on top of lead time + safety).
    reorderCoverDays: int(env.REORDER_COVER_DAYS, 60),
    defaultLeadTimeDays: int(env.DEFAULT_LEAD_TIME_DAYS, 14),
    defaultSafetyDays: int(env.DEFAULT_SAFETY_DAYS, 7),
  },

  bol: {
    enabled: bool(env.BOL_ENABLED, Boolean(env.BOL_CLIENT_ID)),
    clientId: env.BOL_CLIENT_ID || '',
    clientSecret: env.BOL_CLIENT_SECRET || '',
    apiBase: env.BOL_API_BASE || 'https://api.bol.com',
    tokenUrl: env.BOL_TOKEN_URL || 'https://login.bol.com/token',
    apiVersion: env.BOL_API_VERSION || 'v10',
    // Which fulfilment methods to track. FBR = you ship yourself (stock comes from your warehouse).
    fulfilmentMethod: env.BOL_FULFILMENT_METHOD || 'FBR',
    pollIntervalSeconds: int(env.BOL_POLL_INTERVAL_SECONDS, 60),
    // Bol accepts a stock amount between 0 and 999.
    maxStock: 999,
  },

  woo: {
    enabled: bool(env.WOO_ENABLED, Boolean(env.WOO_CONSUMER_KEY)),
    baseUrl: (env.WOO_BASE_URL || 'https://tochtstripdeur.nl').replace(/\/+$/, ''),
    consumerKey: env.WOO_CONSUMER_KEY || '',
    consumerSecret: env.WOO_CONSUMER_SECRET || '',
    webhookSecret: env.WOO_WEBHOOK_SECRET || '',
    // Safety net for missed webhooks: poll recently modified orders.
    pollIntervalSeconds: int(env.WOO_POLL_INTERVAL_SECONDS, 300),
    // Order statuses in which WooCommerce itself has reduced stock.
    countStatuses: list(env.WOO_COUNT_STATUSES, ['processing', 'on-hold', 'completed']),
    // Order statuses in which the goods go back into stock.
    releaseStatuses: list(
      env.WOO_RELEASE_STATUSES,
      ['pending', 'cancelled', 'failed', ...(bool(env.WOO_RESTOCK_ON_REFUND) ? ['refunded'] : [])],
    ),
  },

  sync: {
    workerIntervalMs: int(env.SYNC_WORKER_INTERVAL_MS, 2000),
    maxBackoffSeconds: int(env.SYNC_MAX_BACKOFF_SECONDS, 900),
  },
};
