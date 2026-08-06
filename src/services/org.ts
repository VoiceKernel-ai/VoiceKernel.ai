import { query, queryOne } from '../db';
import { config } from '../config';
import { ApiError } from '../errors';
import { decryptSecret, encryptSecret } from '../lib/crypto';
import { ProviderClient } from '../provider/client';

export interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  plan: string;
  status: string;
  provider_mode: 'platform' | 'byo';
  provider_key_cipher: string | null;
  provider_key_last4: string | null;
  provider_key_set_at: Date | null;
  region: string;
  settings: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export async function getOrg(orgId: string): Promise<OrganizationRow | null> {
  return queryOne<OrganizationRow>(`SELECT * FROM organizations WHERE id = $1`, [orgId]);
}

export async function getOrgBySlug(slug: string): Promise<OrganizationRow | null> {
  return queryOne<OrganizationRow>(`SELECT * FROM organizations WHERE slug = $1`, [slug]);
}

export async function createOrg(params: {
  name: string;
  slug?: string;
  region?: string;
}): Promise<OrganizationRow> {
  const slug = await uniqueSlug(params.slug ?? slugify(params.name));
  const row = await queryOne<OrganizationRow>(
    `INSERT INTO organizations (name, slug, region) VALUES ($1, $2, $3) RETURNING *`,
    [params.name, slug, params.region ?? 'us-east'],
  );
  if (!row) throw ApiError.internal('Could not create organization.');
  return row;
}

export function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'org';
}

async function uniqueSlug(base: string): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const existing = await queryOne(`SELECT 1 FROM organizations WHERE slug = $1`, [candidate]);
    if (!existing) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

/**
 * Stores a tenant's own provider key and flips them to BYO mode. The key is
 * validated against the provider before it is persisted - saving a key that does not
 * work turns every later call into a confusing 401.
 */
export async function setOrgProviderKey(orgId: string, apiKey: string): Promise<OrganizationRow> {
  const trimmed = apiKey.trim();
  if (!trimmed) throw ApiError.badRequest('A provider API key is required.');

  const probe = new ProviderClient(trimmed);
  try {
    await probe.get('/assistant', { limit: 1 });
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      throw ApiError.badRequest('The voice provider rejected that API key. Check it and try again.');
    }
    throw err;
  }

  const row = await queryOne<OrganizationRow>(
    `UPDATE organizations
        SET provider_mode = 'byo',
            provider_key_cipher = $2,
            provider_key_last4 = $3,
            provider_key_set_at = now()
      WHERE id = $1
      RETURNING *`,
    [orgId, encryptSecret(trimmed), trimmed.slice(-4)],
  );
  if (!row) throw ApiError.notFound('Organization not found.');
  return row;
}

/** Drops the tenant key and returns them to the shared platform account. */
export async function clearOrgProviderKey(orgId: string): Promise<OrganizationRow> {
  const row = await queryOne<OrganizationRow>(
    `UPDATE organizations
        SET provider_mode = 'platform',
            provider_key_cipher = NULL,
            provider_key_last4 = NULL,
            provider_key_set_at = NULL
      WHERE id = $1
      RETURNING *`,
    [orgId],
  );
  if (!row) throw ApiError.notFound('Organization not found.');
  return row;
}

/**
 * Resolves the provider credential an org's traffic should use.
 *
 * BYO      -> the tenant's own key; their provider account, so no cross-tenant
 *             filtering is required downstream.
 * platform -> VoiceKernel's shared key; the proxy MUST enforce isolation via
 *             the resources registry.
 */
export function resolveProviderClient(
  org: OrganizationRow,
  credential: 'private' | 'public' = 'private',
): {
  client: ProviderClient;
  mode: 'platform' | 'byo';
} {
  // A tenant's own account has its own public key, which we do not hold: BYO
  // stores one credential. Rather than silently falling back to the platform's
  // public key - which would create the call in the wrong account - say so.
  if (credential === 'public') {
    if (org.provider_mode === 'byo') {
      throw ApiError.notConfigured(
        'Browser test calls need this provider\'s public key, which VoiceKernel does not store for bring-your-own-key organizations. Place the call from your own application, or switch this organization to the shared platform account.',
      );
    }
    if (!config.provider.publicKey) {
      throw ApiError.notConfigured(
        'VoiceKernel has no provider public key configured, so browser test calls cannot be created. Set PROVIDER_PUBLIC_KEY on the deployment.',
      );
    }
    // The two keys are different values, and the provider rejects the private
    // one here with a generic 401. Catching the duplicate locally turns a
    // puzzling "Invalid Key" into the thing that is actually wrong - otherwise
    // the natural reading is that the key itself is bad, and it is not.
    if (config.provider.publicKey === config.provider.apiKey) {
      throw ApiError.notConfigured(
        'PROVIDER_PUBLIC_KEY is set to the same value as PROVIDER_API_KEY. Browser calls authenticate with the provider\'s public key, which is a different value found alongside the private key in the provider dashboard.',
      );
    }
    return { client: new ProviderClient(config.provider.publicKey), mode: 'platform' };
  }

  if (org.provider_mode === 'byo') {
    if (!org.provider_key_cipher) {
      throw ApiError.notConfigured(
        'This organization is in bring-your-own-key mode but has no provider key stored.',
      );
    }
    return { client: new ProviderClient(decryptSecret(org.provider_key_cipher)), mode: 'byo' };
  }

  if (!config.provider.apiKey) {
    throw ApiError.notConfigured(
      'VoiceKernel has no platform provider key configured. Set PROVIDER_API_KEY, or add your own key under Settings → Provider.',
    );
  }
  return { client: new ProviderClient(config.provider.apiKey), mode: 'platform' };
}

export async function updateOrg(
  orgId: string,
  patch: { name?: string; region?: string; settings?: Record<string, unknown> },
): Promise<OrganizationRow> {
  const sets: string[] = [];
  const params: unknown[] = [orgId];

  if (patch.name !== undefined) {
    params.push(patch.name);
    sets.push(`name = $${params.length}`);
  }
  if (patch.region !== undefined) {
    params.push(patch.region);
    sets.push(`region = $${params.length}`);
  }
  if (patch.settings !== undefined) {
    params.push(JSON.stringify(patch.settings));
    sets.push(`settings = settings || $${params.length}::jsonb`);
  }
  if (sets.length === 0) {
    const current = await getOrg(orgId);
    if (!current) throw ApiError.notFound('Organization not found.');
    return current;
  }

  const row = await queryOne<OrganizationRow>(
    `UPDATE organizations SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
    params,
  );
  if (!row) throw ApiError.notFound('Organization not found.');
  return row;
}

export interface MemberRow {
  id: string;
  org_id: string;
  user_id: string;
  role: 'owner' | 'admin' | 'developer' | 'viewer';
  email: string;
  name: string | null;
  created_at: Date;
}

export async function listMembers(orgId: string): Promise<MemberRow[]> {
  return query<MemberRow>(
    `SELECT m.id, m.org_id, m.user_id, m.role, m.created_at, u.email, u.name
       FROM memberships m
       JOIN users u ON u.id = m.user_id
      WHERE m.org_id = $1
      ORDER BY m.created_at ASC`,
    [orgId],
  );
}

export function publicOrg(org: OrganizationRow) {
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    plan: org.plan,
    status: org.status,
    region: org.region,
    provider: {
      mode: org.provider_mode,
      keyLast4: org.provider_key_last4,
      keySetAt: org.provider_key_set_at,
      platformKeyAvailable: Boolean(config.provider.apiKey),
    },
    settings: org.settings,
    createdAt: org.created_at,
  };
}
