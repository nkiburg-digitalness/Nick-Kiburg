import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);

export const ROLES = {
  beheerder: { label: 'Beheerder', level: 3 },   // everything, incl. users and deleting products
  medewerker: { label: 'Medewerker', level: 2 }, // book receipts, stocktakes, edit products
  kijker: { label: 'Alleen bekijken', level: 1 },
};

export const SESSION_COOKIE = 'vb_session';
const SESSION_DAYS = 30;
const MIN_PASSWORD_LENGTH = 10;

export class AuthError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored ?? '').split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length);
  return timingSafeEqual(actual, expected);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeEmail(email) {
  return String(email ?? '').trim().toLowerCase();
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    disabled: Boolean(row.disabled),
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

/**
 * User accounts and login sessions. Passwords are stored as scrypt hashes; the
 * session cookie holds a random token of which only the SHA-256 hash is stored.
 */
export class Auth {
  constructor(db) {
    this.db = db;
    this.failures = new Map(); // key → { count, first }
  }

  hasUsers() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0;
  }

  listUsers() {
    return this.db.prepare('SELECT * FROM users ORDER BY disabled, name COLLATE NOCASE').all().map(publicUser);
  }

  getUser(id) {
    return publicUser(this.db.prepare('SELECT * FROM users WHERE id = ?').get(id));
  }

  async createUser({ email, name, role = 'medewerker', password }) {
    email = normalizeEmail(email);
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new AuthError('Vul een geldig e-mailadres in');
    if (!String(name ?? '').trim()) throw new AuthError('Vul een naam in');
    if (!ROLES[role]) throw new AuthError('Onbekende rol');
    validatePassword(password);
    if (this.db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
      throw new AuthError('Er bestaat al een gebruiker met dit e-mailadres');
    }
    const row = this.db.prepare(`
      INSERT INTO users (email, name, role, password_hash) VALUES (?, ?, ?, ?) RETURNING *
    `).get(email, String(name).trim(), role, await hashPassword(password));
    return publicUser(row);
  }

  /** Update name/role/disabled. Refuses to leave the system without an active beheerder. */
  updateUser(id, { name, role, disabled }) {
    const user = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!user) throw new AuthError('Onbekende gebruiker', 404);
    if (role !== undefined && !ROLES[role]) throw new AuthError('Onbekende rol');
    const next = {
      name: name !== undefined ? String(name).trim() || user.name : user.name,
      role: role ?? user.role,
      disabled: disabled !== undefined ? (disabled ? 1 : 0) : user.disabled,
    };
    const losesAdmin = user.role === 'beheerder' && !user.disabled && (next.role !== 'beheerder' || next.disabled);
    if (losesAdmin && this.#activeAdmins() <= 1) {
      throw new AuthError('Er moet minstens één actieve beheerder overblijven');
    }
    this.db.prepare('UPDATE users SET name = ?, role = ?, disabled = ? WHERE id = ?').run(next.name, next.role, next.disabled, id);
    if (next.disabled) this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    return this.getUser(id);
  }

  async setPassword(id, password, { keepSession = null } = {}) {
    validatePassword(password);
    const hash = await hashPassword(password);
    const { changes } = this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, id);
    if (!changes) throw new AuthError('Onbekende gebruiker', 404);
    // Log out everywhere else.
    this.db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash IS NOT ?').run(id, keepSession ? sha256(keepSession) : null);
  }

  async changeOwnPassword(id, currentPassword, newPassword, sessionToken) {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!row || !(await verifyPassword(currentPassword ?? '', row.password_hash))) {
      throw new AuthError('Huidig wachtwoord klopt niet', 403);
    }
    await this.setPassword(id, newPassword, { keepSession: sessionToken });
  }

  deleteUser(id) {
    const user = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!user) throw new AuthError('Onbekende gebruiker', 404);
    if (user.role === 'beheerder' && !user.disabled && this.#activeAdmins() <= 1) {
      throw new AuthError('Er moet minstens één actieve beheerder overblijven');
    }
    this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
  }

  /**
   * Check credentials and start a session. Returns { token, user }.
   * Too many failed attempts for an address/IP blocks further tries for 15 minutes.
   */
  async login(email, password, { ip = '' } = {}) {
    email = normalizeEmail(email);
    const key = `${ip}|${email}`;
    const f = this.failures.get(key);
    if (f && f.count >= 8 && Date.now() - f.first < 15 * 60 * 1000) {
      throw new AuthError('Te veel mislukte pogingen. Probeer het over 15 minuten opnieuw.', 429);
    }
    const row = this.db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    // Always run a hash comparison so response time doesn't reveal whether the account exists.
    const ok = await verifyPassword(password ?? '', row?.password_hash ?? DUMMY_HASH);
    if (!row || !ok || row.disabled) {
      const entry = f && Date.now() - f.first < 15 * 60 * 1000 ? f : { count: 0, first: Date.now() };
      entry.count++;
      this.failures.set(key, entry);
      throw new AuthError('E-mailadres of wachtwoord klopt niet', 401);
    }
    this.failures.delete(key);
    const token = randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
    this.db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), row.id, expires);
    this.db.prepare("UPDATE users SET last_login_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(row.id);
    this.db.prepare("DELETE FROM sessions WHERE expires_at < strftime('%Y-%m-%dT%H:%M:%fZ','now')").run();
    return { token, user: publicUser(row), maxAgeSeconds: SESSION_DAYS * 86400 };
  }

  /** Resolve a session token to its (active) user, or null. */
  userForToken(token) {
    if (!token) return null;
    const row = this.db.prepare(`
      SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now') AND u.disabled = 0
    `).get(sha256(token));
    return publicUser(row);
  }

  logout(token) {
    if (token) this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  }

  #activeAdmins() {
    return this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'beheerder' AND disabled = 0").get().n;
  }
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new AuthError(`Wachtwoord moet minstens ${MIN_PASSWORD_LENGTH} tekens lang zijn`);
  }
}

// A valid hash of a random value, used to equalize timing for unknown accounts.
const DUMMY_HASH = await hashPassword(randomBytes(16).toString('hex'));

export function hasRole(user, role) {
  return Boolean(user && ROLES[user.role] && ROLES[user.role].level >= ROLES[role].level);
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Generate a readable temporary password, e.g. for new colleagues. */
export function generatePassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(14);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += alphabet[bytes[i] % alphabet.length];
  return `${out.slice(0, 5)}-${out.slice(5, 10)}-${out.slice(10)}`;
}
