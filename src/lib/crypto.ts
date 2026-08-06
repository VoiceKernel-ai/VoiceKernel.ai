import crypto from 'node:crypto';
import argon2 from 'argon2';
import { config } from '../config';

// ---------------------------------------------------------------------------
// Symmetric encryption for tenant secrets at rest (BYO provider keys, webhook
// signing secrets). AES-256-GCM: confidentiality plus tamper detection.
//
// Ciphertext format:  v1.<iv-b64url>.<tag-b64url>.<ciphertext-b64url>
// The version prefix exists so a future key rotation can decrypt old records.
// ---------------------------------------------------------------------------

const CIPHER_VERSION = 'v1';

function encryptionKey(): Buffer {
  const key = Buffer.from(config.encryptionKey, 'base64');
  if (key.length !== 32) {
    throw new Error('ENCRYPTION_KEY must decode to exactly 32 bytes (base64 of 32 random bytes).');
  }
  return key;
}

export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    CIPHER_VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

export function decryptSecret(encoded: string): string {
  const parts = encoded.split('.');
  if (parts.length !== 4 || parts[0] !== CIPHER_VERSION) {
    throw new Error('Malformed ciphertext.');
  }
  const [, ivB64, tagB64, dataB64] = parts;
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    encryptionKey(),
    Buffer.from(ivB64, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

// ---------------------------------------------------------------------------
// Password hashing
// ---------------------------------------------------------------------------

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19456, // 19 MiB - OWASP baseline
    timeCost: 2,
    parallelism: 1,
  });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// API keys
//
// Format:  vk_<env>_<prefix><secret>
// e.g.     vk_live_a1b2c3d4e5f6...   (prefix = first 12 chars after the env)
//
// The prefix is stored in clear and uniquely indexed so authentication is a
// single indexed lookup; only the full key is hashed. SHA-256 rather than
// argon2 here because API keys are high-entropy (192 bits) and must verify on
// every request - a slow KDF would cap throughput for no security gain.
// ---------------------------------------------------------------------------

export const API_KEY_PREFIX_LENGTH = 12;

export interface GeneratedApiKey {
  plaintext: string;
  prefix: string;
  hash: string;
  last4: string;
}

export function generateApiKey(environment: 'live' | 'test'): GeneratedApiKey {
  const body = crypto.randomBytes(24).toString('base64url'); // 192 bits
  const plaintext = `vk_${environment}_${body}`;
  return {
    plaintext,
    prefix: `vk_${environment}_${body.slice(0, API_KEY_PREFIX_LENGTH)}`,
    hash: hashApiKey(plaintext),
    last4: plaintext.slice(-4),
  };
}

export function hashApiKey(plaintext: string): string {
  return crypto.createHash('sha256').update(plaintext).digest('hex');
}

/** Extracts the indexed lookup prefix from a presented key, or null if malformed. */
export function apiKeyPrefix(plaintext: string): string | null {
  const match = /^vk_(live|test)_([A-Za-z0-9_-]+)$/.exec(plaintext);
  if (!match) return null;
  const [, env, body] = match;
  if (body.length < API_KEY_PREFIX_LENGTH) return null;
  return `vk_${env}_${body.slice(0, API_KEY_PREFIX_LENGTH)}`;
}

// ---------------------------------------------------------------------------
// Generic token + signature helpers
// ---------------------------------------------------------------------------

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/**
 * Constant-time comparison that does not leak length. Buffers of differing
 * length make timingSafeEqual throw, so both sides are hashed first.
 */
export function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Signature we attach to every outbound webhook. The timestamp is inside the
 * signed payload so a captured request cannot be replayed later.
 *
 *   X-VoiceKernel-Signature: t=<unix>,v1=<hex hmac of "t.body">
 */
export function signWebhook(secret: string, body: string, timestamp: number): string {
  const mac = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${mac}`;
}

export function verifyWebhookSignature(
  secret: string,
  body: string,
  header: string,
  toleranceSeconds = 300,
): boolean {
  const parts = Object.fromEntries(
    header.split(',').map((kv) => {
      const i = kv.indexOf('=');
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    }),
  );
  const t = Number.parseInt(parts.t ?? '', 10);
  const v1 = parts.v1;
  if (!Number.isFinite(t) || !v1) return false;
  if (Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return safeEqual(expected, v1);
}
