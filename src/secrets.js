import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Encrypts webshop credentials (API keys) before they are stored in the database,
 * with AES-256-GCM. The key comes from SECRET_KEY; a database file or backup on its
 * own then doesn't reveal the API keys.
 */
export class SecretBox {
  constructor(secret) {
    this.key = createHash('sha256').update(String(secret)).digest();
  }

  seal(plain) {
    if (plain === null || plain === undefined || plain === '') return null;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    return `v1:${Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64')}`;
  }

  open(sealed) {
    if (!sealed) return '';
    if (!sealed.startsWith('v1:')) throw new Error('Onbekend versleutelingsformaat');
    const raw = Buffer.from(sealed.slice(3), 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  }
}

/**
 * The encryption key: SECRET_KEY from the environment, or (fallback for a simple
 * local setup) a random key kept in a file next to the data.
 */
export function loadSecret({ envSecret, keyFile, log = console.warn }) {
  if (envSecret) return envSecret;
  if (existsSync(keyFile)) return readFileSync(keyFile, 'utf8').trim();
  const secret = randomBytes(32).toString('hex');
  mkdirSync(dirname(keyFile), { recursive: true });
  writeFileSync(keyFile, `${secret}\n`, { mode: 0o600 });
  log(`SECRET_KEY is niet ingesteld; er is een sleutel aangemaakt in ${keyFile}. Bewaar die goed (zonder sleutel zijn de opgeslagen API-sleutels onleesbaar).`);
  return secret;
}
