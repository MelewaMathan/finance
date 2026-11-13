import crypto from 'node:crypto';
import { config } from '../config/env';

/**
 * Cryptographic helpers.
 *
 * Two different jobs are handled here:
 *  1. Field-level encryption at rest (AES-256-GCM) for national IDs, phone
 *     numbers, guarantor details -- data that must never be readable by a
 *     database dump alone.
 *  2. Blind indexes (HMAC-SHA256) so we can still detect duplicate national
 *     IDs / phones without storing the plaintext or decrypting rows.
 *
 * Ciphertext format: `v1:<iv_b64>:<tag_b64>:<ciphertext_b64>`
 * The version prefix allows key rotation later without guessing the format.
 */

const encryptionKey = Buffer.from(config.FIELD_ENCRYPTION_KEY, 'hex');
const blindIndexKey = Buffer.from(config.BLIND_INDEX_KEY, 'hex');

export function sha256Hex(input: string | Buffer): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function hmacSha256Hex(input: string): string {
  return crypto.createHmac('sha256', blindIndexKey).update(input).digest('hex');
}

export function encryptField(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

export function decryptField(blob: string | null | undefined): string | null {
  if (!blob) return null;
  const [version, ivB64, tagB64, dataB64] = blob.split(':');
  if (version !== 'v1' || !ivB64 || !tagB64 || !dataB64) {
    throw new Error('Malformed ciphertext blob');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  // The auth tag makes tampering with ciphertext a hard failure, not a silent
  // garbage read -- this is the property we want for PII at rest.
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

/** Normalise a Kenyan-style national ID for blind indexing. */
export function normalizeNationalId(value: string): string {
  return value.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
}

/**
 * Normalise a phone number to 254XXXXXXXXX so "0712 345 678",
 * "+254712345678" and "254-712-345-678" all collapse to one blind index.
 */
export function normalizePhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.startsWith('254')) return digits;
  if (digits.startsWith('0')) return `254${digits.slice(1)}`;
  if (digits.startsWith('7') || digits.startsWith('1')) return `254${digits}`;
  return digits;
}

export function blindIndex(value: string): string {
  return hmacSha256Hex(value);
}

export function nationalIdBlindIndex(value: string): string {
  return hmacSha256Hex(`nid:${normalizeNationalId(value)}`);
}

export function phoneBlindIndex(value: string): string {
  return hmacSha256Hex(`phone:${normalizePhone(value)}`);
}

/** Masked representation for API responses: 0712***678 */
export function maskValue(value: string | null): string | null {
  if (!value) return null;
  if (value.length <= 4) return '*'.repeat(value.length);
  return `${value.slice(0, 4)}${'*'.repeat(Math.max(3, value.length - 7))}${value.slice(-3)}`;
}

export function randomToken(bytes = 48): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Timing-safe comparison for opaque tokens / hashes. */
export function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return crypto.timingSafeEqual(bufferA, bufferB);
}
