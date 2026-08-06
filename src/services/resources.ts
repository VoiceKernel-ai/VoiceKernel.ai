import { query, queryOne } from '../db';
import type { ResourceKind } from '../provider/resources';

export interface ResourceRow {
  id: string;
  org_id: string;
  kind: string;
  provider_id: string;
  name: string | null;
  snapshot: Record<string, unknown>;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

/**
 * Records (or refreshes) an object VoiceKernel created in the provider on behalf of an
 * org. Idempotent on (kind, provider_id).
 *
 * The conflict clause deliberately does NOT reassign org_id: if a row already
 * exists for another tenant, the insert quietly leaves ownership alone and
 * `registerResource` reports the existing owner. That turns an ID collision
 * into a detectable condition rather than a silent takeover.
 */
export async function registerResource(params: {
  orgId: string;
  kind: ResourceKind | string;
  providerId: string;
  name?: string | null;
  snapshot?: unknown;
  metadata?: Record<string, unknown>;
}): Promise<ResourceRow> {
  const row = await queryOne<ResourceRow>(
    `INSERT INTO resources (org_id, kind, provider_id, name, snapshot, metadata)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
     ON CONFLICT (kind, provider_id) DO UPDATE
       SET name       = COALESCE(EXCLUDED.name, resources.name),
           snapshot   = CASE WHEN EXCLUDED.snapshot = '{}'::jsonb
                             THEN resources.snapshot ELSE EXCLUDED.snapshot END,
           metadata   = resources.metadata || EXCLUDED.metadata,
           deleted_at = NULL
       WHERE resources.org_id = EXCLUDED.org_id
     RETURNING *`,
    [
      params.orgId,
      params.kind,
      params.providerId,
      params.name ?? null,
      JSON.stringify(params.snapshot ?? {}),
      JSON.stringify(params.metadata ?? {}),
    ],
  );

  if (row) return row;

  // The WHERE guard suppressed the update: the row belongs to someone else.
  const existing = await queryOne<ResourceRow>(
    `SELECT * FROM resources WHERE kind = $1 AND provider_id = $2`,
    [params.kind, params.providerId],
  );
  if (existing) return existing;

  throw new Error(`Failed to register resource ${params.kind}/${params.providerId}`);
}

/** Returns the row only if it belongs to `orgId`. Deleted rows are excluded. */
export async function findOwnedResource(
  orgId: string,
  kind: ResourceKind | string,
  providerId: string,
): Promise<ResourceRow | null> {
  return queryOne<ResourceRow>(
    `SELECT * FROM resources
      WHERE org_id = $1 AND kind = $2 AND provider_id = $3 AND deleted_at IS NULL`,
    [orgId, kind, providerId],
  );
}

export async function isOwned(
  orgId: string,
  kind: ResourceKind | string,
  providerId: string,
): Promise<boolean> {
  const row = await queryOne<{ one: number }>(
    `SELECT 1 AS one FROM resources
      WHERE org_id = $1 AND kind = $2 AND provider_id = $3 AND deleted_at IS NULL`,
    [orgId, kind, providerId],
  );
  return row !== null;
}

/** The set of IDs this org owns for a kind - used to filter proxied lists. */
export async function ownedIds(
  orgId: string,
  kind: ResourceKind | string,
): Promise<Set<string>> {
  const rows = await query<{ provider_id: string }>(
    `SELECT provider_id FROM resources
      WHERE org_id = $1 AND kind = $2 AND deleted_at IS NULL`,
    [orgId, kind],
  );
  return new Set(rows.map((r) => r.provider_id));
}

export interface ListResourcesOptions {
  orgId: string;
  kind: ResourceKind | string;
  limit?: number;
  offset?: number;
  search?: string;
}

export async function listResources(
  opts: ListResourcesOptions,
): Promise<{ items: ResourceRow[]; total: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);

  const filters = [`org_id = $1`, `kind = $2`, `deleted_at IS NULL`];
  const params: unknown[] = [opts.orgId, opts.kind];
  if (opts.search) {
    params.push(`%${opts.search}%`);
    filters.push(`name ILIKE $${params.length}`);
  }
  const where = filters.join(' AND ');

  const items = await query<ResourceRow>(
    `SELECT * FROM resources WHERE ${where}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  const countRow = await queryOne<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM resources WHERE ${where}`,
    params,
  );

  return { items, total: Number.parseInt(countRow?.count ?? '0', 10) };
}

/**
 * Soft delete. The row is retained so that a late-arriving webhook referencing
 * the object can still be attributed to the right org rather than dropped.
 */
export async function markResourceDeleted(
  orgId: string,
  kind: ResourceKind | string,
  providerId: string,
): Promise<void> {
  await query(
    `UPDATE resources SET deleted_at = now()
      WHERE org_id = $1 AND kind = $2 AND provider_id = $3`,
    [orgId, kind, providerId],
  );
}

export async function updateSnapshot(
  orgId: string,
  kind: ResourceKind | string,
  providerId: string,
  snapshot: unknown,
): Promise<void> {
  await query(
    `UPDATE resources
        SET snapshot = $4::jsonb,
            name     = COALESCE($5, name)
      WHERE org_id = $1 AND kind = $2 AND provider_id = $3`,
    [
      orgId,
      kind,
      providerId,
      JSON.stringify(snapshot ?? {}),
      typeof (snapshot as Record<string, unknown> | null)?.name === 'string'
        ? (snapshot as Record<string, string>).name
        : null,
    ],
  );
}

/**
 * Resolves which org owns a provider object without knowing its kind. Used when an
 * inbound webhook references an ID we must attribute to a tenant.
 */
export async function resolveOwner(providerId: string): Promise<{ orgId: string; kind: string } | null> {
  const row = await queryOne<{ org_id: string; kind: string }>(
    `SELECT org_id, kind FROM resources WHERE provider_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [providerId],
  );
  return row ? { orgId: row.org_id, kind: row.kind } : null;
}

export async function countByKind(orgId: string): Promise<Record<string, number>> {
  const rows = await query<{ kind: string; count: string }>(
    `SELECT kind, COUNT(*)::text AS count FROM resources
      WHERE org_id = $1 AND deleted_at IS NULL GROUP BY kind`,
    [orgId],
  );
  return Object.fromEntries(rows.map((r) => [r.kind, Number.parseInt(r.count, 10)]));
}
