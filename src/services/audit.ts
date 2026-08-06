import { query } from '../db';
import { logger } from '../logger';

export interface AuditEntry {
  orgId: string | null;
  actorType: 'user' | 'api_key' | 'system';
  actorId?: string | null;
  actorLabel?: string | null;
  action: string;
  resourceKind?: string | null;
  resourceId?: string | null;
  status?: number | null;
  ip?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Writes an audit row. Deliberately never throws: an audit failure must not
 * turn a successful API call into a 500. Failures are logged instead, where
 * the operator's log pipeline can alert on them.
 */
export async function recordAudit(entry: AuditEntry): Promise<void> {
  try {
    await query(
      `INSERT INTO audit_logs
         (org_id, actor_type, actor_id, actor_label, action, resource_kind,
          resource_id, status, ip, user_agent, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
      [
        entry.orgId,
        entry.actorType,
        entry.actorId ?? null,
        entry.actorLabel ?? null,
        entry.action,
        entry.resourceKind ?? null,
        entry.resourceId ?? null,
        entry.status ?? null,
        entry.ip ?? null,
        entry.userAgent ?? null,
        JSON.stringify(entry.metadata ?? {}),
      ],
    );
  } catch (err) {
    logger.error({ err, action: entry.action }, 'failed to write audit log');
  }
}

export interface AuditRow {
  id: string;
  org_id: string;
  actor_type: string;
  actor_id: string | null;
  actor_label: string | null;
  action: string;
  resource_kind: string | null;
  resource_id: string | null;
  status: number | null;
  ip: string | null;
  user_agent: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

export async function listAudit(
  orgId: string,
  opts: { limit?: number; offset?: number; action?: string; resourceId?: string } = {},
): Promise<AuditRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);

  const filters = ['org_id = $1'];
  const params: unknown[] = [orgId];
  if (opts.action) {
    params.push(`%${opts.action}%`);
    filters.push(`action ILIKE $${params.length}`);
  }
  if (opts.resourceId) {
    params.push(opts.resourceId);
    filters.push(`resource_id = $${params.length}`);
  }

  return query<AuditRow>(
    `SELECT * FROM audit_logs WHERE ${filters.join(' AND ')}
      ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
}

export function publicAudit(row: AuditRow) {
  return {
    id: row.id,
    actor: { type: row.actor_type, id: row.actor_id, label: row.actor_label },
    action: row.action,
    resource: row.resource_kind ? { kind: row.resource_kind, id: row.resource_id } : null,
    status: row.status,
    ip: row.ip,
    userAgent: row.user_agent,
    metadata: row.metadata,
    createdAt: row.created_at,
  };
}
