import { query, queryOne, transaction } from '../db';
import { logger } from '../logger';
import { proxyToProvider } from './proxy';
import type { OrganizationRow } from './org';

/**
 * Right to erasure.
 *
 * A caller asks to be forgotten and the operator needs one action that reaches
 * every place their voice and words came to rest - transcripts, summaries,
 * analysis, recordings, and the raw provider payload we mirrored. Doing this by
 * hand across those surfaces is how records get missed, so it is one call with
 * a receipt.
 *
 * The subject is identified by phone number, which is the only identifier that
 * spans a call record and the caller's own request.
 *
 * Two deliberate choices:
 *
 *  - The call rows are redacted in place rather than deleted. Deleting them
 *    would silently rewrite historical volume and cost, and an operator being
 *    audited needs to show that a call happened and that its content was
 *    erased. Identifiers and content go; the shape of the record stays.
 *
 *  - Upstream deletion is attempted per call and its outcome recorded per call.
 *    A provider failure must not be swallowed - the receipt says exactly which
 *    calls are still pending upstream so the operator can retry rather than
 *    believing the erasure completed.
 */

export interface ErasureReceipt {
  subject: string;
  organizationId: string;
  requestedAt: string;
  callsFound: number;
  callsRedacted: number;
  upstream: { deleted: number; failed: number; failures: Array<{ callId: string; reason: string }> };
  eventsRedacted: number;
  complete: boolean;
  note: string;
}

/** Normalises a number the way the call mirror stores it. */
function normalise(subject: string): string {
  return subject.replace(/[\s()-]/g, '');
}

export async function eraseSubject(
  org: OrganizationRow,
  subject: string,
  options: { deleteUpstream?: boolean } = {},
): Promise<ErasureReceipt> {
  const number = normalise(subject);
  const requestedAt = new Date().toISOString();

  const calls = await query<{ provider_call_id: string }>(
    `SELECT provider_call_id FROM calls WHERE org_id = $1 AND customer_number = $2`,
    [org.id, number],
  );

  const failures: Array<{ callId: string; reason: string }> = [];
  let upstreamDeleted = 0;

  // Ask the provider to drop its copy first. If we redacted locally first and
  // then failed here, we would have lost the IDs needed to finish the job.
  if (options.deleteUpstream !== false) {
    for (const call of calls) {
      try {
        await proxyToProvider({
          org,
          method: 'DELETE',
          path: `/call/${encodeURIComponent(call.provider_call_id)}`,
        });
        upstreamDeleted++;
      } catch (err) {
        failures.push({
          callId: call.provider_call_id,
          reason: err instanceof Error ? err.message : 'unknown error',
        });
      }
    }
  }

  const { redacted, events } = await transaction(async (client) => {
    // Content and identifiers are cleared; timing, cost and outcome remain so
    // the call is still auditable as an event that occurred.
    const callResult = await client.query(
      `UPDATE calls SET
         customer_number = NULL,
         transcript      = NULL,
         summary         = NULL,
         recording_url   = NULL,
         analysis        = NULL,
         raw             = jsonb_build_object(
                             'erased', true,
                             'erasedAt', $3::text,
                             'id', raw ->> 'id',
                             'status', raw ->> 'status',
                             'endedReason', raw ->> 'endedReason'
                           )
       WHERE org_id = $1 AND customer_number = $2
       RETURNING id`,
      [org.id, number, requestedAt],
    );

    // Event payloads mirror call bodies and would otherwise retain the number
    // and transcript after the call row is clean.
    const eventResult = await client.query(
      `UPDATE events SET
         payload = jsonb_build_object('erased', true, 'erasedAt', $2::text, 'type', payload ->> 'type')
       WHERE org_id = $1
         AND payload::text LIKE '%' || $3 || '%'
       RETURNING id`,
      [org.id, requestedAt, number],
    );

    return { redacted: callResult.rowCount ?? 0, events: eventResult.rowCount ?? 0 };
  });

  const complete = failures.length === 0;

  logger.info(
    { orgId: org.id, callsFound: calls.length, redacted, upstreamDeleted, failed: failures.length },
    'erasure request processed',
  );

  return {
    subject: number,
    organizationId: org.id,
    requestedAt,
    callsFound: calls.length,
    callsRedacted: redacted,
    upstream: { deleted: upstreamDeleted, failed: failures.length, failures },
    eventsRedacted: events,
    complete,
    note: complete
      ? 'Transcripts, summaries, analysis, recordings and identifiers were removed. Call timing, cost and outcome are retained so the call remains auditable as an event.'
      : 'Local records were redacted, but some provider-side deletions failed. The erasure is NOT complete - retry for the call IDs listed under upstream.failures.',
  };
}

/**
 * What an erasure would touch, without touching it. Operators asked for this
 * before running a destructive action they cannot undo.
 */
export async function previewErasure(
  orgId: string,
  subject: string,
): Promise<{ subject: string; calls: number; earliest: Date | null; latest: Date | null }> {
  const number = normalise(subject);
  const row = await queryOne<{ count: string; earliest: Date | null; latest: Date | null }>(
    `SELECT COUNT(*)::text AS count, MIN(created_at) AS earliest, MAX(created_at) AS latest
       FROM calls WHERE org_id = $1 AND customer_number = $2`,
    [orgId, number],
  );
  return {
    subject: number,
    calls: Number.parseInt(row?.count ?? '0', 10),
    earliest: row?.earliest ?? null,
    latest: row?.latest ?? null,
  };
}
