import { query, queryOne } from '../db';
import { ApiError } from '../errors';
import { apiKeyPrefix, generateApiKey, hashApiKey, safeEqual } from '../lib/crypto';
import type { OrganizationRow } from './org';

export interface ApiKeyRow {
  id: string;
  org_id: string;
  name: string;
  environment: 'live' | 'test';
  prefix: string;
  key_hash: string;
  last4: string;
  scopes: string[];
  last_used_at: Date | null;
  expires_at: Date | null;
  revoked_at: Date | null;
  created_by: string | null;
  created_at: Date;
}

/**
 * Scopes are `resource:action` with `*` wildcards, e.g. `agents:read`,
 * `calls:*`, or plain `*` for full access. Kept deliberately coarse - fine
 * grained scopes that nobody can reason about are worse than a few clear ones.
 */
export const AVAILABLE_SCOPES = [
  '*',
  'agents:read',
  'agents:write',
  'calls:read',
  'calls:write',
  'phone-numbers:read',
  'phone-numbers:write',
  'tools:read',
  'tools:write',
  'files:read',
  'files:write',
  'squads:read',
  'squads:write',
  'campaigns:read',
  'campaigns:write',
  'chats:read',
  'chats:write',
  'sessions:read',
  'sessions:write',
  'evals:read',
  'evals:write',
  'analytics:read',
  'analytics:write',
  'webhooks:read',
  'webhooks:write',
  'provider:passthrough',
] as const;

export function scopeSatisfied(granted: string[], required: string): boolean {
  if (granted.includes('*')) return true;
  if (granted.includes(required)) return true;
  const [resource] = required.split(':');
  return granted.includes(`${resource}:*`);
}

export async function createApiKey(params: {
  orgId: string;
  name: string;
  environment?: 'live' | 'test';
  scopes?: string[];
  createdBy?: string | null;
  expiresAt?: Date | null;
}): Promise<{ key: ApiKeyRow; plaintext: string }> {
  const environment = params.environment ?? 'live';
  const scopes = params.scopes?.length ? params.scopes : ['*'];

  const invalid = scopes.filter((s) => !AVAILABLE_SCOPES.includes(s as never));
  if (invalid.length) {
    throw ApiError.badRequest(`Unknown scope(s): ${invalid.join(', ')}`, {
      availableScopes: AVAILABLE_SCOPES,
    });
  }

  const generated = generateApiKey(environment);
  const row = await queryOne<ApiKeyRow>(
    `INSERT INTO api_keys (org_id, name, environment, prefix, key_hash, last4, scopes, created_by, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [
      params.orgId,
      params.name,
      environment,
      generated.prefix,
      generated.hash,
      generated.last4,
      scopes,
      params.createdBy ?? null,
      params.expiresAt ?? null,
    ],
  );
  if (!row) throw ApiError.internal('Could not create API key.');

  // The plaintext is returned exactly once and never stored.
  return { key: row, plaintext: generated.plaintext };
}

export async function listApiKeys(orgId: string): Promise<ApiKeyRow[]> {
  return query<ApiKeyRow>(
    `SELECT * FROM api_keys WHERE org_id = $1 ORDER BY created_at DESC`,
    [orgId],
  );
}

export async function revokeApiKey(orgId: string, keyId: string): Promise<void> {
  const row = await queryOne(
    `UPDATE api_keys SET revoked_at = now()
      WHERE id = $1 AND org_id = $2 AND revoked_at IS NULL
      RETURNING id`,
    [keyId, orgId],
  );
  if (!row) throw ApiError.notFound('API key not found or already revoked.');
}

export interface AuthenticatedKey {
  key: ApiKeyRow;
  org: OrganizationRow;
}

/**
 * Authenticates a presented API key.
 *
 * The lookup is by indexed prefix, then the full hash is compared in constant
 * time. Returning null for every failure mode keeps the caller from
 * accidentally distinguishing "no such key" from "revoked" in its response.
 */
export async function authenticateApiKey(plaintext: string): Promise<AuthenticatedKey | null> {
  const prefix = apiKeyPrefix(plaintext);
  if (!prefix) return null;

  const row = await queryOne<ApiKeyRow & { org: unknown }>(
    `SELECT * FROM api_keys WHERE prefix = $1`,
    [prefix],
  );
  if (!row) return null;
  if (!safeEqual(row.key_hash, hashApiKey(plaintext))) return null;
  if (row.revoked_at) return null;
  if (row.expires_at && row.expires_at.getTime() < Date.now()) return null;

  const org = await queryOne<OrganizationRow>(`SELECT * FROM organizations WHERE id = $1`, [
    row.org_id,
  ]);
  if (!org || org.status !== 'active') return null;

  // Fire-and-forget: last_used_at is telemetry, not part of the auth decision.
  void query(`UPDATE api_keys SET last_used_at = now() WHERE id = $1`, [row.id]).catch(() => {});

  return { key: row, org };
}

export function publicApiKey(row: ApiKeyRow) {
  return {
    id: row.id,
    name: row.name,
    environment: row.environment,
    prefix: row.prefix,
    last4: row.last4,
    scopes: row.scopes,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    // Display form: never the real secret, just enough to recognise the key.
    masked: `${row.prefix}${'•'.repeat(12)}${row.last4}`,
  };
}
