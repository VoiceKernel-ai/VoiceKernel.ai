import { query, queryOne } from '../db';
import { logger } from '../logger';

/**
 * Local mirror of provider call objects.
 *
 * Two reasons this table exists rather than reading the provider on demand:
 *  1. In platform mode we cannot ask the provider for "this org's calls" - the account
 *     is shared. Analytics has to come from data we scoped ourselves.
 *  2. Dashboards page through thousands of calls; proxying every render would
 *     burn the tenant's provider rate limit for data that does not change.
 */

export interface CallRow {
  id: string;
  org_id: string;
  provider_call_id: string;
  assistant_id: string | null;
  squad_id: string | null;
  phone_number_id: string | null;
  type: string | null;
  status: string | null;
  ended_reason: string | null;
  customer_number: string | null;
  direction: string | null;
  started_at: Date | null;
  ended_at: Date | null;
  duration_seconds: string | null;
  cost: string | null;
  cost_breakdown: unknown;
  transcript: string | null;
  summary: string | null;
  recording_url: string | null;
  analysis: unknown;
  raw: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

function asDate(v: unknown): Date | null {
  if (typeof v !== 'string' || !v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number.parseFloat(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Upserts a call from any provider representation - the create response, a GET, or
 * an end-of-call webhook. Later payloads are richer, so COALESCE keeps whatever
 * we already learned instead of nulling it out when a sparser payload arrives.
 */
export async function recordCallFromProvider(orgId: string, payload: unknown): Promise<void> {
  if (!payload || typeof payload !== 'object') return;
  const call = payload as Record<string, unknown>;

  const providerCallId = asString(call.id);
  if (!providerCallId) return;

  const customer = (call.customer ?? {}) as Record<string, unknown>;
  const artifact = (call.artifact ?? {}) as Record<string, unknown>;
  const analysis = (call.analysis ?? null) as Record<string, unknown> | null;

  // the provider reports latency under artifact.performanceMetrics, and only once the
  // call has ended. Pulled into columns because the console charts percentiles
  // across the whole window and digging through JSONB per render does not hold.
  const perf = (artifact.performanceMetrics ?? {}) as Record<string, unknown>;

  const startedAt = asDate(call.startedAt);
  const endedAt = asDate(call.endedAt);
  const duration =
    startedAt && endedAt ? (endedAt.getTime() - startedAt.getTime()) / 1000 : null;

  // The end-of-call report embeds the call object as it was when the call was
  // created, so its `status` still reads "queued" while the report itself
  // carries an endedReason. Trusting that field left every finished call
  // showing as queued in the console for ever, including calls that plainly
  // failed. An ended reason - or an end timestamp - settles it.
  const reportedStatus = asString(call.status);
  const status = asString(call.endedReason) || endedAt ? 'ended' : reportedStatus;

  try {
    await query(
      `INSERT INTO calls (
         org_id, provider_call_id, assistant_id, squad_id, phone_number_id, type, status,
         ended_reason, customer_number, direction, started_at, ended_at, duration_seconds,
         cost, cost_breakdown, transcript, summary, recording_url, analysis, raw,
         transcriber_latency_ms, model_latency_ms, voice_latency_ms,
         endpointing_latency_ms, turn_latency_ms, user_interruptions, agent_interruptions
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18,$19::jsonb,$20::jsonb,
         $21,$22,$23,$24,$25,$26,$27
       )
       ON CONFLICT (provider_call_id) DO UPDATE SET
         assistant_id     = COALESCE(EXCLUDED.assistant_id, calls.assistant_id),
         squad_id         = COALESCE(EXCLUDED.squad_id, calls.squad_id),
         phone_number_id  = COALESCE(EXCLUDED.phone_number_id, calls.phone_number_id),
         type             = COALESCE(EXCLUDED.type, calls.type),
         -- Webhooks are not ordered. A late "ringing" status-update arriving
         -- after the end-of-call report would otherwise drag a finished call
         -- back to ringing and leave it there, which is how a call that had
         -- plainly ended kept showing as in-progress in the console.
         status           = CASE
                              WHEN calls.status = 'ended' THEN calls.status
                              ELSE COALESCE(EXCLUDED.status, calls.status)
                            END,
         ended_reason     = COALESCE(EXCLUDED.ended_reason, calls.ended_reason),
         customer_number  = COALESCE(EXCLUDED.customer_number, calls.customer_number),
         direction        = COALESCE(EXCLUDED.direction, calls.direction),
         started_at       = COALESCE(EXCLUDED.started_at, calls.started_at),
         ended_at         = COALESCE(EXCLUDED.ended_at, calls.ended_at),
         duration_seconds = COALESCE(EXCLUDED.duration_seconds, calls.duration_seconds),
         cost             = COALESCE(EXCLUDED.cost, calls.cost),
         cost_breakdown   = COALESCE(EXCLUDED.cost_breakdown, calls.cost_breakdown),
         transcript       = COALESCE(EXCLUDED.transcript, calls.transcript),
         summary          = COALESCE(EXCLUDED.summary, calls.summary),
         recording_url    = COALESCE(EXCLUDED.recording_url, calls.recording_url),
         analysis         = COALESCE(EXCLUDED.analysis, calls.analysis),
         raw              = calls.raw || EXCLUDED.raw,
         transcriber_latency_ms = COALESCE(EXCLUDED.transcriber_latency_ms, calls.transcriber_latency_ms),
         model_latency_ms       = COALESCE(EXCLUDED.model_latency_ms, calls.model_latency_ms),
         voice_latency_ms       = COALESCE(EXCLUDED.voice_latency_ms, calls.voice_latency_ms),
         endpointing_latency_ms = COALESCE(EXCLUDED.endpointing_latency_ms, calls.endpointing_latency_ms),
         turn_latency_ms        = COALESCE(EXCLUDED.turn_latency_ms, calls.turn_latency_ms),
         user_interruptions     = COALESCE(EXCLUDED.user_interruptions, calls.user_interruptions),
         agent_interruptions    = COALESCE(EXCLUDED.agent_interruptions, calls.agent_interruptions)
       WHERE calls.org_id = EXCLUDED.org_id`,
      [
        orgId,
        providerCallId,
        asString(call.assistantId),
        asString(call.squadId),
        asString(call.phoneNumberId),
        asString(call.type),
        status,
        asString(call.endedReason),
        asString(customer.number),
        inferDirection(asString(call.type)),
        startedAt,
        endedAt,
        duration,
        asNumber(call.cost),
        JSON.stringify(call.costBreakdown ?? null),
        asString(artifact.transcript) ?? asString(call.transcript),
        analysis ? asString(analysis.summary) : asString(call.summary),
        asString(artifact.recordingUrl) ?? asString(call.recordingUrl),
        JSON.stringify(analysis),
        JSON.stringify(call),
        asNumber(perf.transcriberLatencyAverage),
        asNumber(perf.modelLatencyAverage),
        asNumber(perf.voiceLatencyAverage),
        asNumber(perf.endpointingLatencyAverage),
        asNumber(perf.turnLatencyAverage),
        asNumber(perf.numUserInterrupted),
        asNumber(perf.numAssistantInterrupted),
      ],
    );
  } catch (err) {
    logger.error({ err, providerCallId, orgId }, 'failed to mirror call');
  }
}

function inferDirection(type: string | null): string | null {
  if (!type) return null;
  if (type.includes('inbound')) return 'inbound';
  if (type.includes('outbound')) return 'outbound';
  if (type.includes('web')) return 'web';
  return null;
}

export interface ListCallsOptions {
  orgId: string;
  limit?: number;
  offset?: number;
  status?: string;
  assistantId?: string;
  direction?: string;
  since?: Date;
  until?: Date;
  search?: string;
}

export async function listCalls(
  opts: ListCallsOptions,
): Promise<{ items: CallRow[]; total: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);

  const filters = ['org_id = $1'];
  const params: unknown[] = [opts.orgId];

  const add = (clause: (i: number) => string, value: unknown) => {
    params.push(value);
    filters.push(clause(params.length));
  };

  if (opts.status) add((i) => `status = $${i}`, opts.status);
  if (opts.assistantId) add((i) => `assistant_id = $${i}`, opts.assistantId);
  if (opts.direction) add((i) => `direction = $${i}`, opts.direction);
  if (opts.since) add((i) => `created_at >= $${i}`, opts.since);
  if (opts.until) add((i) => `created_at <= $${i}`, opts.until);
  if (opts.search) {
    add(
      (i) => `(customer_number ILIKE $${i} OR transcript ILIKE $${i} OR summary ILIKE $${i})`,
      `%${opts.search}%`,
    );
  }

  const where = filters.join(' AND ');
  const items = await query<CallRow>(
    `SELECT * FROM calls WHERE ${where} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  const countRow = await queryOne<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM calls WHERE ${where}`,
    params,
  );

  return { items, total: Number.parseInt(countRow?.count ?? '0', 10) };
}

export async function getCall(orgId: string, providerCallId: string): Promise<CallRow | null> {
  return queryOne<CallRow>(`SELECT * FROM calls WHERE org_id = $1 AND provider_call_id = $2`, [
    orgId,
    providerCallId,
  ]);
}

/** Shape returned by the API - camelCase, no internal columns. */
export function publicCall(row: CallRow) {
  return {
    id: row.provider_call_id,
    object: 'call',
    assistantId: row.assistant_id,
    squadId: row.squad_id,
    phoneNumberId: row.phone_number_id,
    type: row.type,
    direction: row.direction,
    status: row.status,
    endedReason: row.ended_reason,
    customer: row.customer_number ? { number: row.customer_number } : null,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationSeconds: row.duration_seconds === null ? null : Number(row.duration_seconds),
    cost: row.cost === null ? null : Number(row.cost),
    costBreakdown: row.cost_breakdown,
    transcript: row.transcript,
    summary: row.summary,
    recordingUrl: row.recording_url,
    analysis: row.analysis,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
