import type { Request } from 'express';
import { z } from 'zod';

/** Query params arrive as strings; coerce before validating. */
export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export function parsePagination(req: Request): { limit: number; offset: number } {
  return paginationSchema.parse({
    limit: req.query.limit ?? undefined,
    offset: req.query.offset ?? undefined,
  });
}

export function parseDate(value: unknown, fallback: Date): Date {
  if (typeof value !== 'string' || !value) return fallback;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

export function parseWindow(req: Request, defaultDays = 30): { since: Date; until: Date } {
  const until = parseDate(req.query.until, new Date());
  const since = parseDate(
    req.query.since,
    new Date(until.getTime() - defaultDays * 24 * 60 * 60 * 1000),
  );
  return { since, until };
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/** Standard list envelope, so every collection paginates identically. */
export function listEnvelope<T>(
  items: T[],
  meta: { total?: number; limit: number; offset: number },
) {
  return {
    object: 'list',
    data: items,
    ...(meta.total !== undefined
      ? {
          pagination: {
            total: meta.total,
            limit: meta.limit,
            offset: meta.offset,
            hasMore: meta.offset + items.length < meta.total,
          },
        }
      : { pagination: { limit: meta.limit, offset: meta.offset } }),
  };
}

/**
 * Forwards the provider filter params a caller supplied, dropping anything else.
 * Passing the raw query object through would let a caller smuggle parameters we
 * have not reasoned about into the upstream request.
 */
const FORWARDABLE_QUERY = new Set([
  'limit',
  'page',
  'sortOrder',
  'createdAtGt',
  'createdAtLt',
  'createdAtGe',
  'createdAtLe',
  'updatedAtGt',
  'updatedAtLt',
  'updatedAtGe',
  'updatedAtLe',
  'assistantId',
  'squadId',
  'phoneNumberId',
  'customerId',
  'name',
  'id',
  'status',
  'type',
]);

export function forwardableQuery(req: Request): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(req.query)) {
    if (FORWARDABLE_QUERY.has(key) && value !== undefined) out[key] = value;
  }
  return out;
}
