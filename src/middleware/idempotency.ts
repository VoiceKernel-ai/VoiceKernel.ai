import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { query, queryOne } from '../db';
import { ApiError } from '../errors';
import { sha256 } from '../lib/crypto';
import { logger } from '../logger';
import { asyncHandler } from './context';

/**
 * Idempotency for unsafe methods, keyed by `Idempotency-Key`.
 *
 * Placing a phone call is expensive and externally visible, so a client that
 * retries after a timeout must not place a second one. The first request to
 * present a key claims it; a replay either returns the stored response or, if
 * the original is still running, is told to retry rather than racing it.
 *
 * The stored request hash guards against a client reusing one key for two
 * different payloads, which is a client bug we should surface loudly.
 */

const REPLAYABLE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

export function idempotency(): RequestHandler {
  return asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const key = req.header('idempotency-key');
    if (!key || !REPLAYABLE_METHODS.has(req.method)) return next();
    if (!req.org) return next();

    if (key.length > 255) {
      throw ApiError.badRequest('Idempotency-Key must be at most 255 characters.');
    }

    const requestHash = sha256(
      `${req.method}:${req.originalUrl}:${JSON.stringify(req.body ?? null)}`,
    );

    // Claim the key. ON CONFLICT DO NOTHING makes the claim atomic, so two
    // concurrent replays cannot both believe they are first.
    const claimed = await queryOne<{ id: string }>(
      `INSERT INTO idempotency_keys (org_id, key, request_hash)
       VALUES ($1, $2, $3)
       ON CONFLICT (org_id, key) DO NOTHING
       RETURNING id`,
      [req.org.id, key, requestHash],
    );

    if (!claimed) {
      const existing = await queryOne<{
        request_hash: string;
        response_status: number | null;
        response_body: unknown;
        completed_at: Date | null;
      }>(
        `SELECT request_hash, response_status, response_body, completed_at
           FROM idempotency_keys WHERE org_id = $1 AND key = $2`,
        [req.org.id, key],
      );

      if (existing && existing.request_hash !== requestHash) {
        throw ApiError.conflict(
          'This Idempotency-Key was already used with a different request payload.',
        );
      }
      if (existing?.completed_at && existing.response_status) {
        res.setHeader('Idempotent-Replay', 'true');
        res.status(existing.response_status).json(existing.response_body);
        return;
      }
      // Original still in flight.
      throw ApiError.conflict(
        'A request with this Idempotency-Key is currently in progress. Retry shortly.',
      );
    }

    // Capture the response so a later replay can be served from storage.
    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      const status = res.statusCode;
      if (status >= 200 && status < 300) {
        void query(
          `UPDATE idempotency_keys
              SET response_status = $3, response_body = $4::jsonb, completed_at = now()
            WHERE org_id = $1 AND key = $2`,
          [req.org!.id, key, status, JSON.stringify(body)],
        ).catch((err) => logger.error({ err }, 'failed to persist idempotent response'));
      } else {
        // A failure should not be replayed - free the key so the client can
        // legitimately retry the same operation.
        void query(`DELETE FROM idempotency_keys WHERE org_id = $1 AND key = $2`, [
          req.org!.id,
          key,
        ]).catch(() => {});
      }
      return originalJson(body);
    }) as Response['json'];

    next();
  });
}

/** Housekeeping: idempotency keys are only meaningful for ~24h. */
export async function purgeExpiredIdempotencyKeys(): Promise<number> {
  const rows = await query<{ id: string }>(
    `DELETE FROM idempotency_keys WHERE created_at < now() - interval '24 hours' RETURNING id`,
  );
  return rows.length;
}
