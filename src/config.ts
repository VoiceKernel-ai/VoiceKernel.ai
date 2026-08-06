import fs from 'node:fs';
import path from 'node:path';

// Minimal .env loader. Node 20 lacks --env-file everywhere we deploy, and a
// dependency for 20 lines of parsing is not worth the supply-chain surface.
function loadDotEnv(file: string): void {
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue; // real env always wins
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadDotEnv(path.resolve(process.cwd(), '.env'));

function str(key: string, fallback?: string): string {
  const v = process.env[key];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return v;
}

function int(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`Environment variable ${key} must be an integer`);
  return n;
}

function bool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return v === 'true' || v === '1' || v === 'yes';
}

const nodeEnv = str('NODE_ENV', 'development');
const isProd = nodeEnv === 'production';

// In production every secret must be supplied explicitly. In development we
// generate ephemeral ones so `npm run dev` works on a fresh clone - sessions
// and stored ciphertext simply do not survive a restart.
function secret(key: string, devFallbackBytes: number): string {
  const v = process.env[key];
  if (v && v !== '') return v;
  if (isProd) throw new Error(`Missing required secret in production: ${key}`);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const generated = require('node:crypto').randomBytes(devFallbackBytes).toString('base64');
  process.env[key] = generated;
  return generated;
}

export const config = {
  nodeEnv,
  isProd,
  isDev: !isProd,
  port: int('PORT', 8080),
  logLevel: str('LOG_LEVEL', 'info'),
  publicBaseUrl: str('PUBLIC_BASE_URL', 'http://localhost:8080').replace(/\/+$/, ''),

  databaseUrl: str('DATABASE_URL'),

  jwtSecret: secret('JWT_SECRET', 48),
  encryptionKey: secret('ENCRYPTION_KEY', 32),

  provider: {
    apiKey: process.env.PROVIDER_API_KEY || '',
    // Browser call creation authenticates with the provider's *public* key,
    // not the private one that authorises everything else. Sending the private
    // key to that endpoint earns a 401 telling you to swap them, so the two
    // are kept apart rather than hoping one works everywhere.
    publicKey: process.env.PROVIDER_PUBLIC_KEY || '',
    baseUrl: str('PROVIDER_BASE_URL', 'https://api.vapi.ai').replace(/\/+$/, ''),
    webhookSecret: process.env.PROVIDER_WEBHOOK_SECRET || '',
    timeoutMs: int('PROVIDER_TIMEOUT_MS', 30_000),
    maxRetries: int('PROVIDER_MAX_RETRIES', 2),
  },

  corsOrigins: str('CORS_ORIGINS', 'http://localhost:8080')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  rateLimit: {
    windowMs: int('RATE_LIMIT_WINDOW_MS', 60_000),
    max: int('RATE_LIMIT_MAX', 600),
  },

  webhooks: {
    maxAttempts: int('WEBHOOK_MAX_ATTEMPTS', 8),
    workerIntervalMs: int('WEBHOOK_WORKER_INTERVAL_MS', 2_000),
    timeoutMs: int('WEBHOOK_TIMEOUT_MS', 10_000),
  },

  allowSignup: bool('ALLOW_SIGNUP', true),

  accessTokenTtlSeconds: int('ACCESS_TOKEN_TTL_SECONDS', 60 * 60),
  refreshTokenTtlSeconds: int('REFRESH_TOKEN_TTL_SECONDS', 60 * 60 * 24 * 30),
} as const;

export type Config = typeof config;
